# Embedded OBS application capture

Status: implementation in progress; not a shipped or verified Avid integration.

The dated checkpoints below retain their historical test results. Statements
about unregistered commands or pending controls describe those checkpoints,
not the current renderer integration summarized here. Internal test packaging
is separate from public distribution approval.

## Preview integration · 2026-09-12

The user explicitly requested minimal implementation inside the existing
Preview, without the earlier Impeccable design approval process. That UI pause
is superseded. Source now exposes application/window selection and optional
crop in the existing gear popup beside volume. No new sidebar, viewport layer,
player or audio control was added. Opening, refreshing or closing settings
does not start capture or broadcasting.

The existing Preview coordinator accepts exact application/PID/window/crop
identity and restores it from native status. Capture passes use separate opaque
review identities; private selection metadata is not added to room messages.
Capture cannot bind itself as a Premiere companion source. Room sharing keeps
the existing decoded/encoded readiness and explicit publication gate.

Broadcast to NDI is a separate settings action. A bounded native registry owns
the sender across popup closure, while a renderer intent counter permits Stop
during startup and rejects delayed/stale starts or stops. No raw pipe identifier
or private path is returned to the renderer. Polling is read-only, serialized,
and does not override a pending explicit action.

This connects the production controls; it does not close the packaged
WKWebView, audible live Avid/other-app, room receiver or external NDI receiver
acceptance gates below. No DMG, install, GitHub push or distribution occurred.

Final automated verification passed on this source: 3,762 frontend tests, 624
Rust tests, three service API tests and 371 application browser cases, plus
TypeScript, lint, Clippy, Swift, capture configuration, packaging, sender and
license gates. The catalog passed 33 browser cases and production exclusion
(65 artifacts). Existing skips remain. Logs:
`/private/tmp/sauce-obs-preview-full-verify-final.log` and
`/private/tmp/sauce-obs-preview-catalog.log`.

The 22 new component tests and six new browser cases cover explicit discovery,
exact window/crop selection, disappearance, startup cancellation, stale replies,
retained drafts and 1100/1680px at normal/125% text. The replacement test exposed
and now protects against stale source initialization and duplicate sibling
keys. These tests use mocked IPC, not a real capture or network broadcast.

## Approved direction

The user explicitly chose **Embed OBS's GPL engine** rather than extending the
existing native capture engine. End users must not need to install or launch
OBS. This is an application-picture/audio fallback for editors that do not
provide usable native NDI output, initially Avid on Apple Silicon macOS.

## Architecture and delivery plan

1. Bundle a dedicated GPL helper using pinned libobs, its graphics backend,
   macOS capture module and the required output dependencies. Do not load
   arbitrary user OBS plugins or settings, and do not embed Qt or Chromium.
   The initial probe tests this boundary before any production capture changes.
2. Select the exact application/window, hide the cursor, crop the viewer, and
   isolate that application's audio. Missing/closed windows fail explicitly;
   never silently fall back to capturing the desktop or all system audio.
3. Feed timestamped picture and audio into the existing Preview/review flow.
   Use one audible program monitor and preserve the microphone/camera path.
   Integrate controls into the existing gear/settings surface, not the
   commenting sidebar or over the picture. Preview remains private until
   explicitly shared with the room.
4. Support the requested capture-to-NDI use case without depending on Avid's
   NDI plugin. NDI broadcasting must be explicit and distinct from room sharing.
   Resolve the NDI SDK/GPL distribution boundary before shipping that output;
   neither an open-source repo nor a subprocess is a blanket license exemption.
5. Bundle self-contained, consistently signed binaries. No runtime dependency
   on /Applications/OBS.app, Homebrew, developer SDK folders, or a checkout.
   Publishable packaging requires the applicable license texts, corresponding
   source/build materials and dependency notices. The original implementation
   task did not authorize publication; a local internal test image does not
   establish distribution clearance.

## Licensing

Original Sauce Bunny source retains its MIT notices. The new OBS-linked helper
is GPL-2.0-or-later, with its own license boundary and corresponding-source
materials. The overall distribution must accurately identify all components;
it must not describe OBS-derived code as MIT. Review the final combination and
all runtime terms before distribution, including libobs's FFmpeg dependencies
and NDI's separate SDK license. No NDI Tools application is redistributed.

Initial upstream engine: OBS Studio 32.2.2, peeled tag commit
`ba2f32bdf791005443988a4955e963663e16b1ed`.
Source archive SHA-256:
`9a33756d87ce6831c6ddae8b6ea92c86b6cf61c693c9511a716673ba3a3caa5b`.

## Acceptance gates (all required)

- Reproducible pinned helper bundle and complete dependency/license inventory.
- Real embedded libobs initialization, graphics, capture and A/V output; an
  installed OBS application is not used at runtime.
- Explicit Avid window selection, viewer crop, correct aspect/raster, cursor
  hiding, isolated stereo audio and no microphone/room-audio feedback.
- Exact-source failure on missing window, revoked permission, source closure,
  resize, display changes and restart; cancellation leaves no child processes.
- No timeline edits. No claim of authoritative sequence timecode or markers.
- Local preview, explicit room sharing and explicit NDI broadcast have distinct
  lifecycles. No capture starts merely by opening settings or listing sources.
- One active clock/audio path; bounded queues; startup, long-run cadence,
  lip-sync, stalls and recovery measured on real media.
- Existing NDI/Premiere, file playback, sharing, recording and commenting tests
  remain green. New lifecycle and UI tests cover failures and stale callbacks.
- Packaged WKWebView verification on Avid plus another permitted application,
  including operation without OBS/Homebrew installed. Synthetic tests are
  supporting evidence, not a substitute for this gate.

## Evidence so far

- Clean baseline at `c4a778e`; full `npm run verify` passed before changes,
  including 365 browser tests (4 intentionally skipped).
- The first probes used separate modules from an intact official OBS 32.2.2
  bundle, verified against publisher `2MMRE5MTB8`. The current build no longer
  copies that app: libobs, OpenGL and obs-ffmpeg are built from pinned source.
- Private libobs core proof passed; capture and FFmpeg source/output modules
  registered without launching OBS or loading its UI/user plugins. The current
  helper uses OBS's stable OpenGL backend, not the experimental Metal backend.
- Generated-media integration proof passed: H.264 Main Level 4.0, no B-frames,
  48 kHz stereo AAC, 79 independent three-frame fragments in an eight-second
  test. Every fragment with picture began with a keyframe; packet timestamps
  were contiguous. Distinct 440/660 Hz channels survived with no silent 100 ms
  intervals in the measured five-second audio sample. A/V end-time difference
  was 46.7 ms in the corrected conversion run. This is not an end-to-end latency
  measurement.
- Live capture exposed a configuration bug in the initial helper: NV12 output
  without `gpu_conversion=true` supplied RGB bytes with the wrong interpretation.
  Both renderers were affected, and the initial nonblank-image assertion missed
  it. The helper now enables conversion, and the regression gate compares decoded
  output against decoded source frames. The old corrupted fixture measured
  121.9 mean absolute pixel error and is rejected (threshold 12); the corrected
  output measured 10.8 and was also visually inspected. A trial capture-format
  change did not fix this and was removed.
