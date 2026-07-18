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
playhead" affordance; saved ops carry `t: null`. The review doc schema
already tolerates null timestamps - verify, don't assume.

## Prompt 1: playhead channel (host drives)

Rust `session.rs`: new `SessionMsg::Playhead { seconds, playing, at }` sent
host -> all at a low fixed rate (2Hz while playing, plus one message on every
seek/pause/play edge; nothing while idle - idle traffic stays zero). Guests
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
