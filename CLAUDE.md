# CLAUDE.md — Sauce Bunny Project Constitution

> Claude Code reads this file automatically on every session.
> It is the single source of truth for how this codebase should be maintained, refactored, and extended.
> Current revision: r44 (2026-05-24)

---

## What this app is

Sauce Bunny is a **local-first macOS desktop app** for transcribing, diarizing, and editing video/audio content. It runs entirely on the user's machine — no cloud, no accounts, no telemetry.

- **Shell:** Tauri 2 (Rust backend → WKWebView frontend)
- **Target:** macOS 13+, Apple Silicon only. No Windows/Linux builds.
- **License:** MIT
- **Distribution:** self-hosted notarized `.dmg` (NOT Mac App Store). See `DISTRIBUTION.md` for the full reasoning and release flow. The app intentionally cannot pass App Store review (bundled yt-dlp + arbitrary subprocess spawning + cookie reads across apps), and we have decided that's the right tradeoff. Do NOT add MAS-compliance code (App Sandbox entitlements, security-scoped bookmarks, helper-app refactor of sidecars) — it would cost product features without unlocking any distribution channel we want.

## What this app is NOT

Do **not** add any of the following. If you think the app needs one, stop and explain why before writing code.

- No backend framework (no Express, no FastAPI, no Hono — this is a desktop app). **One deliberate exception (r58/r63):** a tiny `127.0.0.1` loopback HTTP server in `src-tauri/src/stream_proxy.rs` that streams remuxed web video into the `<video>`/MSE pipeline. It binds loopback only (never `0.0.0.0`), serves no app logic, and is the *only* way to play web sources with audio in WKWebView (see "Media playback path"). It is a media primitive, not an app backend — don't grow it into one.
- No CSS framework (no Tailwind, no styled-components, no CSS-in-JS)
- No state management library (no Redux, no Zustand, no Jotai, no MobX)
- No router (no React Router, no TanStack Router — single-page app, second window uses `?window=panel`)
- No analytics, telemetry, or tracking of any kind
- No authentication or user accounts
- No additional bundler config beyond Vite defaults
- No AI/ML inference in the frontend (Whisper and diarization run as native sidecars)

---

## Architecture overview

```
src/                          # React 18 + TypeScript (strict)
  components/                 # One component per file, PascalCase.tsx
  lib/                        # Utility modules (mediabunny wrappers, helpers)
    mediabunny-helpers.ts
    mediabunny-export.ts
    mediabunny-audio.ts
  hooks/                      # Custom hooks — only when shared across 3+ components
                              # (create on first need; not yet present)
  styles/
    tokens.css                # Design tokens (colors, spacing, type scale, radii)
    app.css                   # All component styles, organized by section comments
  main.tsx                    # Entry point — reads ?window=panel → PanelApp vs App
  App.tsx                     # Main window root
  PanelApp.tsx                # Floating side-panel window root (r44.B)
src-tauri/                    # Rust backend
  src/
    main.rs                   # 4-line shim — calls sauce_bunny_lib::run()
    lib.rs                    # Tauri app setup, menu, window management, command registry
    commands.rs               # ~30 invoke handlers (monolith — splitting is on roadmap)
  tauri.conf.json             # Tauri config (titleBarStyle: Overlay, sidecar declarations)
  Cargo.toml                  # Package: sauce-bunny · lib: sauce_bunny_lib
swift-sidecar/                # Speaker diarization (Swift 5.9+, SPM)
  Sources/
  Package.swift               # THE source of truth for Swift deps — no .xcodeproj in git
scripts/                      # Build/maintenance scripts
  build-diarizer.sh           # Compiles saucebunny-diarize, copies into src-tauri/bin/
  refresh-sidecars.sh         # Pulls latest yt-dlp, records version
.github/workflows/ci.yml      # macOS-latest: tsc --noEmit, cargo check, swift build
```

### Do not create these directories
- `utils/`, `helpers/`, `shared/`, `common/`, `core/` — put things where they're used
- `services/` — Tauri commands are the service layer
- `store/`, `state/`, `context/` — hooks + Tauri events handle state
- `types/` as a standalone dir — colocate types with the code that uses them
  (the existing `src/types.ts` is a shared-types convention, not a directory)

---

## Tech stack (locked)

