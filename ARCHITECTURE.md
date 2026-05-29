# Sauce Bunny — Architecture

A walk-through of how the pieces fit. Read this before your first PR; it'll save you a day of source-spelunking.

## What Sauce Bunny is

A macOS desktop app for **clipping sections out of online videos** (YouTube, Vimeo, TikTok, Twitter, Reddit, Instagram, ~1,800 other sites via yt-dlp) **and local video files**, with:

- Frame-accurate or lossless mark-in / mark-out cuts
- Optional Whisper transcription (`base.en` recommended, others available)
- Optional speaker diarization on top of Whisper, with a Riverside-style speaker-editor UI
- Auto-loading transcripts when you re-open the same source

What Sauce Bunny **is not**: a full NLE, a streaming service, a cloud tool. Everything runs on your machine.

## Top-level layout

```
.
├── src/                       # React + TypeScript frontend
│   ├── App.tsx                # Big-state component (will be split — see roadmap)
│   ├── components/            # UI, mostly one concern per file
│   ├── lib/                   # Pure modules: parsers, helpers, storage, future api client
│   ├── styles/                # Global CSS + tokens
│   └── types.ts               # Shared TS types (mirrors Rust serde structs)
├── src-tauri/                 # Rust backend (Tauri shell + sidecar orchestration)
│   ├── src/
│   │   ├── lib.rs             # Tauri command registration + cache-sweep startup hook
│   │   ├── main.rs            # 5-line entrypoint
│   │   └── commands.rs        # All Tauri commands (~4k lines; split is on the roadmap)
│   ├── binaries/              # Bundled sidecar executables
│   ├── capabilities/          # Tauri permission lists
│   └── tauri.conf.json        # Bundle config + window settings
├── swift-sidecar/             # Swift package that builds saucebunny-diarize
│   ├── Package.swift
│   └── Sources/saucebunny-diarize/main.swift
├── scripts/                   # Build + maintenance scripts
├── .github/                   # Issue templates + CI workflow
└── docs/                      # Per-feature deep dives (sidecars, diarization, …)
```

## Data flow

```
URL / local file
      │
      ▼
fetch_metadata    OR    probe_local_file    (Rust)
      │                       │
      └──────────┬────────────┘
                 ▼
        Metadata state in App.tsx
                 │
                 ▼
        Player path selection
                 │
   LOCAL FILE ───┤
                 ├─► Native <video> (LocalMediaPlayer)   (path A: codec supported by WKWebView)
                 ├─► MediaBunny canvas (MediaBunnyPlayer) (path B: WebCodecs decode in browser)
                 └─► ffmpeg playback prep                 (path C: transcode to native-compatible MP4)
                          │
                          ▼
                    Cached MP4 in ~/Library/Caches/com.saucebunny.desktop/
                          │
                          ▼
                    Native <video>

   WEB SOURCE ──► MSEStreamPlayer  (the only path that streams web video WITH AUDIO in WKWebView)
                 │
                 │   yt-dlp -g (resolve direct CDN url)
                 ▼
                 loopback proxy  127.0.0.1  (src-tauri/src/stream_proxy.rs)
                 │   /fmp4/v1/<b64>?start=N → spawns ffmpeg (-c copy, fragmented MP4)
                 ▼
                 fetch() stream → appendBuffer → same-origin blob: MediaSource (MSE)
                 ▼
                 WebKit NATIVE decode (H.264 + AAC) → <video>
                 │
                 └─ on any failure → yt-dlp download-to-cache → LocalMediaPlayer (fallback)

   Why this shape: WKWebView blocks the YouTube IFrame (Error 153), refuses
   cross-origin <video src>, and lacks a WebCodecs AudioDecoder (< Safari 26).
   MSE fed by a same-origin blob + ffmpeg's reference fMP4 is the only
   combination that yields full audio. See CLAUDE.md "Media playback path".

─────── Playback + Mark in/out ───────

Export clip:
    Marked range → ffmpeg cut → MP4/MP3 in user-chosen folder

Generate transcript:
      │
      ├─► Whisper (whisper-cli sidecar)        ┐
      └─► yt-dlp captions                       ├─► SRT in ~/Documents/Sauce Bunny/Transcripts/YYYY-MM/
                                                ┘
                                                │
                              if Detect speakers is on:
                                                │
                                ▼
                    saucebunny-diarize (Swift sidecar) ─► JSON of speaker turns
                                                │
                                ▼
                    merge into SRT with [SPEAKER_NN]: prefix
                                                │
                                ▼
                            TranscriptViewer
                            (speaker bubbles, drag-to-merge,
                             rename, search, history popover)
```

