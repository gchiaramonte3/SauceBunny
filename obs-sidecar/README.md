# Embedded OBS helper (in development)

Production renderer controls now exist in Preview's **Source settings** popup:
choose **Application window**, explicitly select an application and window,
optionally set the crop, then choose **Preview source**. Discovery, refresh,
focus and popup closure do not start capture. **Broadcast to NDI** is a separate
explicit action from room sharing; closing the popup does not stop a broadcast.
The app continues observing native broadcast status outside the popup, including
cleanup failures. These controls require an OBS-enabled internal build. They do
not establish packaged Avid/audio/network acceptance or distribution readiness.

This directory is **GPL-2.0-or-later**, not MIT. Original Sauce Bunny code
outside it retains its existing licensing. The helper embeds real libobs in a
separate process; it is not an OBS remote-control plugin and does not launch
the OBS application.
The explicitly MIT-licensed `raw-frame.hpp` wire-format header is the exception:
it contains no libobs code and is shared with the separate native NDI consumer.

`probe.mm` is an engineering gate, not yet a production capture executable.
It initializes libobs 32.2.2, OpenGL, stereo audio and the pinned capture/output
modules, then observes one second of rendering without creating a screen or
audio capture source. It does not read OBS settings or enumerate user plugins.

Build from the pinned OBS source archive and pinned macOS OBS dependency
archive. Neither building nor running the current helper requires an installed
OBS application. CMake/Xcode are build-time tools only. The first script verifies
both archive hashes before extraction and disables OBS's dependency downloader:

```sh
bash scripts/build-obs-core.sh "$OBS_SOURCE_ARCHIVE" "$OBS_DEPS_ARCHIVE" "$NEW_CORE_DIR"
bash scripts/build-obs-probe.sh "$NEW_CORE_DIR" "$NEW_OUTPUT_DIR"
"$NEW_OUTPUT_DIR/MacOS/saucebunny-obs-probe" "$NEW_OUTPUT_DIR"
bash scripts/make-obs-test-fixture.sh "$GENERATED_TEST_MEDIA"
node scripts/verify-obs-probe.mjs "$NEW_OUTPUT_DIR" "$GENERATED_TEST_MEDIA"
node scripts/verify-obs-owner.mjs "$NEW_OUTPUT_DIR" "$GENERATED_TEST_MEDIA"
npm run test:obs-capture
```

The resulting private runtime has no dynamic-library reference to an installed
application or Homebrew. libobs, OpenGL and obs-ffmpeg are built from source;
their dependencies are copied from the pinned OBS dependency archive by actual
load graph. SIMDe 0.8.2 headers come from that same verified archive. The builder
creates `runtime-inventory.json` with each Mach-O's hash, architecture, dependencies
and search paths. The audit rejects external paths, escaping symlinks, unexpected
plugin executables and linking NDI into this GPL helper. This is a binary load
inventory, not a complete static-dependency/source-license bill of materials.
New builds also record frozen core/helper source inputs and compiled UUIDs.
The helper compiles from `source/helper`, not a mutable checkout; earlier builds
without these records must be rebuilt before source-material staging. UUID
association is provenance, not proof of byte-for-byte reproducibility.
`npm run stage:obs:source -- <runtime> <obs-archive> <deps-archive> <new-directory>`
collects the recorded source, notices and pinned inputs without running a build.
`npm run stage:obs:source -- --verify <directory>` verifies that artifact offline.
It remains internal-only: dependency preferred-form source/build recipes are
incomplete, and no rebuild, licensing clearance or distribution is implied.
This initial probe is deliberately not
registered as a Tauri sidecar and is not included in release artifacts yet.
The OBS capture module is built from hash-checked source with recorded patches
that exclude child windows, expose passive, latched source health and validate
ScreenCaptureKit frame status before consuming picture/geometry. Its original
capture pixel format is unchanged.
The helper explicitly enables GPU conversion for NV12 output; leaving it off
produces corrupted picture despite successful encoding. The integration gate
compares the decoded output against source frames, not just image variance.

The core carries a second recorded patch that removes global keyboard listener
creation and mouse-state polling. Upstream libobs could otherwise create an
event tap at startup if its identity already had Input Monitoring permission,
even with no configured shortcuts. `check-obs-core.sh` inspects the linked core
for those input APIs; it rejects the unpatched upstream binary. The helper also
rejects the upstream runtime version before calling `obs_startup`. Its private
version is `32.2.2-sauce-capture1`; the public libobs API version is unchanged.
No permission grant/reset or system-wide input interception is used.

