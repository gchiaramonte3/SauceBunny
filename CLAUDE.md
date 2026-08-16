# CLAUDE.md — Sauce Bunny Project Constitution

> Claude Code reads this file automatically on every session.
> It is the single source of truth for how this codebase should be maintained, refactored, and extended.
> Current revision: r156 (2026-07-28)

---

## What this app is

Sauce Bunny is a **local-first macOS desktop app** for transcribing, diarizing, and editing video/audio content. It runs entirely on the user's machine — **no cloud _by default_**, no accounts, no telemetry. (r135: an OPT-IN cloud-AI path exists — the AI Summary + reader Analysis features can use the user's own Claude/OpenAI key instead of local Qwen. Off unless the user configures it in Settings ▸ AI APIs; see the cloud-AI entry under "What this app is NOT".)

- **Shell:** Tauri 2 (Rust backend → WKWebView frontend)
- **Target:** macOS 14+, Apple Silicon only. No Windows/Linux builds. (Floor raised from 13: the diarizer's FluidAudio dependency and native dictation need 14 — a 13 install whose headline features silently fail was worse than requiring 14.)
- **License:** MIT
- **Distribution:** self-hosted notarized `.dmg` (NOT Mac App Store). See `docs/DISTRIBUTION.md` for the full reasoning and release flow. The app intentionally cannot pass App Store review (bundled yt-dlp + arbitrary subprocess spawning + cookie reads across apps), and we have decided that's the right tradeoff. Do NOT add MAS-compliance code (App Sandbox entitlements, security-scoped bookmarks, helper-app refactor of sidecars) — it would cost product features without unlocking any distribution channel we want.

## Co-review: what may cross the wire

Sauce Bunny is local-first, and a live session is the one place bytes leave the Mac. The rule:

> **Playback is always from a local copy or a fixed, known-quality stream — never a real-time encode that degrades to fit the link.** Media may be transferred to a peer ahead of or during playback. Every transfer needs a click on BOTH sides: the host offers one file (`session_offer_file`), the guest chooses to receive it or to watch it live. Only that file is servable, matched by BLAKE3, and no filesystem path is ever on the wire.

What that rules in and out:

- **Fixed quality, not adaptive bitrate.** The rung ladder (`src/lib/stream-rung.ts`) picks ONE known height and reports which the guest actually got. It must never collapse the bitrate mid-shot — a reviewer judging a grade has to see compression that is in the source, not in the transport.
- **Streaming converges to a copy.** "Watch it now" runs a Tier C transfer underneath the live stream (`src/lib/stream-keep.ts`), so a stream becomes a local file rather than evaporating with the session. That copy is a multi-GB write, so it is named in the button the guest clicks — never only in a tooltip.
- **A relayed path is a different bargain.** Kilobytes of control traffic through n0's public relay was an accepted cost; someone's media is not. A relayed session is capped at the lowest rung and keeps no copy at all.
- **No second transport.** iroh QUIC already gives NAT traversal, encryption and P2P delivery, and the connection is open and authenticated before media starts. Do not add WebRTC or GStreamer for file streaming. (WebRTC IS used, over iroh signalling, for the live webcam/mic mesh — a different problem with different latency rules.)
- **The webcam mesh needs a STUN server, and that is the app's one un-asked-for outbound call.** A STUN server exists to tell you how your NAT sees you, so it necessarily learns your public IP. It was hardcoded to Google's, which meant nobody could see it, aim it elsewhere, or refuse it — a real gap in an app whose first promise is that it runs on your machine. It now lives in `src/lib/ice-servers.ts`, is shown and editable in Settings ▸ General, and an empty field means no reflexive candidates at all (LAN, plus TURN if configured). The default is unchanged, so upgrading behaves identically. Note this is ONLY the A/V mesh: control traffic, the review doc and file transfer all ride iroh, which does its own traversal and never touches this list. Do not re-inline the endpoint; `src/lib/ice-servers.test.ts` fails the build if a `stun:` URL appears anywhere else.

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
- No cloud calls **by default**. **One deliberate, opt-in exception (r135):** the AI Summary + reader Analysis features can call the user's chosen cloud model (Claude / ChatGPT) with the user's OWN API key. Non-negotiable invariants — do NOT weaken them: local Qwen (llama-server) stays the DEFAULT and the app must work fully with zero cloud config; the key lives in the **macOS Keychain** (`src-tauri/src/commands/cloud_ai.rs` `set/has/delete_api_key`), NEVER in localStorage and never readable back by the frontend; the API call is made in **Rust** (`cloud_chat`, reqwest) so the key stays server-side and it dodges the browser CORS block. Frontend seam: `src/lib/ai-provider.ts` + `src/components/AiApiSettings.tsx`; both AI surfaces branch on `loadAiProvider()`. This is the ONLY sanctioned cloud dependency — don't add others (no cloud transcription, storage, sync, or accounts) without the same "stop and explain" bar.

---

## Architecture overview

```
src/                          # React 18 + TypeScript (strict)
  components/                 # One component per file, PascalCase.tsx
  lib/                        # Utility modules (mediabunny wrappers, helpers)
    mediabunny-helpers.ts
    mediabunny-export.ts
    mediabunny-audio.ts
  hooks/                      # Custom hooks — shared 3+ ways, or one cohesive
                              # subsystem extracted from App.tsx (use-panel-bus,
                              # use-web-playback, use-co-review, use-transport)
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
    commands/                 # Invoke handlers, split by domain (r47):
      mod.rs                  #   shared helpers + event types, re-exports
      download.rs             #   yt-dlp: metadata, preview, captions, audio
      media.rs                #   clip export, snapshots, playback prep
      transcript.rs           #   whisper + diarizer pipelines
      system.rs               #   JobRegistry, cache, fs, windows, build-id
    stream_proxy.rs           # loopback media proxy (token-gated; see below)
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
| Persistence | `localStorage` | Namespaced `saucebunny.*` (nine legacy `cp-` keys survive; see Storage layout) |
| Backend | Tauri 2 invoke commands | `tokio` async, `serde` JSON |
| Media decode | mediabunny | WebCodecs MP4/MOV, frame-accurate scrub |
| MP3 encode | `@mediabunny/mp3-encoder` | LAME-via-WASM, registered once at startup |
| Transcription | whisper-cli (whisper.cpp) | Sidecar, 16kHz mono WAV input |
| Diarization | saucebunny-diarize (Swift) | SpeakerKit primary, FluidAudio fallback |
| Video download | yt-dlp | Sidecar, bundled binary |
| Media processing | ffmpeg | Sidecar, clip cutting + transcode fallback |

### Plugins (Tauri)
`tauri-plugin-shell`, `tauri-plugin-dialog`, `tauri-plugin-notification`

**Ejected in r152, and not to be re-added.** `tauri-plugin-clipboard-manager`
pulled `arboard`, which declares the `image-data` feature and cannot be turned
off from here — so the app compiled an entire image and colour stack (`image`,
`tiff`, `zune-jpeg`, `moxcms`, `fax`, `weezl` …) in order to copy a join code.
Writes went to `navigator.clipboard.writeText`, which three other call sites
already used; the one READ stayed native as `read_clipboard_text`
(`NSPasteboard` via `objc2-app-kit`, already in the graph via `muda`) because
`navigator.clipboard.readText()` raises macOS's "Paste from clipboard?" modal
and reading from our own process does not. `tauri-plugin-opener` went for its
capability, not its size: `opener:default` bundles `reveal_item_in_dir`, which
takes a `Vec<PathBuf>` and — unlike its two siblings — performs NO scope check,
so the renderer held an unscoped reveal-any-path-in-Finder for a command the
app never called. Replaced by `open_external_url`, which validates the scheme
in three lines. Together: 34 packages out of `Cargo.lock`.

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
- **Never let an await sit between starting work and holding the handle that
  cancels it.** Stop then finds nothing to stop, and what the user sees is not
  "Stop was slow": handleStop resets the UI, the run carries on, and the result
  lands on a screen that says it was cancelled. This shipped repeatedly
  (`use-stream-keep` yield/resume, `use-batch-transcribe` reporting SUCCESS for
  a file finished after Stop, and all three transcription entry points).

  Prefer to make the window impossible rather than to guard it. Job ids are now
  minted synchronously in the renderer — `newJobId()` from `src/lib/job-id.ts`,
  never a round trip — which closed all seventeen call sites at once after the
  guard-it approach had been applied to six and missed eleven. Guarded by
  `src/lib/job-id.test.ts`, including against `await newJobId()`, which
  type-checks and silently costs the microtask turn that was the whole bug.

  Where an await genuinely IS unavoidable before the invoke, the shape is:
  create the AbortController or token first, assign it, then await, then
  re-check `aborted` before spawning — and re-check again after any expensive
  marshalling, since `Array.from(new Uint8Array(buf))` over tens of MB is
  seconds wide. Note that `handleStop` reads job ids out of a `useCallback`
  closure, so a `setJobId(id)` is not visible to it until the next render
  either.

### CSS
- All styles live in `src/styles/app.css`, organized by component name in comment blocks.
- Use tokens from `tokens.css` for colors, spacing, font sizes, radii. Never hardcode hex colors or pixel values that have a token equivalent.
- No inline styles. No CSS-in-JS. No CSS modules.
- Class names: kebab-case, all prefixed with the stable project namespace `cp-` (carryover from the original ClipPull name — kept intentionally because renaming ~600 classes touches every file and adds no user-visible value). Within that prefix, group by component context (e.g. `cp-player-controls-volume`, `cp-tx-speaker`, `cp-queue-foot-row`). New code MUST use the `cp-` prefix; do not introduce a new prefix.
- No `!important` unless overriding a third-party style you can't control.
- **The spacing scale does not describe this UI, and that is measured, not felt.**
  `--s-*` is a 4px grid (4/8/12/16/20/24/28/32/40/48). Of 737 raw `gap` /
  `padding` / `margin` values in the stylesheets, **460 are off that grid** —
  and 297 of those sit on even 2px steps. The three most-used spacing values
  after 8px are 6px (99), 4px (97) and 2px (81): the interface was built on a
  **2px rhythm**, not a 4px one. 6px alone is the second most common spacing
  value in the app and has no token at all.
  So the low token adoption here (160 token uses vs 737 raw) is not
  carelessness — the scale never fitted, and reaching for `var(--s-2)` when you
  need 6px is not an option anyone declined, it is one nobody had.
  **Do not mass-convert spacing to the current scale**: rounding 6px to 4 or 8
  moves nearly every dense control in the app. The decision worth making is
  whether to give the scale its real 2px base or to re-space the UI onto 4px,
  and that wants someone looking at it. Radii have the same split, smaller:
  ~56 of 272 off-scale, with 10px appearing 14 times between `--r-md` and
  `--r-lg`. (1px `padding`/`gap` is excluded from all of this — 44 uses, and it
  is hairline work rather than spacing.)

- **Focus styles: never the green accent.** A focused control brightens its existing outline toward white (`--focus-ring`, defined in `base.css`); composed fields (wrapper + borderless inner input, e.g. `.cp-url`) brighten the wrapper via `:focus-within` and suppress the inner input's ring. Guarded by `src/lib/focus-contract.test.ts` — do not allowlist around it.

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
- Target macOS 14+, Swift 5.9+ (matches the app's minimumSystemVersion — FluidAudio's floor).
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
| `panel:state` | main → panel | Push state on actual change (debounced ~50ms) + as the `panel:request-state` reply |
| `panel:action:<kind>` | panel → main | Panel requests an action from main |
| `panel:request-state` | panel → main | Panel asks for current state on mount (listener registered before requesting — the mount handshake) |
| `panel:popped-out` | Rust → main | Notifies main that panel window was created |
| `panel:closed` | Rust → main | Notifies main that panel window was destroyed |
| `panel:playhead` | main → panel | 4Hz playhead heartbeat (`{seconds}`) while a panel is detached and the playhead moves — feeds the panel's playhead store; the live clock deliberately stays OUT of `panel:state` snapshots |
| `saucebunny:speakers-changed` | either window → both | Speaker overrides persisted; consumers re-read localStorage. Same name also fired as a window CustomEvent for the same-window fast path |

Events are the PRIMARY channel — post-registration delivery is reliable in
Tauri 2.x; the historical "fresh panel rendered empty" failures were the
mount race (events are dropped, not queued, before a webview registers its
listener), which the request/response handshake removes. localStorage
(`saucebunny.panelSnapshot`, written only on publish — never on a timer) is
the panel's synchronous boot seed plus the target of slow ~5s reconciliation
polls that only act after event silence. Do NOT reintroduce fixed-interval
polling as a primary sync channel; idle traffic must stay at zero.

When adding a new cross-window interaction, use this event pattern. Do not introduce a shared state store, BroadcastChannel, or postMessage.

---

## Storage layout

| What | Where |
|------|-------|
| App cache (temp files) | `app_cache_dir()` prefixed `saucebunny-*`, swept on startup (>24h) |
| Whisper models | `app_data_dir()/whisper-models/` |
| Diarizer models | Bundled or downloaded on first run, cached locally |
| Transcript library | `~/Documents/Sauce Bunny/Transcripts/YYYY-MM/` |
| Casts | `~/Documents/Sauce Bunny/Casts/casts.json` — ONE file, not sharded like Reviews: a shelf of casts is a few hundred KB and the picker needs all of them at once. Debounced atomic write-through (`src/lib/cast-store.ts`); writes are refused until hydration has accounted for the disk copy, or a save made during boot would erase the file with a subset of itself |
| Review docs | `~/Documents/Sauce Bunny/Reviews/` — one `<slug>-<hash>.json` per source + `index.json`; hydrated at boot, debounced write-through (`src/lib/review-store.ts`); legacy localStorage docs migrated out on first boot |
| User prefs | `localStorage` namespaced `saucebunny.*` (incl. review history/fingerprint index/reviewer identity — only review DOCS moved to files). **Nine keys are still `cp-*`** — `cp-defaults-v2`, `cp-aspect`, `cp-captions-on`, `cp-folder`, `cp-logs-open`, `cp-muted`, `cp-recents`, `cp-sidebar-sections`, `cp-volume` — the same ClipPull carryover as the CSS classes. There were TWO legacy prefixes: `clippull.*` got a real migration (`lib/migrate-storage.ts`, still running at boot) and `cp-*` never did. They are not being renamed: renaming a key discards the user's value unless a migration copies it first, and `cp-defaults-v2` is the whole settings blob, so getting it wrong resets every preference on every existing install in exchange for a tidier string nobody sees. NEW prefs use `saucebunny.`; `src/lib/storage-keys-contract.test.ts` pins the nine and fails on a tenth. |

Do not change these paths without updating both the Rust backend and the frontend.

**A key derived from a filename must be NFC-normalised.** macOS stores
filenames DECOMPOSED and a text field hands back what the keyboard sent, which
is COMPOSED, so "café.mov" is two different strings depending on which side
asked. Three bugs shipped from this, all silent, all found only by measuring:
library search could not find a file by the name shown on it (and, because the
on-disk name is decomposed, searching WITHOUT the accent did work — insensitive
in one direction and exact in the other); renaming a file to an accented name
lost its chosen poster frame and source timecode; and `reviewFingerprint`
produced two identities for one file, so a rename orphaned the producer's
notes, which stayed on disk under the old key where nothing looked broken.

Normalise on read as well as write and the store migrates itself. Do NOT fold
case (repath.ts depends on these stores being case-SENSITIVE so a case-only
rename does the identity work) and do NOT strip diacritics (`\p{Diacritic}`
covers Japanese dakuten, so folding makes か match が — a different word).
Accent-insensitive matching is a product decision; fixing an encoding mismatch
is not.

---

## Build-ID handshake

The frontend defines `EXPECTED_BACKEND_BUILD_ID` in `src/lib/build-id.ts`. The Rust backend exposes `BACKEND_BUILD_ID` in `src-tauri/src/commands/system.rs` via the `get_backend_build_id` command. On app startup, the frontend checks that they match. If they don't, the user sees a warning that the Rust binary is stale.

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

**ProRes / 10-bit (`d1da322`, revised in r148):** mediabunny can only *paint* a
sample by wrapping it in a WebCodecs `VideoFrame`, and WKWebView has no 10-bit
`VideoFrame` support, so an unpaintable sample used to yield a BLACK canvas
with no error. The original fix routed all 10-bit sources to path 3.

**That blanket route is gone, and must not come back.** `@mediabunny/prores`
now probes which `VideoFrame` formats the platform can actually construct and
passes them to turbores as `allowedOutputFormats`, so it never hands WKWebView
a sample it cannot wrap — and turbores is roughly 3x FASTER than ffmpeg on
ProRes (~310 fps vs ~107 at 4K 422 HQ). Bailing to a subprocess on sight of
ProRes traded that away for a hazard the decoder already handles. There is
therefore deliberately NO ProRes short-circuit in `mediabunny-helpers.ts`; the
empirical `canvasLooksBlank` guard is the backstop, on ANY codec, rather than
a blanket ban on one. Re-adding a codec-name check here is a regression.

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

**Single-clock model (r88 — reverts the r82 audio-master twin):** the streamed
native muxed `<video>` is the ONE clock for audio, picture, and captions. WebKit
keeps A/V locked inside that element, and the playhead = `corrected(video.currentTime)`
= `baseTime + max(0, currentTime − clockOrigin)` (clockOrigin = `buffered.start(0)`,
subtracts the fMP4 start-PTS). The transcript highlight and on-video captions read
that same playhead, so all three are in sync by construction. The proxy's fMP4
remux carries full audio (incl. the r75 DASH audio-merge), so the `<video>` is
audible and unmuted. **Do NOT reintroduce the hidden-`<audio>` "twin" / audio-master
clock** (it ran two independent media-element clocks; the muted picture drifted from
the audio and needed a fragile playbackRate soft-sync — retired in `cd11f08`, briefly
re-added, removed again in r88). The cached source audio (`download_audio_track`) is
still fetched, but ONLY as a transcription head-start (Whisper reuses it via
`source_audio_prefix`); it is not a playback clock.

**Transcript timeline:** Whisper SRT cue times are absolute source time. When a
mark-in sub-range is cut for transcription (`generate_transcript` `cut_section`),
the cues are re-based by `+start_s` (`shift_srt_file` in `transcript.rs`) so they
stay aligned to the full playback timeline — never offset by the in-point.

**Proxy security:** every proxy request carries a per-session capability token
in the path (`/t/<token>/…`). Without it the loopback server would be an open
relay for any local process or port-scanning webpage. Keep the token check
intact when touching `stream_proxy.rs`.

**Asset-protocol scope:** `app.security.assetProtocol.scope` is `$APPCACHE/**`
and nothing else. Anything outside the cache is granted PER FILE at runtime by
`allow_asset_read` in `probe_local_file` — the one command every local source
passes through. Mint asset URLs only via `assetUrl()` in `src/lib/asset-url.ts`.
A path covered by neither half returns 403 with an EMPTY body, so it shows up as
a black video or a broken thumbnail and never as an error. mediabunny's local
reads are NOT affected (they go through `read_file_range`, which the scope does
not gate), so do NOT add grants to the thumbnail commands: those run per library
item, `Scope::is_allowed` is a linear glob scan on every asset request, and a
large library would put a thousand-pattern scan on the playback byte-range path.
Guarded by `src/lib/asset-scope-contract.test.ts` — do not widen the scope to
get unblocked.

Don't reintroduce the IFrame, custom URI schemes for `<video>`, or WebCodecs-audio — all three are proven non-starters in WKWebView (see the deep-research notes that drove r61/r63).

---

## Sidecar management

All sidecars are bundled binaries invoked through `tauri-plugin-shell`. Each long-running sidecar process must be registered in the **JobRegistry** (`Mutex<HashMap<String, CommandChild>>`) so it can be canceled.

| Sidecar | Purpose | Update mechanism |
|---------|---------|-----------------|
| yt-dlp | Video/URL download | `npm run refresh:sidecars` (pulls yt-dlp's static binary) |
| ffmpeg | Clip cutting, transcode, audio extraction | `npm run refresh:ffmpeg` (osxexperts.net static arm64) |
| ffprobe | yt-dlp stream fixups (HLS aac_adtstoasc) | `npm run refresh:ffprobe` (martin-riedl.de static arm64) |
| whisper-cli | Local speech-to-text (whisper.cpp) | `npm run build:whisper` (builds from source, statically linked) |
| saucebunny-diarize | Speaker diarization (Swift) | `npm run build:diarizer` (builds from `swift-sidecar/`) |
| llama-server | Local LLM chat for the AI Summary tab | `npm run build:llama` (builds llama.cpp from source, static + Metal) |

**Not in git**: sidecar binaries are assembled locally by `npm run setup`
(fresh clones) — they are gitignored, and CI stubs them.

**Distribution rule**: every binary in `src-tauri/binaries/` MUST be self-contained. No `/opt/homebrew/`, `/usr/local/`, or `/Users/` dylib references. Each script above enforces this with an `otool -L` guard rail and refuses to install a leaky binary. The previous `cp /opt/homebrew/bin/ffmpeg …` and `cp /opt/homebrew/bin/whisper-cli …` recipes were silently shipping binaries that crashed on any user's Mac without the exact matching Homebrew install — that class of bug is now blocked at the script level.

---

## Refactoring priorities (current roadmap)

These are the known cleanup tasks. When Claude Code has discretion on how to organize something, prefer these directions:

1. ~~**Split `commands.rs`**~~ — DONE in r47 (`commands/{download,media,transcript,system}.rs`, thin wrappers, `mod.rs` re-exports).
2. ~~**CSS organization**~~ — DONE in r48 (per-section files imported from `index.css`; tokens stay in `tokens.css`).
3. ~~**Type consolidation**~~ — DONE in r49. Shared types are generated from canonical Rust structs via the `ts-rs` crate. Cross-boundary structs carry `#[derive(ts_rs::TS)] #[ts(export, export_to = "../../src/bindings/")]`. Run `cargo test --lib` from `src-tauri/` to refresh `src/bindings/*.ts`. `src/types.ts` re-exports the generated types + adds frontend-only types (form state, narrowed enums like `LogTag`, etc.). When adding a new Rust struct that crosses the invoke boundary, derive TS on it; do not hand-write the TS shape in `types.ts`.
4. ~~**Error handling**~~ — DONE (r51 bulk migration; last stragglers swept in r108). The typed error system is wired (`src-tauri/src/error.rs`'s `AppError` enum, generated TS binding at `src/bindings/AppError.ts`, frontend bridge at `src/lib/error-format.ts`), and every remaining `Result<T, String>` fn in `src-tauri/src/commands/` now returns `Result<T, AppError>` — zero `Result<T, String>` signatures left. The pattern for NEW commands stays mechanical:
   - Return `Result<T, AppError>` from the handler (and from domain helpers it calls).
   - Use the appropriate `AppError` variant (`AppError::internal(...)`, `AppError::not_found(...)`, etc.) OR rely on the `From` impls for `std::io::Error` / `reqwest::Error` / `serde_json::Error` / `String` (then `?` just works; a bare `String` becomes `Invalid`, which renders its text verbatim — use it when preserving an established user-facing message matters).
   - Update frontend callers to use `formatError(e)` from `lib/error-format.ts` instead of `String(e)`.
   - Re-run `cargo test --lib` if you add new `AppError` variants — the binding regenerates automatically.
5. ~~**UI smoke harness**~~ — DONE (r105): `npm run test:e2e` drives the Vite-served frontend in Chromium with the Tauri IPC layer mocked at the `__TAURI_INTERNALS__` seam (`e2e/tauri-mock.ts`) — tauri-driver has no macOS/WKWebView support, so this is deliberately a *shell* smoke (boot, toolbar/sidebar/monitor render, settings modal, co-review popover, drawer — zero pageerrors), run in CI. Native playback/transcription pipelines remain covered by cargo/swift tests + manual verification.

   **Component tests** (added later) fill the layer between the two: the e2e
   suite proves the app boots, the vitest units prove the pure functions are
   right, and neither could answer "does this control behave the way its props
   say it does". Write one as `src/components/<Name>.test.tsx` with
   `// @vitest-environment jsdom` as the FIRST line — the default environment
   stays `node` so the ~550 pure tests keep running in about a second.
   `src/test-setup.ts` fills in the browser APIs jsdom lacks; keep it small,
   and never stub away behaviour the test is supposed to be checking. Mock
   `@tauri-apps/api/*` and the heavy decode helpers (`mediabunny-helpers`,
   `waveform`) per file with `vi.mock`. Wrap a `setPlayheadFrames` in `act()`.
6. **Shrink `App.tsx`.** It is ~6,400 lines and the largest single risk in the
   codebase: nothing can be tested without booting the whole app, and reviewing
   a change to it means reading around a dozen unrelated subsystems. The
   direction is the one already established — lift ONE cohesive subsystem at a
   time into `src/hooks/use-*.ts`, destructure the result at the call site so
   no existing reference has to change, and add tests to the extracted hook
   that were impossible before. Do NOT attempt a single sweeping split.

   Done so far: `use-panel-bus`, `use-web-playback`, `use-co-review`,
   `use-library-scan`, `use-media-capture`, and `use-transport` (shuttle,
   steps, seeks, in/out marks — 190 lines, 36 new tests). Extracting transport
   also surfaced that `applyShuttle`/`exitShuttle` had never been part of
   App's surface at all; every one of their references was another transport
   handler. That kind of finding is the point of the exercise.

   Plausible next candidates, each self-contained: the keyboard/shortcut
   dispatch, the export/queue pipeline, and the transcript-history wiring.

7. ~~**Transcript render performance**~~ — DONE (`68d4a25`): the karaoke render's O(turns²) cue-offset scan, per-turn name/alias resolution, and search-match lookup are precomputed in memos keyed on turns/overrides, so a playhead tick only re-marks the active cue.

---

## Before every change

Run and confirm all pass:

```bash
# 1. TypeScript type check + unit tests
npx tsc --noEmit
npm test             # vitest (srt/timecode/commands/validation)

# 2. Rust compilation + unit tests
cargo check          # from src-tauri/
cargo test --lib     # proxy parsing, short_err + ts-rs binding freshness

# 3. Swift sidecar
swift build          # from swift-sidecar/

# 4. Full app launch
npm run tauri dev    # confirm no console errors
```

The CI (`.github/workflows/ci.yml`) runs steps 1–3 on every push. Do not commit if any fail.

## Enforced contracts

Sixteen rules in this file are checked by a test rather than remembered. If you
are about to violate one you will meet its failure message, so this table is
here to save you reverse-engineering the rule from it. Each test explains ITS
OWN history at the top of the file; that is deliberately not repeated here.

Every one of them exists because the rule alone was not enough — each was
written after finding the rule already broken somewhere.

| Test (`src/lib/`) | What it holds |
|---|---|
| `voice-contract` | No em/en dashes in user-facing copy |
| `focus-contract` | A focus ring never uses the green accent |
| `hit-target-contract` | Declared pointer-target sizes (see also `e2e/target-size.spec.ts`, which measures the rendered ones) |
| `design-tokens-contract` | `--font-mono` always brings `tabular-nums`; no unreferenced token; the radius scale is used, not re-typed |
| `path-identity-contract` | One NFC path normaliser, in `lib/repath` |
| `storage-keys-contract` | New prefs use the `saucebunny.` namespace; nine legacy `cp-` keys are pinned by name |
| `invoke-contract` | Invoke type args come from `src/bindings/`; byte payloads use the raw IPC body; every `write_text_to_path` is atomic |
| `ipc-surface-contract` | Every registered command is called, and every invoked command is registered |
| `job-id` | Job ids are minted locally and never awaited |
| `updater-purity-contract` | No `setX(prev => …)` writes, invokes, persists or touches a ref |
| `pure-updater-contract` | Reducer-style updaters stay pure |
| `rust-panic-contract` | No `unwrap`/`expect`/`panic!` in production Rust |
| `rung-ladder-contract` | The streaming rung table is identical in TS and Rust |
| `wire-path-contract` | A review doc on the wire carries no local filesystem path |
| `asset-scope-contract` | The `asset://` scope stays narrow |
| `csp-contract` | The shipped CSP permits what startup actually registers |

Three more are measured against the RENDERED app rather than its source, in
`e2e/`, because CSS and the accessibility tree are not readable by grep:

| Test (`e2e/`) | What it holds |
|---|---|
| `target-size` · `contrast` · `accessible-names` | Rendered pointer targets, contrast ratios, and control names |
| `focus-trap` · `popover-focus` | Focus stays in a dialog; a popover is reachable |
| `console-clean` | No console error or warning in any view - where React reports duplicate keys and invalid nesting, and where a packaged WKWebView build shows nobody |
| `landmarks` | Each view exposes exactly one NAMED main landmark |
| `reduced-motion` | No keyframe animation runs under `prefers-reduced-motion` (transitions are a known gap) |

Two habits these encode, worth applying to any new one:

- **Assert you scanned something.** A test that walks source and asserts a
  filtered list is empty passes by finding nothing. Four of these could, until
  a broken file filter left `voice-contract` reporting a clean bill of health
  over zero files.
- **Break-test it.** Change the code the rule forbids and watch the test fail.
  Several tests in this repo were written, passed, and could not fail.

---

## Before every release

```bash
npm run check:release    # audits sidecars + entitlements + signing env
npm run verify:packaged  # checks that ONLY hold in a packaged build — the lazy
                         # MP3 chunk shipped, read_clipboard_text is in the
                         # binary, the CSP permits WASM, no ejected plugin
                         # grant survived, sidecars are self-contained. Prints
                         # the two that need a human (the paste modal, and a
                         # COLD first MP3 export).
npm run tauri build      # produces signed + notarized .dmg
```

`check:release` refuses to pass if any binary in `src-tauri/binaries/` references a non-system dylib path (`/opt/homebrew/`, `/usr/local/`, `/Users/`), if entitlements aren't wired into `tauri.conf.json`, or if the signing identity env vars aren't set up. See `docs/DISTRIBUTION.md` for the full first-time setup.

---

## Bundling gotchas

- **`bundle.resources` keys must be DISTINCT destination file paths.** Several
  sources mapped at one directory key (`"../LICENSE": "licenses/"`,
  `"../THIRD-PARTY-LICENSES.md": "licenses/"`, …) silently collapse: the map is
  keyed by destination, so they overwrite each other and the bundle ships a
  single FILE named `licenses` holding whichever one survived. Every build
  before r153 was missing the MIT LICENSE and the GPLv3 text that bundled
  ffmpeg requires. Write `"licenses/LICENSE"` etc. No comment keys either -
  tauri treats every key as a resource path and fails the build.
- **Verify the artifact, not just the source.** `npm run verify:bundle` asserts
  the things that have actually broken: the CSP tokens baked into the binary
  (a frontend rebuild does NOT change them), the narrowed asset scope, the
  license files, non-stub sidecars, `Assets.car`, the Info.plist keys TCC needs,
  and the signature. Run it after `npm run tauri build`.
- **`grep -q` in a pipeline is a trap under `set -o pipefail`.** grep exits the
  moment it matches, the writer upstream takes SIGPIPE (141), and pipefail
  reports the pipeline failed on a SUCCESSFUL match. Two checks in
  verify-bundle.sh were wrong this way before being caught by dogfooding.
  Use `case "$var" in *needle*)`, which has no pipe.

## Open source hygiene

- **License:** MIT. All new source files should be compatible.
- **No secrets.** No API keys, tokens, credentials, or personal paths in any committed file.
- **Dependencies:** must carry a licence compatible with shipping inside an
  MIT-licensed app. Permissive (MIT / Apache-2.0 / BSD / ISC / OFL) is the
  default, and **weak-copyleft is fine when the dependency stays a separate
  library or binary** — the app already ships MPL-2.0 (mediabunny, its
  extensions, turbores), LGPL (the ffmpeg build; LAME inside the MP3 encoder)
  and OFL-1.1 (Nunito Sans), all recorded in `THIRD-PARTY-LICENSES.md`. What
  is genuinely out is strong copyleft that would reach the whole app (GPL,
  AGPL). This rule previously said "MIT, Apache-2.0, or BSD" and so forbade
  five things the app already shipped; it was the rule that was wrong.
- **Docs:** Update `docs/ARCHITECTURE.md` when structural changes are made. Keep `CONTRIBUTING.md` accurate.
- **Commits:** Imperative mood, max 72 chars first line. Format: `area: change` (e.g., `diarizer: switch to SpeakerKit primary backend`, `ui: add volume slider to player controls`).

---

## When in doubt

1. Keep it local — no cloud dependencies (the ONE opt-in exception is the r135 cloud-AI path above; local Qwen stays the default), no network calls except for explicit user-initiated downloads.
2. Keep it simple — if the existing pattern (hooks, Tauri events, CSS tokens) can solve it, don't introduce a new pattern.
3. Keep it readable — a human should be able to open any file and understand it without reading 5 other files first.
4. Keep it buildable — all three build steps (tsc, cargo, swift) must pass at all times.
5. Keep it small — fewer files, fewer abstractions, fewer layers. The app is intentionally minimal-stack.
