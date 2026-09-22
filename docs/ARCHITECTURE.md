# Sauce Bunny — Architecture

Multitrack output recovery: cached PCM does not imply an active audio device.
Play/scrub resume a non-running Web Audio context (including WebKit's
`interrupted` state), recheck readiness after resume/decode, and report a
non-running device instead of showing false playback. Device interruptions
park transport and stop scheduled voices; resuming the device alone does not
restart playback. A new explicit Play gesture is required. This does not
change the bounded PCM preparation or recognizer concurrency.

A walk-through of how the pieces fit. Read this before your first PR; it'll save you a day of source-spelunking.

## What Sauce Bunny is

A macOS desktop app for **clipping sections out of online videos** (YouTube, Vimeo, TikTok, Twitter, Reddit, Instagram, ~1,800 other sites via yt-dlp) **and local video files**, with:

- Frame-accurate or lossless mark-in / mark-out cuts
- Optional Whisper transcription (`base.en` recommended, others available)
- Optional speaker diarization on top of Whisper, with a Riverside-style speaker-editor UI
- Auto-loading transcripts when you re-open the same source
- A separate Multitrack workspace for read-only embedded-audio AAF inspection
  and per-microphone local transcription (see [AAF-MULTITRACK.md](AAF-MULTITRACK.md))

What Sauce Bunny **is not**: a full NLE, a streaming service, a cloud tool. Everything runs on your machine.

## Top-level layout

```
.
├── src/                       # React + TypeScript frontend
│   ├── main.tsx               # Entry point — reads ?window= and mounts App or PanelApp
│   ├── App.tsx                # Big-state component (will be split — see roadmap)
│   ├── PanelApp.tsx           # Root of the floating side-panel window (?window=panel)
│   ├── components/            # UI, mostly one concern per file
│   ├── hooks/                 # Subsystems lifted out of App.tsx, + shared stateful logic
│   ├── lib/                   # Pure modules: parsers, helpers, storage, and the *-contract tests
│   ├── bindings/              # GENERATED from the Rust structs by ts-rs — do not hand-edit
│   ├── styles/                # Global CSS + tokens
│   └── types.ts               # Shared TS types (re-exports bindings/ + frontend-only types)
├── src-tauri/                 # Rust backend (Tauri shell + sidecar orchestration)
│   ├── src/
│   │   ├── lib.rs             # Tauri command registration + cache-sweep startup hook
│   │   ├── main.rs            # tiny entrypoint shim → sauce_bunny_lib::run()
│   │   ├── commands/          # Tauri commands by domain — twelve modules:
│   │   │                     #   download, media, transcript, library, tags, system,
│   │   │                     #   session, peer_stream, rung, llm, cloud_ai, sniff
│   │   └── stream_proxy.rs    # loopback fMP4 media proxy for web playback
│   ├── binaries/              # Bundled sidecar executables (gitignored; fetched by `npm run setup`)
│   ├── capabilities/          # Tauri permission lists
│   └── tauri.conf.json        # Bundle config + window settings
├── swift-sidecar/             # One SPM package, THREE sidecars
│   ├── Package.swift          # the source of truth for Swift deps — no .xcodeproj in git
│   └── Sources/
│       ├── saucebunny-diarize/  # speaker diarization (SpeakerKit, FluidAudio fallback)
│       ├── saucebunny-dictate/  # live on-device dictation (Apple Speech)
│       └── saucebunny-capture/  # ScreenCaptureKit screen sharing for co-review
├── aaf-sidecar/               # Read-only AAF reader, frozen with pyaaf2 and Python
├── scripts/                   # Build + maintenance scripts
├── e2e/                       # Playwright UI smoke — boots the frontend with Tauri IPC mocked
├── harness-audio/             # Decode probes (see below)
├── harness-csp/               #   "
├── harness-real/              #   "
├── licenses/                  # GPLv3 text, bundled because ffmpeg requires it
├── docs/                      # This file, DESIGN, DISTRIBUTION, HAND-TEST, DECISIONS
└── .github/                   # Issue templates + two workflows (ci, nightly-sidecars)
```

### The three `harness-*` directories

Not tests, and not dead code: **standalone probes that answer a question the
test suite structurally cannot.** Each boots Vite and drives a real browser
engine through Playwright, then prints observed numbers.

They exist because the app's hardest bugs have been environmental rather than
logical — a decoder that PARKS instead of throwing, a WASM step that a CSP
blocks on one engine and not another — and a mocked unit test cannot see any
of it. Run them by hand when touching the decode path; nothing in CI does.

| directory | the question it answers |
|---|---|
| `harness-audio/` | does the real mediabunny path decode this Opus/AV1 file, and at what rate |
| `harness-csp/` | which WASM and blob-Worker steps a given CSP actually blocks, per engine |
| `harness-real/` | does the REAL player component play a real MP4 over Range requests |

`ENGINE=webkit` runs any of them in Playwright WebKit, which is the closest
available stand-in for the WKWebView the app actually ships in. See
`harness-audio/README.md` for flags, and `docs/DECISIONS.md` for what these
probes have already overturned.

