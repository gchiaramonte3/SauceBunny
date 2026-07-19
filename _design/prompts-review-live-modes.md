# Review sessions: live modes (design doc + prompt pack)

Status: DESIGN. Written 2026-07-19 from the user's direction. No code in this
pack has been built yet; each prompt below is sized for one session.

## The problem

A review session currently assumes everyone can watch "the same thing," but
there are really three different situations, and each one needs a different
sync contract:

1. **Screen-share sessions.** The host shares a display (an NLE timeline, a
   browser, anything). Guests see pixels, not a source. There is no shared
   timecode, so comments must not pretend there is one.
2. **Link sessions.** Everyone loads the same web URL (YouTube, Vimeo, etc.).
   Each machine streams its OWN copy through its own proxy pipeline. The only
   thing worth sending is the playhead. The host drives.
3. **Local-file sessions.** The host has a file guests don't have. Guests
   should be able to REQUEST it; if the host approves, the file transfers
   peer-to-peer over the existing iroh connection into a managed cache, and
   from then on it behaves like mode 2: playhead-only sync against a local
   copy on every machine.

One principle covers all three: **media never streams through the session
channel.** The session carries identity, presence, RTC signaling, review ops,
and (new) playhead state + file-transfer frames. Picture always comes from
each machine's own pipeline (their stream, their cache copy, or the host's
shared screen via RTC).

## Mode detection

The session doesn't ask the host to pick a mode. It derives one:

- Host is screen-sharing and no shared source is set -> `share` mode.
- Session has a shared source that is a web URL -> `link` mode.
- Session has a shared source that is a local file -> `file` mode
  (guests individually in `file-pending` until they hold a cache copy).

The mode is host-owned state, broadcast in the session (a `Mode` message
folded into `SessionState`), and shown as a quiet chip in the room header.

## Comment/timecode contract per mode