| Layer | Technology | Notes |
|-------|-----------|-------|
| Shell | Tauri 2 | WKWebView, custom titlebar, native menubar via `tauri::menu` |
| Frontend | React 18 + TypeScript strict + Vite 6 | Single bundle, multi-window via query param |
| Styling | Hand-rolled CSS | Tokens in `tokens.css`, components in `app.css` |
| Font | Nunito Sans | Self-hosted via `@fontsource/nunito-sans` (300/400/600/700/800 + italic) |
| State | React hooks only | Cross-window sync via Tauri events |
| Persistence | `localStorage` | Namespaced `saucebunny.*` |
| Backend | Tauri 2 invoke commands | `tokio` async, `serde` JSON |
| Media decode | mediabunny | WebCodecs MP4/MOV, frame-accurate scrub |
| MP3 encode | `@mediabunny/mp3-encoder` | LAME-via-WASM, registered once at startup |
| Transcription | whisper-cli (whisper.cpp) | Sidecar, 16kHz mono WAV input |
| Diarization | saucebunny-diarize (Swift) | SpeakerKit primary, FluidAudio fallback |
| Video download | yt-dlp | Sidecar, bundled binary |
| Media processing | ffmpeg | Sidecar, clip cutting + transcode fallback |

### Plugins (Tauri)
`tauri-plugin-shell`, `tauri-plugin-dialog`, `tauri-plugin-opener`, `tauri-plugin-clipboard-manager`, `tauri-plugin-notification`

Do not add new Tauri plugins without explaining what existing capability is insufficient.

---

## Code style rules

### General
- **Composition over abstraction.** A clear 20-line component beats a 5-line component that imports from 4 utility files.
- **No barrel exports.** No `index.ts` re-export files. Import directly from the source module.
- **One component per file.** If a helper function is only used in that component, keep it in that file.
- **No dead code.** No commented-out blocks. No `// TODO` without a linked issue number.
- **No `any`.** Use `unknown` + type narrowing if the type is genuinely unknown.
- **Prefer `type` over `interface`** unless you need declaration merging or `extends`.

### TypeScript / React
- Extract a custom hook **only** when the same stateful logic appears in 3+ components.
- Keep components under 150 lines. If a component is longer, it probably needs to be split — but split into **sibling components**, not into a deeply nested abstraction tree.
- Event handlers: define inline if ≤2 lines, extract to a named function if longer.
- Avoid `useEffect` for derived state — compute it during render.
- Use `React.memo` only after profiling confirms a re-render problem, never preemptively.

### CSS
- All styles live in `src/styles/app.css`, organized by component name in comment blocks.
- Use tokens from `tokens.css` for colors, spacing, font sizes, radii. Never hardcode hex colors or pixel values that have a token equivalent.
- No inline styles. No CSS-in-JS. No CSS modules.
- Class names: kebab-case, all prefixed with the stable project namespace `cp-` (carryover from the original ClipPull name — kept intentionally because renaming ~600 classes touches every file and adds no user-visible value). Within that prefix, group by component context (e.g. `cp-player-controls-volume`, `cp-tx-speaker`, `cp-queue-foot-row`). New code MUST use the `cp-` prefix; do not introduce a new prefix.
- No `!important` unless overriding a third-party style you can't control.

### Rust
- Invoke handlers in `commands.rs` should be **thin wrappers**: validate input, call business logic, format the response. The business logic itself belongs in dedicated modules (this refactor is in progress).
- Use `#[tauri::command]` with typed args — no manual JSON parsing in handlers.
- Errors: return `Result<T, String>` from commands. Use `.map_err(|e| e.to_string())` for now (proper error types are a future improvement).
- JobRegistry pattern: any long-running sidecar process must be registered so it can be canceled.

### Swift (swift-sidecar/)
- This directory is a **Swift Package Manager** project.
- It **must** build with `swift build` from the command line.
- It **must** open in Xcode via `File > Open > swift-sidecar/Package.swift`.
- **Never** add `.xcodeproj` or `.xcworkspace` files to git — SPM generates these on demand.
- Target macOS 13+, Swift 5.9+.
- Use AVFoundation for audio loading — do not introduce a WhisperKit dependency.
- The JSON envelope schema (v1) is a contract between Swift, Rust, and JS. Changing it requires updating all three layers.
- **Never** import UIKit (this is macOS, not iOS).

---

## Multi-window architecture (r44.B)

Two windows: **main** and an optional **floating side-panel**.

### Routing
Single Vite bundle. `main.tsx` reads the `?window=` query parameter:
- No param or `?window=main` → mounts `<App />`
- `?window=panel` → mounts `<PanelApp />`

Do not introduce a router for this. The query-param switch is the entire routing layer.

### Event bus
Cross-window communication uses Tauri events, not shared state:

| Event | Direction | Purpose |
|-------|-----------|---------|
| `panel:state` | main → panel | Push current state to floating panel |
| `panel:action:<kind>` | panel → main | Panel requests an action from main |
| `panel:request-state` | panel → main | Panel asks for current state on mount |
| `panel:popped-out` | Rust → main | Notifies main that panel window was created |
| `panel:closed` | Rust → main | Notifies main that panel window was destroyed |

