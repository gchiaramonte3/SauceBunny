# Premiere connection delivery

Implementation and local validation in progress. Historical entries below
describe their own build state; see [the September 8 continuity test build](INTERNAL-TEST-2026090901.md)
for the current corrections, regression evidence and distribution limits.

The accepted objective is **Connect Premiere → private preview → explicit room
publication**, with a bundled standard runtime and a one-time official Premiere
plugin installer link. Keep the old room feed running while privately checking
a different source. Do not substitute stop-then-preview.

## September 8: clear program viewport

### Pairing follow-up

A live unauthenticated WebSocket probe reproduced the pairing rejection: the
current app returned 101 for `127.0.0.1:PORT` and 403 for `localhost:PORT`, which
is the companion's manifest-approved address. The native handshake now accepts
both exact authorities on its bound port. IPv4 loopback binding, Origin/path
validation, 256-bit secret, expiry and single-client checks remain in place.
Duplicate Host headers and lookalike/wrong-port hosts are rejected.

Companion 0.1.6 also retains the actual network/timeout/acknowledgement failure
instead of replacing it with “Pairing cancelled”. Old hello and heartbeat work
cannot close a newer connection. The desktop package verifier now checks the
same `ws://localhost` permission as the companion manifest; no wildcard or
external-network permission was added.

The real-socket regression failed with the original 403 and passes with the
fix. All 31 bridge tests and 35 companion tests pass. Full application
verification passes: 3,522 frontend tests (2 skipped), 473 Rust tests
(21 ignored), 11 Swift tests and 359 browser cases (3 native-capture cases
not enabled in this run). Companion archive/isolated UI checks also pass.
Logs: `/private/tmp/sauce-pairing-fix-verify.log` and
`/private/tmp/sauce-pairing-fix-build.log`.

A separate local test app is ready at
`/private/tmp/sauce-pairing-fix-app.loDqKs/Sauce Bunny.app`, containing companion
0.1.6. Its deep signature, bundle contents, NDI runtime and exact companion
resource verification pass. Signed executable SHA-256:
`8ca227015baec0b9ce4fbe6807c5028975f6da128cb9d2cdd02a3ef8efd9f7d9`.
It is ad-hoc signed, not a notarized release. Following explicit restart
approval, this exact app was launched September 8 at 14:14 local time (PID
85904); Premiere remained running with its original PID 19117. No installation
or new DMG was made. Home rendered, but opening Settings blocked the main
thread in `has_review_identity` / `SecKeychainFindGenericPassword` while a
background identity load waited for macOS SecurityAgent. The stack sample is
`/private/tmp/sauce-pairing-fix-settings-sample.txt`. Computer Use explicitly
refused access to SecurityAgent; no alternate route, credential read, or
Keychain permission change was attempted. The user must handle that system
prompt directly before native testing can continue. A fresh code must still
pair in the native Premiere panel before authenticated pairing is accepted.
No real credentials, sequence bindings or markers were created during this
investigation.

On the next native recheck, Settings was responsive and Integrations rendered
normally. The pairing action reached “Waiting for the companion to pair” and
the copy action reported “Copied. Paste in Premiere.” The code was not read
into diagnostics or sent to the companion. Authenticated connection still
awaits action-time approval; no sequence binding or marker writes were enabled.
The app and Premiere process IDs subsequently changed to 91923 and 91593;
read-only process inspection confirmed the app still uses the same pairing-fix
bundle path. The earlier temporary pairing cannot be assumed valid after that
process change.

Private NDI verification in the running build found the Premiere source on
opening Connect Premiere, rendered its 1280 × 720 picture, and retained the
Review / Transcript / AI Summary / Queue tabs with no Sauce Bunny playback
buttons or file-shortcuts hint. Volume read unmuted at 100%. A short Premiere
playback test advanced the picture in Sauce Bunny; Premiere's meters were
active. Playback was stopped and the original `00:00:11:03` playhead restored.
This proves live picture delivery, not audible output or jitter acceptance.
The user was asked whether any audio was audible and which output they were
listening through; that confirmation remains outstanding. Nothing was shared
with a room, and no note or marker was created.