For **internal** consistently signed validation, use the existing signing
identity selector, then sign this private runtime only:

```sh
source scripts/stable-signing.sh
node scripts/sign-obs-runtime.mjs "$NEW_OUTPUT_DIR"
```

That script audits before signing, signs nested code inside-out without an
ad-hoc fallback, verifies one team and hardened runtime across all components,
and refreshes the inventory hashes. It does not sign/replace the installed app,
notarize, publish, or claim to produce a distributable package. Rerun both native
verification scripts after signing; testing an unsigned copy is not equivalent.

With an interactive desktop and existing capture permission, the explicit
source-lifetime gate creates its own small, disposable, generated-picture app:

```sh
node scripts/verify-obs-source-lifecycle.mjs "$NEW_OUTPUT_DIR"
```

It verifies the runtime's signatures and private load graph, compiles/signs the
test app, and captures only that app's exact visible window. Moving it must
preserve capture; resizing, hiding, closing and quitting it must stop capture
with an explicit invalid-source result, not a crash or a timeout. Every child
is owned and reaped, including on assertion failure. Captured bytes are drained
without retaining media; bounded diagnostic logs remain in a new temporary
directory. No permission prompts/resets, user application capture, broadcast,
or user input automation are involved. This test is intentionally not part of
unattended `npm run verify` and its fixture is never included in the runtime
bundle. It does not verify display migration, permission revocation, audio
isolation or restarting capture in the production UI.

The separate interactive audio gate launches two signed generated-tone apps
through macOS LaunchServices, with distinct bundle IDs:

```sh
node scripts/verify-obs-audio-isolation.mjs "$NEW_OUTPUT_DIR"
```

Both play quiet stereo tones for the duration of the test (440/660 Hz and
880/1320 Hz, amplitude 0.01). The gate captures each exact visible window in
turn, verifies both source audio clocks kept advancing, then checks five
seconds of decoded 48 kHz stereo in 100 ms blocks. Each app's tones must be present
in its own capture and absent from the other's; silence cannot pass as isolation.
The oracle's Vitest tests deliberately inject a combined system mix, swapped
channels, a dropout and invalid PCM. No microphone, user media, output-device
change or permission reset is used. The fixture stays silent in the existing
source-lifetime test. Shared setup/signature/child cleanup code lives in
`scripts/obs-window-test-fixture.mjs`; all test-only artifacts stay outside the
private runtime and application bundle.

LaunchServices matters: initially executing both fixture binaries as children
of one runner resulted in both tones being attributed together. Launching them
as distinct applications fixed isolation without changing the capture module
or loosening the oracle. This does not establish isolation of arbitrary
helper-process audio in an editor; real Avid under competing audio remains a
packaged acceptance check. Also, overlapping capture-helper teardown caused
the surviving stream to stop with ScreenCaptureKit error -3805. The sequential
audio gate does not certify concurrent separate-helper lifecycles. The current
backend instead uses the shared-engine service described below.

To reproduce the unresolved overlapping-helper failure explicitly (not an
unattended test), append `--overlap` to that command. It requires both helpers
to complete normally; it does not accept the current -3805 source-loss error
as a passing outcome. It uses the same exact-window, quiet-tone and cleanup
limits as the sequential gate.

The shared-engine alternative has its own native regression gate:

```sh
node scripts/verify-obs-shared-capture.mjs "$NEW_OUTPUT_DIR"
```

It runs two exact generated-window sources inside one libobs lifetime, using
the same `ProgramOutput` component as the ordinary media/capture workers.
Each program has a private canvas, a reserved stereo audio mix and a separate
inherited output pipe. It destroys the first source while requiring the second
to keep delivering encoded bytes and advancing frames, then decodes both
outputs and checks tone isolation and contiguous A/V timestamps. Duplicate
audio-mix reservations are rejected before routing can change. The second
audio measurement includes the period after first-source teardown. Test tones
and cleanup limits are the same as the isolation gate; no user window or media
is selected, and nothing is shared or broadcast.

The backend now uses that primitive through one `capture-service` process.
Its actual Rust supervisor/ring integration has a separate generated-window gate:

```sh
node scripts/verify-obs-service.mjs "$NEW_OUTPUT_DIR"
node scripts/verify-obs-service.mjs "$NEW_OUTPUT_DIR" --source-lifecycle
```

