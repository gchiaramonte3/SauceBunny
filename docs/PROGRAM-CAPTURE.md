# Program capture: Preview ▸ Source ▸ Screen / Window / Region

Status: Phase 0 (spike) done 2026-10-05. Phases 1 to 3 (Screen, Window, Region) built 2026-10-05: every
Preview ▸ Source capture tab runs on the picker and nothing in the app reaches the OBS controls. NDI
broadcast of a picker capture (Phase 4) and deleting the OBS code (Phase 5) remain. The owner chose the
picker for the whole app on 2026-10-05, so co-review's Share your screen moves onto it next.

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

## Phases 2 and 3 as built

- **The seam bug.** The first picker build read the helper's records with the
  OBS service's reader, which accepted kinds 1 to 3 only, so every pick's
  answer (kind 4) ended the service with "The screen capture helper stopped".
  Neither side's unit tests crossed the boundary. `Wire::through(5)` fixes it,
  and `the_real_helper_answers_through_this_reader` runs the built helper
  through the reader (it fails with the old limit).
- **Window**: the picker in `.singleWindow` or `.singleApplication` mode, the
  second for windows that will not pick on their own (a remote-desktop viewer
  filling another display). Its sound is the owning app and its helpers,
  matched by bundle identifier; a picker filter names the app only from macOS
  15.2, so before that application audio is off with the reason shown.
- **Region**: a display pick, then a still to draw on. The still is a JPEG of
  the first frame of a short stream on the pick itself (`snapshot` op, kind-5
  records), never a system screenshot, so it needs nothing the picker did not
  already grant. A region starts only on Preview. There is no live Edit or
  on-screen border yet; the area is changed in the dialog and previewed again.
- **Whose sound**: Audio from ▸ every app but Sauce Bunny (the default for a
  screen or region), this app only (a window), or only the apps ticked (the
  `apps` op lists running apps by name; a start carries their bundle
  identifiers). "Every app but Sauce Bunny" leaves out WebKit's processes,
  which play the app's own audio including a session's voices, so nobody hears
  themselves; Safari plays through the same processes and is left out with
  it. That avoids the undocumented responsibility call the plan raised.
  The tap re-reads Core Audio's process list every second, because an app has
  no audio process until it first plays and helpers come and go.
- **Native Edit retired**: the OBS region overlay's Edit (`obs:edit-source`,
  `use-obs-region-edit`) had no source left to edit and is gone, with the OBS
  window list, display list and preflight commands the old tabs used.
- **Not yet**: Broadcast to NDI is not offered for a picker capture (Phase 4).