### Viewport implementation

Source/connection and audio-recovery chrome now lives in NDI settings, not on
the program picture. Passive publication status and a centered unavailable
sequence-timecode readout sit above it. Timing availability and playback
ownership share a transport line, with no file Shortcuts hint. Preview keeps
the notes rail docked at narrow widths instead of inheriting Clip's overlay.
The existing decoder, local volume and file-timeline footprint are preserved.

Recovery is reported from the selected decoder to the actual settings dialog;
its button invokes that video's play action directly. Closing/reopening settings
retains the pending recovery. Guests can use local recovery without discovery,
capture, marker setup or publication controls. Switching a visible source is
not a side effect of opening its settings gear.

These source changes do not establish audible output on the editor's Mac or
verified Premiere sequence timecode. No application restart, Premiere playback,
pairing, real-room publication or audio-preference change is part of this batch.

Final source verification: `npm run verify` passed all gates, including 3,522
frontend tests (2 skipped), 471 Rust tests (21 ignored), 11 Swift tests, and
362 application browser cases. The browser suite includes the captured native
H.264/AAC fixture: pause → open settings → close/reopen → Enable program audio
resumes the same video. Layout tests cover both window sizes, enlarged text,
the centered readout, one-line timing/ownership, a docked rail, and clear picture.
Catalog checks passed 33 browser cases, 6 isolation checks and the production
exclusion build. Logs: `/private/tmp/sauce-clear-viewport-verify-final.log`,
`/private/tmp/sauce-clear-viewport-catalog.log`.

The NDI-enabled debug build succeeded after rebuilding only the generated
`objc2-foundation` cache (the first attempts reported a missing rlib). A separate
ad-hoc-signed app is staged at
`/private/tmp/sauce-clear-viewport-app.Lugtu6/Sauce Bunny.app`; strict deep
signature verification passes. Its signed executable SHA-256 is
`7d7b75bdf90091a52da2052886bca8de9c3fc63d5c846400d47c4209339de0d1`.
It has not been launched or installed. The previous test apps remain available;
no DMG was made. Final build log: `/private/tmp/sauce-clear-viewport-build-final.log`.

## September 8: source settings placement correction

NDI source selection now lives in a portal settings dialog, opened by the
utility gear directly beside Preview's single volume control. It is no longer
inserted into the shared Review / Transcript / AI Summary / Queue sidebar.
The existing source controller, program player and comment drafts are retained;
opening or closing settings does not publish, reconnect, or reset volume.
Marker setup and Reconnect picture are separated by 12px. The standalone
Preview paste/watch header has 12px padding and a 12px gap below it.

TypeScript, scoped ESLint, 39 focused component/style tests and 19 browser cases
passed, including both target window sizes, enlarged text, long source names,
focus return, preserved comment drafts, actual source callbacks, and synthetic
native-media decoding. These are production-source tests, not acceptance of
physical output or the currently running application. No application restart,
Premiere playback, pairing, room publication or audio-preference change was
performed for this correction. Earlier inline-inspector layout notes below
are historical and superseded by this placement.

The final full verification passed all gates: 3,519 frontend tests, 471 Rust
tests, 11 Swift tests, 362 application browser cases, TypeScript, lint, Clippy
and licenses. Catalog verification also passed its 33 browser cases and
production isolation. A closed settings dialog now removes its portal, while
its source-selection state remains mounted; this preserves existing modal
and keyboard behavior elsewhere in the application. Final logs:
`/private/tmp/sauce-ndi-settings-verify-final.log` and
`/private/tmp/sauce-ndi-settings-catalog.log`.

An NDI-enabled debug build containing this correction is staged at
`/private/tmp/sauce-ndi-settings-app.GnoCHA/Sauce Bunny.app`. Its ad-hoc signature
passes strict deep verification. It has not been launched or installed; the
running application and Premiere remain untouched. The previous buffer-only
test app is retained separately. Loading this corrected build requires the
editor's approval to restart Sauce Bunny; no Premiere restart is needed.