- Mach-O load commands across the private bundle contained no installed OBS,
  Homebrew, Qt or Chromium paths. This is a dependency check, not a substitute
  for a clean-machine release test or a complete corresponding-source package.
- Exact window/PID/application matching and inward-rounded crop/raster guards
  are tested by `npm run test:obs-capture`, now included in `npm run verify`.
  The complete suite passed after the live-capture fixes: 3,696 frontend unit
  tests, 504 Rust tests, the Swift/native configuration gates, and 365 browser
  tests (existing skips retained). The final native bundle also passed the
  decoded-image/audio gate: 78 independent fragments, 32.0 ms A/V end-time
  difference, and 10.9 image error against the generated source.
- After the user brought Composer onto the visible display, exact-window Avid
  capture passed. Decoded frames match the Composer picture; an inward-rounded
  crop produced a 1236×702 viewer-only frame with no surrounding controls.
  A separate eight-second playback capture contained non-silent stereo audio
  (RMS 0.0146/0.0156), 235 H.264 frames, 79 keyframes, contiguous A/V packet
  timestamps, and a 68.0 ms end-time difference. Avid was paused again afterward;
  no project or timeline edits were made. This does not yet establish isolated
  audio under competing applications, sustained sync, or audible WKWebView output.
- Hidden/other-Space capture remains disabled. Discovery still requires the
  explicitly selected visible window; lifetime checks also reject a window that
  goes off-screen. The pinned OBS module is rebuilt with child-window inclusion
  disabled. No broader permission was granted or requested.
- The supervised helper now feeds the application's existing bounded Program
  ring through a strict fMP4 adapter. A generated-media test ran for twelve
  seconds with no consumer: 109 fragments were produced, only eight were
  retained (616 KB in that run), and a late reader received initialization plus
  a complete current fragment. Explicit stop then completed. The old finite
  proof deadline does not limit the continuous worker.
- Real libobs lifetime tests passed using generated media: explicit stop and
  stdin EOF completed in 111/127 ms; heartbeat expiry stopped output in about
  two seconds; owner death stopped it in 204 ms. With an intentionally undrained
  output pipe, the independent watchdog exited in 4.85 seconds after heartbeats
  stopped. These are local test measurements, not platform-wide guarantees.
- The shared output refactor retained correct decoded picture/stereo audio:
  78 independent fragments, 13.4 ms A/V end-time difference, and 10.8 image
  error against the generated source. Source privacy checks are unchanged.
- The new backend service validates exact window/PID/application and crop,
  sanitizes/bounds diagnostics, enforces startup/media deadlines, and retains
  worker capacity until teardown finishes. It uses the existing private/shared
  registry and revocable peer publication mechanism; starting capture does not
  create a room publication or NDI sender. A native Rust service API supports
  integration testing without exposing unused renderer commands. At this
  checkpoint those commands were unregistered; the Preview integration above
  subsequently connected them. Existing Premiere/NDI behavior was preserved.
- The supervisor also compares reported encoder frame count with delivered
  three-frame fragments. More than 90 queued frames stops capture, so trickling
  output cannot keep an ever-growing encoder queue alive by evading the normal
  four-second no-progress timeout. The native watcher reports once per second;
  this is a fail-closed lag bound, not frame-accurate latency measurement.
- A follow-up one-minute generated-media run passed with that lag guard active:
  589 fragments produced, exactly eight retained (612 KB), and successful late
  reader/stop. The full verification suite passed (3,696 frontend tests, 518
  Rust unit tests, two native-service API tests, Swift/configuration/license
  gates, and 365 browser tests). After the final lag guard, all Rust tests were
  rerun with 519 passing, plus clean clippy and the IPC/no-panic contract tests.
- The global-input audit found that upstream libobs creates a keyboard event
  tap when pre-existing access is available, even without configured shortcuts.
  The private core now compiles out that listener and mouse-state polling, with
  recorded source patches. A linked-symbol gate rejects the original upstream
  binary, and the helper checks its private version before startup. No Input
  Monitoring permission was granted or reset.
- The source-built runtime (`32.2.2-sauce-capture1`) passed decoded-picture,
  stereo continuity and all five owner/shutdown cases. A subsequent internally
  signed bundle passed again: all 24 Mach-O components verified under one Apple
  Development team with hardened runtime; 79 independent fragments, 46.7 ms
  A/V end-time difference and 10.8 decoded-image error. Explicit stop/EOF took
  about 125 ms, owner death 102 ms, and the blocked-pipe watchdog exited in
  4.87 seconds. No user screen/media was captured in these generated-fixture runs.
- A one-minute test of that signed runtime through the actual Rust supervisor
  produced 589 fragments, retained exactly eight (596 KB), and passed late-read
  and stop checks. This is not an audible WKWebView or live-room test.
- Build-time dependency inspection now resolves every non-system library and
  search path inside the private bundle, rejects unexpected plugin executables
  and NDI linkage, and records binary hashes. The pinned OBS dependency archive's
  supplied license collection is retained. Complete static-dependency attribution
  and corresponding-source packaging remain release gates.
- A clean follow-up build used only the two pinned local archives, with HTTP
  proxy access deliberately unavailable. The private CMake path no longer runs
  OBS's dependency downloader or changes quarantine attributes. Its final signed
  bundle again passed decoded picture/stereo and all five shutdown scenarios.
  The supplied dependency tree provides both runtime libraries and SIMDe headers;
  no separate unverified header checkout is needed.
- The complete suite passed after the source-build/signing changes: 3,696
  frontend tests, 519 Rust unit tests, two native-service API tests, four runtime
  dependency-audit tests, native geometry/Swift/license gates, and 365 browser
  tests (existing skips retained). The initial Node/Vitest collection conflict
  was corrected; the final `npm run verify` completed with all gates green.
- The final offline-built, internally signed runtime was also retested against
  the user's visible Avid Composer window. A paused full-window sample showed
  the correct picture and silence. An eight-second playing, viewer-only sample
  produced 1236×702 H.264 and non-silent 48 kHz stereo AAC, with 235 video frames,
  79 keyframes, no backwards packet timestamps and no gaps above one-microsecond
  timestamp rounding. A/V end-time difference was 68.0 ms. The decoded crop was
  visually inspected, and Avid was paused afterward without project/timeline
  edits. This verifies the source-built signed capture path, not audible
  WKWebView playback, competing-application audio isolation or NDI broadcast.

## Engineering checkpoint limitations

The source-loss audit found that ScreenCaptureKit failure can leave OBS's last
texture renderable while the encoder continues. The private capture module now
exposes a versioned, passive, atomic failure latch. The helper checks it during
startup and capture; the Rust supervisor revokes readiness before draining stale
encoder output. The native synthetic callback test fails against the earlier
module and passes for user-stop, missing-source and internal-error callbacks;
unit tests preserve the specific failure, reject late Live records and verify
immediate readiness revocation even when worker cleanup takes longer.