When adding a new cross-window interaction, use this event pattern. Do not introduce a shared state store, BroadcastChannel, or postMessage.

---

## Storage layout

| What | Where |
|------|-------|
| App cache (temp files) | `app_cache_dir()` prefixed `saucebunny-*`, swept on startup (>24h) |
| Whisper models | `app_data_dir()/whisper-models/` |
| Diarizer models | Bundled or downloaded on first run, cached locally |
| Transcript library | `~/Documents/Sauce Bunny/Transcripts/YYYY-MM/` |
| User prefs | `localStorage` namespaced `saucebunny.*` |

Do not change these paths without updating both the Rust backend and the frontend.

---

## Build-ID handshake

The frontend defines `EXPECTED_BACKEND_BUILD_ID` in `src/lib/build-id.ts`. The Rust backend exposes `BACKEND_BUILD_ID` in `src-tauri/src/commands.rs` via the `get_backend_build_id` command. On app startup, the frontend checks that they match. If they don't, the user sees a warning that the Rust binary is stale.

When modifying Rust commands or changing the invoke API surface, bump the build ID in both places.

---

## Media playback path

There are TWO playback paths — local files and web sources — because they
hit completely different WKWebView constraints.

### Local files (imported)
Smart selection, tried in order:

1. **Native HTML5** `<video>` (`LocalMediaPlayer`) — if WKWebView can play the format natively (`asset://`, same-origin).
2. **mediabunny / WebCodecs → canvas** (`MediaBunnyPlayer`) — decode any codec WKWebView's `<video>` can't, render to canvas. Toggle in Settings.
3. **ffmpeg transcode** — sidecar prep to a WKWebView-compatible MP4 when WebCodecs can't decode either.

### Web sources (YouTube/Vimeo/… — the r53–r66 saga)
WKWebView makes the obvious paths impossible, all VERIFIED dead ends:
- **YouTube IFrame** → Error 153 (YouTube tightened Referer/origin Dec 2025; `tauri://localhost` rejected).
- **`<video src="https://googlevideo…">`** (direct or via loopback proxy) → the media engine probes `bytes=0-1` then refuses to read a cross-origin loopback stream.
- **WebCodecs audio** → WKWebView < Safari 26 has NO `AudioDecoder`, so the canvas/WebCodecs path is silent.

What actually works — and is the current design (`MSEStreamPlayer`):

```
yt-dlp -g  →  loopback proxy (127.0.0.1, src/stream_proxy.rs)
              · /fmp4/v1/<b64>?start=N  → spawns ffmpeg (-c copy,
                fragmented MP4) and pipes it to the response
           →  fetch() that stream (CORS ok)  →  appendBuffer into a
              same-origin blob: MediaSource  →  WebKit NATIVE decode
              (H.264 + AAC = full audio)  →  <video>
```

Key rules:
- **ffmpeg does the fMP4 remux, NOT mediabunny.** mediabunny keeps the audio track but WKWebView won't play audio out of its muxed fMP4; ffmpeg's reference muxing plays both. mediabunny is used only for the lightweight codec/duration probe.
- **MSE attaches via a same-origin `blob:` URL** and is fed by `fetch()` — that's what sidesteps the cross-origin `<video>` block.
- **Seek-anywhere** = rebuild the stream from the seek point via ffmpeg `-ss` (the `?start=` query); the player tracks an absolute `baseTime`. In-buffer seeks are native/instant.
- **Scrubbing pauses playback** (resumes on settle) so playback can't fight the playhead.
- Any failure → `onMediaError` → the yt-dlp **download-to-cache fallback** (plays the local file via `LocalMediaPlayer`), so playback can't regress to nothing.

Don't reintroduce the IFrame, custom URI schemes for `<video>`, or WebCodecs-audio — all three are proven non-starters in WKWebView (see the deep-research notes that drove r61/r63).

---

## Sidecar management

All sidecars are bundled binaries invoked through `tauri-plugin-shell`. Each long-running sidecar process must be registered in the **JobRegistry** (`Mutex<HashMap<String, CommandChild>>`) so it can be canceled.