## September 8: native audio/buffer investigation

The private playback check is still **not accepted**: clicking Enable program
audio cleared its recovery prompt, but the editor reported silence. A separate
production-encoder probe decoded nonzero stereo AAC; that did not prove the
running WKWebView or physical output. The Mac's selected output was External
Headphones; the editor's actual listening device still needs confirmation.

Read-only Web Inspector checks then found the running player unmuted at volume
1 with an enabled audio track, but seeking in 30/30 samples (26 seek events in
six seconds). Receiver drop counters were zero. A separate read of the same
existing private stream received 60 complete media segments in six seconds.
Native SourceBuffer completion took up to 268 ms, exceeding the old nominal
200-ms queue. A temporary muted append-first decoder kept one continuous
buffer with no low-ready or seeking samples. All temporary decoders, property
wrappers, readers, and timers were removed; Premiere stayed parked and no media
was saved, room published, companion paired, or audio preference changed.

The source now drains queued media before catch-up seeks, retains up to eight
whole fragments (nominally 800 ms, at most 16 MiB), and uses a 300-ms local /
400-ms guest playback reserve. A pending seek in an older retained range is
not replaced just because a new disjoint range arrives. Decoded-buffer eviction,
the single media-element clock, volume state, and source/room ownership stay
unchanged. Unit/component coverage includes coalesced-burst drain order,
bounded overload, short-fragment warmup, and pending-seek retention.

**These source changes are not yet loaded in the running app.** Native moving
picture, stereo audibility, latency, and guest acceptance remain open. A muted
diagnostic and mocked component tests do not satisfy those gates. Evidence and
the pre-change verification log are in the local temporary directory
`/private/tmp/sauce-ndi-audio-check.M9nOkN/`.

The pre-change full verification failed on an unused `cp-premiere-help` style,
two browser cases (`card-unity` and returning-user Review setup), and a Rust
dependency rlib availability error. Do not call that baseline a passing build.
The Rust error cleared after rebuilding only the `objc2-foundation` and `iroh`
package caches: 471 tests passed, 20 ignored. After the buffering changes,
43 focused unit/component tests, TypeScript, focused lint, and all 11 NDI
browser cases passed, including the three opt-in native-capture cases. The
unused help styles have since been removed. The card test now measures the
adopted Finder caption wrapper, and the returning-user test checks hidden
onboarding access controls without changing invitation policy or acquiring
devices. It preserves initial StrictMode reads and verifies tab switches do
not reload grants or create invitations.

Full post-fix `npm run verify` passed: 3,519 frontend tests (2 skipped), 471 Rust
tests (20 ignored), 11 Swift tests, 355 browser tests (3 opt-in capture cases
skipped in this run), TypeScript, lint, Rust compile/strict Clippy, license,
packaging, and profiler checks. The three capture cases passed in the separate
11-case NDI run above. Logs are `verify-after-buffer-fix.log`,
`focused-cleanup.log` (32 component/style tests; its first browser attempt
exposed an incorrect exact-once StrictMode assertion), and
`browser-cleanup.log` (both corrected browser checks passed). These automated
checks do not establish native audibility or release acceptance.
A separate ad-hoc-signed debug test app is staged at
`/private/tmp/sauce-ndi-buffer-app.yyjKa2/Sauce Bunny.app`; its strict deep
signature check passed. It has not been launched. Restart and the next private
audio check await user approval; the running app was not overwritten.
The staged executable was rebuilt from the fully verified source, replaced
only in that temporary app, and its strict deep signature check passed again
(`build-verified-source.log`).

Current placement objective: **preserve Review's existing room UI**. Private
Premiere testing stays in a dialog, reached from the Host card before a session
or the existing source-sharing menu in a room. There is no standalone preview
page, additional source toolbar, or permanent diagnostic strip under the room
monitor. The newer three-choice onboarding/Library-link proposal is separate
from this restoration and has not been implemented.