The updated signed bundle (25 inventoried Mach-O components, including the new
no-capture test executable) passed generated picture/stereo and all five owner
shutdown cases. It produced 79 independent fragments, first bytes in 868 ms,
25.4 ms A/V end-time difference, and 7.6 decoded-image error. These are local
test results, not end-to-end latency or a performance guarantee under load.
Concurrent browser/native verification initially exceeded the unchanged native
startup limits; isolated reruns passed. The image oracle now compares every
frame of the bounded five-second generated reference instead of sampling at
4 fps, which could miss the matching frame. The error threshold remains 12.
An existing detached-panel geometry test also compared two separately awaited
layouts; its measurements now occur in one browser evaluation. An intentional
four-pixel overlap still failed the repaired assertion and was removed.
The final full run passed: 3,696 frontend tests, 521 Rust unit tests, two
native-service API tests, native/Swift/license checks and 365 browser tests
(existing skips retained). The signed module also passed another real,
stationary Avid viewer capture at 1236×702; the decoded crop was inspected.
That stationary sample was silent and does not establish audio isolation or
sustained playback performance. No Avid transport or project state was changed
for that follow-up check.

An additional signed, native source-lifetime gate now uses only a disposable
generated-picture application, not Avid or another user window. Moving the same
visible window preserved media output. Resizing, hiding, closing and quitting
the exact source each stopped capture with `sourceValid:false` and exit 5;
the final run measured 267, 439, 439 and 188 ms respectively from the test
command to helper exit. No process was force-killed on the passing paths.
The test also failed as expected when a temporary fixture mutation reported
"resized" without changing the window; that mutation was removed and all five
cases passed again. The gate verifies the private load graph and one hardened
runtime signing team, drains/discards captured media, and reaps owned children
on both success and assertion failure. It does not change capture permission
or broadcast anything. The pure identity/crop and four dependency-audit tests
also passed. Production capture code did not change for this test addition;
the full-suite result above remains the latest full run.

These measurements establish native fail-closed behavior for the tested source
transitions, not automatic crop recovery or a seamless production UI restart.
Display migration, actual permission revocation and packaged monitoring still
require their own checks.

A generated two-application audio-isolation gate now passes with the same signed
runtime. Both apps play distinct quiet stereo tones throughout two sequential
eight-second captures; each is the positive control for the other's excluded
audio. Five decoded seconds per capture passed every 100 ms block with the
correct channels, minimum wanted amplitude 0.00994 and maximum unwanted-tone
amplitude below 0.00000182. Both source clocks advanced by over 430,000 samples
during each capture. The unchanged thresholds require wanted amplitude above
0.004 and unwanted below 0.0003; synthetic combined mixes, swapped channels,
silence, one-block dropouts and invalid PCM are rejected. This is real native
application capture using generated audio, not an audible WKWebView test.

The fixture originally used direct child execution. Despite distinct window
bundle IDs, both apps' tones appeared in both captures. Launching the fixture
apps through LaunchServices isolated their audio without a production capture
change. This is evidence that launch/OS audio attribution matters, not proof
that filtering by a window gives process-level isolation in every application.
Apple documents window-filter audio as containing the owning application's
audio, including its other windows. Actual Avid under competing audio, helper
processes and final app monitoring still need testing.

**Unresolved lifecycle finding:** when two capture helpers overlapped, stopping
the first was followed by ScreenCaptureKit error -3805 (application connection
interrupted) and a fail-closed stop in the other. The cause is not established.
The sequential audio gate must not be used as evidence that simultaneous
private/room capture or source replacement is safe. Resolve and regression-test
this behavior before wiring a production lifecycle that overlaps helpers.
The retained `verify-obs-audio-isolation.mjs --overlap` mode reproduced that
failure again with properly launched fixture apps; it remains an explicit
failing manual acceptance check, not a waived invariant. All generated apps
and capture workers were reaped. The shared-fixture refactor also retained all
five passing native window-lifetime cases. The frontend/package suite passed
with 3,710 Vitest tests (two existing skips), 21 NDI packaging tests and three
profiling tests, followed by clean typecheck, lint and whitespace checks. These
additions change the test harness only, not production capture behavior.

The overlap investigation now has a narrower result. A signed diagnostic using
ScreenCaptureKit directly reproduced the interruption across processes, but
two streams in one process survived first-stream shutdown. Keeping the first
process alive postponed interruption of the second until process exit; waiting
for its stop-completion callback did not prevent the separate-process failure.
These are measurements on the current Mac, not a universal Apple API claim.

The private helper now has a reusable `ProgramOutput`: each program owns an
independent OBS canvas and an exclusively reserved stereo mix, with no native
audio monitoring. Existing single-program workers use that same component.
The signed shared-engine regression passed with two generated source apps:
the second output advanced another 121 frames after the first source's teardown,
continued delivering encoded bytes, and retained contiguous A/V timestamps.
Five decoded seconds from the first output and eight from the second passed
the unchanged per-100-ms tone oracle, including the post-teardown period.
Maximum unwanted-tone amplitude was below 0.00000161. All 26 private runtime
components were signed under one hardened Apple Development team.

The Rust start path now uses one owned `capture-service` engine with independent
program slots, bounded per-program delivery and cancellation. It retains slot
capacity until native teardown acknowledgement and prevents a replacement
engine from starting while an old helper is being reaped. Wire records carry
slot/generation identities; stale media, status and stop acknowledgements are
ignored. Removing that generation guard made its regression test fail; the
guard was restored. A deliberately unresponsive helper test also passed bounded
kill/reap and restart exclusion. The original single-program worker remains
test-only. Renderer commands were unregistered at this checkpoint and are now
connected through the Preview controls described above.

The signed 27-component runtime passed the actual Rust supervisor/Program-reader
gate with two generated applications. The first capture stopped, its slot was
reused with a new generation and a 600×352 crop, and the surviving 1200×704
capture delivered 82 further fragments. All three recordings retained
contiguous A/V packet timestamps. Five, eleven and six interior decoded seconds
respectively passed the existing per-100-ms stereo oracle: minimum wanted tone
was 0.00783 and maximum unwanted tone 0.000113 (limits 0.004 and 0.0003).
The surviving ring retained exactly eight fragments; every program stopped and
the shared helper was reaped. The initial run's replacement recording was too
short for the five-second audio oracle, so only the test duration was extended;
audio thresholds were not changed. No user application/media was captured.
This verifies native shared-service stop/replacement, not room sharing, NDI
output, actual Avid competing-audio isolation or packaged WKWebView readiness.

After this migration, the full `npm run verify` passed: 3,710 frontend tests,
527 Rust unit tests, two native-service API tests, Swift/native configuration,
dependency/license gates, lint/typecheck/clippy and 365 browser checks (existing
skips retained). The final signed-runtime supervisor test passed again after
the full suite, with all three recordings meeting the unchanged tone and
timestamp checks and the helper fully reaped. No installed app, project,
permission setting, DMG or GitHub state was changed.

