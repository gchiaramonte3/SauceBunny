# Bundled sidecar versions

This file tracks the version of every binary we ship under
`src-tauri/binaries/`. Updated automatically by the scripts under
`scripts/` — do not edit by hand.

Every bundled binary MUST be self-contained (no `/opt/homebrew/`,
`/usr/local/`, or `/Users/` dylib references) so the app actually
works on a user's Mac. Each script enforces this with an `otool -L`
guard rail and refuses to install a leaky binary.

| Binary | Updater | Source |
|---|---|---|
| `yt-dlp-aarch64-apple-darwin` | `npm run refresh:sidecars` | yt-dlp official GitHub release (single-file static) |
| `ffmpeg-aarch64-apple-darwin` | `npm run refresh:ffmpeg` | osxexperts.net (static arm64) |
| `whisper-cli-aarch64-apple-darwin` | `npm run build:whisper` | whisper.cpp source, CMake `-DBUILD_SHARED_LIBS=OFF` |
| `saucebunny-diarize-aarch64-apple-darwin` | `npm run build:diarizer` | `swift-sidecar/` (SPM, owned by us) |

## ffmpeg
- version: 8.1
- source: https://www.osxexperts.net/ (static arm64 build)
- refreshed: 2026-05-25

## whisper-cli
- version: e0fd1f6787a5bd4a4957dd97c5b64df882ee7b0c (commit e0fd1f6)
- source: https://github.com/ggerganov/whisper.cpp (built from source, static)
- refreshed: 2026-05-25