| Sidecar | Purpose | Update mechanism |
|---------|---------|-----------------|
| yt-dlp | Video/URL download | `npm run refresh:sidecars` (pulls yt-dlp's static binary) |
| ffmpeg | Clip cutting, transcode, audio extraction | `npm run refresh:ffmpeg` (osxexperts.net static arm64) |
| whisper-cli | Local speech-to-text (whisper.cpp) | `npm run build:whisper` (builds from source, statically linked) |
| saucebunny-diarize | Speaker diarization (Swift) | `npm run build:diarizer` (builds from `swift-sidecar/`) |

**Distribution rule**: every binary in `src-tauri/binaries/` MUST be self-contained. No `/opt/homebrew/`, `/usr/local/`, or `/Users/` dylib references. Each script above enforces this with an `otool -L` guard rail and refuses to install a leaky binary. The previous `cp /opt/homebrew/bin/ffmpeg …` and `cp /opt/homebrew/bin/whisper-cli …` recipes were silently shipping binaries that crashed on any user's Mac without the exact matching Homebrew install — that class of bug is now blocked at the script level.

---

## Refactoring priorities (current roadmap)

These are the known cleanup tasks. When Claude Code has discretion on how to organize something, prefer these directions:

1. **Split `commands.rs`** — The ~30 invoke handlers in one file should be organized into modules by domain: `commands/transcript.rs`, `commands/media.rs`, `commands/download.rs`, `commands/system.rs`. Each module exports its handlers; `commands/mod.rs` re-exports them. Keep handlers as thin wrappers.
2. **CSS organization** — `app.css` is growing. Evaluate splitting into per-section files (`player.css`, `transcript.css`, `sidebar.css`) imported from a single `index.css`. Tokens stay in `tokens.css`.
3. ~~**Type consolidation**~~ — DONE in r49. Shared types are generated from canonical Rust structs via the `ts-rs` crate. Cross-boundary structs carry `#[derive(ts_rs::TS)] #[ts(export, export_to = "../../src/bindings/")]`. Run `cargo test --lib` from `src-tauri/` to refresh `src/bindings/*.ts`. `src/types.ts` re-exports the generated types + adds frontend-only types (form state, narrowed enums like `LogTag`, etc.). When adding a new Rust struct that crosses the invoke boundary, derive TS on it; do not hand-write the TS shape in `types.ts`.
4. **Error handling** — IN PROGRESS (r50). The typed error system is wired (`src-tauri/src/error.rs`'s `AppError` enum, generated TS binding at `src/bindings/AppError.ts`, frontend bridge at `src/lib/error-format.ts`). One command (`get_cache_stats`) is migrated end-to-end as the reference. **Remaining work (r51)**: bulk-migrate the other 32 `Result<T, String>` handlers to `Result<T, AppError>`. The pattern is mechanical:
   - Change return type `Result<T, String>` → `Result<T, AppError>`
   - Replace `.map_err(|e| e.to_string())` with appropriate `AppError` variant (`AppError::internal(...)`, `AppError::not_found(...)`, etc.) OR rely on the `From` impls for `std::io::Error` / `reqwest::Error` / `serde_json::Error` (then `?` just works).
   - Update frontend callers to use `formatError(e)` from `lib/error-format.ts` instead of `String(e)`.
   - Re-run `cargo test --lib` if you add new `AppError` variants — the binding regenerates automatically.

---

## Before every change

Run and confirm all pass:

```bash
# 1. TypeScript type check
npx tsc --noEmit

# 2. Rust compilation
cargo check          # from src-tauri/

# 3. Swift sidecar
swift build          # from swift-sidecar/

# 4. Full app launch
npm run tauri dev    # confirm no console errors
```

The CI (`.github/workflows/ci.yml`) runs steps 1–3 on every push. Do not commit if any fail.

## Before every release

```bash
npm run check:release    # audits sidecars + entitlements + signing env
npm run tauri build      # produces signed + notarized .dmg
```

`check:release` refuses to pass if any binary in `src-tauri/binaries/` references a non-system dylib path (`/opt/homebrew/`, `/usr/local/`, `/Users/`), if entitlements aren't wired into `tauri.conf.json`, or if the signing identity env vars aren't set up. See `DISTRIBUTION.md` for the full first-time setup.

---

## Open source hygiene

- **License:** MIT. All new source files should be compatible.
- **No secrets.** No API keys, tokens, credentials, or personal paths in any committed file.
- **Dependencies:** Must be MIT, Apache-2.0, or BSD compatible. Check before adding.
- **Docs:** Update `ARCHITECTURE.md` when structural changes are made. Keep `CONTRIBUTING.md` accurate.
- **Commits:** Imperative mood, max 72 chars first line. Format: `area: change` (e.g., `diarizer: switch to SpeakerKit primary backend`, `ui: add volume slider to player controls`).

---

## When in doubt

1. Keep it local — no cloud dependencies, no network calls except for explicit user-initiated downloads.
2. Keep it simple — if the existing pattern (hooks, Tauri events, CSS tokens) can solve it, don't introduce a new pattern.
3. Keep it readable — a human should be able to open any file and understand it without reading 5 other files first.
4. Keep it buildable — all three build steps (tsc, cargo, swift) must pass at all times.
5. Keep it small — fewer files, fewer abstractions, fewer layers. The app is intentionally minimal-stack.
