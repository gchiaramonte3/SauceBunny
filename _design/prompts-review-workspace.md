# Claude Code OVERNIGHT pack — the Review workspace: dedicated room, onboarding, camera/mic/screen share

This pack SUPERSEDES prompts 1-3 of _design/prompts-live-presence.md (do not
run those; the spike prompt 0 there remains valid and its harness is built).

OVERNIGHT RULES: run 1 → 2 → 3 → 4 → 5 sequentially, unattended. Full gate
each prompt: npx tsc --noEmit && npm test && npm run test:e2e, plus cargo
check && cargo test --lib when Rust changes (then build-ID bump both sides).
COMMIT ONLY IF GREEN. If a gate fails after two fix attempts, write the
failure into _design/overnight-notes.md and continue to the next prompt.
Nothing in this pack waits on a human: everything device- or network-real is
covered by mocks overnight and lands on the MORNING CHECKLIST at the bottom
of this file, which Claude Code must append to as it goes.

Capture-risk note: the media spike harness exists (behind localStorage
saucebunny.devMediaSpike) but its on-hardware results are not yet recorded.
Build prompts 2-4 anyway against the mocked device layer; keep
src/lib/media-devices.ts as the ONLY module that touches real
navigator.mediaDevices, so if the morning hardware run surfaces a capture
problem, the fix is contained to one seam.

Design language for every prompt: the app's tone-card panel grammar
(commits 206771b, c90f3e1: tone-cards on an open page). Read those commits
and the current styles before designing; the session room must feel like the
same product. Terse copy, no em dashes, tokens only, cp- prefixes, no new
dependencies, reduced-motion respected.

---

## Prompt 1 — Split the workspaces: sessions live in Review, not Clip

```
Co-review currently runs INSIDE the Clip view (screening is a Clip mode;
the toolbar carries session status). Separate them: Review (⌘4) becomes a
dedicated workspace that owns sessions end to end; Clip returns to a solo
editing tool. Both keep the review/approval tools.

Read first: src/App.tsx (activeView switch, screening wiring, the stage/
body layout), src/hooks/use-co-review.ts, src/components/CoReviewLobby.tsx,
CoReviewPopover.tsx, ParticipantRail.tsx, ReviewPanel.tsx,
src/styles/screening.css + the tone-card grammar commits (206771b, c90f3e1).

THE ONE HARD CONSTRAINT: the media player must never remount. There is one
player DOM subtree; entering or leaving a session must reflow it with CSS
(exactly how cp-screening works today), never unmount/remount it. The
architecture is one shared stage, two dressings:

1. View model: the Review view has two faces.
   - No session: the lobby (kept from CoReviewLobby, restyled to tone-cards
     in prompt 2's onboarding work; structure only for now).
   - Live session: the SESSION ROOM: the app body renders the theater,
     owned and branded by Review. Implementation: keep the single stage in
     the app body; a `sessionRoom` presentation class on cp-body (the
     successor of cp-screening) drives the reflow, and the nav rail's
     active item shows Review while it's live. Rename screening state/CSS
     to room state where touched; do not duplicate the stage.

   THE ROOM'S OWN DESIGN SYSTEM — what is IN and what is OUT (this is the
   core correction; the current build leaks Clip furniture into the room):
   - OUT, unconditionally: the Clip source/export sidebar (metadata,
     transcript generation, export form, recent exports), the export
     queue tab, the filename field, the pipeline/logs sheet, the URL
     toolbar. c90f3e1 kept the source sidebar visible in the theater;
     REVERSE that. None of Clip's editing furniture renders in the room.
   - IN, and only this: (1) the nav rail, ALWAYS visible, never hidden,
     never auto-collapsed — it is the app's main navigation and the room
     is not an exception; (2) the stage; (3) the PEOPLE panel on the LEFT
     (Louper model: real camera feeds, prompt 3 fills it; roster
     avatars until then); (4) the review/approval drawer on the RIGHT,
     pulled from Clip (same ReviewPanel instance and the approval
     control, moved by layout); (5) the room control bar bottom-center;
     (6) minimal transport (play/pause + timeline scrub, host-authorita-
     tive as today). Nothing else. If a control cannot justify itself to
     a person REVIEWING (not editing), it does not enter the room.
   - The room reads as its own place: bg-0 deepens behind the stage, the
     People panel and drawer use the tone-card grammar, and Clip's
     layout never flashes during the transition (CSS reflow only).
2. Entering: starting/joining from the lobby activates the room (activeView
   "review", room class on). Switching to Clip (⌘3) while a session is live
   is ALLOWED: the session stays connected (audio/presence continue), the
   stage returns to the solo Clip dressing, and the rail's Review item
   pulses its live dot as the way back. Switching back to Review restores
   the room. This is the same keep-alive discipline as every other view.
3. Clip cleanup: remove the co-review popover/status chip from the Clip
   toolbar entirely (the rail's Review item with its live badge is the one
   session affordance). The screening toggle moves into the room's control
   bar (prompt 3 builds the bar; for now a minimal room header carries
   leave/end + the theater toggle).
4. Review/approval tools in both workspaces: ReviewPanel (comments,
   annotations, resolves) stays available in Clip's drawer exactly as
   today, and renders in the session room's drawer as well (same component,
   same doc, one instance moved by layout, not two mounted copies).
5. LoadSource still propagates from the host; a guest joining with nothing
   loaded lands in the room with the stage showing the "waiting for the
   host" empty state (one line, tone-card).

e2e: update smoke specs (toolbar no longer has the popover; the room class
gates on session state). Manual sanity is deferred to prompt 3's two-app
test.

Commit: `review: dedicated workspace owns sessions; clip returns to solo editing`
```