## Data flow

### Library organization

`LibraryBrowser` integrates a reference-only Projects/Favorites sidebar alongside
the existing disk browser. `library-organization.ts` validates the versioned
folder tree, identities, membership and smart rules; `LibraryOrganizationStore`
serializes acknowledged writes and owns scoped undo/redo. The native
`library_organization` commands write `Documents/Sauce Bunny/Library/organization.json`
atomically, with expected-text compare-and-save and a stable sibling file lock
across app processes. Failed or unknown-format reads never authorize a reset.

Project items are references to local paths, web URLs, transcript paths or saved
Multitrack document IDs. Removal/reparenting never deletes originals. Media
rename/repath updates stable asset IDs; organization undo preserves those newer
paths. Metadata dialogs merge their changes with current membership instead of
restoring a stale snapshot. Explicit Relink is available for local references.

`library-project-catalog.ts` combines known scanned files, cached web metadata,
transcript inventory/history and saved AAF documents using read-only commands.
Smart results use current facts, with unknown access kept distinct from offline.
Availability/tag reads are capped at 500 paths per batch; obsolete refreshes stop
before scheduling further batches. Existing Clip/transcript routes are reused;
saved Multitrack requests are deferred when that workspace has an active job.

The file browser paginates rather than discarding items above 300. Deeper folders
are scanned one level at a time into a browser-local overlay, leaving Home's
shared scan and registered roots unchanged. Disk moves remain explicit native
operations, with a navigable destination dialog and Browse for external locations.
See [LIBRARY-ORGANIZATION.md](LIBRARY-ORGANIZATION.md) for acceptance coverage.

### Multitrack documents

`MultitrackPage` owns its document, track selection, single-clock PCM audition, and
transcription jobs independently of App's Clip player. Navigation hides the
workspace without throwing away jobs, and pauses its audition when inactive.
`useMultitrackKeyboard` opens the numeric `MultitrackTimecodeDialog` only in the
active workspace outside editable fields and other overlays. It shares Clip's
digit-fill parsing and HUD styling; AAF rate/drop-frame conversion and source
start offset resolve only on Enter. The dialog seeks the existing audition
engine in frames, never the hidden Clip player. TRT is a separate duration
frame count, not an absolute source timecode.
`commands/aaf.rs` exposes the typed boundary; `commands/aaf/` separates the
versioned model/store, cancellable processes, bounded audio preparation, and
ASR result handling. The bundled `saucebunny-aaf` process resolves source spans
and reads embedded PCM; existing FFmpeg, Whisper, and Parakeet sidecars provide
resampling and recognition. No diarization or cloud service is involved.

The native schema-2 AAF document remains authoritative for labels, recording-date
provenance/overrides and per-track results, including committed empty results.
Native writes emit `saucebunny:multitrack-changed` only after atomic saving.
`useMultitrackLibrary` reconciles typed document entries on disk into the
Transcripts > Multitrack shelf; no SRT alias or second transcript payload is
created. Entries use source filenames and disambiguate preserved duplicates.
Unchanged reimports reopen an existing document; changed versions remain distinct.
Cast preferences are copied into document labels rather than live-linked.

The transcript pane keeps its overflow selector in a fixed, compact grid column
outside the scrolling person tabs. Optional **Search with AI** uses the same
installed model preference, local llama-server and streaming chat client as
AI Summary. `local-ai-server.ts` shares Summary/search cold starts and stops a
load only when its last waiter cancels. Each completed request rechecks native
server identity rather than trusting a stale frontend server handle.
`ai-transcript-search.ts` scans bounded sections without sampling away passages;
model-returned IDs are validated against that section and mapped to original
rows. No generated quotation or timestamp becomes a seek target. The search
hook cancels stale queries and document/person changes, with no work on playback
ticks or keystrokes. Search results are transient; saved transcripts and exports
are unchanged. Search is local even when Summary has an opt-in cloud provider.

Multitrack exports share the full manifest's audio-lane mapping. New AAF imports
retain optional `PhysicalTrackNumber`; legacy imports keep displayed lane order.
Filtered transcripts never renumber lanes. Avid serialization stays in the
shared marker writer. `multitrack-export.ts` owns the SRT overlap sweep and adapts
all saved passages to the existing escaped print template. Native Save As names
TXT/PDF destinations. `export_transcript_pdf` loads restricted HTML directly into
a script-disabled WebKit view with a unique private base URL, blocked navigation
and no capability grants. Asynchronous AppKit pagination writes a private staging
PDF; only a completed, validated PDF is atomically copied to the chosen path.
The separate `print_transcript` command opens the native print dialog and does not
claim that a file was saved. Neither route uses Tauri's data-URL HTML rewrite.

