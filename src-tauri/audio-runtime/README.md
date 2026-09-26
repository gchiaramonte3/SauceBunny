First-party optional audio-evidence worker. Build with `npm run build:audio-analysis`.

Only the generated executable and receipt are bundled here; both are gitignored.
It uses system AVFoundation/SoundAnalysis, not a downloadable model or microphone.
The feature-flagged Advanced Intelligence preview requests it after visual
descriptions. Raw suggestions are not calibrated music detections or genres.
See `docs/VIDEO-INTELLIGENCE.md` for integration and calibration gates.