## Review restoration, September 7

- The hook now exposes separate preview and room programs, telemetry, and
  decoded-picture callbacks. A candidate cannot take over the room monitor,
  pause the file transport, or block file-note composition. Publication must
  receive a frame confirmation from the room surface, not just the private one.
- Done hides but retains the prepared decoder; hidden previews are muted and
  no longer advertise an active modal. Cancel targets only the candidate.
  Closing a room-launched dialog restores focus to the stable Share trigger.
- The existing transport structure is retained for NDI, with Live instead of
  file timecode, disabled source-owned controls, an inactive timeline footprint,
  and program volume in the existing volume position. The main NDI monitor
  has no separate audio/diagnostic bar. File-review controls are unchanged.
- Stop sharing retains the last decoded element and stopped-source identity.
  It does not cancel a separate candidate or expose the underlying file.
  Cancelling the file picker no longer stops an active NDI publication.
- The obsolete PremiereProgramControls component and its screen-specific
  tests were removed; publication/cancellation checks now exercise the dialog.
  The pre-edit source snapshot is
  `/private/tmp/sauce-review-restore.8SfLpU/source-state.tgz` (temporary local
  recovery copy, not an off-machine backup or Git commit).
- The native captured fMP4 browser test has passed with the dialog-to-room
  handoff. This proves decoding, readiness, and explicit publication only,
  not Premiere-to-monitor latency or remote-guest behavior.
- Full verification passed after the restoration: 3,392 frontend tests
  (2 skipped), 324 browser tests including the native fMP4 capture, 429 Rust
  tests (19 ignored), TypeScript, lint, Rust compile/strict all-target Clippy,
  Swift build/11 tests, license checks, and packaging/profiling unit checks.
- An isolated `44c9565` source archive and the restored frontend were rendered
  with the same fixture at 1100×700 and 1680×1020, ordinary and theater modes.
  People, room header, monitor, transport, timeline, and notes-drawer bounding
  boxes match exactly in all four combinations. Screenshots and JSON evidence:
  `/private/tmp/sauce-review-baseline.ZsaedF/`. This is geometry evidence, not
  a claim that every pixel or media state is identical.
- Browser tests also preserve a draft file note and the room geometry while
  opening, testing, closing, and revisiting private NDI. The note can be posted
  afterwards. The fixture's file media does not actually play, so this does
  not prove uninterrupted moving picture/audio or remote-guest delivery.
- The inherited minimum-width room transport can clip its rightmost controls.
  The pre-NDI layout has the same issue. This restoration did not change the
  panel widths or introduce a responsive room redesign. The theater geometry
  check enters theater at desktop width before resizing to the minimum.
- Follow-up reproduced three publication-supersession failures. A queued or
  in-flight share invalidated by leaving/changing the room must reject, not
  resolve successfully and trigger the dialog's commit callbacks. Exact old
  leases are still revoked; the new room's error state is not overwritten.
  All three red probes now pass, including invalidation during receiver cleanup.
- The inactive Live timeline now retains the measured file-timeline height
  (including its taller filmstrip/waveform state), ignoring hidden zero-size
  measurements. Unit and real native-capture browser assertions cover this.
- A stronger browser test imports the actual native H.264/AAC capture through
  MediaBunny's byte-range file source and verifies changing canvas pixels before
  and during private NDI decoding, plus mounted-player identity and continued
  playback after Done. It initially exposed an unsupported hardware-preference
  configuration despite a successful default canDecode() probe. The player now
  checks its exact optional decoder configuration and retains MediaBunny's
  defaults when those preferences are unavailable; the moving-picture test
  passes without FFmpeg preparation. This is browser picture-continuity evidence,
  not audible A/V or remote-guest verification.