### Clip and Review media

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

   WEB SOURCE (no completed copy / live) ──► existing stream-first path:
                 MSEStreamPlayer
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
                 └─ on failure → yt-dlp download-to-cache → completed-copy path below

   The streaming path feeds native A/V decoding with FFmpeg's reference fMP4
   through a same-origin MediaSource blob. Completed review copies use the
   separate in-app local decoder below. See CLAUDE.md "Media playback path".

   COMPLETED WEB REVIEW COPY (Clip and Preview)
      ProxyPresentationPlayer / presentation-playback.ts
         ├─ local MediaBunny: authoritative scrub/seek and immediate Play
         └─ hidden, muted candidate: MSE split A/V, or native HLS/progressive
              resolve → prepare bounded buffer → confirm decoded frames
              → promote at the parked frame OR synchronized forward 1× playback

   Play never resolves URLs or seeks the candidate. It synchronously checks
   the confirmed source frame, current generation, seek/error state and >=2s
   contiguous playable media (or the remaining duration) for an already
   qualified candidate. Otherwise it starts the local copy immediately.
   Automatic promotion during forward 1× playback uses the stricter
   presentationCanSwitch check: current-generation advancing decoded frames,
   a fresh sample within one source frame of local playback, required tracks,
   no seeking/error, and >=5s contiguous playable A/V (or remaining duration).
   A resolved URL or successful play() alone is never readiness. Standby audio
   remains muted independently of the user's preference; picture, audible
   output and authoritative clock change together. Inactive events cannot
   update captions, transcripts or transport.

   Native waiting/fatal errors and lost synchronization fall back to the
   matching local position. Failed preparation/recovery stays local for that
   run, with another attempt permitted at pause or settled seek. Only the
   selected engine publishes time/playing state or plays audio. Native rate
   preference is retained, but the proxy reports its actual 1× capability.

   beginScrub disposes the candidate's fetch/decoder; endScrub resolves on the
   local frame without waiting for high quality. Preparation is one operation
   per settled target/generation. Matching pending requests reuse it; changed
   targets supersede it. A running candidate can align within its existing
   buffer, never rebuild repeatedly to chase the playhead. Scrubbing, shuttle
   and non-1× playback disable automatic promotion. Paused promotion preserves
   the exact source frame. Source epochs and transport command IDs gate
   callbacks. Signed-URL refresh never remounts a working active high-quality
   source; the replacement is held for safe preparation.
   MSE retains its ~30s ahead cap; native candidates use metadata preload and
   actual buffer observations (preload is only a browser hint).

─────── Playback + Mark in/out ───────

Export clip:
    Marked range → ffmpeg cut → MP4/MP3 in user-chosen folder

Generate transcript:
      │
      ├─► Whisper (whisper-cli sidecar)        ┐
      └─► yt-dlp captions                       ├─► SRT in ~/Documents/Sauce Bunny/Transcripts/<project or YYYY-MM>/
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

## Full-frame scene analysis (integration in progress)

`src/lib/scene-analysis/client.ts` owns a cancellable module worker. The worker
retains MediaBunny Input, decoded samples, canvas and detector features; the
window only serves compressed native filesystem ranges through the existing
typed IPC commands. Terminal messages acknowledge cleanup, and run IDs isolate
late results. The reference detector is distinct from the native video worker's
sampled semantic-retrieval index: only full-frame boundaries may establish a
shot count. The internally flagged AI Summary path prepares a 540p H.264 proxy
in the owned native worker, verifies every presentation timestamp after encoding,
and compares the browser's full decoded-PTS digest before adopting boundaries.
Versioned proxy/source mapping and immutable detector evidence are saved before
model reasoning. `useShotIntelligence` owns source/transcript generations and
Stop across preparation, detection, persistence and bounded native shot batches.
The existing text conversation stays mounted across the compact mode switch.
The remembered, verified picture-model ID (9B default, optional 4B) passes through
the typed request into each native run and its result provenance. Selection is
frozen while running; embeddings and audio classification remain separate.
Picture inference receives frames without dialogue; supplied transcript text has
its own response field. Pinned software AV1 decoding extends the existing runtime
without changing the source identity or presentation-time mapping.
Analysis emits source-labeled, ordered `video-analysis-pipeline` events to the
main window from either docked or detached panels. `useAnalysisPipeline` feeds
the existing bounded Pipeline log (and therefore Copy/Export diagnostics) and
its active badge. Native job-scoped observers report real model loading and
shot counts; percentage updates are coalesced. The worker publishes each complete
description while keeping the model loaded for its bounded batch. Native and
frontend validators bind every update to its job, source, detector ID, model,
requested range and sampled frames. The final batch must match the live updates.
Stop retains accepted rows; source changes hide them and reject late updates.

