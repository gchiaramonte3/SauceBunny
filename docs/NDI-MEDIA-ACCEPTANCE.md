# Premiere media acceptance runbook

This is a test procedure, not evidence that the gates passed. Current results
and build status are in [NDI-CONNECTION-DELIVERY.md](NDI-CONNECTION-DELIVERY.md).
Use an internal local .app until the actual host and guest gates pass; do not
build the DMG merely because the automated suites pass.

## Preserve the editor's work

Ask before creating a separate temporary Premiere project or changing the
active project. Do not import calibration clips into an existing edit, save
over it, alter sequences, install software, or change system network/audio
settings without the appropriate user approval. Record Premiere and Sauce
Bunny versions, build path, machine, display refresh rate, and audio route.

## Prepare input media

From the repository root:

```sh
node scripts/create-premiere-ndi-fixtures.mjs
```

The command creates a new temporary directory, prints its location, and probes
all seven movies. It does not open Premiere. The six 18-second 1080p AV-sync
movies contain a large frame number and synchronized flash/beep at exact rates
24000/1001, 24, 25, 30000/1001, 30, and 60. The separate 30-fps stereo movie
alternates left-only 440 Hz and right-only 880 Hz every two seconds. Input audio
is 48-kHz stereo PCM to avoid AAC encoder priming in the test source.

With permission, create each test sequence from its corresponding clip in the
separate calibration project; do not force every clip into a 30-fps sequence.
Use loop playback for sustained tests. Keep local program monitoring muted
until an audio check is explicitly started, preferably using headphones.

## Host matrix

### Stop-start playback regression gate

Before shipping any NDI transport/decoder change, run the real native encoder
and sustained decoded-audio test (SDK installed on the test Mac):

```sh
SAUCE_NDI_SDK_DIR='/Library/NDI SDK for Apple' bash scripts/test-ndi.sh 24/1 continuous
```

Repeat at `30/1` and `60/1` for release qualification. Continuous mode creates
only its own synthetic moving picture and stereo tones, validates both encoded
tracks' timestamp continuity, then runs the production browser decoder three
times with repeated 300 ms delivery bursts. Each run measures 15 seconds after
startup: both audible channels, silent-gap duration, clock stalls, frame count,
and seek count. A single nonzero peak is not a continuity test. Run this alone,
not concurrently with another Playwright suite sharing port 51730.

The normal `npm run verify` gate also tests the native reader's full eight
fragments, partial reads, telemetry interleaving, true overload recovery, the
decoder's startup reserve, and a delayed-seek clock. These tests must fail if
the old two-fragment skip cutoff, immediate autoplay, backward recovery seek,
or narrow catch-up hysteresis returns. The opt-in media test supplements them;
it does not replace real WKWebView/Premiere playback and the host/guest matrix.

For the native app, measure a moving Premiere sequence (verify its timecode
advances), not only a parked picture. Record `seeking`, `waiting`, `stalled`,
`pause`, decoded frames, buffered ranges, and clock advance over the same
interval. Program must be unmuted; confirm audibility separately. No telemetry
or console result by itself proves the listener's output device or A/V sync.

### Manual matrix

In Premiere 2026, enable Mercury Transmit and NDI video output, set Primary
Audio Device to NDI output, use Full playback resolution, and leave background
video output enabled. In Sauce Bunny use Connect Premiere, select the source
explicitly, and Preview source. Previewing must not create or publish a room.

For each of the six matching sequences, record actual input dimensions/rate,
measured output rate, video/audio drops, picture, and audio. A 60-fps input must
keep the fixed session output at the prototype's 30-fps cap. Check portrait and
resolution changes without replacing the monitor or changing the output raster.

Across the matrix, log 50 mixed play/pause, J/K/L, scrub, and frame-park actions.
Also check sequence switching, backgrounding, output disable/re-enable, and
Premiere restart. Do not count synthetic sender actions as Premiere actions.

Acceptance requires:

- Discovery within five seconds of enabling output and host picture within
  three seconds of source selection.
- No blank replacement of a valid picture during a four-second interruption;
  visible disconnected/stale state and recovery without restarting Sauce Bunny.
  A connected, parked Premiere picture must not be labelled disconnected.