- The restored debug app was rebuilt and opened against actual Premiere.
  The existing 720×1280/24-fps source decoded privately, with monitoring muted.
  Done, Clip/Review navigation, and reopening the dialog retained its parked
  picture and receiver. The installer download action is available inside the
  dialog; no installer was run and no room/source was published. This short
  check is not a moving-picture latency or stereo acceptance result.
- Final source verification after the publication, timeline, and decoder fixes:
  3,401 frontend tests passed (2 skipped), all 325 browser tests passed including
  both actual-capture checks, 429 SDK-free Rust tests passed (19 ignored), and
  TypeScript, lint, strict Clippy, Swift build/11 tests, dependency-license,
  package-verifier, and profiler checks passed. Full log:
  `/private/tmp/sauce-review-native.o1BjPG/verify-final.log`.
- The SDK-enabled Rust rerun also passed: 429 tests, 20 ignored. The local
  debug app was rebuilt again at 12:20:58 PDT with the final frontend fixes;
  both bundle and packaged-asset verification passed. It was reopened and
  decoded the actual Premiere portrait picture in the private dialog, muted
  and not shared. Logs are `build-final.log`, `bundle-final.log`,
  `packaged-final.log`, and `rust-sdk-final.log` in the same temporary evidence
  directory. Ad-hoc signing remains local-only, not distribution approval.
- Remaining verification: private replacement while a real multi-user room
  is playing, guest continuity/handoff, and measured Premiere end-to-end delay.
  A separate calibration project requires the user's approval; their existing
  Premiere project and sequences have not been edited. No new DMG has been
  produced, and the complete objective remains open.

### File-return follow-up

- A real-capture browser probe reproduced hidden file marks being copied into
  the NDI review pass on publication. Frame-mark persistence now follows the
  underlying media identity, independently of the live review's note identity.
  Existing saved entries are not deleted or migrated.
- The same probe then reproduced lost marks when the room's File picker chose
  the already-mounted file: the redundant import reset its state. An explicit
  return to that loaded file now stops NDI and reuses the file player; choosing
  a different file still imports normally. A source change during the stop
  await supersedes the old selection.
- The browser test verifies actual caption text and frame-mark values before
  publication, no file captions/marks in Live mode, unchanged mark storage,
  an inactive timeline with the loaded filmstrip's footprint, last-picture mode
  after Stop sharing, and restored captions/marks/controls plus changing canvas
  pixels after an explicit return. A mounted-element canary proves the file
  decoder was retained. Cancelling the file picker must not invoke native stop
  or unpublish.
- These are browser tests with mocked room IPC and real captured media. They
  do not establish actual remote continuity, audible stereo, or measured
  Premiere latency; those external acceptance gates remain open.
- Full post-fix verification passed: 3,401 frontend tests (2 skipped), all 326
  browser tests, 429 SDK-free Rust tests (19 ignored), TypeScript/lint/Clippy,
  Swift build/11 tests, licensing, packaging and profiler checks. Evidence:
  `/private/tmp/sauce-review-native.o1BjPG/verify-return-file.log`.
- The local debug app was rebuilt at 12:29:01 PDT and both bundle/packaged
  verifiers passed (`build-return-file.log`, `bundle-return-file.log`, and
  `packaged-return-file.log` in the same evidence directory). It starts
  responsively and again displays the actual 720×1280 Premiere picture in
  the private dialog, with program audio muted and no room publication.
  This is still an ad-hoc-signed local app, not a DMG or distribution build.

## Implemented

- Native registry: two scoped sessions, worker capacity retained until actual
  teardown, independent cancellation, room-generation binding.
- Explicit host publication leases keyed by source, room generation, presenter
  epoch, and immutable publication revision. Private IDs are refused by the
  peer media route. Revocation wakes readers and cancels queued network writes.
- Shared native runtime lifetime across discovery/receivers. Connection count,
  input fps, measured output fps, audio drops; no invented sequence timecode.
- Generated preflight/session/telemetry bindings. Packaged runtime resolution
  never falls back to SDK, environment, or Tools. Developer overrides remain
  available only to unbundled developer builds.
