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

Eight executables ship in `src-tauri/binaries/`, using the platform-tuple naming convention (`<name>-aarch64-apple-darwin`). The app invokes `yt-dlp`, `ffmpeg`, `whisper-cli`, `saucebunny-diarize`, `saucebunny-dictate`, `saucebunny-capture`, and `llama-server` directly (via `app.shell().sidecar(name)` / a resolved path). `ffprobe` is the exception — the app never spawns it; it ships beside `ffmpeg` so yt-dlp can discover it (yt-dlp derives `ffprobe-<triple>` from the `--ffmpeg-location` path it's given).

| Sidecar | What it does | Where it comes from |
|---|---|---|
| `yt-dlp` | Resolves video URLs, downloads streams, fetches captions | Official static build from github.com/yt-dlp/yt-dlp/releases. Refresh via `scripts/refresh-sidecars.sh` (YouTube extractors rot weekly). |
| `ffmpeg` | Audio extraction, video transcoding, frame extraction | osxexperts.net static arm64 build via `npm run refresh:ffmpeg`. Stable; rebuild rarely. |
| `ffprobe` | yt-dlp's HLS fixup (`aac_adtstoasc`) + media metadata. Not spawned by the app — found by yt-dlp beside ffmpeg. | ffmpeg.martin-riedl.de static arm64 build via `npm run refresh:ffprobe`. Required for playable HLS/live downloads. |
| `whisper-cli` | Whisper.cpp speech-to-text | Build whisper.cpp from source, copy the `whisper-cli` binary. Stable. |
| `saucebunny-diarize` | Speaker diarization (SpeakerKit primary, FluidAudio fallback) | Built locally via `npm run build:diarizer`. We own this code (`swift-sidecar/`). |
| `llama-server` | Local LLM for the AI Summary tab (loopback HTTP, token-gated) | Build llama.cpp from source via `npm run build:llama`. Static + Metal. |
| `saucebunny-dictate` | Live dictation for review comments — Apple Speech, partial transcripts while you speak | Built locally via `npm run build:dictate`. We own this code (`swift-sidecar/`). |
| `saucebunny-capture` | ScreenCaptureKit capture engine for co-review screen sharing | Built locally via `npm run build:capture`. We own this code (`swift-sidecar/`). |

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
same spirit as the stream proxy — not an app backend. **Media transits peers only on request**: by default everyone plays their own
copy and only tiny newline-delimited JSON control lines (`SessionMsg`) cross the
wire. Two opt-in paths carry bytes, each requiring a click on both sides — the
host offering a file, and a guest choosing to receive it (verified BLAKE3
transfer) or to watch it live (fMP4 remuxed over a typed substream).

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
  Reactions merge as an LWW-element-set (`reactedAt`, glyph → name → when):
  the membership list alone is grow-only, so unioning two copies could express
  a reaction but never its removal, and every un-react was resurrected by the
  next merge. Adds still union — two people reacting at once must both land —
  and names with no recorded op (docs predating `reactedAt`) still union too.
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

### What is left to extract, and what only looks extractable

`App.tsx` is ~5,470 lines. The roadmap direction is one cohesive subsystem at a
time into `src/hooks/use-*.ts` (done: `use-panel-bus`, `use-web-playback`,
`use-co-review`, `use-library-scan`, `use-media-capture`, `use-transport`,
`use-keyboard-shortcuts`, `use-clip-export`, `use-clip-queue`).
Picking the next one by *name* is how the exercise goes wrong, so this records
what the code actually shows.

**The last three were moved VERBATIM, and that is the technique to reuse.**
The block comes out byte-identical — asserted programmatically before
committing — so the diff is a move rather than a rewrite, and `tsc` enumerates
the real dependency surface instead of a human guessing at it. That caught
four wrong types on the keyboard hook and six on the export hook, including
`framesToTc` resolving to marker-time's three-argument version rather than
timecode's two. Each hook then gets the tests that were impossible before:
27 across the three.

Two things fall out of moving code across a component boundary, both of which
were invisible while it stayed inside. First, an unstable callback becomes
visible: `readerFps` and `cookiesBrowserOrNone` were bare arrows recreated
every render, harmless in place but, as props, enough to re-subscribe the
window key listeners on every render — both are now `useCallback`s with no
deps. Second, ESLint stops being able to prove that refs and setState
functions are stable, so they have to be listed; every one of them is
identity-stable, so the lint moved and the behaviour did not.

**A scripted dependency edit needs the same review as a typed one.** Appending
with `replace("]);", ", x]);")` produces `}, [, x]);` on an array that was
empty — an elision hole that reads as `undefined`, is perfectly stable, and
passes tsc, ESLint and every test. It happened twice, the second time one
commit after the first was written up, because a write-up is not a fix. Handle
the empty case in the script and grep the result for `[, `.

**Diarizer model prep — DONE** (`src/hooks/use-diarizer-prepare.ts`, 13 tests).
It was picked because it reached outside itself exactly twice — a
notification and the "models are cached" latch — and both became arguments
(`useDiarizerPrepare({ notify, onReady })` → `{ state, error, prepare, cancel }`).
App.tsx lost 57 lines. The job id stopped being `useState` mirrored into a
`useRef`, so starting a download no longer re-renders the whole App tree to
store a string nothing renders. The tests that came with it were impossible
before: every one needs a `diarize-prepare-done` payload delivered to a listener
that used to be registered inside App's central event effect.

**~~Captions is NOT cohesive~~ — that reasoning has since been overtaken.**
The objection was that `captions-done` writes `setActiveTranscript` and
`setTranscriptArrivedTick`, "which the Whisper pipeline also owns", and that a
hook reaching back into App to set those would be a worse seam than the status
quo.

That held while the Whisper pipeline was still inline. It stopped holding the
moment that pipeline became `use-transcript-listeners.ts`, which takes the same
two setters as arguments — as do the clip-export and playback-prep hooks.
Neither pipeline owns that state; App does, and hands it to both. The seam the
note warned about became the house pattern, so it no longer distinguishes
captions from the three already extracted, and captions is now
`use-captions-listeners.ts`.

What the note got RIGHT is that the cohesive unit is *transcript arrival*
rather than captions. Two hooks writing the same pair is that unit expressed as
symmetry: whichever pipeline finishes hands App the same two setters, and the
Transcript tab does not care which one produced the SRT.

**The central listener effect is the real obstacle, and splitting it is not the
easy win it looks like.** One `useEffect` registers 13 Tauri listeners behind a
shared `mounted` flag and writes 16 setters across captions, transcript, export
and status. Any extraction that owns an event has to lift its listener out of
it. That was fine for the diarizer pair — own listeners, own cleanup — and is
the hard part for everything else.

The obvious move is to split it by domain (clip/export `a,b,c`; captions `d,f`;
transcript `g,h,i,j,jPhase`; playback-prep `k,l,m` — the boundaries are clean).
Do not do that casually. `dcaef9d` kept the registrations sequential *on
purpose*, and its tail comment says why: **several handlers share event shapes**.
`LogEvent`, `DoneEvent` and `ProgressEvent` each serve multiple channels, so
attaching the wrong handler to the wrong event NAME type-checks perfectly and
fails silently at runtime — and nothing in the suite exercises these 13 events.

**That prerequisite is now done.** All 14 handlers are named after their events
(`listen("clip-done", onClipDone)`), and `event-surface-contract` asserts the
pairing, so wiring `onClipDone` to `"captions-done"` fails a test instead of
shipping. Worth knowing how weak the old safety net was: doing exactly that swap
by hand, `tsc` reported only an *unused variable* — never the mis-wire.

**And the split is done.** The one 292-line effect is now four, by domain —
clip export (3 listeners), captions (2), transcription (5), playback prep + the
LLM server (4) — each with its own `mounted` flag, its own `unlistens` array,
its own StrictMode tail sweep and its own cleanup. Verified the way the naming
pass was: every handler body hashed before and after, all 14 byte-identical, all
14 still on their own event, and each effect cleaning up exactly what it pushes.

What is left in App.tsx is now four readable blocks instead of one wall, and an
extraction that owns an event lifts one small effect rather than carving a
listener out of a shared one.

## Build-ID handshake

Both sides of the IPC carry a build-ID string:
- `src-tauri/src/commands/system.rs` `BACKEND_BUILD_ID`
- `src/lib/build-id.ts` `EXPECTED_BACKEND_BUILD_ID`

On launch, the frontend asks the backend for its ID and shows a red banner if they don't match. That's the unambiguous "you need to restart `npm run tauri dev`" signal — without it, mismatched Rust binaries would cause silent runtime mysteries.

Bump both whenever you change a Rust command's signature or add a new one.

## Roadmap

Done since this list was written: the commands.rs split (r47 — `commands/{download,media,transcript,system}.rs`), the floating side-panel window (r44.B), typed errors via `AppError` (r50–51), generated TS bindings via ts-rs (r49), unit tests for the pure logic in CI (r86 — vitest + `cargo test --lib`), and the playhead-tick render costs — the karaoke highlight's O(turns²) bookkeeping is precomputed in memos (`68d4a25`), and the playhead itself moved to a subscription store so playback ticks re-render only the leaves that paint it (see "State management"). The `api.ts` wrapper experiment was retired in r86: the codebase calls `invoke()` directly, typed by the generated bindings.

Remaining, roughly in priority order:

1. ~~**UI smoke harness**~~ — done (r105). `npm run test:e2e` drives the Vite-served frontend in Chromium with the Tauri IPC layer mocked at the `__TAURI_INTERNALS__` seam; tauri-driver has no macOS/WKWebView support, so it is deliberately a shell smoke. Native playback and transcription remain manual (see `docs/HAND-TEST.md`).
2. **First public release** — tagged v0.1.0 with a notarized .dmg (see docs/DISTRIBUTION.md), plus an app-update story (tauri-plugin-updater) and a plan for yt-dlp staleness (YouTube breaks extractors faster than app releases ship).
3. **Linux / Windows builds** — macOS-first while we hit 1.0; cross-platform after.

## Boot cost, measured — and why the decode stack stays eagerly imported

The main bundle is ~1.82 MB, and Vite says so on every build. Roughly 40% of it
is one dependency: attributing source bytes through the sourcemap gives
mediabunny 1,652 kB and `@mediabunny/prores` 265 kB, against 303 kB for
`App.tsx` and 131 kB each for `@tauri-apps/api` and `react-dom`. All nine
mediabunny imports are static, none of it is needed to render the home view,
and the MP3 encoder next door is already lazy — so making the decode stack lazy
too looks like the obvious win.

It is not, and the numbers are here so this does not get re-argued. Serving the
real `dist/` build and timing a cold load to the home view:

    to home            166 ms
    first paint        152 ms
    domInteractive      18 ms
    bundle fetch+parse  41 ms   (one file; 547 kB over the wire)

41 ms. Making mediabunny lazy means converting nine modules from static to
dynamic imports, which turns every call site on the local-playback, export,
waveform and ProRes paths async. That is the code CLAUDE.md is most emphatic
about not destabilising, and the ceiling on the win is a few tens of ms of parse
time that happens once per launch, behind a splash the user is not watching.

Two things the same run confirms. Only ONE js file loads at boot, so the MP3
encoder chunk genuinely stays out of the boot path — the invariant
`verify:packaged` checks in the packaged app, observed here in the browser.
And measure the SHIPPED bundle, not the dev server: the e2e harness serves
unbundled per-module Vite, where the same boot reads 547 ms with `App.tsx` and
`MediaBunnyPlayer.tsx` as separate resources. That number describes the
developer's dev loop and nothing a user ever experiences.

## Media stream cache + timeline contract (r112–r114)

**Warm boot / stream cache.** Web-source state persists across sessions so a
repeat open skips yt-dlp entirely when possible:
- `media/meta/<urlhash>.json` in the app cache — source metadata + the last
  resolved signed stream URLs (with their expiry), read by `get_warm_start`
  (async command) BEFORE the optimistic mount.
- `saucebunny-media/downloads/` — completed download-fallback copies, exempt
  from the 24h cache sweep. A complete copy short-circuits to
  `LOAD_CACHED` → LocalMediaPlayer; still-valid signed URLs short-circuit
  the resolve (`RESOLVED fromCache: true`) into the same proxy/MSE path.
- Signed URLs rot: a cached stream's failure edge spends ONE fresh yt-dlp
  resolve before the download fallback, and every fallback edge carries
  `resumeAtSeconds` so the position survives the swap (see
  `src/lib/web-playback-machine.ts` — the state types make the handoff
  mandatory).

**Timeline contract (proxy ↔ player).** The `/fmp4` route answers with:
- `X-Timeline: absolute | rebased` — whether stream timestamps are true
  source time. ffmpeg's fragmented-MP4 muxer re-zeros every track to its
  first dts, so "absolute" is achieved by recovering the erased origin:
- `X-Stream-Epoch: <seconds>` — the first video dts at the `-ss` landing
  keyframe, probed by a bounded (4s wall-clock, memoized) ffprobe pass.
  The player re-adds it via `SourceBuffer.timestampOffset`, making
  buffered ranges genuinely absolute; the landing seek then places
  `currentTime` exactly on the requested second.
- The player commits its (mode, baseTime, duration) tuple atomically per
  pipeline from that pipeline's OWN response header — never from a
  previous pipeline's mode (a failed probe legitimately flips a rebuild
  to `rebased`, which asserts baseTime = seek target instead).

## Tone-card design grammar (shell v3)

Panels (sidebar, queue drawer, library tree/detail, prail) are uniform
tone cards: `--bg-1` surfaces on the `--bg-0` canvas, `--r-lg` radius,
8px gutters with 4px half-gaps, and NO borders — tonal contrast does the
separation. The flat tier (nav rail, Home, Library hero/grid) and the
open center (monitor + timeline) stay borderless and flush. Focus never
uses the green accent: `--focus-ring` (white) brightens the control's
outline; composed fields brighten the wrapper and suppress the inner
ring (guarded by `src/lib/focus-contract.test.ts`).
