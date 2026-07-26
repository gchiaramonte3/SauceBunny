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
npm run setup       # fetch/build all six sidecar binaries (one-time)
npm run tauri dev
```

Prerequisites:

- **macOS 14+** (the diarizer’s FluidAudio Core ML dependency
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
sidecar for diarization. Read `docs/ARCHITECTURE.md` for the full tour with a
data-flow diagram.

Sidecar binaries are **not** checked into git (they were ~150 MB of blobs).
`npm run setup` assembles all six into `src-tauri/binaries/`: yt-dlp, ffmpeg,
and ffprobe are downloaded as static builds; whisper-cli and llama-server are
compiled from whisper.cpp / llama.cpp source; `saucebunny-diarize` is ours — its
source lives in `swift-sidecar/` and builds via `npm run build:diarizer`. Every install path
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

### Testing a component

Three layers, and it is worth knowing which one your change belongs in:

| Layer | What it proves | Where |
|---|---|---|
| unit | a pure function is correct | `src/lib/*.test.ts` |
| component | a control behaves the way its props say | `src/components/*.test.tsx` |
| e2e | the app boots and the chrome wires up | `e2e/*.spec.ts` |

For a while only the first and third existed, so "every part correct, wired
together wrong" had nowhere to be caught. The very first component test found
a `disabled` prop on the timeline playhead that gated its keymap and dropped
it out of the tab order, all of it unreachable because the only call site
sits inside a `{!dim && …}` guard.

Component tests are ordinary vitest files with one requirement: put

```
// @vitest-environment jsdom
```

on the **first line**. The default environment stays `node`, which is what
keeps the ~550 pure tests running in about a second; jsdom costs roughly
200ms per file and almost nothing else needs it.

Conventions worth copying from `Timeline.test.tsx` and `CaptionOverlay.test.tsx`:

- Mock `@tauri-apps/api/core` and `@tauri-apps/api/event` per file. There is
  no backend in vitest.
- Mock the decode helpers (`../lib/mediabunny-helpers`, `../lib/waveform`).
  They reach for WebCodecs and a real file.
- Move the playhead with `act(() => setPlayheadFrames(n))`, not by passing a
  prop. It lives outside React on purpose, and the test should exercise the
  same path playback does.
- Assert what a user or a screen reader can observe. `getByRole` over
  `querySelector` wherever the component has a role to find.

`src/test-setup.ts` fills in the browser APIs jsdom does not implement
(ResizeObserver, IntersectionObserver, matchMedia, a working localStorage).
Add to it only when jsdom genuinely lacks something — a component test that
passes because the setup file faked the behaviour under test is worth less
than no test at all.

### If you touched packaging

Everything above checks *source*. Nothing in it can see the artifact, and
three real defects used that gap: a CSP compiled into the binary that
forbade WebAssembly (audio was silent in the .dmg and perfect in
`tauri dev`), a resource map that collapsed three license files into one so
the MIT and GPLv3 texts shipped in no build at all, and a DMG step that
failed while the .app it had just produced was fine.

So if you changed `tauri.conf.json`, `Info.plist` keys, entitlements, icons,
or anything under `scripts/`, build once and check the result:

```bash
npm run tauri build
npm run verify:bundle
```

CI does this too (the `bundle` job), but with stubbed sidecars and no
signing identity, so it passes `--allow-stub-sidecars` and can only prove
the parts that do not need real binaries. A release must run it *without*
that flag, which `npm run check:release` does for you.

## Nightly real-sidecar smoke

Per-push CI stubs the sidecar binaries, so it never actually *runs* whisper,
ffmpeg, or yt-dlp — a whisper.cpp flag rename or a broken fMP4 remux would
ship silently. The nightly workflow
(`.github/workflows/nightly-sidecars.yml`) closes that gap: every night it
assembles the **real** binaries (latest yt-dlp/ffmpeg/ffprobe releases,
whisper.cpp master built from source, cached on its upstream SHA) and runs
the `#[ignore]`-tagged `nightly_*` Rust tests. Those tests drive the
**production arg-builders** — `whisper_cli_args`, `wav_16k_mono_args`,
`playback_prep_args` + the color-routing quality args, and the stream
proxy's `/fmp4/` route — end-to-end against fixtures generated on the spot
with the fetched ffmpeg:

- **Playback prep**: a testsrc2+sine H.264/AAC file must take the SDR-8
  fast path; a 10-bit **PQ-tagged ProRes 422 HQ** file must route through
  the zscale/tonemap chain to bt709-tagged 8-bit SDR (the CLAUDE.md
  "ProRes / 10-bit caveat" case — this is what catches a zscale/tonemap
  option rename in a new ffmpeg build); an **untagged 10-bit** file must
  take the error-diffusion dither path; audio-only input must come out as
  MP3. All outputs are ffprobe-verified 8-bit yuv420p H.264 (+AAC,
  faststart).
- **Whisper**: macOS `say` speech → the production 16 kHz mono WAV
  conversion → whisper-cli with the app's exact flags (incl. `-l` language
  and `--vad`) must emit a well-formed SRT; every flag we pass must still
  exist in `whisper-cli --help`.
- **fMP4 remux (stream proxy)**: a local HTTP server stands in for the CDN;
  the proxy's ffmpeg remux must stream a fragmented MP4 that keeps **both**
  tracks (the r63 audio invariant), honor `?start=` seeks, and merge
  DASH-split video+audio inputs (r75).
- **yt-dlp**: the latest release must run, and every `--long-flag` we pass
  anywhere in `commands/download.rs` must still be listed in `--help`
  (the flag list is scraped from our own source, so it can't go stale).

Run it locally (needs `npm run setup` first; downloads the tiny.en + Silero
VAD models to `~/.cache/sauce-bunny/nightly/` on first run, ~78 MB total —
override with `SB_NIGHTLY_WHISPER_MODEL` / `SB_NIGHTLY_VAD_MODEL`):

```bash
cd src-tauri && cargo test --lib nightly_ -- --ignored --test-threads=1
```

On CI the workflow sets `SB_NIGHTLY_ALLOW_SW_ENCODER=1` because GitHub's
virtualized macOS runners may not expose the VideoToolbox hardware encoder;
the playback-prep tests then retry with libx264 (loudly) so the rest of the
arg surface is still verified. Don't set it locally — a real Mac should
exercise the real encoder. A red nightly files/updates a "Nightly sidecar
smoke failed" issue with a link to the run; it can also be triggered by hand
from the Actions tab (`workflow_dispatch`).

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
