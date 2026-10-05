# Program capture: Preview ▸ Source ▸ Screen / Window / Region

Status: Phase 0 (spike) done 2026-10-05. Phase 1 (Screen) built 2026-10-05: Preview ▸ Source ▸ Screen
runs on the picker; Window and Region still show the OBS controls until Phases 2 and 3 replace them.

## Why this exists

The Preview source dialog's Screen, Window and Region tabs used an embedded
OBS (libobs, GPL) helper that ordinary builds never included, so every user
saw "The embedded OBS capture runtime is missing". Shipping OBS publicly would
mean GPL corresponding-source obligations on every release (OBS, our patches,
and the GPLv3 FFmpeg/x264 inside OBS's dependency bundle), a boundary to
defend between GPL output and the proprietary NDI SDK, and it would not fix
the permission experience: on macOS OBS captures through ScreenCaptureKit the
way that needs Screen Recording permission and raises macOS 15/26's monthly
"bypass the system private window picker" alert. OBS tried Apple's picker and
abandoned it (obs-studio PR #11139).

So capture runs on ScreenCaptureKit directly, chosen through macOS's own
sharing picker (`SCContentSharingPicker`, macOS 14): no Screen Recording
permission for the picture, and no monthly alert. Decided by the owner on
2026-10-05.

## Shape

- `saucebunny-program-capture` (swift-sidecar/, MIT), packaged as
  `Contents/Helpers/Sauce Bunny Capture.app` (`com.saucebunny.desktop.capture`,
  `LSUIElement`). The filter the picker returns is valid only inside the
  process that showed it, so the process that chooses is the process that
  streams: one long-lived helper with two slots.
- **Choose, then start.** `choose` shows the picker and returns a token; `start`
  takes a token and never shows UI, so the person's time in the picker never
  counts against the 12 s first-media watchdog. Tokens die with the helper:
  after a relaunch the UI says "Choose again" (macOS cannot persist a pick).
- The stdout records are the OBS service's (`commands/obs/service_wire.rs`):
  14-byte header, kind 1 fMP4, 2 status, 3 end, plus 4 choice result.
- Encoding is the NDI input's recipe (`src-tauri/native/ndi_bridge.mm`):
  AVAssetWriter fMP4, 100 ms segments, keyframe every 3 frames, no reordering,
  H.264 Main (`avc1.4d0028`), 6 Mbps, AAC-LC 48 kHz stereo, fed by SCK '420v'
  buffers at the encoded size and a 30 Hz pacer that repeats the last picture.
- Audio comes from a Core Audio process tap (macOS 14.2+, "System Audio
  Recording Only"), because a picker stream's own audio is silence without a
  Screen Recording grant.

## Spike findings (macOS 26.5, Mac Studio, 2026-10-05)

The helper was built as a bare `.app` (ad-hoc signed, hardened runtime),
launched from a shell, and run in its `--spike` mode.

| Question | Answer |
|---|---|
| Can the helper (accessory app) show the picker and receive the filter? | **Yes.** `present(using: .display)`, observer `didUpdateWith` delivered a display filter. |
| Any Screen Recording permission check? | **None logged** by TCC for the helper during either run. (Owner to confirm no prompt or alert appeared.) |
| What does a picker filter expose without permission? | `style` (display), `contentRect` (points: 2560×1080 at 0,0) and `pointPixelScale` (2): enough to size the raster. |
| Output format fits `framing.rs` and the Preview player? | **Yes.** H.264 Main level 4.0 (`avc1.4d0028`), keyframe every 3 frames, AAC-LC 48 kHz stereo; top-level boxes are one `ftyp`+`moov` then only `moof`+`mdat` pairs (no `styp`/`sidx`). 8 s: 233 frames received, 239 encoded (pacer repeats), 79 fragments. Picture not black (luma mean 46, sd 33). |
| `sourceRect` on a picker display filter (Region)? | **Yes.** Normalized 0.25,0.25,0.5,0.5 → 1280×540 pt at 640,270; 30 fps. |
| Reuse one pick for a second stream? | **Yes.** A second `SCStream` on the same filter 2 s after the first stopped ran normally (172 frames in 6 s). |
| Process tap audio? | **Yes.** A global tap excluding the helper delivered 48 kHz audio; a 440 Hz test tone played by `afplay` measured 439 Hz in the recording. |

Still open, for Phase 1 inside the app: whether `excludedBundleIDs` keeps Sauce
Bunny's own windows out of the captured **content** (not just the picker
list); the tap's permission prompt naming Sauce Bunny when the app spawns the
helper; keeping Sauce Bunny's own playback (its WebKit processes) out of a
system-audio tap; the stop paths (menu bar Stop sharing, window close, display
unplug); and A/V sync against the flash/tone oracle.

## Phase 1 as built

- Helper: `swift-sidecar/Sources/saucebunny-program-capture/` (`--service`
  mode: Service.swift; picker: Picker.swift; capture and pacer: Capture.swift;
  encoder: Encoder.swift; tap: AudioTap.swift), pure parts in
  `Sources/ProgramCaptureCore/` (Wire, Raster, Control) under `swift test`.
  `scripts/build-program-capture.sh` builds and signs `Sauce Bunny Capture.app`
  (356 KB); `build-app-with-ndi.sh` copies it to `Contents/Helpers` through a
  generated `bundle.macOS.files` config.
- Supervisor: `src-tauri/src/commands/obs/picked.rs`, a focused supervisor
  rather than the OBS service, because the helper must outlive any one capture
  (it holds the picks). It reuses `service_wire.rs`, `framing.rs`, `Program`
  and the OBS watchdog thresholds. Commands: `program_capture_preflight`,
  `program_capture_choose` (job id from the renderer, cancellable),
  `program_capture_cancel_choose`, `program_capture_start`. A pick is a third
  case of `ObsSelection` (`Picked`), so status, room sharing and the frontend
  coordinator take it unchanged; the rename away from `obs_*` waits for Phase
  5, when the OBS cases are deleted.
- Frontend: `ProgramCaptureControls.tsx` (Choose screen…, Waiting for your
  choice…, Selected, Choose another screen…). A pick starts its preview at
  once: the picker's Share click is the go-ahead. A pick the helper no longer
  holds says "Choose again".
- Audio: the tap excludes the helper and the app's main process. The Preview
  monitor starts muted for a local capture, so its own playback (played by
  WebKit's audio process, which the tap may not exclude) does not feed back
  unless the person unmutes it; whether to exclude WebKit's processes too is
  open (it needs an undocumented call) and waits for the hand test.
