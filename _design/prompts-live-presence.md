# Claude Code prompt pack — live presence: webcams in screening, Riverside-style recording, session archive

Four prompts, strictly in order. Prompt 0 is a feasibility spike: DO NOT run prompts 1-3 until 0 passes on real hardware. Commit between phases.

Architecture decisions (context for us; each prompt carries what it needs):

* No WebSocket server, no new infra. WebRTC signaling (SDP/ICE) is relayed over the EXISTING iroh session star as an opaque `Rtc` SessionMsg variant, exactly like ReviewOp, addressed by session-scoped member ids (host assigns m0/m1/m2...; names collide and roster positions shift). iroh stays the control plane; WebRTC media flows peer-to-peer with public STUN. No TURN server shipped (local-first): if a pair's ICE fails, tiles degrade to avatar-only presence, loudly logged; an OPTIONAL user-supplied TURN field in Settings is the escape hatch for hostile NATs.
* Mesh topology: MAX_PEERS=3 means max 4 people = 6 links. No SFU needed. Outbound tile video is capped ~360p (tiles are small; the mesh sends one encode per peer, so caps keep upload ~1.5 Mbps total). Full quality exists only in each member's LOCAL recording.
* Alternatives rejected: media-over-iroh (WKWebView has no WebCodecs audio encode/decode and we cannot rebuild WebRTC's echo cancellation); hosted SFUs like LiveKit/Jitsi (server infra violates the local-first constitution); native libwebrtc sidecar (loopback video piping + native AEC = complexity explosion). Browser WebRTC over iroh signaling is the only fit for this stack.
* One capture, two consumers (the Riverside pattern): a single getUserMedia stream feeds both RTCPeerConnection (live) and MediaRecorder (local full-quality recording). Never a second capture process on the camera.
* Recordings archive: ~/Documents/Sauce Bunny/Sessions/<stamp>-<slug>/ with a session.json manifest. Guests ship their recording to the host over a dedicated iroh bi-stream after the session (chunked; NOT the 2MB-capped control lines).
* Nav rail: screening currently hides the rail behind a hover hot-zone. That changes to a persistent compact rail (prompt 2) — main nav never disappears.

## Prompt 0 — Capture spike (gate for everything else)

```
Feasibility spike: prove camera+mic capture and in-page recording work in
THIS app's WKWebView before we build live presence on top. Keep all spike
code behind a dev-only flag; it ships nothing user-visible.

Context: ARCHITECTURE.md's dictation section says WKWebView's media-capture
permission path was unreliable on this stack (dictation went ffmpeg instead).
That was before the plist/entitlement work below; the webview APIs are the
right tool for WebRTC presence, so we now verify them properly.

1. Permissions plumbing:
   - src-tauri/Info.plist: add NSCameraUsageDescription (plain, honest copy
     in the style of the existing mic string: camera used only for live
     review sessions, video never leaves the machines of session members).
   - src-tauri/entitlements.plist: add com.apple.security.device.camera AND
     com.apple.security.device.audio-input (hardened runtime gates TCC for
     notarized builds; the mic one is ALSO a latent gap for dictation in
     release builds — note that in the commit message). Follow the file's
     comment style explaining why each is needed.
   - Check what our wry/tauri versions do with WKUIDelegate's
     requestMediaCapturePermission (see wry issue #1195): if the current
     versions auto-grant when plist keys exist, nothing more needed; if not,
     document what version bump or config is required and apply it if it's a
     patch/minor bump (Cargo.toml).
2. Dev harness: a hidden panel (e.g. behind a saucebunny.devMediaSpike
   localStorage flag, rendered from SettingsModal's dev section if one
   exists, else a temporary route in App) that runs and reports, in order:
   a. navigator.mediaDevices.getUserMedia({video: true, audio: true}) —
      does the OS prompt fire? does a live <video> preview render?
   b. enumerateDevices() after grant — are camera/mic labels populated?
   c. Switching devices via deviceId constraints.
   d. MediaRecorder on the stream: record 5s, report mimeType actually used
      (expect mp4/h264+aac on WKWebView; webm unlikely), byte size, and
      play the result back in a <video>.
   d2. Chunk-concat validity: record with timeslice (start(5000)), collect
      the chunks, concatenate the raw bytes, and verify the result plays.
      The crash-safe recording design (prompt 3) depends on concatenated
      timeslice chunks being a playable file; if they are not, report it —
      prompt 3 falls back to buffering whole-blob with a visible caveat.
   d3. AEC vs program audio: play a video WITH sound in the page while
      capturing with audio constraints {echoCancellation: true, noise-
      Suppression: true}; record the mic and check the program audio is
      substantially cancelled (Safari's AEC references the page's own audio
      output, and the screening video lives in the same page, so this
      SHOULD work; verify, don't assume). If AEC does not cancel it, note
      it: prompt 2 then ships with a "headphones recommended" chip and
      auto-ducking becomes a follow-up.
   e. RTCPeerConnection loopback (two PCs in-page, no network): tracks flow,
      connectionState reaches connected. Also verify
      sender.setParameters({encodings:[{scaleResolutionDownBy}]}) or
      applyConstraints can cap the outbound resolution (needed for mesh
      upload control in prompt 2).
   Each step prints pass/fail + details into the panel and the log drawer
   under a "media" tag.
3. Run it via npm run tauri dev AND a built .app (npm run tauri build,
   unsigned local build is fine) — TCC behaves differently between the two;
   record both results in the PR/commit description.
4. Deliverable: the harness + a short findings section appended to this
   prompt file (_design/prompts-live-presence.md) under "Spike results".
   If a/b/d fail on the built app after the plist+entitlement fixes, STOP:
   do not proceed to prompts 1-3; write up exactly which call fails and how
   (no prompt, denied, empty tracks) so we can decide on fallbacks.

No new npm dependencies. tsc/cargo/tests must stay green; bump build-ID only
if you add/change a Rust command (you shouldn't need to).
```

## Prompt 1 — Green room: devices, permissions, onboarding

```
Prereq: the capture spike passed (see "Spike results" in this file).

Build device selection + permission onboarding into the co-review lobby
(CoReviewLobby.tsx — respect its centered single-column design from the v3
polish pass). This phase is capture and UX only: no networking changes.

1. New module src/lib/media-devices.ts: typed helpers over
   navigator.mediaDevices — requestCapture(constraints), enumerate cameras/
   mics, persisted device picks (saucebunny.mediaDevices = {cameraId, micId}),
   and a devicechange listener helper. No classes, plain functions.
2. Lobby "green room" block, shown when hosting or joining (before and
   during a session): a camera preview card (mirrored, rounded, tokens) with
   two selects beneath: Camera and Microphone (labels from enumerateDevices;
   graceful "Default" entries when labels are empty pre-grant). Beneath the
   mic select: a live input level meter (WebAudio AnalyserNode on the mic
   track; reuse the drawing approach of DictationWave if it fits, else a
   simple 12-segment bar). Camera-off and mic-muted toggle buttons on the
   preview. Choices persist and re-apply next session.
3. Permission states, honest and quiet (voice contract: terse, no em dashes):
   - not yet asked: a single "Enable camera and microphone" button; clicking
     triggers getUserMedia (the OS prompt).
   - denied: one line explaining, plus a button that deep-links System
     Settings (open x-apple.systempreferences:com.apple.preference.security?
     Privacy_Camera via the opener plugin) and a "Try again".
   - granted: straight to preview.
   Joining a session with camera declined is ALWAYS allowed — presence
   degrades to the avatar, never blocks entry.
4. The stream created here is the session's capture: keep it alive in a
   module-level ref owned by use-co-review (or a sibling hook
   use-media-capture consumed by it), stopped (tracks.stop()) on session
   leave/end and on app quit. Prompt 2 will hand this same stream to
   RTCPeerConnection; design the ownership so there is exactly one
   getUserMedia stream per session.
5. a11y: selects labeled, meter aria-hidden with a text fallback ("Mic
   working"), preview aria-label "Your camera".

Frontend-only (plus any plist copy tweaks). tsc/vitest/e2e green; e2e can
only smoke the lobby render (no real devices in CI) — mock
navigator.mediaDevices in e2e/tauri-mock.ts to a stub that resolves a fake
stream so the lobby renders its granted state.
```

## Prompt 2 — Live tiles: WebRTC mesh over iroh signaling + persistent rail

```
Prereq: prompt 1 merged.

Make session members see and hear each other, Louper-style, and fix the nav
rail so main navigation never disappears in screening.

Read first: src-tauri/src/commands/session.rs (SessionMsg enum, the star
relay, MAX_PEERS=3, input caps), src/hooks/use-co-review.ts,
src/components/ParticipantRail.tsx (docstring already says Louper-style; it
becomes the tile rail), src/styles/screening.css (the current hover
hot-zone), the green-room capture ownership from prompt 1.

1. Signaling over the existing star — Rust side is a dumb relay:
   - Member identity first: the host assigns each member a session-scoped
     unique id (host = "m0", then "m1", "m2"... on Hello). PeerList grows
     to carry {id, name} pairs (names collide; roster POSITIONS shift when
     someone leaves mid-handshake, so neither is a routing key — ids are).
     Update the frontend roster plumbing (use-co-review, ParticipantRail)
     to key on id, display by name.
   - Add SessionMsg::Rtc { from: String, to: String, payload: String }
     where from/to are member ids (payload = opaque JSON: offer/answer/ICE
     candidate, Rust never parses it). Host relays to the addressed member
     only. Respect the existing input-size caps.
   - ts-rs regenerates SessionMsg binding; bump BACKEND_BUILD_ID both sides.
   - Rust unit tests: an Rtc line relays only to its target id; ids stay
     stable when another peer disconnects.
2. Frontend mesh (new hook src/hooks/use-rtc-mesh.ts, consumed by
   use-co-review): on session join/peer-list change, establish
   RTCPeerConnection per other member (deterministic offerer: lower member
   id offers). Config: iceServers = [stun:stun.l.google.com:19302] plus, if
   the user filled the new optional "Relay server (TURN)" field in Settings
   (saucebunny.defaults, empty by default, format turn:host:port with
   user/pass fields), that server too — an escape hatch for hostile NATs,
   no infrastructure shipped. Attach the single green-room stream's tracks,
   and CAP the outbound video at ~640x360 via sender.setParameters
   scaleResolutionDownBy (tiles render small; full quality belongs to the
   LOCAL recording only — this keeps a 3-peer mesh at roughly 1.5 Mbps up
   total instead of 3x full-res). Handle device switch via replaceTrack
   (not renegotiation, for same-kind swaps).
   Peer connectionState → per-member status: connecting / live / failed
   (failed = avatar-only tile + a loud log line, no retries beyond ICE
   restart once).
   If the spike's AEC test (d3) failed, show a one-line "Headphones
   recommended" chip in the green room; do not build audio ducking in this
   phase.
3. Tiles: ParticipantRail rows become video tiles when a live remote stream
   exists (16:9 rounded tile, name + host crown overlay bottom-left, mic-
   muted icon when the remote audio track is disabled, speaking glow via a
   lightweight AnalyserNode threshold on remote audio). Your own tile shows
   the local preview, mirrored, with your mute/camera toggles. No stream →
   the existing avatar row. Remote audio plays through hidden <audio>
   elements (one per peer; the screening <video> stays the media clock —
   presence audio is independent).
4. Mute/camera state propagates by track.enabled (no extra protocol);
   remote UI reads track.muted/enabled events.
5. Nav rail, persistent: remove the screening hover hot-zone behavior.
   In screening the rail stays visible as a compact variant (icons only,
   labels hidden, slightly translucent bg-1), part of the layout (no
   overlay, no reflow of the player when toggling screening — verify no
   remount, same constraint as ever). Update screening.css and nav.css;
   delete the hot-zone wrapper if nothing else uses it.
6. Leaving/ending the session closes every PC, stops remote audio elements,
   and (from prompt 1's ownership) stops capture. No leaked green camera
   light after leave — verify with the macOS menu-bar indicator.

Constraints: no new dependencies (WebRTC is platform API). Mesh size is
bounded by MAX_PEERS; do not add limits beyond it. Fail loud on signaling
errors. tsc/vitest/e2e + cargo test green. Manual verify: two machines (or
two user accounts) host+join, see/hear each other, device switch mid-call,
one side kills wifi → tile degrades to avatar with a logged reason.
```

## Prompt 3 — Riverside-style local recording, ship-to-host, session archive

```
Prereq: prompt 2 merged.

Every member can record their OWN camera/mic locally at full quality; when
the session ends, guests ship their recording to the host; the host archives
sessions and Home grows a Sessions shelf with history.

1. Local recording (frontend): MediaRecorder on the green-room stream (the
   same one feeding the mesh — one capture, two consumers). Host starts/stops
   recording FOR THE SESSION via a new relayed SessionMsg::Record { on: bool }
   (dumb relay like Rtc): every member's recorder starts/stops together, so
   takes align. Use the mimeType the spike proved (expect mp4). Chunk to a
   Rust append command every ~5s (new command append_session_recording:
   session id + chunk bytes → appends to a temp file in the media cache;
   Result<_, AppError>) so a crash mid-call loses at most seconds, not the
   take (WKWebView blobs are memory; do not buffer a whole call in RAM).
   Recording state is visible: a red dot + "Recording" chip in the rail
   (both sides), and the roster shows who is capturing.
2. Session manifest + archive layout (Rust, new commands in session.rs or a
   sibling module): ~/Documents/Sauce Bunny/Sessions/<yyyy-mm-dd-hhmm>-<slug>/
     session.json   (source url/title, started/ended, roster, recordings:
                     [{name, file, duration, received_at}])
     <member-name>.mp4  (recordings land here)
   Host finalizes its own recording straight into the folder.
3. Ship to host (iroh): ending a session with recordings enters a WRAP-UP
   state instead of tearing down: the host keeps the iroh endpoint and
   connections open, the UI shows "Wrapping up: receiving recordings"; the
   session fully closes only when transfers finish, fail, or the host
   dismisses wrap-up (guests' unsent recordings stay local with Retry).
   Within wrap-up, a guest offers its recording: new control line
   RecordingOffer { from, name, bytes }; host auto-accepts (same-session
   trust) and the guest opens a DEDICATED iroh bi-stream for the transfer
   (chunked reads/writes, progress events to both frontends, the existing
   2MB line cap untouched because this is its own stream).
   Reuse the endpoint/connection that session.rs already holds. Progress UI:
   a quiet transfer row in the lobby's active/ended state ("Sending your
   recording to <host> · 42%"). Transfer failure leaves the local file in
   the media cache with a "Retry send" affordance in the session's history
   entry; fail loud in logs.
4. History + Home:
   - The Review view (lobby) gains a "Previous sessions" list below the
     cards: reads the Sessions directory (new list_sessions command → Vec of
     manifest summaries), each row: date, source title, member count,
     recording count; click opens the folder in Finder (host) or shows the
     local recording (guest).
   - Home gains a "Sessions" shelf (standard card size) that appears only
     when sessions exist: poster = the source's poster if resolvable, else a
     tokens-styled session card; opening routes to the Review view's history
     (not Clip).
5. Wiring: ts-rs on new structs, AppError everywhere, build-ID bump both
   sides, Rust unit tests for manifest read/write and the chunked-append
   command (temp dirs). Update CLAUDE.md's storage-layout table with the
   Sessions directory (keep the docs truthful).

Verify manually with two machines: record a 2-minute session, end it, watch
the guest's file land in the host's session folder, kill the transfer
mid-way and retry it, confirm the Sessions shelf and history rows populate,
and confirm no recording ever starts without the visible red chip on every
member's screen.
```

## Commit points

0. `spike: prove WKWebView capture + recording (plist, entitlements, harness)`
1. `co-review: green room — device pickers, permissions, level meter`
2. `co-review: live webcam tiles — WebRTC mesh over iroh signaling; persistent rail in screening`
3. `sessions: aligned local recording, ship-to-host over iroh, archive + history`

## Spike results (pending hardware run)

> Fill in after running MediaSpikePanel (`localStorage
> saucebunny.devMediaSpike = "1"`) in BOTH environments — `tauri dev` and
> a built .app (TCC prompts behave differently). Prompts 1-3 stay locked
> until every line below has a verdict.

- [ ] dev: getUserMedia camera+mic granted, device labels present
- [ ] dev: device switch works, MediaRecorder mimeType accepted
- [ ] dev: timeslice concat plays back, AEC ratio sane, RTC loopback OK
- [ ] built .app: same ladder (camera + mic TCC prompts appear, once each)
