# Bundled sidecar versions

This file tracks the version of every binary we ship under
`src-tauri/binaries/`. Updated automatically by the scripts under
`scripts/` — do not edit by hand.

## Integrity: sidecars.lock.json

Versions are not the same as bytes. Every binary that ships inside the `.dmg`
is also pinned by SHA-256 in `sidecars.lock.json` at the repo root, checked in
three places:

- **On fetch** — `refresh:sidecars` and `refresh:ffmpeg` verify the download
  BEFORE it is made executable or installed. The order matters: the smoke test
  runs the binary, and "it runs" is not evidence that it is the artifact we
  reviewed.
- **On demand** — `npm run verify:sidecars` checks everything installed.
- **On release** — `npm run check:release` refuses to pass on a mismatch.

This is trust-on-first-use, and it exists because two of these downloads had no
upstream integrity story at all: ffmpeg is discovered by SCRAPING a vendor's
homepage for a filename, and yt-dlp came from a mutable "latest" pointer. What
ended up inside a signed build was whatever the network served that day. The
committed lock file is the only anchor a compromised publisher cannot move.

Accepting a new upstream build is deliberate:

```bash
npm run refresh:ffmpeg -- --accept-new   # verifies, then moves the pin
git diff sidecars.lock.json              # THIS is the review step
```

For a locally built sidecar (whisper-cli, llama-server, the Swift three) a
changed hash means a rebuild, not an attack. Re-pin it explicitly:

```bash
npm run repin:sidecar whisper-cli -- --note "rebuilt against whisper.cpp v1.8.2"
```

Never re-pin to silence an error. For a DOWNLOADED sidecar, a changed hash is
exactly the event this mechanism exists to surface.

Every bundled binary MUST be self-contained (no `/opt/homebrew/`,
`/usr/local/`, or `/Users/` dylib references) so the app actually
works on a user's Mac. Each script enforces this with an `otool -L`
guard rail and refuses to install a leaky binary.

| Binary | Updater | Source |
|---|---|---|
| `yt-dlp-aarch64-apple-darwin` | `npm run refresh:sidecars` | yt-dlp official GitHub release (single-file static) |
| `ffmpeg-aarch64-apple-darwin` | `npm run refresh:ffmpeg` | osxexperts.net (static arm64) |
| `ffprobe-aarch64-apple-darwin` | `npm run refresh:ffprobe` | ffmpeg.martin-riedl.de (static arm64) — yt-dlp finds it beside ffmpeg for HLS fixup |
| `whisper-cli-aarch64-apple-darwin` | `npm run build:whisper` | whisper.cpp source, CMake `-DBUILD_SHARED_LIBS=OFF` |
| `saucebunny-diarize-aarch64-apple-darwin` | `npm run build:diarizer` | `swift-sidecar/` (SPM, owned by us) |


## whisper-cli
- version: e0fd1f6787a5bd4a4957dd97c5b64df882ee7b0c (commit e0fd1f6)
- source: https://github.com/ggerganov/whisper.cpp (built from source, static)
- refreshed: 2026-05-25

## ffprobe
- version: 8.1.1
- source: https://ffmpeg.martin-riedl.de/ (static arm64 build)
- refreshed: 2026-06-04

## llama-server
- version: 88a39274ecf88ba11686acd357b59685b1cbf03d (commit 88a3927)
- source: https://github.com/ggml-org/llama.cpp (built from source, static)
- refreshed: 2026-06-12

## ffmpeg
- version: 8.1
- source: https://www.osxexperts.net/ (static arm64 build)
- refreshed: 2026-07-19

## yt-dlp
- version: 2026.07.04
- source: https://github.com/yt-dlp/yt-dlp (official single-file macOS static build)
- refreshed: 2026-07-22