## Sidecars

Four executables ship in `src-tauri/binaries/`. The Tauri shell invokes them via `app.shell().sidecar(name)` with the platform-tuple naming convention (`<name>-aarch64-apple-darwin`).

| Sidecar | What it does | Where it comes from |
|---|---|---|
| `yt-dlp` | Resolves video URLs, downloads streams, fetches captions | Official static build from github.com/yt-dlp/yt-dlp/releases. Refresh via `scripts/refresh-sidecars.sh` (YouTube extractors rot weekly). |
| `ffmpeg` | Audio extraction, video transcoding, frame extraction | Homebrew ffmpeg or static build. Stable; rebuild rarely. |
| `whisper-cli` | Whisper.cpp speech-to-text | Build whisper.cpp from source, copy the `whisper-cli` binary. Stable. |
| `saucebunny-diarize` | Speaker diarization (SpeakerKit primary, FluidAudio fallback) | Built locally via `npm run build:diarizer`. We own this code (`swift-sidecar/`). |

## Diarizer architecture

Two backends behind one CLI:

```
saucebunny-diarize --input audio.wav --output turns.json --backend speakerkit|fluidaudio|auto

┌──────────────────────────────────────────────────────────────┐
│ Default: --backend auto                                      │
│                                                              │
│   try SpeakerKit (pyannote v4, MIT, 1.0 stable)              │
│       └─► if init throws → fall back ─┐                      │
│                                       ▼                      │
│   try FluidAudio (pyannote 3, 0.x, Mirror reflection)        │
│       └─► if THAT fails too → exit 5                         │
│                                                              │
│ Both backends emit the SAME JSON envelope (schema_version 1).│
│ The Rust caller and TS frontend don't know or care which ran.│
└──────────────────────────────────────────────────────────────┘
```

This lets us swap backends without touching Rust or JS. The Swift sidecar is the abstraction boundary.

## State management

`App.tsx` owns most application state via `useState`. Preferences and history persist to `localStorage` under the `saucebunny.*` namespace:

- `saucebunny.defaults` — user preferences (output folder, format, Whisper model, Detect speakers, expected speakers, transcript library path, etc.)
- `saucebunny.transcriptHistory` — the last 50 transcripts (path + source + timestamps)
- `saucebunny.speakerNames.<srt-path>` — per-transcript speaker renames + merges
- `saucebunny.diarizerModelsReady` — true once the diarizer model cache is warm
- `saucebunny.queueDrawerWidth` — last drawer width

A one-shot migration helper at app boot copies any leftover `clippull.*` keys to `saucebunny.*` (legacy from the pre-rebrand `ClipPull` name).

## Build-ID handshake

Both sides of the IPC carry a build-ID string:
- `src-tauri/src/commands.rs` `BACKEND_BUILD_ID`
- `src/lib/build-id.ts` `EXPECTED_BACKEND_BUILD_ID`

On launch, the frontend asks the backend for its ID and shows a red banner if they don't match. That's the unambiguous "you need to restart `npm run tauri dev`" signal — without it, mismatched Rust binaries would cause silent runtime mysteries.

Bump both whenever you change a Rust command's signature or add a new one.

## Roadmap

The non-trivial items, roughly in priority order:

1. **Split `src-tauri/src/commands.rs`** into per-feature modules (`commands/yt_dlp.rs`, `commands/whisper.rs`, `commands/diarize.rs`, etc.) — the monolith is the single biggest barrier to drive-by contributions.
2. **Migrate every `invoke()` call site through `src/lib/api.ts`** — the typed client wrapper landed in r40; existing direct calls are technical debt.
3. **Real test harness** — cargo test for Rust unit tests, Playwright for UI smoke. Currently we rely on manual reproduction.
4. **Float side panel to its own window** — Tauri 2 supports multi-window; the Transcript drawer would benefit (Premiere-style detach).
5. **Linux / Windows builds** — macOS-first while we hit 1.0; cross-platform after.