When no transcript is supplied, `scene-analysis/dialogue.ts` owns a separate
local Clip Whisper job before picture inference. It uses the selected installed
Whisper model with fast decoding and cached SpeakerKit diarization; it never
downloads models. `transcript-preview` exposes the completed Whisper SRT while
speaker detection finishes. Final text and speaker labels replace those dialogue
cells, with cue overlap mapped to the same source-relative shot ranges. Speech
stays outside picture prompts and immutable detector evidence. A second source
identity check precedes adoption and picture inference. Unique library filenames
avoid overwriting existing transcripts, and committed saves are recorded even
when Stop or navigation rejects their display. Existing supplied transcripts
remain untouched; a retry reuses this run's verified dialogue. Missing speech
models remain an Info diagnostic and do not prevent picture analysis.
Terminal events identify user Stop, source/panel changes, priority cancellation,
and failures; stale events cannot revive a finished run. This observability
path does not change cancellation, add resumability, or persist model answers.
Analysis metadata and diagnostics live in `ShotAnalysisInfo`, a viewport-contained
disclosure next to the existing settings gear. Its trigger is portalled into
the mode row while the source-bound analysis hook retains ownership; opening
info performs no native work. The tab toolbar holds Add cut markers immediately
after Audio, outside the tablist. Results retain their terse missing/pending
states; failure changes the CTA to Retry analysis and marks the info trigger
without inserting diagnostic prose into the results table.
Analysis start/end, audio ranges, durations and cut tooltips use source-rate
HH:MM:SS:FF non-drop-frame timecode, shared with the player. Only timecode
numbering uses rounded FPS; media-time conversions retain the actual rate
(e.g. 60000/1001). Half-microsecond tolerance at frame boundaries accounts for
the proxy's PTS serialization without snapping arbitrary seeks or modifying
immutable evidence. Shot end is exclusive. VFR retains original PTS for seeking;
the displayed clock is its source-rate timeline address, not a decoded-frame ordinal.
The playhead's consumers, panel heartbeat, scrub/step and export paths use the
same actual-rate clock. New queue rows carry `frameClock: "source"`; legacy rows
keep their rounded-FPS elapsed ranges. Source marks persist their conversion
rate; old marks restore to the nearest source frame once, including late FPS
metadata, without re-saving a stale pre-conversion snapshot.
This is not yet enabled by default. See `docs/VIDEO-INTELLIGENCE.md` for tested
browser surfaces and remaining rollout gates.

## Local AI: one transcript ingestion, shared by every feature

`llama-server` runs as a sidecar and the AI Summary, the auto-chapters and the
reader Analysis all talk to it. The expensive part of any of those calls is not
generation — it is reading the transcript in. On an M4 Max a feature-length
transcript is ~10,000 tokens at ~180 tok/s: about a minute before the first
token of an answer.

llama-server will reuse the KV cache for whatever PREFIX a new prompt shares
with the previous one, so that minute is payable **once**. Getting that reuse
is the entire design:

- **`src/lib/prompt-prefix.ts` owns the system message**, and every feature
  sends it byte-for-byte identically. Nothing that varies may enter it — not
  the summary style, not the source description, not the question.
- **Task instructions ride in the user turn**, after it.
- **Summary context is windowed one way** (`fitTranscript`, sampled evenly
  across the runtime). Two different windowings of one transcript are two
  different prompts and share nothing.

Multitrack semantic search is intentionally exhaustive instead: it uses the same
prefix builder on bounded, unsampled sections and sequentially searches every
section. Its cue-ID records differ from the summary's timestamped input, so it
does not claim cross-feature KV-cache reuse for that different representation.

Measured on one server, 28,335 tokens, three consecutive features: **60.92 s**
for the first, then **0.13 s** and **0.15 s**.

This used to be the other way round — each feature put its own rules above the
transcript — so the prefix diverged in the first fifty tokens and every feature
re-read the whole video. `prompt-prefix-contract.test.ts` pins it, because the
regression breaks nothing: the app simply becomes slow again, and "slow again"
is indistinguishable from "local models are slow".

**Server flags that matter** (`src-tauri/src/commands/llm.rs`): threads are the
PERFORMANCE core count, not `available_parallelism()` — the batch synchronises
each step, so including efficiency cores drops the whole run to their pace
(measured 37.7 → 83.8 tok/s on a 4B). `--reasoning-budget 0`, because Qwen3's
template enables thinking and a "summarise this in a few bullets" request spent
3,254 tokens reasoning without reaching an answer. `-np 1`, because the app
serialises model calls and the auto-chosen 4 slots each reserved a full context
of KV cache for work that cannot arrive.

## Transcript projects

A transcript lands in `Transcripts/YYYY-MM/` — a bucket the app makes on the
day you hit transcribe. That is filing by accident, so a transcript can be
moved into a **project**: a directory you name under the same root.

The choice worth knowing is that **the filesystem is the truth**. A project IS
a directory. Moving a transcript into one is `mv`, the files stay browsable in
Finder, and deleting the metadata costs posters and nothing else.

```
~/Documents/Sauce Bunny/Transcripts/
├── 2026-08/            ← auto, a month bucket: plain label, no menu
├── Marry Harry/        ← a project: named, poster, rename/delete
│   ├── ep1.srt
│   └── ep1.diarization.json
└── projects.json       ← metadata ONLY (title, poster, colour)
```