- Standard-runtime staging: pinned checksums/version, vendor signature check,
  component terms/vendor notices, generated Tauri framework configuration.
  Only runtime and vendor notices are copied from the SDK, not Tools/plugin/SDK.
- Build/package verifiers now require bundled runtime/bridge/notices/signature
  and prohibit proprietary SDK/Tools payloads and external library dependencies.
- Installer/vendor links in the existing connection panel and new Settings →
  Integrations → Premiere, plus About attribution. Setup rechecks on return
  from installation, and does not call plugin presence a working picture.
- App-level coordinator with independent candidate/published identities,
  serialized mutation intents, decoded-picture plus encoded-media readiness,
  scoped cancellation, and native-authorized publication. Preview never
  publishes, changes the room document, or stops the old file/web/program feed.
- One native publication commit announces the new source. Late-join welcomes
  use the committed native source, not a stale frontend snapshot. Unpublish
  retains a stopped source descriptor and local preview; private media stays
  unauthorized even for a late join.
- Connect Premiere dialog: installation evidence, opt-in, explicit source
  selection, private Preview, Share Premiere with room, Cancel, and Done.
  The Host card opens this dialog before a room exists; the source-sharing
  menu opens it in a room. Neither entry starts or publishes a receiver.
  Clip shows neither NDI picture nor connection controls. Navigating away keeps
  the receiver/decoder mounted; returning to Review resumes the same monitor.
  Review keyboard navigation focuses the visible preview, not the hidden lobby.
- Mounted decoder handoff retains the actual last video element until the
  replacement decodes; stale attempts cannot paint. Separate program mute,
  volume, stereo meters, collapsed diagnostics, and no file seek controls.
- Notes and drawing are blocked only for an unconfirmed new room picture,
  not for a private candidate. Incoming room notes continue syncing. Logical review
  identity and named sequence/pass survive receiver restarts and panel remounts.
  General/manual timing never uses the hidden file's clock.
- Detached seek/range/queue-range actions and clock heartbeats carry source
  identity. Stale or unscoped actions are rejected with a visible notice; NDI
  suppresses the hidden file clock and file-range controls.
- Fixed a real Premiere startup regression: Mercury Transmit can initially
  send an 8×8 blank frame. It no longer defines the fixed encoder raster;
  startup waits for a usable picture. Later blank frames still render using
  the established output dimensions, with audio intact.
- Fixed an independently reproduced application-startup blocker: the saved
  transcript-folder listing performed filesystem I/O on the main macOS thread.
  It now uses the blocking worker pool. A stalled/cloud-backed folder no longer
  freezes the connection UI; paths, files, and successful listing results are
  unchanged.
- Media-element decoder errors now revoke preview readiness and expose a
  reconnect action without discarding the retained picture. A late loadeddata
  event from a failed attempt cannot silently re-enable publication.
- Covered file actions are inert and absent from the accessibility tree while
  Premiere owns the monitor. The underlying published player remains mounted
  and is not hidden or paused; program controls and feedback remain accessible.
- Reduced native fragment/keyframe cadence from 500 ms to 100 ms. Local MSE
  catch-up now targets a 100 ms reserve above a 250 ms backlog; guests retain
  a 180 ms reserve with a 450 ms catch-up threshold. Recovery avoids the leading
  audio/video boundary and does not supersede an in-range outstanding seek.
  These are buffer settings, not measured Premiere-to-monitor delay.

## Earlier implementation evidence (before the restoration follow-up above)