- No crash, receiver restart, or frozen audio during the 50 mixed actions.
- Correct stereo routing and continuous microphone/camera conversation through
  input start, stop, stall, and recovery. Keep program and conversation audio
  controls independent; private-preview audio must not reach guests.
- Steady 1080p30 receiver and encoder drops below 1%. Measure counter deltas
  over the same steady interval; report receiver and encoder losses separately.
  Intentional 60-to-30 frame selection is not an encoder failure.

## Measure latency and audio sync

Use a synchronized recording of Premiere's Program Monitor and Sauce Bunny's
monitor showing the frame-number fixture. For remote tests, the capture method
must have a shared timing reference; do not subtract unrelated device clocks.
Account for test-loop wrap and the exact rational source frame rate. Report
multiple samples, maximum delay, and the recording's temporal resolution.

For A/V, capture the displayed flash and the corresponding program beep in one
recording and measure their separation. Identify the audio route and account
for the capture device's own audio/video offset. A listening impression, output
frame cadence, and the UI's playback buffer are not end-to-end measurements.

Required limits: host picture delay at most 1.25 s, guest picture delay under
2 s on at least 10 Mbps upload and approximately 50 ms RTT, and A/V offset within
80 ms. Preserve the measurement recording and calculations with the test log.

## Memory and dual-source preview

Use a 30-minute moving 1080p run with a published feed and a different private
candidate. Include repeated candidate preview/cancel/failure/retry while the
published feed continues. A parked single-source baseline is useful but cannot
satisfy this gate. Do not change or restart the measured app during a run.

Identify the app and its own WebContent process before starting the profiler:

```text
node scripts/profile-ndi-processes.mjs 1800 moving-1080p-published-and-private <native-pid> <webcontent-pid>
```

The read-only profiler verifies process identity, samples RSS every 20 seconds,
and samples physical footprint every five minutes. It writes a new temporary
directory containing samples.jsonl and summary.json. Record any other media or
build workload, sample gaps, process exits, and excluded GPU/media processes.
Inspect the post-warm-up trend and recovery after cancelling the candidate;
neither a successful script exit nor rising RSS alone is a stability verdict.

## One real guest

Use a second Mac with Sauce Bunny and no external NDI Tools or SDK. The host
uses Premiere's official plugin; the guest receives Sauce Bunny's encoded
program channel, not raw NDI. A second browser tab or mocked transport is not
this test. Obtain permission before inviting anyone or sending their media.

1. Publish a file or program feed. Preview a different NDI source privately on
   the host. Confirm the guest still sees and hears the old published source,
   including file transport. Room notes remain attached to that old source.
2. Cancel, refresh discovery, and exercise candidate failure. The guest must
   remain unaffected. The room's note/drawing context stays on the published
   source, and incoming notes continue saving. The modal temporarily owns
   keyboard focus; closing it restores the usable room composer. A private
   candidate must never set the room's picture-readiness or note-blocking state.
3. Publish the ready candidate once. The guest keeps the old frame until the
   new picture paints, and only then targets the new review context. General
   and manually timecoded notes remain unverified; no hidden-file timing.
4. Stop sharing, late join, disconnect/reconnect, hand off presentation, and
   leave the room. Private media must never become accessible. Revocation must
   stop existing media readers. Stop sharing keeps the host's local preview;
   handoff/leave stops room-associated native sessions.
5. With approved network shaping, constrain the guest while transferring a
   background file. Record actual bandwidth/RTT, delay, dropped/obsolete
   segments, and note acknowledgements. Slow guests must not delay the host;
   comments must survive disconnect/retry without duplication or misfiling.

## Evidence and build decision

For every case record pass/fail/not-run, exact build, source/sequence/rate,
actions, timestamps, measurements, artifacts, and any limitation. Run the full
frontend, browser, Rust SDK-enabled/SDK-free, and package suites after fixes.

Only after actual host and one-guest media gates pass, build the internal DMG,
verify bundled-runtime provenance/signatures/notices, final privacy keys,
sidecars/CSP, and absence of SDK/Tools/plugin payloads or external runtime
dependencies. Repeat discovery, picture, stereo, stall recovery, and Clip/Review
navigation using the DMG-installed application. Keep experimental status until
the later 2–4-user one-hour constrained-network soak passes.