---

## Prompt 2 — Onboarding: the green room flow

```
Build the join/host onboarding into the Review lobby as a short, calm,
tone-card flow. Three steps, one card, no wizard chrome overkill:

1. Step model (one component, CoReviewLobby rebuilt around it):
   - IDENTITY: name field (seeds from the saved reviewer identity;
     saving writes it back), avatar color swatch picker (the review
     color set). Returning users with a saved name skip this step.
   - DEVICES: camera preview card (mirrored, rounded), Camera and
     Microphone selects (enumerateDevices labels; "Default" pre-grant),
     live mic level meter (AnalyserNode; reuse DictationWave's drawing if
     it fits), camera-off and mic-mute toggles. Permission states: not yet
     asked shows one "Enable camera and microphone" button; denied shows
     one line + a System Settings deep link (opener plugin,
     x-apple.systempreferences Privacy_Camera) + Try again. Joining with
     devices declined is always allowed; presence degrades to avatar.
     Device choices persist (saucebunny.mediaDevices) and re-apply.
   - READY: host face (Start session, then the join code as a
     click-to-copy keycap chip) or join face (code field + Join). Recent
     co-reviewers greeting is out of scope.
   Returning users with saved identity + granted permissions land directly
   on READY with a compact device strip (small preview thumbnail + device
   names + "Change") instead of the full DEVICES step.
2. Capture ownership: the stream created here is THE session capture,
   held in a module-level ref owned by a new hook use-media-capture
   (consumed by use-co-review): exactly one getUserMedia stream per
   session, tracks.stop() on leave/end/app quit. Prompt 3 hands this same
   stream to the mesh. New module src/lib/media-devices.ts for the typed
   getUserMedia/enumerate/persist helpers (plain functions).
3. e2e: mock navigator.mediaDevices in e2e/tauri-mock.ts (fake stream +
   two fake devices) so the lobby renders IDENTITY → DEVICES → READY in
   the smoke run; assert the step progression and the persisted-name skip.

Commit: `review: green room onboarding — identity, devices, permissions, ready`
```

---

## Prompt 3 — The room: webcam tiles, control bar, mesh