- Earlier full frontend: 3,386 passed, 2 skipped. TypeScript/build and lint passed.
- Earlier full Chromium suite: 322 passed, including native synthetic fMP4 decoding, minimum
  1100×700 connection-panel layout, Escape/focus restoration, detached-panel
  layout, explicit publication, audio opt-in, persistent monitor identity, and
  the Review-lobby connection shortcut without creating a room.
  An intermediate run had 321 pass / 1 native-capture failure and was not a
  clean gate. The updated NDI browser suite also passed 40/40 repetitions
  across six workers after Review relocation and the short-fragment changes.
  After moving drawings/reactions into the same Review-only layer, all four
  focused NDI browser checks, build and lint passed again.
  Native fMP4 decoding uses an actual open loopback HTTP stream with a backlog
  burst followed by continuing 100 ms delivery; explicit
  EOF revokes publication readiness, retains the old video, and requires a
  decoded replacement before enabling Share again.
  A finite all-at-once capture can leave too few frames after coalescing to
  complete startup, so it is not used as evidence for a continuing source.
  Browser-test HMR is disabled: trace evidence also caught a development reload
  interrupting a test. Normal development hot refresh remains unchanged.
- Post-fix SDK-free Rust suite: 429 passed, 19 ignored. SDK-enabled: 429 passed,
  20 ignored. Used isolated `CARGO_TARGET_DIR` after the Desktop build cache
  failed to link a required rlib; no existing build artifacts were deleted.
  Strict all-target Clippy passes after clarifying two independent reader
  conditionals. The dependency-license check also passes.
- 21 staging/package-verifier tests passed. Positive/negative fixtures cover
  terms/notices/provenance, forbidden SDK/Tools/plugin payloads, external runtime
  symlinks/dependencies, signature failure, wrong build, and absent bridge.
- Three read-only process-profiler unit tests passed. The opt-in profiler
  distinguishes RSS from physical footprint, checks PID/start identity, and
  records sample gaps rather than declaring a soak passed automatically.
- Generated and probed seven 1080p Premiere calibration movies covering the
  six exact frame rates, synchronized flash/beep with a large frame counter,
  and alternating left/right stereo. These are input fixtures, not Premiere
  validation results. See [the acceptance runbook](NDI-MEDIA-ACCEPTANCE.md).
- Synthetic dual-receiver/concurrent-discovery harness passed after the
  placeholder and portrait-format cases were added: 24 main segments, 4 private
  segments, four-second sender stall/recovery, zero reported video/audio drops.
  Both encoded files probe as 1920×1080 H.264 plus stereo 48-kHz AAC, despite an
  initial 8×8 frame and a later 720×1280 input. Artifacts:
  `/private/tmp/sauce-ndi-test.B2psbt/program.mp4` and its `.preview.mp4` sibling.
- The extended native harness passes all six input rates: 24000/1001, 24, 25,
  30000/1001, 30, and 60. Each run checks input-rate telemetry, the 30-fps encoded
  timestamp cadence, fixed 1920×1080 output with stereo 48-kHz AAC, initial
  placeholder deferral, concurrent receiver/discovery teardown, and a four-second
  stall/recovery. The generator now paces audio at exactly 48 kHz for each input
  rate. These synthetic checks do not satisfy the actual Premiere matrix.
  After changing to 100 ms fragments, the 30-fps synthetic run passed with 122
  main / 22 preview segments, four-second stall/recovery, and zero reported
  video/audio drops. Capture: `/private/tmp/sauce-ndi-test.fBzjha/program.mp4`.
  The remaining five input rates subsequently passed at the new fragment
  interval as well, including the 60-fps input / 30-fps output cap.
- The debug .app's bundle-content checks passed: approved standard runtime,
  both runtime architecture UUIDs, vendor notices/component terms, native
  bridge, no launch-time NDI linkage, privacy/Bonjour keys, existing sidecars,
  CSP and restricted asset scope. Ad-hoc signing is local-only: this is not
  Developer-ID/notarized distribution evidence or installed-DMG verification.
- Runtime and SDK installer signatures pass outside the sandbox; the installer
  is trusted by Apple notarization. Sandboxed signature checks reported invalid
  signatures due to inaccessible macOS trust services. Never waive the checks;
  use the approved unsandboxed verification path.
- User screenshot confirms Premiere 2026 → Video Monitor picture. The old
  prototype document's contrary discovery blocker is obsolete.
