# Contributing to Sauce Bunny

Thanks for thinking about contributing. Sauce Bunny is a small, focused tool
for pulling and trimming clips from YouTube + arbitrary web sources, with
on-device transcription and speaker diarization. The codebase rewards
readers — start here, then dig in.

## Setup

From a clean machine:

```bash
git clone <repo-url> "Sauce Bunny"
cd "Sauce Bunny"
npm install
npm run setup       # fetch/build all five sidecar binaries (one-time)
npm run tauri dev
```

Prerequisites:

- **macOS 13+** (14+ recommended — diarization needs the FluidAudio Core ML
  models, which platform-pin at 14)
- **Xcode Command Line Tools** (`xcode-select --install`)
- **Rust 1.77+** (`rustup default stable`)
- **Node 20+**
- **Swift 5.9+** — confirm with `swift --version`

First `tauri dev` cold-builds the Rust crate (~3 min) and downloads the
FluidAudio Core ML models on first diarization run (~300 MB, one-time, cached
under `~/.cache/fluidaudio/Models/`).

## Project shape

The repo splits cleanly into React frontend, Rust Tauri shell, and a Swift
sidecar for diarization. Read `ARCHITECTURE.md` for the full tour with a
data-flow diagram.

Sidecar binaries are **not** checked into git (they were ~150 MB of blobs).
`npm run setup` assembles all five into `src-tauri/binaries/`: yt-dlp, ffmpeg,
and ffprobe are downloaded as static builds; whisper-cli is compiled from
whisper.cpp source; `saucebunny-diarize` is ours — its source lives in
`swift-sidecar/` and builds via `npm run build:diarizer`. Every install path
runs an `otool -L` guard that refuses binaries with non-system dylib
references, so what you bundle runs on any Mac.

## Build the diarizer locally

```bash
npm run build:diarizer            # arm64 only (~2s incremental, dev default)
npm run build:diarizer:universal  # arm64 + x86_64 fat binary
```

The script writes `src-tauri/binaries/saucebunny-diarize-aarch64-apple-darwin`
(and the x86_64 slice with `--universal`). Tauri's bundler picks them up
automatically.

## Running checks before opening a PR

```bash
npx tsc --noEmit                   # type-check frontend
npm test                           # vitest — parser/timecode/scoring units
(cd src-tauri && cargo test --lib) # Rust units + ts-rs binding freshness
npm run build:diarizer             # ensure the Swift sidecar still builds
```

CI runs all of these on every PR. Unit tests cover the pure logic (SRT/VTT
parsing, timecode math, proxy request parsing); playback and pipeline flows
are still verified manually, so please also describe the smoke-test you ran
in the PR body (e.g. "Pulled a YouTube clip, generated a transcript with
diarization on, dragged two speaker bubbles to merge — no regressions").

## Conventions

- **TypeScript strict mode.** No `any` unless you leave a comment explaining
  why the type can't be expressed.
- **Call `invoke()` directly, typed by the generated bindings.** Cross-
  boundary structs are defined once in Rust with `#[derive(ts_rs::TS)]`; run
  `cargo test --lib` from `src-tauri/` to regenerate `src/bindings/*.ts`.
  Don't hand-write a TS mirror of a Rust struct.
- **Rust commands live in `src-tauri/src/commands/`**, split by domain
  (`download.rs`, `media.rs`, `transcript.rs`, `system.rs`). Handlers are
  thin wrappers; put new commands in the module that owns their domain.
- **Comments explain WHY, not WHAT.** Look at existing files for the
  established voice — terse, dry, no marketing-speak. If a comment is
  restating the code in English, delete it.
- **Build ID handshake.** The constant in `src/lib/build-id.ts` must match
  the one in `src-tauri/src/commands/system.rs` (`BACKEND_BUILD_ID`). Bump both
  whenever you change a Rust command the frontend depends on — otherwise
  the in-app red banner will yell at you (and that's the point).

## Filing bugs and feature requests

Use the issue templates under `.github/ISSUE_TEMPLATE/`. Bug reports should
include the pipeline log output — press `⌘\` in the app to expand the
pipeline panel, then use its Copy button.

## Code of conduct

This project follows the Contributor Covenant. See `CODE_OF_CONDUCT.md` for
the full text and the reporting address.