```
Prereq: prompt 2 merged.

Members see and hear each other in the session room. Design first,
transport second.

DESIGN (tone-card grammar; the Louper model — cameras are a PLACE, not a
decoration):
1. The PEOPLE panel: a dedicated LEFT column in the room (between the nav
   rail and the stage, ~240px, collapsible to a 72px avatar spine but
   never removed), holding the participant camera feeds stacked
   vertically: each a 16:9 tile, rounded, tone-card border; name + host
   crown bottom-left; mic-muted glyph when muted; a soft speaking glow
   (AnalyserNode threshold) on the active speaker. Your own feed is the
   TOP tile, mirrored, marked You, live from the green-room stream the
   moment you enter the room (you see your own camera working before any
   peer connects — this is the "I can see the physical camera" moment).
   No stream (declined/failed/camera off) = the avatar card in the same
   slot. Under ~1100px width the panel collapses to the avatar spine and
   tiles pop over on hover/focus. ParticipantRail's roster/exit duties
   fold INTO this panel; retire the old rail where superseded.
2. CONTROL BAR: a floating tone-card bar bottom-center of the room:
   mic toggle, camera toggle, share screen (wired in prompt 4; render it
   disabled with title "Screen share arrives with the next build" until
   then), theater toggle (fullscreen-feel), leave/end. Terse labels on
   hover only; icons from Icons.tsx dialect (add what's missing). The bar
   auto-dims when the pointer is idle over the stage (reduced-motion:
   stays).

TRANSPORT (over the existing iroh star; Rust stays a dumb relay):
3. Member ids: host assigns session-scoped ids (m0, m1...) at Hello;
   PeerList carries {id, name}; frontend roster keys on id. Rust unit
   test: ids stable when another peer disconnects.
4. SessionMsg::Rtc { from, to, payload } (opaque JSON: SDP/ICE), relayed
   to the addressed member only, existing size caps. ts-rs regen +
   build-ID bump.
5. Mesh hook use-rtc-mesh.ts consumed by use-co-review: one
   RTCPeerConnection per other member (lower id offers). iceServers:
   Google STUN + an optional user-supplied TURN from Settings (empty by
   default). Attach the green-room stream; cap outbound video ~640x360
   via sender.setParameters scaleResolutionDownBy (tiles are small; a
   full mesh stays ~1.5 Mbps up). Device switch = replaceTrack. States:
   connecting / live / failed (avatar + loud log; one ICE restart max).
   Remote audio via hidden <audio> per peer; the stage <video> remains
   the only media clock.
6. Mute/camera propagate via track.enabled; remote UI reads track events.
7. Teardown: leave/end closes every PC, stops remote audio, stops capture
   (prompt 2's ownership). Verify no camera indicator lingers.

Overnight coverage: unit-test the mesh hook with a fake RTCPeerConnection
class (vitest): offerer determinism by member id, replaceTrack on device
switch, teardown closes every PC, failed state after one ICE restart. The
e2e mock renders the room with two fake members (stub streams) so the tile
strip and control bar smoke-test. Add to the MORNING CHECKLIST: two-instance
run (see/hear each other, both layouts, speaking glow, mute propagation,
Clip ⌘3 mid-call keeps audio + rail dot, return restores the room, no
camera light after leave).

Commit: `review: webcam tiles + control bar; webrtc mesh over iroh signaling`
```

---

## Prompt 4 — Screen share (native pipeline; WKWebView has no getDisplayMedia)