The shared Rust service now has a generated-window source-lifecycle gate
(`verify-obs-service.mjs --source-lifecycle`). Its first complete run passed
move, resize, hide, close and application quit. Move preserved both streams;
the other transitions revoked only the affected program, delivered a specific
source-loss error through ProgramReader and acknowledged native teardown in
43–350 ms. An explicit post-resize restart changed 1200×704 to 1440×864 without
reviving the failed program. The other capture continued for 70–81 fragments.
A deliberate test mutation that moved instead of resizing failed the source-loss
assertion; that mutation was removed.

**Audio acceptance remains unresolved.** Repeating the resize gate exposed an
intermittent ~21 ms gap in decoded audio even though packet timestamps remained
continuous. It occurred before the resize as well as in a replacement capture,
so resize itself is not an established cause. Retained evidence:
`/private/tmp/sauce-obs-service-FEwQOv/R` (three affected outputs) and
`/private/tmp/sauce-obs-service-czibxz/R` (replacement affected). The latter had
passed the older 100 ms frequency test. The oracle now additionally rejects
five milliseconds of sustained near-silence in the generated tones; it rejects
these affected recordings and still accepts all three recordings in the first
resize run (`/private/tmp/sauce-obs-service-GgHKYE/R`). Synthetic coverage pins
the 1024-sample dropout case. This strengthens, not relaxes, audio acceptance.
Native tests now retain typed status and bounded vendor diagnostics locally;
production still discards helper stderr. An independently signed diagnostic
runtime records OBS audio-buffer growth, but these logs do not yet establish
whether the gap originates in ScreenCaptureKit, the OBS mixer or encoding.
One intervening rerun also missed startup readiness; it is not counted as a
pass. The added status trace makes future startup failures inspectable.
Do not use the earlier passing native runs to claim sustained audio reliability,
and do not mask this failure by extending timeouts or weakening the oracle.
The full `npm run verify` passed after these additions (3,711 frontend tests,
Rust/API/clippy, Swift, native configuration/license checks and 365 browser
tests with the existing skips). That unattended suite does not run the manual
generated-window/audio gate and does not resolve its observed dropout.

The next stage trace localized the short dropout. In
`/private/tmp/sauce-obs-service-ainK50/R`, raw captured samples had no sustained
silence, while the mixer emitted exactly 1,024 silent samples in each affected
channel. Its reserve was 64 ms. A separate uniform 30 dB attenuation was already
present in the captured samples in that run (and the preceding `lqCjMY` run);
it is not attributed to the mixer and was absent in the subsequent run without
changing fixture amplitude, test thresholds or Mac volume.

The private engine now uses OBS's fixed buffering API with a 128 ms reserve
(six 1,024-sample stereo blocks at 48 kHz). No timestamp rewrite, extra transport
or automatic gain change was added. `audio-buffer.test.mm` supplies continuous
generated PCM with 40 ms delivery latency and three 50 ms arrival stalls. The
old dynamic configuration reproduces a 1,024-sample silent block; three fixed
runs pass with maximum near-zero runs of one sample. The runner requires the
negative control to fail for that particular dropout, not merely exit nonzero.
`verify-obs-av-sync.mjs` sends generated white flashes and simultaneous stereo
tone bursts through the real file-source/native encoder. Two runs measured
39.7 and 54.7 ms worst absolute offset, within its two-frame bound (66.7 ms).
The oracle detects an injected 128 ms shift and missing pulses, and matches
both early and late sub-frame offsets without an interior-boundary off-by-one.

The fixed-reserve shared-service resize run
`/private/tmp/sauce-obs-service-Wfy8ja/R` passed all three recordings: 6/13/6
interior seconds, expected isolated tone levels, no sample gaps, and normal
source teardown/restart. A trace-disabled full lifecycle attempt at
`/private/tmp/sauce-obs-service-nsqGgC` passed M/R/H/C, but Q failed when both
programs reported source-health loss. This is not counted as an all-green
lifecycle run. Bounded stop-reason diagnostics now distinguish application,
window identity, on-screen state, permission, capture-stream and raster loss
without logging private metadata. The previous startup-readiness miss and
this source-health failure still require follow-up; do not treat the mixer fix
as proof that the entire capture lifecycle or feature is complete.

The diagnostic quit rerun (`/private/tmp/sauce-obs-service-1DyxqS/Q`) passed:
the selected application's termination was observed in 87 ms, the surviving
stream produced another 71 fragments, and both decoded recordings passed the
strict stereo/near-silence oracle. This does not explain the earlier failure.
A complete follow-up attempt (`/private/tmp/sauce-obs-service-guWn1t/M`) failed
on move: slot 1 first reported `source_raster_changed`, then slot 0 received
ScreenCaptureKit -3805 and stopped. No all-green lifecycle claim is made.

Inspection found that the pinned module consumed geometry without checking
frame status. A new generated-IOSurface regression reproduced a concrete
defect: an idle sample with omitted geometry changed 1200×704 to zero, failing
the raster assertion against the previous module. The recorded
`macos-frame-status.patch` now consumes complete frames only. Idle/started
notifications preserve the confirmed raster; blank/suspended/stopped states
latch source loss. The regression also proves complete resized frames still
change the raster, so it cannot pass by suppressing all updates. The newly
built, internally signed 28-component runtime passes that native test. Live
lifecycle validation is still required; this synthetic reproduction alone
does not prove which attachment triggered the observed two-stream failure.

That new runtime subsequently passed the complete shared-service M/R/H/C/Q
gate (`/private/tmp/sauce-obs-service-3VS6sp`). All eleven recordings retained
the expected raster and isolated stereo; maximum sustained near-zero run was
one sample (0.0208 ms), with no relaxed thresholds. Resize reported the actual
1200×704 → 1440×864 change and preserved the other stream through explicit
restart. Every case stopped and reaped its helper. The earlier intermittent
failure is retained above; this is one complete passing sequence, not proof
of sustained real-editor/WKWebView reliability.

The full frozen-source verification after that frame-status fix passed all
gates (3,711 frontend tests and 365 browser checks, with existing skips).
An earlier browser run was invalidated by changing the build ID during its
execution; its mismatch banner caused the lasso geometry failure. The clean
rerun retained the original lasso behavior and assertions.

The next integration audit found that an acknowledged renderer Stop only
removed the registry entry; native worker capacity could still be occupied.
The existing stop command now awaits a scoped service completion outside the
session lock. Individual completion follows slot acknowledgement and permit
release; last-slot completion additionally waits for helper reap. A unit
negative control that announced completion before reap failed as intended.
The stuck-helper test confirms bounded cleanup without admitting a replacement
too soon. NDI/untracked identities do not wait on an unrelated OBS capture.

The signed-runtime replacement gate (`/private/tmp/sauce-obs-service-NFlF7n`)
now uses real worker permits, verifies both slots exhaust capacity, and starts
the new crop immediately after the same completion boundary used by the
renderer command. It passed: the survivor remained 1200×704 and the replacement
was 600×352. All three recordings passed isolated stereo, timestamp continuity
and the strict near-silence checks (maximum near-zero run one sample). Every
program stopped and the helper was reaped. No room or NDI broadcast was started.