This starts both sources, stops the first, reuses its slot with a new generation
and a half-size viewer crop, and checks uninterrupted media and isolated stereo
from the other program. Each output is decoded after traversing the real Program
reader. It also verifies bounded ring retention and final helper teardown.
The lifecycle mode runs five separate generated-window cases: move, resize,
hide, close and quit. Source loss must revoke readiness, deliver the specific
error through ProgramReader, acknowledge teardown and leave the other program
delivering isolated stereo and contiguous A/V. Resizing also requires an
explicit restart at the new raster; the old program cannot resume. Append
`M`, `R`, `H`, `C` or `Q` to run one case. Nothing changes Avid, permissions,
or a user's media, and all fixture applications are closed after each case.
The earlier `--overlap` check still exposes the separate-process limitation;
that architecture is no longer used by the backend OBS start path. Neither gate
proves packaged Preview playback, live-room delivery or NDI broadcast.

The media integration gate expects generated test footage with a 440 Hz left
tone and 660 Hz right tone. It checks actual decode, audio continuity/channel
isolation, packet timing, codec compatibility, and independent short fragments.
It writes results into a new temporary directory and never captures the screen.
First encoded bytes are reported as a startup diagnostic, **not** end-to-end
monitoring latency.

`window-probe.mm --applications` lists running, foreground-capable application
identities (name, bundle ID and PID) through NSWorkspace. It does not enumerate
windows, ask for screen-recording permission, start OBS or read picture/audio.
Terminated, background-only, invalid and self processes are excluded; regular
and accessory applications remain eligible. An application with no visible
windows can be listed, but cannot start capture. Multiple processes with the
same app name/bundle ID remain distinct choices. Paths, icons and window titles
are not included in this list.

With a bundle-ID argument, `window-probe.mm` enumerates windows only for the
specified application, without starting capture or asking for permission.
That separate operation requires existing screen-recording access. Its optional PID argument reports identity
diagnostics, not another selection/fallback mechanism. `capture-probe.mm` is
an explicit eight-second local test of an exact visible window/PID/bundle ID:

```sh
"$NEW_OUTPUT_DIR/MacOS/saucebunny-obs-window-probe" --applications
"$NEW_OUTPUT_DIR/MacOS/saucebunny-obs-window-probe" "$APPLICATION_BUNDLE_ID"
node scripts/probe-obs-window.mjs "$NEW_OUTPUT_DIR" "$APPLICATION_BUNDLE_ID" "$PID" "$WINDOW_ID"
```

The capture probe requests that window's contents and application audio.
Optional trailing `crop-x crop-y crop-width crop-height` values select a
normalized rectangle within that window. The output follows the cropped
aspect ratio, never upscales, and is limited to 1920×1080 with even dimensions.
Use only an authorized test window, continuously drain stdout, and supervise
the process with a timeout. It never falls back to a desktop or different app.
The script drains stdout continuously and imposes a 20-second hard timeout.
Real Avid picture, viewer cropping and stereo audio have passed finite local
tests. Hidden-window capture remains disabled.

The helper checks native capture health as well as exact window identity,
visibility and raster. A ScreenCaptureKit error can leave a renderable last
texture behind, so continuing encoder output is not evidence of live capture.
The private module latches that failure atomically until a new source is created;
the helper stops instead of advertising repeated old frames as live. Missing or
older health contracts fail closed. `capture-health.test.mm` invokes the actual
module delegate with synthetic user-stop, missing-source and internal-error
callbacks, without creating a capture stream or changing permissions. This is
not a substitute for testing actual permission revocation in the packaged app.
The same test sends generated IOSurface samples through the real module:
idle/started notifications cannot erase confirmed dimensions, complete frames
still update dimensions, and blank/suspended/stopped states latch source loss.
The original module fails the idle-without-geometry regression. This protects
parked pictures without disabling real resize or source-loss detection.

The same capture/media entrypoints also build as `capture-worker` and
`media-worker`. Those run until their owner stops them. Their stdin accepts
only `P` (heartbeat) and `S` (stop); EOF, owner death, an invalid byte, or two
seconds without a heartbeat requests shutdown. An independent watchdog exits
after three more seconds even if vendor shutdown or an encoder write hangs.
These single-program entrypoints remain diagnostic/test tools. The backend uses
`capture-service`: newline-delimited P/Q heartbeats/shutdown and typed JSON
start/stop requests over the inherited owner pipe. Requests allow only exact
bundle/PID/window/crop selections, slots 0/1 and monotonically increasing
generations; no paths, URLs or broadcast commands are accepted. Commands are
bounded to 4 KB and two pending starts. Each output has its own pipe-drain thread
and stdout records carry its slot/generation. Terminal acknowledgement follows
output/source teardown and all earlier media. EOF, parent death or lost
heartbeats triggers an independent bounded shutdown watchdog.
The app's supervisor continuously drains stdout into the existing eight-fragment
Program ring, not into an individual browser/network reader. It rejects partial,
out-of-order or oversized MP4 boxes, times out startup/media stalls, and kills
and reaps only its owned child when graceful shutdown fails. There is no second
media transport or file cache.

