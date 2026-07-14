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
│   │   ├── main.rs            # tiny entrypoint shim → sauce_bunny_lib::run()
│   │   ├── commands/          # Tauri commands by domain (download, media, transcript, system, llm)
│   │   └── stream_proxy.rs    # loopback fMP4 media proxy for web playback
│   ├── binaries/              # Bundled sidecar executables (gitignored; fetched by `npm run setup`)
│   ├── capabilities/          # Tauri permission lists
│   └── tauri.conf.json        # Bundle config + window settings
├── swift-sidecar/             # Swift package that builds saucebunny-diarize
│   ├── Package.swift
│   └── Sources/saucebunny-diarize/main.swift
├── scripts/                   # Build + maintenance scripts
└── .github/                   # Issue templates + CI workflow
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

Six executables ship in `src-tauri/binaries/`, using the platform-tuple naming convention (`<name>-aarch64-apple-darwin`). The app invokes `yt-dlp`, `ffmpeg`, `whisper-cli`, `saucebunny-diarize`, and `llama-server` directly (via `app.shell().sidecar(name)` / a resolved path). `ffprobe` is the exception — the app never spawns it; it ships beside `ffmpeg` so yt-dlp can discover it (yt-dlp derives `ffprobe-<triple>` from the `--ffmpeg-location` path it's given).

| Sidecar | What it does | Where it comes from |
|---|---|---|
| `yt-dlp` | Resolves video URLs, downloads streams, fetches captions | Official static build from github.com/yt-dlp/yt-dlp/releases. Refresh via `scripts/refresh-sidecars.sh` (YouTube extractors rot weekly). |
| `ffmpeg` | Audio extraction, video transcoding, frame extraction | osxexperts.net static arm64 build via `npm run refresh:ffmpeg`. Stable; rebuild rarely. |
| `ffprobe` | yt-dlp's HLS fixup (`aac_adtstoasc`) + media metadata. Not spawned by the app — found by yt-dlp beside ffmpeg. | ffmpeg.martin-riedl.de static arm64 build via `npm run refresh:ffprobe`. Required for playable HLS/live downloads. |
| `whisper-cli` | Whisper.cpp speech-to-text | Build whisper.cpp from source, copy the `whisper-cli` binary. Stable. |
| `saucebunny-diarize` | Speaker diarization (SpeakerKit primary, FluidAudio fallback) | Built locally via `npm run build:diarizer`. We own this code (`swift-sidecar/`). |
| `llama-server` | Local LLM for the AI Summary tab (loopback HTTP, token-gated) | Build llama.cpp from source via `npm run build:llama`. Static + Metal. |

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

## Voice dictation

The Review composer's mic button turns speech into comment text, entirely on-device:

```
dictate_start ─► ffmpeg -f avfoundation -i :default → 16 kHz mono WAV
              (registered in the JobRegistry under job_id; a detached
               tokio task drains its output)
dictate_stop  ─► JobRegistry::write_stdin(job_id, "q")   # graceful finalize
              └► drain task: ffmpeg exits 0 → run ASR on the WAV
                 (Parakeet if its model is present, else any Whisper model)
              └► emit `dictate-done` { text, error, note }  → the composer
```

Key points:
- **Capture is via ffmpeg, not the WebView's `getUserMedia`** (WKWebView's media-capture permission path is unreliable on this stack). `:default` selects the system default input — a bare `:0` would pick avfoundation device *index* 0 (often a capture card / virtual device).
- **Graceful stop matters.** `dictate_stop` writes `q` to ffmpeg's stdin so it finalizes the WAV header; a `kill()`/SIGKILL would truncate it. `JobRegistry::write_stdin` exists for exactly this (it writes without removing the child, so the drain task still sees the clean exit). `cancel_job` (SIGKILL) is used only to discard a recording (e.g. the panel unmounts mid-record).
- **Microphone permission** comes from `NSMicrophoneUsageDescription` in `src-tauri/Info.plist`, which the macOS bundler auto-merges into the generated plist (dev + `.dmg`). The ffmpeg child inherits the app's TCC grant. **Dev caveat:** a stale `tauri dev` binary (build-ID mismatch) or a denied TCC prompt makes capture fail — restart the dev build and allow the mic prompt when testing dictation.

## P2P co-review (watch party)

`src-tauri/src/commands/session.rs` + `src/hooks/use-co-review.ts` (the whole
frontend subsystem — session lifecycle, transport follow, shared-doc sync,
ghost cursors, screening mode — extracted from App.tsx in the same shape as
`use-panel-bus`/`use-web-playback`). A peer-to-peer collab *primitive* in the
same spirit as the stream proxy — not an app backend. **Media never transits peers**: everyone plays their own copy of
the source; only tiny newline-delimited JSON control lines (`SessionMsg`) cross
the wire.

```
host: session_start ─► iroh QUIC endpoint + one-line ticket (join code)
peer: session_join(ticket, name) ─► dial, open bi-stream, send Hello
topology: star — host + up to MAX_PEERS(3) guests, host relays everything
```

- **Wire messages** (`SessionMsg`, ts-rs generated): `Hello`, `PeerList`
  (roster, host always first), `LoadSource`, `Transport` (2 Hz playhead truth),
  `ReviewOp`/`ReviewDoc` (opaque JSON review mutations/snapshots — Rust only
  relays), `Presence` (ghost playheads, ~3 Hz).
- **Session-first flow**: a session can start with nothing loaded. The host's
  `activeSourceUrl` effect broadcasts `LoadSource` on every source change +
  to each new joiner; a peer holds the transport playhead-chase until its own
  player `isReady()` for that source, then snaps to the host's frame.
