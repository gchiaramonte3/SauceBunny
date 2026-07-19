# Giant review, round 2 (deferred findings)

The 2026-07-19 giant review (12 finder agents, adversarial verify) produced
152 findings. Round 1 fixed ~45 (all confirmed App.tsx bugs, the capture/AV
stack, library menus, 13 Rust fixes, 21 dead-code removals). These are the
verified-or-plausible leftovers, ordered by value. Each is sized for a
normal session; none is trivial.

## High

- **rtc-mesh.ts ~168: pre-allocate transceivers.** A peer connection built
  while the local capture has no track never gains one (no renegotiation
  path). Fix: `addTransceiver("video"/"audio")` at build when the track is
  missing, record the senders, and replaceTrack fills them later. This is
  the "join without devices, enable camera later" story.
- **MSEStreamPlayer ~197: play-during-rebuild wedge.** Pressing play while
  a seek rebuild is in flight can leave the transport stuck "playing"
  (pause() on an already-paused element emits nothing). Fix: emit an
  explicit state correction when a transport command lands mid-rebuild.
- **transcript.rs merge tag stacking is FIXED, but** srt.ts:80 (`S\d+`
  machine-pattern stealing) and srt.ts:345 (double strip on weak-speaker
  promotion) remain: both are parser edge cases with tests to update
  alongside.

## Medium

- rtc-mesh.ts ~101: queue ICE candidates that arrive while
  setRemoteDescription is pending (currently dropped; slow-network joins).
- use-rtc-mesh ~117: TURN field edits rebuild the mesh per keystroke and the
  rebuilt mesh never re-receives the roster (keep members in a ref;
  re-apply after rebuild; debounce the config).
- share-machine.ts ~45: `start()` must re-check state after each await so a
  stop() during "starting" can't be resurrected.
- use-media-capture: PeoplePanel remote camera-off shows a black tile (track
  stays live, enabled=false on the far side is invisible). Listen for the
  receiver track's mute/unmute events per tile, fall to the avatar card.
- review-store.ts ~257: multi-window index.json writes are
  last-writer-wins over the whole map - merge with the on-disk index before
  writing.
- review.ts restampReviewOp: add the "status" op so redo of a review
  verdict survives its LWW guard.
- timecode.ts tcToSeconds divides by raw fps while every sibling rounds -
  one drifted second per NTSC minute in TC round-trips. Align + test.
- session.rs: bound `read_line` growth (the MAX_MSG_BYTES check only fires
  after a full line); don't hold the manager mutex across peer writes (one
  stalled peer wedges broadcast).
- media.rs ~326: failed/cancelled export leaves the partial output + .fNNN
  DASH intermediates in the export folder - clean on the error path.
- transcript.rs ~1229: generic yt-dlp failure surfaces the log's FIRST line
  (usually a warning), not the actual error line.
- mediabunny-audio/waveform/mediabunny-export still open local files via
  UrlSource(convertFileSrc) - the documented-broken pattern for some
  sources; route through the read_file_range CustomSource like playback.
- TranscriptViewer: "Download .srt" writes raw VTT into a .srt name;
  per-turn rename shadows the visible default; hasAnyOverride ignores
  aliases/colors so Reset hides. InsightsPopover shows raw diarizer tags.
- QueueDrawer ~580: the click-after-drag guard is dead - dragging a tab to
  reorder also activates it.
- ReviewPanel ~796: Approve / Request changes skip the ensureNamed gate
  (status op lands with an empty reviewer).
- App handleQueueRenameAll: base-1..N without collision check against
  non-queued siblings.
- use-web-playback ~124: Tauri listeners leak if cleanup runs before the
  listen() promises resolve (guaranteed once per boot in StrictMode-ish
  double-mount patterns).
- LocalMediaPlayer ~313 cleanup no-op (ref nulled before cleanup runs) and
  MediaBunnyPlayer ~332 stale onTimeUpdate closure (route through a ref).
- settings.css vs palette.css both define .cp-shortcuts-grid with
  conflicting layouts - rename the settings one.
- MSEStreamPlayer ~844: scrub pause/resume leaks through onPlayStateChange
  (transport flicker); ~289: getCurrentTime hole between rebuild debounce
  and pipeline open.
- stream_proxy extract_frame: not JobRegistry-registered, no wall-clock
  bound (contract violation - every long sidecar must be cancellable).

## Readability / structure (do opportunistically)

- ONE device-select row component (GreenRoomDevices + DevicePanel +
  AvSettingsPane render near-identical markup 3x - now over the 3+ rule);
  same for the analyser meter (twice + speaking detector = 3 consumers).
- SettingsModal (1733 lines) and ReviewPanel (~12 components in one file):
  split into sibling panes per the YouTubeSettings precedent.
- App.tsx dedupes: RecentClip construction (3x), seconds-to-frames seek
  adapter (2x), engine-readiness gate (2x), URL-bar focus incantation (3x).
- Em-dash sweep over Rust user-facing error strings (voice contract covers
  TS only); logs.css/monitor.css hardcoded status hexes -> tokens;
  buttons.css neutral hex literals -> tokens.
- SettingsModal About pane: license text + network-calls description are
  stale; Defaults.streamPreview doc comment states the wrong default;
  use-rtc-mesh role prop: type the union, not bare string.
- CoReviewLobby in-session people list keyed by index (Participant.id is
  the roster key); lobby + room faces could split into sibling components.

## Reusable join codes (user ask 2026-07-19, deferred - needs a spike)

"Use the same code for your second time": persist a 32-byte iroh SecretKey
under app_data_dir and feed `.secret_key(...)` into session_start's endpoint
builder - the host's NodeId becomes stable across sessions. CAVEAT the
mapper verified: EndpointTicket also embeds live relay + direct addresses,
so the dressed SAUC- code can still change between sessions even with a
stable key. A byte-identical "personal room code" requires NodeId-only
dialing, which session.rs:1016 records as unverified on our setup (needs
live n0 discovery). Spike: persist the key, mint a NodeId-only invite,
verify a cross-network join, then swap parse_invite to accept both forms.
Needs a rand/getrandom dep for key generation (none in Cargo.toml today).

## Rejected / not doing

- MSE audio-only branch removal (finder called it unreachable; the
  hasVideo=false path is one refactor away from real again - keep).
- sound.ts mute API, legacy review wrappers, csv/edl exporters: REMOVED in
  round 1; markers.ts is the canonical export path.
