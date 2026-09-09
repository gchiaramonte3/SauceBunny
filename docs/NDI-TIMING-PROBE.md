# NDI timing probe — experimental, not sequence timecode

This probe answers a narrow question: **what timing and frame metadata does the
current NDI framesync output actually supply to Sauce Bunny's encoder?** It does
not prove which Premiere sequence frame a reviewer saw. Automatic marker
placement must remain disabled until a separate, real-media mapping passes the
acceptance matrix below.

## Safety and limits

- Off by default. Starting a probe does not discover, select, connect, publish,
  stop, or restart an NDI source. It requires an existing local source ID.
- Capture lasts 30 seconds by default; explicit durations are limited to 1–60
  seconds. It expires on the native polling clock even if the UI disappears.
- The last 600 observations are held in memory (about 20 seconds at 30 fps).
  `overwrittenSamples` makes retention loss visible. Incremental reads use
  `afterSequence`. Reading does not extend the capture or empty the ring.
- Start returns a new `probeId`. Read and stop require both that token and the
  original source ID. An old stop or in-flight frame cannot affect a new probe.
  Stopping the source also stops its probe; a replacement receiver has a new ID.
- Metadata is untrusted: copy at most 2,048 UTF-8 bytes while NDI owns the frame;
  report truncation or invalid UTF-8. Never parse XML entities, follow URLs, or
  interpret a sender's `verified` attribute as trusted application state.
- Observations have no per-frame Tauri event, are never put in peer media
  packets, and are not logged, saved, or uploaded automatically. Sender metadata
  may contain project names or other private information: review any diagnostic
  data before sharing it outside the editing machine.
- Probe errors do not fail program audio/video. Encoding remains exactly the
  existing fixed-raster H.264/AAC path with presentation timestamps `tick / 30`.

## Typed commands

Definitions live in `src-tauri/src/commands/ndi_timing.rs`; Rust tests generate
`src/bindings/NdiTimingProbeResult.ts`, `NdiTimingProbePhase.ts`, and
`NdiTimingSample.ts`. The commands are in `commands/ndi.rs`.

```ts
// Explicit user action only; keep the returned identities before scheduling reads.
const started = await invoke<NdiTimingProbeResult>("ndi_timing_probe_start", {
  id: localProgramId,
  durationSeconds: 30,
});
const current = await invoke<NdiTimingProbeResult>("ndi_timing_probe_read", {
  id: started.sourceId,
  probeId: started.probeId,
  afterSequence: lastReadSampleSequence,
});
await invoke<NdiTimingProbeResult>("ndi_timing_probe_stop", {
  id: started.sourceId,
  probeId: started.probeId,
});
```

One read per second is sufficient for a diagnostic UI; do not cause React
updates at the capture rate. SDK-free builds return an actionable unsupported
error. A stopped/replaced source may no longer be in the registry; treat that
error as capture completion, not a reason to reconnect it.

## What an observation means

| Field | Meaning; limits |
| --- | --- |
| `sampleSequence` | Ordered observation within this probe; not a sequence frame number. |
| `outputTick` / `outputTimescale` | Encoder presentation coordinate, timescale 30. Null when no encode was attempted. **Not Premiere ticks.** |
| `outputAccepted` | Pixel-buffer append accepted by the encoder. Not confirmation of encoded segment delivery or guest display. |
| `ndiTimecode` | Raw NDI signed 64-bit 100-nanosecond value, kept as a decimal string. May be synthesized clock time. |
| `ndiTimestamp` | Raw sender-SDK timestamp, not a sequence location; unavailable sentinel is preserved. |
| `metadata` | Whatever frame metadata survives at framesync output, if any. Null is meaningful evidence, not an error to fill with CTI. |
| `sameTimingAsPreviousCapture` | Timecode and timestamp equal the preceding valid capture in this probe. A diagnostic hint only: two pictures can have equal clock fields. |
| `receivedFrames`, `ndiDroppedFrames`, `encoderDroppedFrames` | Independent cumulative counters, preserved as decimal strings. Framesync can also drop/repeat without a receiver-drop increment. |
| `lastInputAgeMs`, `stale` | Age since the receive counter last advanced; stale after two seconds. Does not make a parked picture a valid sequence anchor. |
| `timingVerified` | Always `false`. Neither a synthetic test nor a hand-entered mapping changes it. |

## Automated proof