| piece | what it does |
|---|---|
| `src/lib/transcript-projects.ts` | pure model: what a project is, which transcript supplies its picture, reconciling stored metadata against the folders that actually exist |
| `src/lib/transcript-project-store.ts` | debounced atomic write-through to `projects.json`, on the existing invoke surface — no new Rust command |
| `src-tauri/src/commands/library.rs` | `create` / `rename` / `delete` of the directory itself |
| `src/components/ReaderProjectHeader.tsx` | the group heading: picture, name, count, menu |
| `src/components/ProjectMenu.tsx` | rename / choose picture / delete, each a dialog because each touches disk |

Three rules that are easy to get wrong and are pinned by tests:

- **Hydration waits for the first scan.** Reconciling against an empty folder
  list drops every stored project as "not on disk", and the next sync writes
  that back — posters gone on every boot, from a list that only meant the scan
  had not finished.
- **Rename carries the metadata, and only after the disk rename lands.** The
  folder is the key, so a rename orphans the entry otherwise.
- **Delete is not recursive.** It refuses while transcripts remain and says how
  many. `remove_dir` would refuse anyway; the count is what makes the refusal
  an instruction rather than `Directory not empty (os error 66)`.

Month buckets are deliberately not projects: they are the app's own filing, so
they get a plain label and no menu. Offering "Delete" on `2026-08` is offering
to bin a month of work nobody chose to group.


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

### Embedded OBS capture (not shipped)

The in-development GPL helper lives in `obs-sidecar/`, outside the MIT Tauri
binary. Its `Engine` owns libobs and pinned modules. `ProgramOutput` gives
each capture its own OBS canvas, stereo mix and inherited output descriptor;
slots 0 and 1 are reserved until their outputs finish teardown. Picture and
audio are still encoded as the same bounded, independently decodable fMP4
used by the existing live-program ring. No OBS UI, user plugins or new network
transport are involved.

The Rust supervisor now owns one `capture-service` process, with two separately
cancellable slots. A bounded owner-only command pipe carries exact selections;
stdout chunks carry slot/generation identities before entering independent MP4
framers and the existing Program rings. Old-generation records cannot affect a
replacement. A slot's capacity is held until native source teardown is
acknowledged; the last slot closes the helper, which is reaped before another
engine may start. Consumer backpressure does not control native capture.
This replaces the per-program process path that could interrupt another
ScreenCaptureKit stream when one process exited. The old single-worker runner
remains test-only for historical media/owner regression gates.
The existing explicit stop command now waits outside the session lock for the
OBS slot's teardown acknowledgement and released worker permit; the final slot
also waits for the helper to be reaped. A scoped completion signal prevents an
immediate source replacement from racing native capacity release. Exact
application/PID/window/crop provenance is retained only in local status
snapshots. It is not added to room announcements, program URLs or peer telemetry;
the current NDI-only session restore still excludes application captures.
Renderer commands and release packaging remain disabled.
The optional raw-output branch reads the same private canvas and exact stereo
mix. Preallocated callback buffers feed a separate nonblocking pipe writer;
encoded Preview never waits for that consumer. A fixed 64-byte header carries
only capture/broadcast generations, original media timestamps and format sizes.
No selected application names, window titles or paths enter this stream.
Each explicit attempt receives a new unlinked FIFO through a separate inherited
Unix datagram control channel. On macOS, its endpoints are opened atomically
close-on-exec instead of creating a pipe and setting flags afterward, which
allowed concurrent child processes to retain a writer and prevent EOF. A private
temporary directory anchors creation and type/identity checks; FIFO metadata and
the directory are removed before returning the endpoints. Media stays in kernel
memory. Allocation failures affect only the optional raw branch. The helper
closes callbacks and joins its writer
before acknowledging stop; failed partial streams are retired rather than reused.
Raw-control failure is scoped to this branch, not the encoded Program. This is
native groundwork, not an NDI sender or an enabled renderer feature. A final
consumer must also drain EOF and confirm its own shutdown before reporting that
broadcasting has stopped.
The separate in-development `src-tauri/native/ndi_sender*` executable consumes
that raw pipe through the pure MIT framing header. It does not link libobs.
Strict generation/raster/sample validation precedes synchronous NDI submission;
borrowed buffers remain owned until each SDK call returns. Tests replace only
the SDK factory, without starting a network source. The native supervisor reserves
an immutable capture/attempt tuple without transferring media, starts the sender,
and arms the raw producer only after SDK readiness. Live requires both the raw
start acknowledgement and successful sender submissions from both tracks.
Cancellation owns the sender through reap, then independently confirms the helper
stop acknowledgement and drains the retained pipe reader to EOF. A blocked SDK
is terminated in its own process without stopping Preview. Lost PID ownership
is quarantined, never treated as permission to signal a potentially reused PID.
Ordinary app exit closes broadcast admission and awaits bounded cleanup; forced
exit/restart relies on the sender's independent parent-loss watchdog. That
watchdog remains active during SDK calls and destruction. Neither a timeout nor
an unconfirmed acknowledgement is reported as a successful stop.
Renderer controls and production acceptance remain unfinished; this native API
is not an enabled renderer feature or a registered release sidecar.
A separate internal-only app stager copies a clean built app to a new location
and nests a resource-only `Contents/Helpers/OBS.bundle`. Its `Contents` directory
is the fixed packaged runtime root; an environment override cannot replace it.
The application profile excludes diagnostic executables and seals its license,
source and inventory resources separately from helper/library code. The stage
verifier checks dependency closure, component hashes and strict same-team
signatures without launching, installing, notarizing or publishing the app.
Complete source materials and packaged playback acceptance remain separate gates.
The internal app builder also stages a separately signed `NDISender.bundle`.
Its frozen MIT sources, SDK-header hashes, build recipe, target/linkage checks
and signed inventory are sealed independently. The sender reuses the existing
app NDI runtime, and final internal verification runs the NDI package verifier
as well as the OBS/sender checks. OBS-only staging remains supported through an
explicitly absent sender option; an unrecorded sender bundle is rejected.
This does not add the sender to the release resource list or enable UI controls.
The generated-window service verifier has an explicit application mode. It
validates the enclosing app before executing only its packaged capture helper
under the Rust test supervisor. Evidence records that boundary; it is not a
packaged-main/WKWebView or NDI network acceptance test. The smaller application
runtime must pass its own profile rather than borrowing diagnostic binaries.
Core/helper builders now freeze their own inputs before compiling and associate
source hashes with compiled UUIDs. The separate source-material stager checks the
runtime and copies those frozen inputs, supplied notices and pinned archives with
an exact output manifest. It refuses old unrecorded builds and detects source
drift; it does not establish reproducible binaries or complete dependency sources.
These materials remain explicitly internal-only and not distribution-ready.
The manual shared-service lifecycle gate includes decoded PCM continuity, not
only packet timestamps. Stage traces localized a 1024-sample dropout to the
OBS mixer despite continuous captured samples. The private engine now reserves
six mixer blocks (128 ms at 48 kHz) at startup instead of growing its reserve
during playback. A generated arrival-jitter negative control reproduces the
old fault; the fixed configuration passes that input without silent blocks.
Native flash/tone tests separately guard picture/audio alignment. This does not
replace sustained real-editor/WKWebView acceptance. Native-test diagnostics are
local and test-only; production discards stderr. Source-stop diagnostics contain
only bounded reason codes, slot/generation and numeric raster dimensions, never
titles, paths or PIDs. The capture module consumes geometry only from complete
ScreenCaptureKit frames. Idle/started notifications retain the confirmed raster;
blank/suspended/stopped states latch source loss. A generated IOSurface regression
fails against the earlier module, which reset a valid raster to zero on idle.
See [the implementation and acceptance record](EMBEDDED-OBS-CAPTURE.md)
for the remaining UI, real-editor, room/NDI and distribution gates.

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
  Insertion and snapshot filtering share the private `commentDeletedAt` rule
  in `review.ts`: a reply inherits the newest deletion of itself or its
  parent, and only a later explicit restoration can survive that deletion.
  The private `mergeComment` keeps per-comment reconciliation separate from
  the document merge: host revision takes priority, then restoration time,
  then edit time; exact ties retain the incoming comment. Reactions merge
  independently of the winning text. Both helpers remain in the domain
  module, with no new public API or persistence format.
