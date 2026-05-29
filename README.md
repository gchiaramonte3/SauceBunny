# Sauce Bunny

A Mac-first local desktop app for clipping a section of a YouTube video into an MP4. Tauri 2 + React + bundled `yt-dlp` and `ffmpeg`.

## Personal-use only

This is a local utility — no cloud, no accounts. Use it on content you have the rights to clip.

## Dev

```
npm install
npm run tauri dev
```

First build pulls all Rust dependencies and takes a while.

## Bundled binaries

`src-tauri/binaries/` ships two sidecars, both suffixed with the Mac arm64 target triple Tauri expects:

- `yt-dlp-aarch64-apple-darwin` — official macOS yt-dlp release
- `ffmpeg-aarch64-apple-darwin` — copied from Homebrew (`/opt/homebrew/bin/ffmpeg`)

The Homebrew ffmpeg dynamically links against dylibs under `/opt/homebrew/Cellar/...`, so the resulting `.app` is not portable to other Macs without those dylibs. For personal use on the build machine this is fine; for distribution, replace with a static ffmpeg build.

## Architecture

- `src/` — React UI. Single window: URL → metadata → Mark In / Mark Out → output folder → Pull Clip.
- `src-tauri/src/commands.rs` — Rust commands: `fetch_metadata`, `create_clip`, `reveal_in_finder`, `new_job_id`. All argument arrays — never raw shell strings.
- `src-tauri/capabilities/default.json` — sidecar allow-list (only the two binaries we ship).

## Clip flow

```
yt-dlp \
  --download-sections "*HH:MM:SS-HH:MM:SS" \
  -f "bv*+ba/b" \
  --merge-output-format mp4 \
  --ffmpeg-location <bundled ffmpeg> \
  --no-playlist --no-part --newline --progress \
  -o <output path> \
  <url>
```

Progress is streamed back as `clip-log` events; completion fires `clip-done`.