- Actual Sauce Bunny/WKWebView discovers `GASPERS-MAC-STUDIO.LOCAL (Adobe
  Premiere Pro)` using the included runtime. Private preview and default-muted
  monitoring work. The first attempt received 8×8 blank output, then 720×1280
  picture after moving Premiere's playhead, exposing the tiny-raster blur bug.
  A native stack sample traced the follow-up UI hang to the transcript-folder
  read, not NDI. After that fix, the rebuilt app starts responsively and shows
  a clear, correctly framed real 720×1280 Premiere picture at 24 fps. Input is
  correctly identified as connected/parked, monitoring remains muted, and the
  private preview survives navigating to Review setup and back. The short
  check showed zero reported video/audio drops, approximately 2.4 Mbps output,
  and a 30-fps output cadence. These are not latency or long-run measurements.

Current local test application (ad-hoc signed, not a DMG or distributable build):

`/private/tmp/sauce-build-validation.Fg4QG6/debug/bundle/macos/Sauce Bunny.app`

The 30-minute parked-source baseline completed (1,801 seconds), on the previous
build and real 720×1280/24-fps private input. After the five-minute warm-up, native
physical footprint was 194.2→197.8 MiB; WebContent was 149.8→185.5 MiB with a
140.9 MiB low. RSS varied widely with paging and is not a leak verdict. The
measurement included competing build/test work and does not establish moving
1080p, dual-source, A/V or end-to-end latency acceptance. Evidence:
the local `sauce-ndi-profile-IJ4a8U/summary.json` diagnostic artifact.

The local app was rebuilt and reopened with the Review placement and reduced-delay
settings. Actual WKWebView preview shows the existing 720×1280/24-fps Premiere
source, host audio muted, 30-fps output, and zero reported NDI/encoder/audio drops
in this short check. The displayed playback buffer was 0.10 s on repeated reads,
compared with observed 0.15–1.15 s values in the old instance. This comparison is
not measured end-to-end latency. No Premiere project or sequence was edited.

That earlier placement put the private connection panel in Review's monitor
beside the notes rail. It has since been replaced by the accepted dialog-only
restoration described above. Neither check created a room or published a source.

## Remaining required implementation

1. Extend the real Premiere/WKWebView picture proof to playback, stereo audio,
   all required frame rates, stalls/restarts and timing measurements. A parked
   frame or synthetic/browser mocks do not satisfy the full acceptance gate.
2. Complete a real second-desktop guest test without external NDI installation;
   availability of that second Mac has been requested from the user.
3. Profile local/remote delays, A/V offset, 30-minute memory, concurrent preview,
   reconnects and constrained-network priority. Do not infer those from buffer
   length, an isolated successful frame, or unit-test counts.
4. Keep NDI experimental. Only after the real host/guest gates pass, build and
   verify the internal DMG and repeat the installed-application checks.

## Unproven delivery gates

- Actual Premiere 2026 in Sauce Bunny/WKWebView: 23.976/24/25/29.97/30 and 60-fps
  cap; scrubbing, parking, sequence changes, backgrounding, restart, stereo,
  input loss/recovery, persistent monitor, camera/microphone continuity.
- Host delay ≤1.25 s, A/V offset ≤80 ms, steady drops <1%, 50 mixed operations,
  memory stabilization over 30 minutes, including concurrent preview/sharing.
- Real second desktop guest without SDK/Tools: delay <2 s on ≥10 Mbps upload
  and ~50 ms RTT; constrained bandwidth/background transfer, durable comments,
  late join/reconnect/handoff/leave/publication revocation.
- Complete frontend/Rust/browser/SDK-enabled/SDK-free suites after all changes.
- Only then build the internal DMG, verify final privacy/signature/sidecar/CSP/
  license/runtime checks, install it and repeat media/navigation checks.
- No public/pilot-ready claim before the later 2–4-user one-hour network soak.

Preserve dirty worktree and persisted documents. No custom Premiere plugin,
automatic verified timecode, Premiere transport/marker insertion, approval flow,
destructive migration, or unrelated reset.