Exact application/PID/window/crop provenance now survives local status reads
as an optional capture selection. Two same-title windows remain distinct.
Tests assert ordinary NDI snapshots stay unchanged and that peer telemetry and
media records contain none of that local selection. The current NDI-only
session restore remains unchanged. Renderer capture controls were pending at
this checkpoint and have since been connected.

The subsequent frozen-source full verification also passed after the stop and
provenance changes: 3,712 frontend tests, 531 Rust library tests, two OBS service
API tests, and 365 browser checks (existing skips/ignored tests retained). This
does not substitute for packaged application capture acceptance.

The private bundle contains finite probes and supervised continuous workers.
They are intentionally absent from release packaging. The exact-window source
follows the actual crop raster and exposes no broadcasting command. The crop
model was connected to the CLI/backend service at this checkpoint and is now
also consumed by the user-facing picker.
The continuously draining supervisor, bounded ring adapter, cancellation,
parent-death handling and stalled-output checks now exist and have native
tests. More source/permission transitions and actual WKWebView monitoring still
need verification.
Child-window capture and global keyboard/mouse listening are disabled in the
pinned source build. No input-monitoring permissions were requested. Internal
runtime signing has passed; validation inside the final enclosing app and
permission continuity across packaged builds still remain.

The supervised service is now connected to the Preview controller and Source
settings dialog, including exact source identity on reconciliation. The remaining
step is packaged live validation in WKWebView. Keep startup, display and
permission transitions under test with the bounded audio reserve.
Real-editor audio isolation, crop/resize recovery, actual WKWebView playback,
room/NDI publication boundaries, clean-machine tests, and distributable GPL/NDI
materials remain required. No DMG, app replacement or GitHub push was made.

## Internal application staging (not a release)

The diagnostic runtime remains the native test fixture. A separate
`application` profile retains only `capture-service`, `window-probe`, libobs,
OpenGL, the two selected plugins and their required dynamic libraries. It does
not carry diagnostic or legacy worker executables. Both profiles are still
marked `internalOnly: true`, `distributionReady: false`.

```sh
SAUCE_NDI_SDK_DIR='/Library/NDI SDK for Apple' npm run build:obs:internal -- \
  /absolute/path/to/diagnostic-runtime /new/absolute/path/SauceBunnyInternal.app
npm run verify:obs:internal -- /new/absolute/path/SauceBunnyInternal.app
```

The builder uses the normal app build with an explicit app-only target, stages
into a new directory, puts OBS under `Contents/Helpers/OBS.bundle/Contents`,
signs the nested runtime, and signs/verifies the enclosing app. It does not change version
numbers, make a DMG, install or launch an application, request permissions,
capture a window, connect a room, broadcast NDI, notarize or upload anything.
An existing destination is rejected, including symlinks; failed artifacts are
retained and explicitly reported as unverified.

### Internal test DMG (not a release)

The ordinary `build:dmg` and `release:dmg` commands do not stage OBS or the
standalone sender. For a local test image containing the current controls and
helpers, build the internal app into a fresh payload directory, verify it, then
wrap that directory with macOS's image tool. Set `OBS_DIAGNOSTIC_RUNTIME` to an
explicit, verified diagnostic runtime whose frozen helper inputs match the
code being tested. Rebuild the enclosing app after frontend/backend changes;
an older verified app is not evidence for the current build ID.

```sh
test_dir="$(mktemp -d /private/tmp/sauce-obs-test-dmg.XXXXXX)"
mkdir "$test_dir/payload"
SAUCE_NDI_SDK_DIR='/Library/NDI SDK for Apple' npm run build:obs:internal -- \
  "$OBS_DIAGNOSTIC_RUNTIME" "$test_dir/payload/Sauce Bunny.app"
node scripts/verify-obs-app.mjs "$test_dir/payload/Sauce Bunny.app"
bash scripts/verify-bundle.sh "$test_dir/payload/Sauce Bunny.app"
bash scripts/verify-packaged.sh "$test_dir/payload/Sauce Bunny.app"
hdiutil create -fs HFS+ -format UDZO -volname 'Sauce Bunny Internal Test' \
  -srcfolder "$test_dir/payload" "$test_dir/Sauce-Bunny-Internal-Test.dmg"
hdiutil verify "$test_dir/Sauce-Bunny-Internal-Test.dmg"
shasum -a 256 "$test_dir/Sauce-Bunny-Internal-Test.dmg"
```

Run each next step only after the preceding check succeeds. Before handing off,
attach the image read-only with `-nobrowse` at a fresh explicit mountpoint,
repeat the app verifiers against that mounted copy, and detach it on success
or failure. Do not use `--allow-stub-sidecars`. Keep a distinct build-number
stamp and the verification results with the image; the internal builder does
not stamp the version for you.

This procedure is a test-image recipe, not a claim that a DMG has been built or
that the packaged live acceptance gates passed. The app remains
`internalOnly: true`, `distributionReady: false`; Apple Development signing is
not Developer ID notarization. Do not install, launch, upload or publish it as
part of these static checks. The app keeps the production bundle identity and
user-data paths, so an isolated artifact directory does not isolate user data
when it is later launched. Public redistribution still requires the source,
license, signing/notarization and acceptance work described in this document.