```
Prereq: prompt 3 merged.

WKWebView does NOT implement getDisplayMedia (verified upstream: tauri
#2338, wry #1101), so screen share cannot use the browser API. We build it
from parts this app already owns: ffmpeg display capture over the loopback
proxy into a hidden <video>, then captureStream() feeds the mesh.

1. Permission (Rust, commands/system.rs or media.rs): screen recording is
   its own TCC class. New command screen_capture_access() using
   CGPreflightScreenCaptureAccess / CGRequestScreenCaptureAccess (core-
   graphics crate or a tiny objc call, matching existing FFI patterns) →
   returns granted|denied|undetermined. Denied state in the UI deep-links
   System Settings Privacy_ScreenCapture. The app restart requirement
   after granting (macOS quirk) gets one honest line in the UI.
2. Display enumeration (Rust): list_displays() → id, name, resolution
   (CoreGraphics CGGetActiveDisplayList). ffmpeg avfoundation captures
   whole displays ("Capture screen N"); window-level capture is a later
   ScreenCaptureKit sidecar, out of scope.
3. Capture pipeline (Rust + proxy): start_screen_share(display_index) →
   spawns ffmpeg: avfoundation input "Capture screen N", no audio, scaled
   to max 1600w, h264 ultrafast + zerolatency, fragmented MP4 with tiny
   fragments → served through a new stream_proxy route (token-gated like
   every proxy route) → JobRegistry-registered so stop/cancel is clean.
   stop_screen_share() ends it (graceful, then kill fallback).
4. Frontend: the control bar's Share Screen button opens a small display
   picker popover (names + resolutions from list_displays). On start: a
   HIDDEN muted <video> plays the proxy stream (MSE or direct src, match
   the codebase's proven path), then videoEl.captureStream() yields the
   share track, sent to every peer via replaceTrack on the camera sender
   (v1: sharing replaces your camera tile; your tile badges "Sharing
   screen" and shows the screen content; camera returns on stop). Latency
   target under ~1s; tune fragment size, note measured latency in the
   commit message.
5. Remote side needs no new code (it is just a video track), but tiles
   render a subtle "screen" badge when the sharer flags it (one relayed
   control line SessionMsg::Sharing { on: bool }, dumb relay).
6. Stopping: bar button, ending the session, or the ffmpeg child dying
   all converge on the same cleanup (share track removed, camera track
   restored, proxy route closed, job deregistered). Fail loud in logs.
7. Tests: Rust unit tests for display-list parsing and the route's token
   gating; e2e untouched (no real capture in CI). ts-rs + build-ID bump.

Overnight coverage: Rust unit tests as above; a vitest test for the share
state machine (start → sharing → stop restores camera; ffmpeg-death event
converges to the same cleanup) with the pipeline mocked at the invoke seam.
Add to the MORNING CHECKLIST: two-instance share of each display (remote
lag under ~1s), camera returns on stop, TCC denied path shows the Settings
link, no orphaned ffmpeg after force-quit.

Commit: `review: native screen share — ffmpeg display capture into the mesh`
```

---

## Prompt 5 — Approval tools, shared by both workspaces

```
Review AND approval: add an explicit approval status to the review doc so
a session (or a solo pass in Clip) can end with a verdict.

1. Data: extend the review doc schema (src/lib/review.ts) with a source-
   level status: "in_review" | "approved" | "changes_requested", set by
   {reviewer, at}. It is an op like any other (LWW semantics, merges via
   the existing algebra; co-review relays it with zero Rust changes).
   Unit tests beside the existing review.test.ts coverage: set/override/
   merge/inverse (undo restores the prior status).
2. UI, same component both workspaces: an approval control at the top of
   ReviewPanel: current status chip + two actions (Approve, Request
   changes). Approved = green chip, changes = amber, in review = neutral.
   Terse. In a live session the chip shows who set it ("Approved · Nika").
3. Surfaces: the status chip appears on the Clip sidebar source header,
   in the session room near the stage title, and on Home/Library cards
   for sources that have a review doc with a status (small corner chip,
   the existing badge grammar; only when a status exists, never a default
   chip on everything).
4. History: status changes append to the review doc like comments do, so
   the timeline shows "Approved by Nika" entries. Export (NLE markers/
   notes) includes the final status line.

Commit: `review: approval status — set, sync, surface in both workspaces`
```

---

## MORNING CHECKLIST (Gasper, on real hardware)

