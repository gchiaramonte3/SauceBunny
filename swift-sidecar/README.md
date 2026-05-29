# `swift-sidecar/` — Sauce Bunny diarizer

Single-purpose Swift package that builds **`saucebunny-diarize`**, the speaker-diarization sidecar binary shipped alongside `yt-dlp`, `ffmpeg`, and `whisper-cli`.

The CLI wraps [FluidAudio](https://github.com/FluidInference/FluidAudio)'s `OfflineDiarizerManager` (VAD → speaker embeddings → clustering, all via Core ML on the Apple Neural Engine) behind a tiny argv interface so the Tauri Rust shell can invoke it the same way it invokes any other sidecar.

## Build

```bash
npm run build:diarizer            # arm64-only, the dev default
npm run build:diarizer:universal  # arm64 + x86_64 (slower, for distribution)
```

The script (`scripts/build-diarizer.sh`) does `swift build -c release`, copies the resulting binary into `src-tauri/binaries/saucebunny-diarize-<target-triple>`, makes it executable, and prints a `--version` line as a smoke test.

First build downloads the FluidAudio SwiftPM package (~10s on a warm cache). First *runtime* invocation downloads the Core ML model files to `~/.cache/fluidaudio/Models/` (hundreds of MB, one-time per machine).

## Usage

```bash
# After building, the binary lives at:
src-tauri/binaries/saucebunny-diarize-aarch64-apple-darwin --help

# Typical call:
./saucebunny-diarize-aarch64-apple-darwin \
  --input  /tmp/audio.wav \
  --output /tmp/turns.json \
  --emit-progress
```

Output JSON envelope (v1):

```json
{
  "schema_version": 1,
  "model": "fluidaudio-offline-diarizer",
  "model_package_version": "0.12.4",
  "audio_seconds": 4013.0,
  "wall_clock_seconds": 32.7,
  "turn_count": 184,
  "turns": [
    { "speaker": "SPEAKER_00", "start": 0.18, "end": 3.42 },
    { "speaker": "SPEAKER_01", "start": 3.50, "end": 8.10 }
  ]
}
```

With `--emit-progress` the binary also writes newline-delimited JSON status lines on stdout (`{"phase":"prepare",...}` → `{"phase":"process",...}` → `{"phase":"done","turns":N}`). The Rust shell parses these to drive a Whisper-style progress channel.

## Platform notes

- **macOS 14+ only.** `Package.swift` pins `.macOS(.v14)` because FluidAudio's Core ML pipeline + the async APIs we use require it. The main Sauce Bunny app still installs on macOS 11+; diarization is the one feature that errors on <14.
- **Not checked into git.** The built binary is large + per-machine + needs signing. Run the build script after cloning. `cargo build` / `tauri dev` will fail clearly if the binary is missing.
- **Signing.** Ad-hoc-signed at build time. `tauri build` re-signs sidecars with the app's identity during bundling, no extra step required.

## When to upgrade FluidAudio

Bump `from: "0.12.4"` in `Package.swift` deliberately — the package is still 0.x and the surface we depend on (`OfflineDiarizerManager`, `OfflineDiarizerConfig`, `OfflineDiarizationResult.segments[].{speakerId, startTimeSeconds, endTimeSeconds}`) could rename. After bumping, re-run `npm run build:diarizer` and `saucebunny-diarize --version` to confirm.