The runtime is a resource-only macOS `BNDL`, with no `CFBundleExecutable`.
Its `MacOS`, `Frameworks` and `PlugIns` directories contain code; license/source
materials and `runtime-inventory.json` live under its `Resources` directory.
The original flat helper directory failed real signing because macOS treated
license text in a code location as unsigned nested code. The corrected layout
follows [Apple's nested-code rules](https://developer.apple.com/library/archive/technotes/tn2206/_index.html).
Sign components first, record their final hashes, then seal the resource-only
bundle and enclosing app without recursive re-signing. A native check verifies
that sealing the bundle leaves all inventoried component hashes unchanged.
Internal app builds clear notarization credentials before invoking Tauri:
even an app-only target could otherwise trigger an upload. Stable local signing
is retained; notarization is a separate release action.

The verifier checks expected build-ID string presence and executable UUID, the
runtime's independently inspected code/dependency graph and hashes, absence of
direct libobs linkage in the main executable, and strict signatures with one
stable team identity throughout the app and runtime. The source executable hash
is provenance: enclosing-app signing changes its signature bytes, so final
integrity is checked by signature and UUID continuity, not a circular checksum.
The application carries an internal-test notice and a sealed build record.
String presence is only a coarse stale-build screen: concatenated/embedded
strings cannot prove which ID the running backend reports. The report names
that limit explicitly; a real backend/frontend handshake in packaged WKWebView
remains a separate acceptance gate.

The source/license directories currently preserved from the diagnostic runtime
are **not** a complete corresponding-source package. Those materials, actual
Preview controls, packaged WKWebView capture/audio and real-editor testing all
remain required. Internal bundle verification is not a distribution or UX gate.
`npm run test:obs-packaging` runs isolated path, tamper, profile, signing and
build-identity regressions as part of `npm run verify`. Native runtime staging
coverage is opt-in with `SAUCE_OBS_TEST_RUNTIME=/absolute/diagnostic/runtime`.
Add `SAUCE_OBS_TEST_SIGNING=1` and a stable `APPLE_SIGNING_IDENTITY` to exercise
real bundle signing and resource-tampering rejection on temporary test copies.

The September 11 internal app build passed staging and strict verification with
build ID `2026-09-11-obs-runtime-bundle`, 19 runtime components and Apple
Development team `U8RP5N8P7M`. The resource-only bundle seal preserved the nested
code hashes; a deliberately modified license resource in a separate test copy
was rejected. The app was not launched, installed, notarized or published.
The complete automated gate passed: 3,715 frontend tests, 531 Rust tests, two
native-service API checks, Swift/lint/license/configuration/packaging checks and
365 browser tests, with existing environment-dependent skips. The opt-in native
runtime and signing tests also passed separately. This verifies the package
structure, not a running backend/frontend handshake or Avid monitoring.

## Frozen source materials (not complete distribution source)

New helper builds compile from a bounded, text-only snapshot of `obs-sidecar/`
and the explicit helper build scripts. The snapshot rejects links, special files,
binary data and changes during copying; its independent verifier checks the exact
file set, hashes and modes. The executing recipe must still match its frozen copy
before the build succeeds. A build record associates that snapshot and the core
build record with the compiled helper/module UUIDs. Older runtimes without these
records are rejected, not retrospectively associated with today's checkout.

The core builder verifies pinned OBS/dependency archives and records its frozen
recipes, patches, toolchain and output UUIDs. The dependency archive remains a
prebuilt build input, **not** complete preferred-form dependency source. UUID
continuity is recorded provenance, not proof of reproducible binaries.

```sh
npm run stage:obs:source -- /absolute/diagnostic-runtime \
  /absolute/obs-source.tar.gz /absolute/obs-deps-2026-07-15-universal.tar.xz \
  /new/absolute/source-materials
npm run stage:obs:source -- --verify /absolute/source-materials
```

Staging independently inspects the runtime, checks source/build associations,
copies its source and supplied notices plus the two pinned input archives, then
verifies the complete output file set. It does not execute the included rebuild
recipes. The result says `internalOnly: true`, `distributionReady: false`,
dependency-source coverage incomplete and rebuild not run. This package includes
no helper executable, application source, signing credentials or user media.
Source/license tampering, extra files, aliases and changed records fail validation.

These checks join `npm run test:obs-packaging` and `npm run verify`. Actual native
source staging is opt-in with `SAUCE_OBS_SOURCE_TEST_RUNTIME`,
`SAUCE_OBS_SOURCE_TEST_ARCHIVE` and `SAUCE_OBS_SOURCE_TEST_DEPS`; synthetic tests do
not prove a binary was built from the included source. Complete dependency sources
and recipes, a rebuild from the staged materials, licensing review, final app/UI
and real-editor verification remain separate gates. No publication is performed.

The September 11 local source-material check passed against a freshly built,
stable-signed 28-component diagnostic runtime. Its 145-file material package
passed offline verification and all 16 material tests, including native staging
and deliberate notice/manifest tampering. A separate core/helper rebuild from
that package's frozen recipes and pinned archives also passed, without the
original checkout. This is a successful rebuild, not byte-identical output or
complete dependency-source coverage. The packager itself still reports rebuild
not run because staging never runs a compiler; this paragraph records the
separate native rebuild check.
The full automated gate passed: 3,715 frontend tests, 544 Rust library tests,
two native-service API checks, native/helper packaging, Swift, lint/license
checks and 365 browser tests (existing skips retained). No real editor window
was captured, and no app installation, DMG, notarization or GitHub push occurred.

## Native application discovery

The helper's `--applications` mode uses NSWorkspace to return a bounded local
snapshot of running regular/accessory applications: display name, bundle ID and
PID only. It never requests screen-recording access, enumerates windows, launches
an app, initializes OBS or starts capture. Terminated, self, background-only and
invalid identities are excluded; missing names fall back to the bundle ID.
Two processes of the same application remain distinct. Empty lists are valid,
not interpreted as denied permission. An application being listed does not
promise that it currently has a capturable window.

The existing bundle-ID window probe remains separate and requires existing
screen-recording permission. Capture still revalidates the exact app/PID/window
and crop before starting. `obs_applications` is now registered and consumed by
the explicit application selector; `obs_windows` remains a separate passive
query. Discovery itself starts neither capture, room publishing nor NDI
broadcast.

Application and window results share a bounded subprocess reader: fixed bundled
helper, cleared environment, 64 KiB output cap, five-second deadline, and kill/reap
on failure. Structured permission errors remain actionable; a nonzero process
exit cannot be accepted as success just because its JSON looks valid.
Tests cover exact identity, duplicate processes, malformed/oversized results,
failed exits and cancellation. The production application CLI also compiles and
runs against a window-discovery tripwire without linking libobs/ScreenCaptureKit;
this tests that app listing never enters window discovery. These checks are
part of `npm run verify`, not a replacement for packaged Avid monitoring.

The September 11 signed diagnostic runtime passed the metadata-only application
query with its restricted environment, including an Avid application identity.
No window enumeration or capture was requested. The paired source build ID is
`2026-09-11-obs-app-discovery`; the previously staged enclosing application has
not been rebuilt with this seam. The full automated gate passed with 3,715
frontend tests, 544 Rust library tests, two native-service API checks and 365
browser checks, plus the native discovery, packaging, Swift, lint and license
gates (existing skips/ignored tests retained). Discovery's 12 Rust behavior tests
include timeout and caller-cancellation reaping. No UI, installed application,
room, NDI broadcast, DMG or GitHub state was changed.

## Raw output and explicit attempt control (in development)

`ProgramOutput` can attach a separate raw consumer to its existing private
canvas and stereo mix. It is disabled by default. Callbacks copy into three
preallocated BGRA slots and a 12,000-frame stereo ring; they never wait for pipe
progress. A dedicated writer uses a 200 ms total deadline per framed record.
Video can replace an unsent picture; audio overflow fails the attempt rather
than dropping samples or inserting silence. Encoded Preview and another
capture remain independent. The writer rejects Preview's pipe and its aliases.

The 64-byte `SBR1` header includes capture/broadcast generations, original OBS
nanosecond timestamps and bounded raster/sample counts. Payloads are packed
BGRA or 48 kHz stereo float32 planes. No application names, window titles,
paths, pairing data or session metadata are included. This is not sequence
timecode. Raw bytes never pass through the encoded service stdout multiplexer.

Explicit native control uses an optional inherited Unix datagram socket pair,
not a filesystem socket or network listener. A 32-byte `SBC1` request transfers
one new anonymous pipe descriptor for each start. Capture and attempt identities
scope every request and acknowledgement. `Started` means callbacks/writer
attached, not that a usable frame reached a consumer. `Stopped`/`Failed` follow
callback disconnection, writer join and closure of helper writer descriptors;
the eventual sender must additionally drain EOF and finish its own shutdown.
A failed pipe is never reused for recovery. No output begins merely by opening
settings or listing applications.

The Rust raw-output actor runs separately from encoded stdout delivery. It
requires a helper handshake, validates the selected running Program, and owns
at most one attempt per capture slot. Cancelling a feed is independent of the
user's volume and mute state. Missing stop acknowledgements remain explicitly
unconfirmed and keep that slot reserved; they are not reported as successful
stops. A source change cancels its attempt without starting another source.
Native encoded teardown continues servicing the other slot's raw controls.

```sh
npm run test:obs-capture
npm run verify:obs:raw-output -- /absolute/private-runtime /absolute/verified-core-build
node scripts/verify-obs-service.mjs /absolute/signed-private-runtime --raw-output
```

The optional native gate generates separate test-media tone pairs, verifies
cropped pixels and exact audio-channel isolation, restarts generations without
resetting timestamps, deliberately stalls one consumer and recovers through a
fresh pipe while both encoded outputs advance. Protocol tests include malformed
headers and bounded payloads. These checks do not capture Avid, create an NDI
sender, prove network delivery or replace packaged WKWebView acceptance. The
signed service gate exercises the production Rust-to-helper descriptor path,
two generated windows, a stalled attempt, fresh-pipe recovery, isolated stereo
samples, continued encoded playback and actual pipe EOF after stop.
The September 11 signed raw-service run passed: both encoded outputs advanced
through a stalled raw consumer and a fresh-pipe restart. Decoded raw rasters
matched the encoded 1200 x 704 pictures. Independent five-second channel-tone
checks passed for both captures, including the surviving capture after teardown.
The separate raw-owner run passed 116 checks with mean cropped-pixel error 0.924;
its observed stop was 3.1 ms and stalled-output detection was 231.1 ms. These are
individual generated-media measurements, not production latency guarantees.
The full automated regression run then passed with 3,715 frontend tests, 560
Rust library tests, three service-API tests and 365 browser tests, plus native,
Swift, lint and license gates. Existing skipped/ignored checks were retained.
The separate sender's native consumer-lifetime integration is described below.
Preview controls were unfinished at this checkpoint and are now connected.
Packaged live acceptance and distribution gates remain open.

### Separate NDI sender process (in development)

The NDI-only consumer under `src-tauri/native/ndi_sender*` is original MIT code,
not part of the GPL libobs helper. Its only shared source is the explicitly
MIT-licensed `SBR1` framing header. The private builder compiles against supplied
NDI SDK headers without linking OBS or loading any runtime. The internal-only app
builder now includes it as `Contents/Helpers/NDISender.bundle`; ordinary release
resource lists are unchanged. The resource-only bundle contains its frozen MIT
source, runnable build recipe, SDK-header hashes (not SDK headers), unsigned
build provenance and signed inventory. It reuses the app's existing NDI runtime
and notices rather than copying another vendor library. Independent inspection
checks exact files, source hashes, arm64/macOS 14 targeting, system-only linkage,
same-team signatures and the enclosing NDI package inventory. This is internal
packaging, not distribution approval. The current renderer separately exposes
the explicit broadcast control described above.

The executable requires an explicit broadcast flag, expected capture/attempt
generations and a read-only FIFO. It rejects malformed or superseded records,
changed raster, non-finite audio and discontinuous audio timestamps. Bounded
buffers and read deadlines prevent partial records from growing memory or
holding the reader forever. NDI submission is synchronous, so the SDK may borrow
payload memory only for the duration of each call. Picture and stereo audio use
the same OBS timestamp origin, converted to 100 ns transport timecode; this is
not Avid sequence timecode. The v1 sender uses the engine's fixed 30/1 cadence.

Creation, submission and destruction run on one sender-process thread. SIGTERM
requests cancellation; it does not destroy an SDK object concurrently. The Rust
supervisor cancels the raw attempt, reaps the sender, then independently confirms
helper stop and actual pipe EOF before reporting a clean stop. The retained
duplicate reader is never consumed while the child is alive. A blocked SDK call
or destructor causes termination of that sender alone after its deadline; Preview
is not stopped. Forced termination remains a failed attempt even when all cleanup
barriers are subsequently proven. Unexpected wait errors quarantine admission
and disable further PID signals instead of risking a recycled process identity.
The current renderer uses this native API for explicit start, stop and status
observation; popup closure does not control the sender lifetime.

Integration first reserves an attempt and exposes its actor-assigned
capture/broadcast generations, then creates the sender and waits for `ready`
before arming raw production. The producer's 200 ms write deadline therefore
does not absorb cold SDK initialization. Reservation alone transfers no writer
descriptor; cancellation before arm needs no fabricated helper stop. The actor
rechecks the latest source identity immediately before transfer. `ready` means SDK initialization;
`live` requires successful submissions from both tracks, not merely process
startup. Clean EOF with no frames or only one track is not proof of live A/V.

Ordinary Quit closes admission synchronously and waits outside the event loop
for bounded sender cleanup before the existing app teardown. Repeated Quit
requests do not create additional drain tasks. Unconfirmed cleanup is reported
locally at the deadline, not recast as success. Tauri restart cannot be prevented
and a main-thread restart can bypass even the final Exit hook. The synchronous
cancel hook remains where Exit is delivered; the independent child watchdog also
covers restarts, forced termination and crashes. It detects parent loss even when
SDK initialization, video/audio submission or destruction is blocked, and exits
the sender after a 2.5-second grace period. It never destroys foreign objects on
the watchdog thread.

`npm run test:ndi-sender` uses generated records, a fake synchronous sink and a
fake factory linked in place of the SDK. It never creates an actual NDI source.
`bash scripts/build-ndi-sender.sh <SDK-include-directory> <new-output-directory>`
builds the real adapter without running it. It retains a runnable source-layout
snapshot and checks both source and SDK header hashes after compilation.
`bash scripts/verify-ndi-sender-sdk.sh <SDK-include-directory>` optionally checks
the real adapter against a generated fake library compiled with the official
headers. Its 37 checks cover frame/sample fields, initialization failures and
destruction order; it does not load the vendor runtime. None of these commands
proves network delivery, packaged broadcast lifetimes or distribution compliance.

2026-09-11 verification: the reader passed more than 1,600 assertions and a
separate ASan/UBSan run; all 90 fake-process cases and 37 fake-library ABI checks
passed. A same-toolchain rebuild from the saved source layout produced the same
binary hash. The full automated gate passed 3,717 frontend tests, 560 Rust
tests, three native-service checks and 365 browser checks, plus Swift, lint,
native packaging and license gates; existing skips/ignored tests were retained.
The first full run exposed Node tests being collected by Vitest. The explicit
exclusion and its regression contract now keep them in the dedicated native
gate. No vendor runtime was loaded, network source created, app installed,
editing application manipulated or changes published for this sender slice.

The subsequent native lifecycle gate passed 95 focused Rust tests (four opt-in
native checks excluded from that run). These cover prepared startup, exact
generation arming, independent cleanup barriers, cancellation, lost process
ownership and bounded app-exit draining. A strict-status regression found that
Serde unit variants accepted unknown fields; empty struct variants now reject
them. All 90 fake-sender process cases and 37 fake-library ABI checks passed.
Parent-loss cases exercised blocked initialization, video, audio and destruction;
the sender exited in approximately 2.53 seconds, with immediate shutdown in the
unblocked case. The isolated sender bundle also passed real Apple Development
signature and inventory verification under team `U8RP5N8P7M`; it was not launched.
Resource-only BNDL signing produces detached signature files, which are narrowly
allowlisted and covered by tamper tests. The paired source build ID for this
slice is `2026-09-11-obs-broadcast-lifecycle`.

The final full gate for that slice passed 3,721 frontend tests, 605 Rust tests,
three service API tests and 365 browser checks, plus Swift, strict Clippy,
native packaging, license checks and all 90 fake-sender process cases. Existing
skips remain. Parallel testing exposed two fixture defects: a one-second raw
control deadline incorrectly included native SDK startup, and the fake helper
did not restore CLOEXEC on received writer descriptors. Phase-aware startup
tests now retain the production SDK deadline; Stop remains one second in the
fixture. Gated-exec, permanently blocked initialization and descriptor-flag
regressions were added without relaxing production cleanup barriers. Exact
cleanup-proof diagnostics remain for future failures. Production panic scanning
now resolves test-module paths and restricted visibility without exempting
unrelated or dual-use production files.

A fresh enclosing internal app subsequently passed strict signatures and
inventory verification with both private helpers. Its main executable UUID is
`B94542FF-5D0B-3157-A4F1-780BCBFF7D11`; the isolated sender UUID is
`D42E21DB-1128-334D-8D36-581375CAA944`. The application-profile OBS inventory
contains 19 components, and both helpers and the app use signing team
`U8RP5N8P7M`. The source build ID was found in the executable; this is static
build evidence, not a running renderer/backend handshake. The artifact remains
`internalOnly: true`, `distributionReady: false`; it was not launched, installed,
notarized or published. Renderer controls were still outstanding at that
checkpoint; packaged live acceptance remains outstanding.

The real generated-window raw-output gate also passed with the signed diagnostic
helper: a prepared attempt emitted zero bytes before explicit arm, stalled raw
delivery did not stop either encoded preview, and recovery used a fresh pipe.
The same gate subsequently passed using the 19-component application-profile
helper from the verified internal app. Both encoded outputs were 1200×704;
interior stereo checks covered eight and seven seconds with no silent blocks or
competing-app tones. This still uses the Cargo test supervisor, not the packaged
main process or WKWebView, and proves neither network NDI reception nor the
outstanding packaged Avid workflow.

To repeat that generated-media-only helper check, use the explicit app mode:

```bash
source scripts/stable-signing.sh
node scripts/verify-obs-service.mjs /absolute/path/Internal.app --application --raw-output
```

It verifies the enclosing app before any launch and uses only its canonical
`Contents/Helpers/OBS.bundle/Contents` runtime. It launches two owned generated
windows, never the app's main executable, user editor, or NDI sender. The saved
proof records the application identity, helper profile, test supervisor and
generated-only/no-broadcast scope. Diagnostic-runtime mode remains explicit and
unchanged. Argument tests reject ambiguous profiles and preserve verification
failures instead of falling back to a different runtime.

The subsequent raw-allocation audit confirmed that Darwin `pipe()` followed by
`fcntl(FD_CLOEXEC)` leaves an inheritance window during concurrent process
creation. The raw allocator now uses a fresh 0700 directory beneath Darwin's
per-user temporary directory, anchored `mkfifoat`/`openat` operations and atomic
`O_CLOEXEC` on every opened descriptor. It validates the FIFO identities, owners,
access modes and nonblocking flags, retains separate reader/writer endpoints,
and removes the FIFO and directory metadata before returning. No media is stored
on disk. Allocation errors affect only the optional raw branch; a process crash
during allocation can leave empty temporary metadata. Cleanup is nonrecursive.

Eight focused checks cover both ordinary and `pre_exec` subprocess paths, an
unprotected legacy-pipe negative control, intentional stdin inheritance, actual
byte transfer/EOF, endpoint substitution and failed/partial allocation cleanup,
including cleanup after the FIFO entry has already been removed.
EOF checks require a zero-byte read within the existing two-second bound; a
temporary would-block result is not success. The updated Rust test supervisor
also passed the real generated-window/raw-output gate against the previously
verified application-profile helper, retaining two continuous 1200×704 previews
and isolated stereo audio. This does not mean the old app's main executable
contains the new allocator. The paired source build ID is now
`2026-09-11-obs-atomic-raw-pipe`; a matching enclosing app must be rebuilt before
packaged-main acceptance.

The subsequent complete local verification run passed: 3,721 frontend tests,
613 Rust unit tests, three service API tests, 365 browser checks, production
compilation, Clippy, Swift, native packaging, sender isolation and license gates.
This includes the config-driven nightly sidecar provisioning regressions; it
does not replace a GitHub nightly rerun or packaged-main acceptance. The full
log is `/private/tmp/sauce-obs-atomic-full-verify-final.log` on the test machine.

The matching internal app was subsequently rebuilt and staged at
`/private/tmp/sauce-obs-atomic-app.JnaKga/SauceBunnyInternal.app`, with executable
UUID `531D80F1-4C8D-3F55-97F6-087AE573D696`, the same signing team and 19
application-profile OBS components. Staging exposed a macOS `/var` alias bug in
the sender manifest command: Node's canonical entry-module path differed from
its command-line path, silently skipping the command. Canonical-path comparison
fixed it; 24 artifact tests cover CLI aliases and inert imports. The real sender
rebuild through the failing alias and subsequent app staging both passed.

Independent bundle verification is recorded in
`/private/tmp/sauce-obs-atomic-app-verify.json`. The full suite passed again in
`/private/tmp/sauce-obs-alias-full-verify.log`, including 119 packaging tests
(three existing skips). The packaged helper then passed the generated raw-output
gate under the current Rust test supervisor: two continuous 1200×704 pictures,
isolated stereo, stalled-consumer recovery and actual EOF. Evidence is in
`/private/tmp/sauce-obs-service-FBH9PH`. This is still not a packaged-main
handshake, audible WKWebView test, room share or NDI broadcast. The app was not
installed, launched, notarized or published. The renderer integration at the top
of this document supersedes that checkpoint's design-confirmation pause;
further native micro-tests do not replace packaged live acceptance.

## Primary references

- [OBS frontend/embedding lifecycle](https://docs.obsproject.com/frontends)
- [OBS backend design](https://docs.obsproject.com/backend-design)
- [OBS pinned source](https://github.com/obsproject/obs-studio/tree/ba2f32bdf791005443988a4955e963663e16b1ed)
- [OBS macOS capture](https://obsproject.com/kb/macos-screen-capture-source)
- [Apple window-filter audio policy](https://developer.apple.com/videos/play/wwdc2022/10155/)
- [Apple running-application snapshot](https://developer.apple.com/documentation/appkit/nsworkspace/runningapplications)
- [NDI SDK distribution terms](https://docs.ndi.video/all/developing-with-ndi/sdk/licensing)