The backend service is exported as a native Rust API and is consumed by the
registered Preview discovery/start and broadcast commands. No capture starts
automatically. Private unbundled debug builds may use `SAUCE_OBS_DEV_RUNTIME`;
packaged apps must use `Contents/Helpers/OBS.bundle/Contents`, with no developer
override. Ordinary release packaging does not include this runtime.

For a current-feature internal app, build and verify a new destination:

```sh
SAUCE_NDI_SDK_DIR='/Library/NDI SDK for Apple' npm run build:obs:internal -- \
  /absolute/path/to/diagnostic-runtime /new/absolute/path/SauceBunnyInternal.app
npm run verify:obs:internal -- /new/absolute/path/SauceBunnyInternal.app
```

This includes the application-profile OBS helper and separate NDI sender,
uses a stable signing identity, and neither installs nor launches the app.
The output remains `internalOnly: true`, `distributionReady: false`. The normal
`build:dmg`/`release:dmg` path does not add these helpers; the
[internal test image instructions](../docs/EMBEDDED-OBS-CAPTURE.md#internal-test-dmg-not-a-release)
describe wrapping the verified app without claiming notarization or distribution
clearance. It retains the production bundle identity and user-data paths; a new
output directory is not a separate user-data sandbox.

To retain the original single-worker generated-media regression (the shared
application supervisor is exercised by `verify-obs-service.mjs` above):

```sh
SAUCE_OBS_TEST_RUNTIME="$NEW_OUTPUT_DIR" SAUCE_OBS_TEST_FIXTURE="$GENERATED_TEST_MEDIA" \
  cargo test --manifest-path src-tauri/Cargo.toml --lib \
  commands::obs::worker::tests::native_obs_stream_uses_bounded_program_ring_and_stops \
  -- --ignored --nocapture
```

The controls are implemented and have mocked-IPC component/browser coverage.
Packaged Preview playback, full source/permission recovery, sustained real-editor
audio isolation, enclosing-app TCC validation, and release-source packaging
remain required gates. Internal runtime and enclosing-app signing have passed;
static signature checks do not prove those runtime behaviors.

Audio acceptance also checks the samples and picture timing, not just muxed
packet timestamps:

```sh
node scripts/verify-obs-audio-buffer.mjs "$NEW_OUTPUT_DIR"
node scripts/verify-obs-av-sync.mjs "$NEW_OUTPUT_DIR"
```

The first gate injects 50 ms arrival stalls into generated, continuous stereo
PCM. The old dynamic-buffer negative control must reproduce a silent mixer
block; three fixed-128-ms runs must reject that dropout. It captures no windows
and produces no audible output. The second encodes a generated flash/tone-burst
file through the actual native output and requires every interior pulse in both
channels to align within two 30 fps frames. Its oracle rejects missing pulses
and an artificial 128 ms audio offset. Real-editor/WKWebView timing remains a
separate required gate. For bounded generated-window diagnostics only, set
`SAUCE_OBS_TEST_AUDIO_TRACE=1` on `verify-obs-service.mjs`; production cannot
enable these capture/mixer sample summaries, and no PCM is logged.

Pinned upstreams:

- OBS 32.2.2: `ba2f32bdf791005443988a4955e963663e16b1ed`.
  Source archive SHA-256: `9a33756d87ce6831c6ddae8b6ea92c86b6cf61c693c9511a716673ba3a3caa5b`.
- [OBS macOS dependencies 2026-07-15](https://github.com/obsproject/obs-deps/releases/tag/2026-07-15),
  `macos-deps-2026-07-15-universal.tar.xz`:
  `4ecb4c598dfa853168df6c2a0c4e0ffec8495a81fbd1ba051ef88ecd5e0f7e53`.
  This includes FFmpeg n8.1.2 and SIMDe 0.8.2. Its supplied license directory
  is preserved in the private bundle; not every dependency in that collection
  is used by this helper. Full corresponding sources still need packaging.

See [the implementation plan](../docs/EMBEDDED-OBS-CAPTURE.md) for the complete
feature, packaging and real Avid acceptance gates. Before distribution, include
the full applicable license texts, notices and corresponding-source/build
materials for all bundled libraries. A link to upstream alone is not a claim
that these obligations have been satisfied.