```sh
cd src-tauri
cargo test --lib commands::ndi::
cd ..
SAUCE_NDI_SDK_DIR='/Library/NDI SDK for Apple' bash scripts/test-ndi.sh 30/1
SAUCE_NDI_SDK_DIR='/Library/NDI SDK for Apple' bash scripts/test-ndi.sh 60/1
```

The opt-in harness sends **generated video and stereo tones only**. It runs two
receivers, enables timing on just one, exercises initial placeholder and raster
changes, stalls the sender for four seconds, and verifies recovery. Probe
records must not enter the `.mp4`; ffprobe still validates fixed 1920×1080
H.264 at 30/1 and stereo 48-kHz AAC. Native helper assertions cover bounded UTF-8
copying and exact signed 64-bit decimal values even if the installed SDK omits
sender metadata. Metadata propagation is reported separately, not assumed.

Rust tests cover ring capacity, retention counters, exact decimal values,
expiry, cancellation, old-probe rejection, invalid packets, source isolation,
and absence of diagnostic records from peer media. Passing these tests is not
the Premiere timing acceptance gate.

### Observed synthetic results, 2026-09-07

- SDK-free Rust: 34 focused NDI tests passed. SDK-enabled Rust: the same 34
  passed; the existing discovery-only manual test remained intentionally ignored.
- 30/1 synthetic input: 418 observations, 370 accepted output frames, valid XML
  metadata and truncation observed, repeated timing during the interruption,
  and successful recovery. The probe-free second receiver had zero observations.
- 60/1 synthetic input: 418 observations, 371 accepted output frames, repeated
  timing and valid XML observed, successful recovery, zero observations in the
  probe-free receiver. Both outputs remained 1920×1080 at 30/1 with stereo AAC.
- Malformed non-XML sender data did not propagate in an initial synthetic run;
  valid XML did. Therefore metadata absence must be reported, not interpreted
  as either a bridge failure or proof that every sender supplies no metadata.
  Native helper tests independently passed invalid UTF-8 and bounded-copy checks.

These runs used a generated sender, **not Premiere**, and measured neither
end-to-end picture delay nor sequence-frame accuracy. They do not unlock
automatic placement or replace the real Premiere/guest matrix below.

## Required real Premiere matrix — not yet passed

Use a disposable Premiere 26.3.2 project and the official NDI output plugin.
Enable sequence timecode/frame overlays and **overlays for Transmit** as a
visible test oracle. Do not implement OCR as the production clock.

For each of 23.976, 24, 25, 29.97 DF, 29.97 NDF, 30, and 60 fps input (the last
through 30-fps output), record these cases:

1. Park at known sequence frames including a nonzero start timecode. Compare
   overlay, raw NDI fields, optional frame metadata, and companion CTI reading.
   Report missing fields and rounding discrepancies explicitly.
2. Play forward; J/K/L reverse; jump several minutes; alternate rapid forward
   and reverse scrubs. Demonstrate whether the frame fields follow the picture
   or merely the sender's clock. Never subtract a fixed network delay from CTI.
3. Switch sequences, open a clip in Source Monitor, change output raster, leave
   Premiere in the background, and restart it. Missing identity must hold notes,
   never redirect them to the newly active sequence.
4. Interrupt output for four seconds. Preserve the parked last frame, observe
   stale and recovery, and prove old picture/timing cannot acquire a new source
   identity. Include frame-repeat and encoder-backpressure cases.
5. With a real guest, vary latency and cause dropped segments. Capture a note
   when typing begins; finish it much later. Prove the anchor is the frame that
   **that guest displayed**, not the host's newest accepted encode.

Required evidence for automatic placement: frame-associated project/sequence
identity and exact sequence ticks must survive encoding, drops, repeats, source
switches and each guest's decoded-frame callback. The probe observes only the
encoder-input side of that chain. If the official sender does not supply enough
information, keep editor-confirmed marker placement and investigate a native
Mercury Transmit component as a separate milestone.

References: [NDI frame types](https://docs.ndi.video/all/developing-with-ndi/sdk/frame-types),
[NDI timecode synthesis](https://docs.ndi.video/all/developing-with-ndi/sdk/ndi-send),
[Adobe transmitted overlays](https://helpx.adobe.com/in/premiere/desktop/organize-media/edit-metadata/display-metadata-as-overlays.html),
[Adobe transmitter structures](https://ppro-plugins.docsforadobe.dev/transmitters/tmModule-structures/).
