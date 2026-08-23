# Sauce Bunny 🐰

[![CI](https://github.com/gchiaramonte3/SauceBunny/actions/workflows/ci.yml/badge.svg)](https://github.com/gchiaramonte3/SauceBunny/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Platform: macOS 14+ · Apple Silicon](https://img.shields.io/badge/platform-macOS%2014%2B%20·%20Apple%20Silicon-black)
![Built with Tauri 2 · React 18](https://img.shields.io/badge/built%20with-Tauri%202%20·%20React%2018-24C8DB)

**Local-first macOS app for pulling, transcribing, and clipping video — no accounts, no telemetry, and no cloud unless you explicitly opt in.**

Paste a URL (YouTube, Vimeo, TikTok, X, Reddit, Instagram, or any page with embedded video) or import a local file. Watch it instantly, mark in/out points frame-accurately, export lossless clips or MP3s, and generate speaker-labeled transcripts — everything runs on your machine.

## Features

- **Instant web playback** — streams web sources straight into the player (no full download wait) via a loopback ffmpeg→MSE pipeline, with an automatic download-to-cache fallback. Seek anywhere; J-K-L shuttle; frame-accurate scrubbing with a WebCodecs preview.
- **Transcription** — local Whisper (whisper.cpp) with downloadable models, or pull the source's own captions in one click. Captions stay locked to the audio you hear — the streamed video is the single clock for audio, picture, and captions; a "Fix timing with Whisper" button re-times loose YouTube auto-captions.
- **Speaker diarization** — on-device speaker detection (SpeakerKit, FluidAudio fallback) with a full speaker editor: rename, drag-to-merge, per-turn overrides, color-coded roster.
- **Transcript workspace** — searchable karaoke-highlighted reader, click any line to jump the video, pop it out to its own floating window, export TXT/MD/SRT/PDF.
- **AI Summary** — a local LLM (llama.cpp) summarizes the transcript on-device, speaker-aware, with clickable timecodes that jump the video.
- **Review workspace** — Frame.io-style timecoded threaded comments, freehand frame annotations, and on-device **voice dictation** (mic → text); export notes to Markdown, a CSV marker sheet, or a CMX3600 EDL.
- **Co-review (watch party)** — host a peer-to-peer session with a one-line join code (iroh QUIC, end-to-end encrypted — no accounts, no cloud). Guests follow your playhead; comments, replies, and likes converge live across everyone; ghost playheads show where each person is parked. A cinematic **screening mode** puts the participant rail, viewport, and comments in a Louper-style theater layout. Web sources only for now.
- **Clip export** — lossless cuts or re-encodes, full-clip or marked range, MP3 audio export, an export queue, on-video captions drawn from your transcript.
- **Command palette** (⌘K), rebindable shortcuts, customizable defaults, dark editorial UI.

## Privacy & local-first

Everything happens on your Mac by default. There are no accounts and no
telemetry: nothing is ever sent about how you use the app. Every path that
touches the network is listed here — if you find one that is not, that is a bug
worth filing.

| what | when | where it goes |
|---|---|---|
| The video, captions and page metadata | You paste a URL or press Fetch | The site you asked for, via yt-dlp |
| Whisper / LLM / diarizer models | You choose to download one | Hugging Face, GitHub |
| A yt-dlp update | You press Update in Settings | GitHub |
| **Co-review session traffic** | You host or join a session | Directly to your peers over encrypted iroh QUIC. If a direct route cannot be found, *control* traffic (kilobytes: comments, playhead) falls back to n0's public relay. Media never uses the relay |
| **Cloud AI** — *off unless you turn it on* | You configure your own Anthropic or OpenAI key in Settings ▸ AI APIs, and only for AI Summary / Analysis | Anthropic or OpenAI. The key is stored in the macOS Keychain, is never readable back by the app's frontend, and the request is made from Rust so it never touches the browser layer. The default is a local model, and the app works fully with no key at all |

Optional: sign-in-gated sources can use your browser's cookies via yt-dlp's
`--cookies-from-browser` — off by default, configured in Settings.

See [SECURITY.md](SECURITY.md) for the threat model (including the loopback
media proxy).

Use it on content you have the rights to clip.

## Install

**Requirements:** macOS 14+, Apple Silicon.

Grab the notarized `.dmg` from [Releases](../../releases) — or build from source:

```bash
git clone https://github.com/gchiaramonte3/SauceBunny.git "Sauce Bunny"
cd "Sauce Bunny"
npm install
npm run setup        # fetches/builds the sidecar binaries (one-time)
npm run tauri dev
```

Build prerequisites: Xcode Command Line Tools, Rust 1.77+, Node 20+, Swift 5.9+. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full dev guide.

## Development

```bash
npm run tauri dev        # run the app — hot-reload frontend + Rust
npm test                 # vitest: SRT/timecode/proxy/validation units
npm run check:release    # audit sidecars + entitlements + signing before a build
```

Before opening a PR, run the full gate:

```bash
npm run verify
```

That is every check CI runs — types, units, lint, `cargo check` / tests /
clippy, the Swift sidecar, the licence scan and the Playwright smoke — in one
command, and it keeps going after a failure so you see the whole picture
rather than the first thing that broke. It is not a substitute for launching
the app: see [HAND-TEST.md](docs/HAND-TEST.md) for what only a human can check.

`cargo test --lib` also regenerates the `ts-rs` TypeScript bindings in
`src/bindings/` from the Rust structs — keep it green when you touch a
cross-boundary type. Architecture tour: [ARCHITECTURE.md](docs/ARCHITECTURE.md);
engineering rules: [CLAUDE.md](CLAUDE.md).

## How it works

Tauri 2 shell (Rust) + React 18 frontend in WKWebView. Media and ML work is done by bundled, self-contained sidecars — yt-dlp, ffmpeg/ffprobe, whisper.cpp, llama.cpp (the AI Summary's local LLM, served over a token-gated loopback port), and our own Swift diarizer — orchestrated by thin Rust commands (argument arrays, never shell strings). Web playback streams through a token-gated `127.0.0.1` proxy that remuxes to fragmented MP4 for MSE (the only path WKWebView plays web video with sound). The full tour lives in [ARCHITECTURE.md](docs/ARCHITECTURE.md); the project's engineering rules live in [CLAUDE.md](CLAUDE.md).

## Contributing

PRs welcome — read [CONTRIBUTING.md](CONTRIBUTING.md) first (setup, checks, conventions). Bugs and ideas go through the [issue templates](.github/ISSUE_TEMPLATE/); include the pipeline log (⌘\ → Copy) in bug reports.

## License

[MIT](LICENSE). Sauce Bunny bundles third-party binaries (yt-dlp, ffmpeg, whisper.cpp, llama.cpp, …) and libraries under their own licenses — see [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md). Note the bundled ffmpeg is a **GPL** build; review that file before cutting a public release.