- **Screening mode** is a pure CSS reflow of the existing body (participant
  rail replaces the sidebar; the player is never remounted). The rail reads
  real roster data; the host is identified by roster position 0 — the name
  "Host" is reserved server-side so a guest can't claim the crown.
- **Input hardening**: relayed control lines are capped (2 MB), Presence names
  run through the same `clean_name` as Hello.
- **Web-source only** for now (a local file can't reach guests); a relay-URL
  override + LAN-only mode is deferred (Phase 3 note in session.rs).

## Saved review-session navigation

The Library session shelf opens `SavedReviewSession` in place. Its browser
stays mounted/hidden so Back preserves search, selection, scroll and row focus.
`SavedSessionNotes` reads the existing hydrated Reviews store and subscribes to
the selected document; it never creates or saves a second copy. The pure
`lib/saved-session.ts` resolver matches local keys, fingerprints, source URLs
or recorded comment IDs, never a similar title. Locally recorded root IDs
include guest notes whose originating session IDs differ; replies follow the
selected roots. Multi-source sessions have an explicit source chooser.

NDI archive keys are not paths. They cannot reach file/web loaders. The reader
does not join sessions, connect Premiere, restart an NDI receiver or alter
playback. A file/web source has a separate explicit Open source in Clip action;
ambiguous version stacks do not silently open the current/first version.
Missing media does not gate note access; a missing review document is reported
instead of pretending the archive had no notes.

Screening index `sourceKinds` and `premiere` fields are additive, preserved by
the whitelist parser, and populated on ordinary future saves. Legacy index
rows get read-only badge enrichment from their full records with at most three
reads in flight. No migration rewrites archived sessions on opening the shelf.

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
  `ReaderPlayerStage` joins that list: the reader's follow-along player reads
  the same store at full tick rate for its clock, its scrub fill and the
  marker positions on its position bar. One clock, no second source of time.
- **Action-time readers** — mark in/out, frame snapshot, seek-by-seconds, and the co-review heartbeat/presence/chase call `getPlayheadFrames()` when they fire; the shuttle edge-stop watches via a plain subscription (no re-render at all).
- **Cross-window feed** — the popped-out panel can't subscribe across webviews, so the playhead reaches it as data, without re-rendering App: the change-driven `panel:state` snapshot carries the position as of its publish (the boot seed + the pause/seek truth), and `use-panel-bus` emits a lightweight `panel:playhead` heartbeat (4 Hz, only while a panel is detached and the playhead actually moved) that PanelApp writes into its window's store. The live clock deliberately stays OUT of the snapshot so playback never re-serializes it.

### What is left to extract, and what only looks extractable

`App.tsx` remains the application composition root. The roadmap direction is one cohesive subsystem at a
time into `src/hooks/use-*.ts` (done: `use-panel-bus`, `use-web-playback`,
`use-co-review`, `use-library-scan`, `use-media-capture`, `use-transport`,
`use-keyboard-shortcuts`, `use-clip-export`, `use-clip-queue`,
`use-local-source`, `use-fetch-source`, `use-transcript-jobs`).
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

That split is now finished: all four live in `src/hooks/` as
`use-clip-export-listeners`, `use-captions-listeners`,
`use-transcript-listeners` and `use-playback-prep-listeners`, each with its own
test file. App.tsx registers almost nothing directly any more. The paragraph
above describes the step that made this possible, not the current state — an
extraction that owns an event now lifts a whole hook rather than carving a
listener out of a shared effect.

**Premiere context/receipt publication (2026-09-10).** The host publication
effects now live in `use-premiere-publication.ts`. The effect bodies moved
unchanged; only stable ref dependencies were added at the hook boundary.
Native source ownership, session ID and context revision remain the gates for
each awaited broadcast. Microtask coalescing, unchanged-message deduplication,
the existing recovery cadence and cleanup are preserved. Mounted tests cover
unchanged heartbeats, source changes during broadcast, late joins, receipt
sanitization and unmount cancellation. This does not move playback ownership.

`premiere-binding.ts` is the dependency-free identity/validation home shared by
the desktop client and Premiere companion. Both now require the former desktop
field/tick bounds and the companion's canonical positive timebase; neither
accepts a value the other previously rejected. Native validation still applies
its own final field/byte checks. Transport-specific envelope validation remains
in `premiere-notes.ts` and companion `protocol.ts`. Receipt sending and receiving
share `MAX_PREMIERE_RECEIPTS_PER_MESSAGE`; batching does not drop excess notes.

The two `PeoplePanel` mount sites share one typed props object in `App.tsx`.
Only `active` and `strip` stay local to each layout. Participant/device truth,
host actions and capture callbacks cannot drift by layout, and neither the
panel positions nor the media player mounts move.

**Review and capture correctness (2026-09-10).** Invitation storage defaults
apply only to an absent store, not denied access, malformed/incomplete JSON or
a dangling link. Read failures preserve the file and block new admissions;
native session startup and the host notification surface report the error.
Read-modify-write transactions are serialized so arrival timestamps cannot
overwrite a concurrent withdrawal. Copy uses the live room's identity, or
reads the current offline identity on demand, without losing a still-valid
one-time grant when the dialog closes. Matching withdrawal invalidates copy
feedback; clipboard failures are visible.

Session capture keeps pending explicit device intent separately from saved
preferences and confirmed tracks. Camera/Mic on actions combine while capture
is pending; off, release and pagehide invalidate obsolete results. Duplicate
pending on requests reuse the current acquisition. A failed request cannot
revive a device, and a still-working stream survives a failed replacement.

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

## Multitrack settled-view work (September 14, 2026)

Multitrack retains its existing AudioContext audition clock, indexed native
PCM reader and persistent min/max waveform pyramids. The architecture review
found unnecessary **render-time** work, not evidence for replacing that audio
engine: timeline clips, text-overlay geometry and ruler labels were recalculated
on every playhead and hover update. The timeline now caches clip geometry by
track data and viewport, and groups enabled text overlays in one pass per
document/viewport/overlay change. Previously each enabled track scanned all
transcript rows on every tick. The cursor and accessible slider position remain
live. No extra source of time, global cache or persisted state was introduced.

The right transcript pane caches the visible page's fixed timecodes and run
information separately from current-cue highlighting. Search, pagination,
document replacement, timing-review results and changed run reports invalidate
the relevant calculation. Caches are component-owned and disappear on unmount.
The waveform canvas already avoids repainting unchanged peaks; broad React
memoization, a new state library and decoder lazy-loading were not adopted.

Person-scoped transcripts and exports share `multitrackPeople`/`multitrackScope`;
explicit cast IDs take precedence over assigned mic labels. Track regeneration
snapshots its engine/model and reuses the normal job/save path, replacing only
the selected track after success. A shared export hook owns the destination
dialog and bounded atomic writes; Avid serialization reuses the existing marker
formatter, with rational sequence-frame conversion at the boundary. No new
persistence schema, transcription engine, or native command is introduced.

Each audition voice feeds its track gain before the existing master gain, all
on one AudioContext clock. Gain changes never rebuild voices. Warm scrub resumes
the context only on an enabled gesture and guards async completion by generation;
throttling retains the latest pointer position. Text overlays aggregate at wide
views and preserve segment bounds at close zoom. The Generate/Export footers
share grid rows; size containment belongs inside the editor, not on its subgrid.

Regression instrumentation reproduced 375 clip-position reads across the
initial three-track render plus 24 frame updates, versus 15 after caching;
changing zoom still recalculates them. A second regression reproduced four
fixed-clock conversions per transcript tick; those conversions now happen only
when their input changes, while active-cue highlighting still follows playback.
These are work-count measurements, not claims about end-to-end audio latency.
The existing Undo round-trip unit test now uses explicit operation timestamps
instead of depending on two wall-clock calls landing in the same millisecond;
the production undo path and its execution-time restamping are unchanged.

The deliverable uses the internal OBS staging recipe so it includes the current
screen/region controls and isolated NDI sender as well as Multitrack. The normal
`build:dmg` path alone does not include those helpers. The test app retains
`com.saucebunny.desktop` and stable Apple Development signing; it is not a
Developer ID-notarized public release.

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
- `media/downloads/` — completed download-fallback copies, exempt
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

## Local video intelligence (September 2026)

Settings manages explicitly downloaded video models; Library owns selected
source scope. `use-video-intelligence` dispatches typed, cancellable requests to
`commands/video_intelligence.rs`. Rust owns one heavy worker and gives existing
playback, ASR and text AI priority. `video-sidecar/worker.py` runs one request per
process: bounded PyAV frame decoding, native MLX-VLM embeddings/reranking/video
descriptions, durable SQLite checkpoints and disposable usearch HNSW indexes.
Inference has no server or implicit download. Source navigation uses decoded
timestamps, never model-authored timecodes. See [Video Intelligence](VIDEO-INTELLIGENCE.md)
for resource bounds, build locks, runtime verification and current limitations.

The optional `analyze-audio` request uses the same Rust job owner but starts
`saucebunny-audio-analysis`, a system-only Swift resource helper, instead of the
Python worker. AVFoundation decodes local audio into three-second PCM windows;
SoundAnalysis returns raw scores with actual source-time coverage. Rust adopts
the collected evidence only after matching source identity and a clean worker
completion. It does not capture a device or download a model. The feature-flagged
Advanced Intelligence controller requests it after visual descriptions and
keeps those descriptions when optional audio analysis fails. Source/run identity
is rechecked before freezing the response. A compact disclosure shows actual
window ranges and unverified classifier suggestions, not inferred music genres.
Music calibration, durable audio results and packaged validation remain rollout
gates.

The optional AST candidate (`video-sidecar/audio_ast.py`) performs local
MLX/NumPy classification against checksum-pinned AudioSet weights. Settings offers
an explicit download; the feature-flagged controller selects `analyze-music` when
its receipt is ready, otherwise retaining the native `analyze-audio` path. Both
use the same owned job and Stop/source-generation checks. Developer-only parity
scripts live in `scripts/music-analysis/`; numerical parity is verified on smoke
fixtures, not music accuracy. `audio_pcm.py` supplies bounded ten-second, 16 kHz mono
windows through PyAV's in-process resampler. Decoded PTS validate each contiguous
region before an exact sample clock removes container quantization; original
anchors, gaps and unpadded tails remain source-timed. `music_analysis.py` owns the
decoder and model, streams evidence, and emits completion only after a second
source hash and successful model cleanup. Failure or cancellation cannot publish
an adoptable result. The transport preserves all 527 float32 scores per window,
with one shared vocabulary; Rust validates identity, coverage and the complete
stream before returning immutable frontend evidence. The LGPL decoder recipe
enables the required audio filters. Existing frozen workers need rebuilding.
`scene-analysis/music-summary.ts` is a versioned presentation policy over that
completed evidence, not another inference engine. It groups related AudioSet
genre scores by their maximum and abstains on short, weak or conflicting
evidence. Suggestions preserve actual window ranges and leave the raw scores
unchanged. Its provisional thresholds and remaining calibration gates are
documented in [Video Intelligence](VIDEO-INTELLIGENCE.md). Packaged lifecycle
validation remains open; this source checkpoint does not update the installed
app or enable the feature flag.

## Tone-card design grammar (shell v3)

Panels (sidebar, queue drawer, library tree/detail, the co-review participant rail) are uniform
tone cards: `--bg-1` surfaces on the `--bg-0` canvas, `--r-lg` radius,
8px gutters with 4px half-gaps, and NO borders — tonal contrast does the
separation. The flat tier (nav rail, Home, Library hero/grid) and the
open center (monitor + timeline) stay borderless and flush. Focus never
uses the green accent: `--focus-ring` (white) brightens the control's
outline; composed fields brighten the wrapper and suppress the inner
ring (guarded by `src/lib/focus-contract.test.ts`).