Claude Code appends per-prompt items here overnight. Baseline list:

1. Media spike, still unrecorded: set localStorage saucebunny.devMediaSpike
   = "1", run the spike panel in dev AND a built .app, paste results into
   _design/prompts-live-presence.md under "## Spike results". If capture
   fails anywhere, the fix seam is src/lib/media-devices.ts.
2. Green room with real devices: prompt fires once, preview renders,
   device switching works, denied path opens System Settings.
3. Two-instance session: your OWN camera feed visible as the top People
   tile the moment you enter the room; tiles, audio, speaking glow, mute
   propagation, Clip ⌘3 mid-call, teardown (no camera light).
3b. Room purity: the session room contains NO Clip furniture (no source
   panel, no export form, no queue, no URL bar, no logs) and the nav rail
   is fully visible at all times in the room.
4. Screen share on each display; remote lag; TCC denied path; no orphaned
   ffmpeg after force-quit.
5. Approval status set in a live session syncs to the other instance and
   shows on the Home card afterward.

### Appended overnight (prompt 2)

- Green room specifics to verify on hardware: the ONE getUserMedia prompt
  fires on "Enable camera and microphone" (not on lobby mount); device
  labels populate only after the grant; the denied path's System Settings
  deep link opens Privacy & Security > Camera; switching camera/mic in the
  selects re-opens the stream on the new device; the mic meter moves when
  you speak; camera-off shows the "Camera off" card; choices persist
  across relaunch (saucebunny.mediaDevices); leaving the session or
  quitting the app turns the camera light off (pagehide + role-off
  release paths).

### Appended overnight (prompt 3)

- Two-instance run: your OWN camera is the top People tile the moment the
  room opens (before any peer connects); the second instance's tile goes
  connecting -> live; you hear each other (remote voice is per-peer hidden
  audio, the stage video stays the only clock); speaking glow tracks the
  active talker; mute propagates (their tile shows the mic-off glyph);
  camera-off swaps to the avatar card in the same slot.
- Layouts: full 240px People column; collapse chevron to the 72px spine
  (tiles pop over on hover); narrow the window under ~1100px and the spine
  takes over automatically.
- Control bar: rests dimmed, wakes on hover; mic/cam toggles flip your own
  tile AND the remote side; share is disabled with the "next build" title;
  theater hides People + drawer but never the rail.
- Clip cmd-3 mid-call keeps audio + the rail dot; cmd-4 restores the room;
  leave/end closes every peer connection and the camera light dies.
- TURN: Settings -> General -> Co-review calls (leave empty for STUN).

### Appended overnight (prompt 4)

- Screen share, two instances: share each display from the picker (names +
  resolutions); remote tile switches to the screen content with the
  "Sharing screen" badge and lag stays under ~1s (100ms fragments,
  zerolatency x264; if it lags, the fragment size in serve_share is the
  dial); your own tile previews the share un-mirrored; stopping restores
  the camera on both sides.
- TCC: first share triggers the ONE screen-recording prompt; grant then
  quit-and-reopen (macOS quirk, stated in the picker); denied path's
  System Settings button lands on Privacy & Security > Screen Recording.
- Cleanup: stop button, ending the session, and killing ffmpeg by hand all
  restore the camera; `pgrep ffmpeg` shows NO capture process after a
  force-quit of the app (the proxy socket teardown kills the child).

### Appended overnight (prompt 5)

- Approval sync: set "Request changes" from instance A mid-session; B's
  panel chip, sidebar header chip, and room title chip update live and
  show who set it; Approve from B overrides (LWW); cmd-Z on the setter
  restores the prior verdict on both sides.
- Solo pass: approve in Clip with no session; the Home/Library card for
  that source shows the corner chip after the doc saves (cards read the
  hydrated store; fingerprint-keyed local docs may need a reopen first -
  known best-effort).
- Export: the review Markdown/notes carry the final "Status:" line.