| Mode | Timecode on notes | Playhead sync | Who drives |
|------|-------------------|---------------|------------|
| share | NO - notes are plain, ordered by wall-clock | none | host implicitly |
| link | YES - source timecode | host broadcasts | host |
| file (before transfer) | guest notes: NO; host notes: YES | host broadcasts (guests can't follow yet) | host |
| file (after transfer) | YES | host broadcasts | host |

In `share` mode the Review composer hides the timecode chip and the "at
playhead" affordance. Notes carry a TAGGED ANCHOR instead of a bare nullable
timestamp (adopted from the 2026-07-19 schema proposal - see "Evaluated
ideas" below):

```ts
type Anchor =
  | { anchor: "timecode"; t: number }                    // source seconds
  | { anchor: "session"; sessionMs: number; wallClockMs: number };
```

A share-mode note records when-in-the-meeting and time-of-day. That is what
makes the note conformable LATER: if the shared screen was recorded, the
recording's start time maps `sessionMs` onto real timecode and the note
retroactively gains a frame address. `t: null` would throw that away. The
review doc schema must tolerate the new anchor kind - verify, don't assume.

## Prompt 1: playhead channel (host drives)

Rust `session.rs`: new `SessionMsg::Playhead { seconds, playing, at }` sent
host -> all at a low fixed rate (2Hz while playing, plus one message on every
seek/pause/play edge; nothing while idle - idle traffic stays zero). `at` is
the SENDER's monotonic-ish clock (ms): followers estimate transit delay from
it and, while playing, advance the target by that delay before comparing -
without this every guest sits a network hop behind the host. Guests
apply it: seek if |delta| > 0.75s, play/pause to match. Frontend: the room's
player already exposes the corrected playhead; wire it into the session via
use-co-review. Guests get a "Following host" chip with a "Watch freely"
toggle (stops applying playheads until re-enabled; re-enabling snaps to the
host). Host UI change: none - the host just plays.

## Prompt 2: mode derivation + share-mode notes

Derive and broadcast the mode (host), render the header chip, and implement
the share-mode comment contract (no timecode chip, `t: null` ops, notes list
falls back to wall-clock order). Keep the diff small; no RTC changes.

## Prompt 3: shared-source handshake (link mode)

Host's loaded web URL is announced in-session (`SessionMsg::Source { url,
title, duration }`). Guests see a one-line banner: "Host is watching <title>
- Load it" -> clicking runs the normal URL-open path on their machine (their
own yt-dlp/proxy pipeline). Once loaded, Prompt 1's playhead channel makes it
a synced screening. No auto-load: a guest always clicks (they may be on
metered data, or mid-something).

## Prompt 4: P2P file offer + cache (file mode)

The big one. In `file` mode guests see "Host has a local file: <name>
(<size>) - Request a copy." Flow:

- Guest sends `FileRequest`. Host gets a notification-style approve/deny
  (green primary = Approve, per the color contract).
- On approve, the file streams host -> guest over a dedicated iroh stream
  (NOT the message channel; open a second bidirectional stream for the
  transfer, chunked, with a progress event both sides render).
- The guest writes into `app_cache_dir()/saucebunny-sessions/<hash>/<name>`
  and registers it with the existing cache sweep EXCEPT session copies get
  their own retention rule (below).
- On completion the guest's player opens the cache copy via the normal
  local-file path, and the guest flips to synced (`file` proper).

Integrity: the host sends `(size, blake3)` up front; the guest verifies
before opening. Cancel/disconnect mid-transfer deletes the partial file.

## Prompt 5: cache/download setting

Settings gains a "Review sessions" group:

- **Keep received files**: "Until the session ends" (default) / "24 hours" /
  "Until I clear them". Maps to the sweep rule for `saucebunny-sessions/`.
- **Ask before receiving files over** N MB (default 500): below the
  threshold the request still requires the HOST's approval, but the GUEST's
  save is automatic; above it the guest confirms too.
- A "Clear received files" row with the current byte count.

## Prompt 6: Avid marker export (future, from the proposal)

Timecode-anchored notes map 1:1 onto Avid text-import markers: Username =
author display name, TC = start timecode advanced by the note's frame,
Track/Color = per-note fields (default V1/red), Comment = body. Ranged notes
export as bracket markers or a RANGE- prefixed comment (Avid text import has
no true spanned marker). Prerequisite: store the source frame rate as a
RATIONAL (30000/1001, drop-frame flag), never a float, and convert
frames -> SMPTE in ONE tested display function (29.97 drop-frame math is the
part with teeth). Session-anchored notes stay out of this export until
conformed (see the anchor section). This prompt ships with a vitest table of
known drop-frame conversions.

## Prompt 7: window-level share (Meet-style picker) - SHIPPED r119

Shipped 2026-07-19: the saucebunny-capture ScreenCaptureKit sidecar (list
with thumbnails + raw BGRA stream piped into the ffmpeg fMP4 proxy path),
the tabbed ShareDialog (Screens / Windows / Portion of screen with a
drag-to-select rect, Zoom's Advanced-tab shape), and SCK system audio
muxed as AAC and mixed into the mic sender. HARDWARE-UNVERIFIED pieces to
test first: the rawvideo pipe end to end, portion coords on Retina, and
whether WKWebView's captureStream() emits audio from the muted hidden
element (the mix silently degrades to mic-only if not). Original design
notes below for reference.

### Original design (pre-implementation)

Today's share is whole displays only, because the capture side is ffmpeg's
avfoundation input and avfoundation enumerates SCREENS, not windows. A
Meet-style "share this window" needs ScreenCaptureKit: extend the existing
Swift sidecar (or a small second SPM target) to list shareable windows
(SCShareableContent: app name, window title, thumbnail) and stream a chosen
SCStream as raw frames into the existing /share/v1 proxy path in place of
the ffmpeg process. The picker UI then gets two tabs - Displays / Windows -
with live thumbnails, like Meet. Sized as its own session; the UI tab shell
can land earlier with displays only.

## Evaluated ideas (2026-07-19 pasted proposal)

A SQLite schema + control-message protocol was proposed. Verdict per idea:

- ADOPTED - tagged anchors (`timecode` vs `session` + wallClockMs): folded
  into the mode contract above. The conform story is the winning argument.
- ADOPTED - sender-clock latency compensation on transport/tick messages:
  folded into Prompt 1.
- ADOPTED - rational frame rates + single drop-frame display function, and
  the Avid marker column mapping: now Prompt 6.
- ALREADY OURS - content-addressed asset identity: review docs are keyed by
  source fingerprint hash today, and Prompt 4's transfer verifies blake3.
  Same idea, no change needed.
- DEFERRED - driver handoff (`{ t: "driver"; participantId }`): the message
  shape is right if multi-driver ever lands, but one-driver-the-host stays
  the contract for now.
- REJECTED - SQLite: the constitution's persistence layer is localStorage +
  JSON review docs with debounced write-through, and at this data volume a
  database adds a dependency, a migration, and a second source of truth
  without buying anything. The schema's SHAPE (assets/notes columns) largely
  restates what review docs already carry.
- REJECTED - WebTorrent/infoHash: iroh is already the transport and blake3
  the content id; a second P2P stack is a hard no.
- REJECTED - persisted `sessions` table: sessions are deliberately ephemeral;
  notes carry authorship and anchors, which is all export needs.

## Out of scope (explicitly)

- Guest-driven scrubbing / multi-driver sessions. One driver: the host.
- Streaming the host's decoded video to guests in link/file modes (that's
  what mode `share` is for, and it's pixels-only by design).
- Any relay server. iroh's existing connectivity is the transport; if two
  machines can't reach each other, the modes degrade to share mode.

## MORNING CHECKLIST (user)

- [ ] Read the mode table - does the timecode contract match how you'd run
      a real session in each mode?
- [ ] Prompt 4's approve/deny direction: host approves every outgoing copy.
      Right default?
- [ ] Prompt 5 defaults (session-end retention, 500 MB guest-confirm) - ok?
- [ ] Say "run the live-modes pack" (or name a single prompt) to start.