- **Shared review doc**: comments/replies/likes/resolves are ops
  (`src/lib/review.ts` — idempotent adds by id, SET-not-toggle likes/resolves,
  LWW edits with a deterministic tiebreak, `mergeReviewDoc` snapshot-merge on
  join). Host applies + relays to all-but-sender, so the star converges.
  On session end everyone persists the collaborative doc locally.
- **Screening mode** is a pure CSS reflow of the existing body (participant
  rail replaces the sidebar; the player is never remounted). The rail reads
  real roster data; the host is identified by roster position 0 — the name
  "Host" is reserved server-side so a guest can't claim the crown.
- **Input hardening**: relayed control lines are capped (2 MB), Presence names
  run through the same `clean_name` as Hello.
- **Web-source only** for now (a local file can't reach guests); a relay-URL
  override + LAN-only mode is deferred (Phase 3 note in session.rs).

## State management

`App.tsx` owns most application state via `useState`. Preferences and history persist to `localStorage` under the `saucebunny.*` namespace:

- `saucebunny.defaults` — user preferences (output folder, format, Whisper model, Detect speakers, expected speakers, transcript library path, etc.)
- `saucebunny.transcriptHistory` — the last 50 transcripts (path + source + timestamps)
- `saucebunny.speakerNames.<srt-path>` — per-transcript speaker renames + merges
- `saucebunny.diarizerModelsReady` — true once the diarizer model cache is warm
- `saucebunny.queueDrawerWidth` — last drawer width

A one-shot migration helper at app boot copies any leftover `clippull.*` keys to `saucebunny.*` (legacy from the pre-rebrand `ClipPull` name).

**Scoped undo/redo** (`src/lib/undo.ts`): one module-level stack (`appUndo`, ⌘Z/⇧⌘Z, capped at 50) covering in/out marks and the user's OWN review ops — never peer-originated co-review changes (entries are pushed only from ReviewPanel's local mutation funnel; inverse ops are built by `inverseReviewOps` in `review.ts` with fresh LWW timestamps). App clears the stack on source change and co-review join/leave. The annotation draft keeps a separate in-composer snapshot history (⌘Z removes the last stroke/label while drawing) because draft state dies with the draft. Inside text fields the shortcut deliberately falls through to the native Edit ▸ Undo menu item, so field-level text undo is untouched.

### The playhead (subscription store, not state)

The one deliberate exception to "state lives in App" is the playhead. It ticks up to 60×/sec while media plays, and as App-level state it re-rendered the entire (unmemoized) App tree per frame — and memoizing wasn't the fix, because Monitor's ~50-prop surface makes the prop-compare itself per-frame work. It lives outside React in `src/lib/playhead-store.ts` (canonical unit: integer frames, the same quantization the old state used, so every derived clock keeps agreeing — the store fans out the r88 single clock, it is never a second one):

- **Writers** — the active player's `onTimeUpdate`, every seek/step/reset path in `App.tsx`, and `PanelApp` (the floating panel is a separate webview with its own store instance; it feeds its store from the two cross-window channels below).
- **Render subscribers** (`useSyncExternalStore`, full tick rate) — the Transport timecode, the Timeline scrub cursor, `CaptionOverlay`'s cue lookup, `TranscriptViewer`'s karaoke highlight, `ReviewPanel`'s composer timestamp, and Monitor's annotation proximity fade. All leaves — a playback tick re-renders a handful of tiny components, never the tree.
- **Action-time readers** — mark in/out, frame snapshot, seek-by-seconds, and the co-review heartbeat/presence/chase call `getPlayheadFrames()` when they fire; the shuttle edge-stop watches via a plain subscription (no re-render at all).
- **Cross-window feed** — the popped-out panel can't subscribe across webviews, so the playhead reaches it as data, without re-rendering App: the change-driven `panel:state` snapshot carries the position as of its publish (the boot seed + the pause/seek truth), and `use-panel-bus` emits a lightweight `panel:playhead` heartbeat (4 Hz, only while a panel is detached and the playhead actually moved) that PanelApp writes into its window's store. The live clock deliberately stays OUT of the snapshot so playback never re-serializes it.

## Build-ID handshake

Both sides of the IPC carry a build-ID string:
- `src-tauri/src/commands/system.rs` `BACKEND_BUILD_ID`
- `src/lib/build-id.ts` `EXPECTED_BACKEND_BUILD_ID`

On launch, the frontend asks the backend for its ID and shows a red banner if they don't match. That's the unambiguous "you need to restart `npm run tauri dev`" signal — without it, mismatched Rust binaries would cause silent runtime mysteries.

Bump both whenever you change a Rust command's signature or add a new one.

## Roadmap

Done since this list was written: the commands.rs split (r47 — `commands/{download,media,transcript,system}.rs`), the floating side-panel window (r44.B), typed errors via `AppError` (r50–51), generated TS bindings via ts-rs (r49), unit tests for the pure logic in CI (r86 — vitest + `cargo test --lib`), and the playhead-tick render costs — the karaoke highlight's O(turns²) bookkeeping is precomputed in memos (`68d4a25`), and the playhead itself moved to a subscription store so playback ticks re-render only the leaves that paint it (see "State management"). The `api.ts` wrapper experiment was retired in r86: the codebase calls `invoke()` directly, typed by the generated bindings.

Remaining, roughly in priority order:

1. **UI smoke harness** — unit tests cover the parsers/math; playback and the transcript pipeline are still verified manually. A Playwright (or tauri-driver) smoke run would close that gap.
2. **First public release** — tagged v0.1.0 with a notarized .dmg (see DISTRIBUTION.md), plus an app-update story (tauri-plugin-updater) and a plan for yt-dlp staleness (YouTube breaks extractors faster than app releases ship).
3. **Linux / Windows builds** — macOS-first while we hit 1.0; cross-platform after.
