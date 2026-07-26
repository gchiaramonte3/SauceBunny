# Security

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Use GitHub's
[private vulnerability reporting](../../security/advisories/new) on this
repository. You'll get a response within a week; fixes ship in the next
release with credit unless you prefer otherwise.

## Threat model — what this app does that you should know about

Sauce Bunny is local-first: no accounts, no telemetry, no cloud backend. The
security-relevant surfaces are:

### 1. Loopback media proxy (`src-tauri/src/stream_proxy.rs`)

To play web video inside WKWebView, the app runs a small HTTP server bound
strictly to `127.0.0.1` (never `0.0.0.0`). It proxies the CDN streams the user
asked for and remuxes them via the bundled ffmpeg.

Mitigations in place:
- **Per-session capability token** — every request must carry a random token
  in the URL path (`/t/<token>/…`); anything else gets a 403. This is what
  stops other local processes, or a malicious webpage fetching
  `http://127.0.0.1:<port>`, from using the proxy as an SSRF relay or reading
  the media the user is watching.
- Decoded upstream URLs must be `http(s)` (no `file://` etc.).
- `?start=` is validated (finite, clamped) before reaching `ffmpeg -ss`.
- ffmpeg children are killed when the client disconnects.

### 2. Browser cookies (optional, off by default)

For sign-in-gated sources, the user can opt in to yt-dlp's
`--cookies-from-browser` in Settings. The cookies are read by yt-dlp at
download time and passed to nothing else; the app never stores, displays, or
transmits them. Turning the setting to "none" disables this entirely.

### 3. Bundled sidecar binaries

yt-dlp, ffmpeg, ffprobe, whisper-cli, saucebunny-diarize, llama-server
(loopback HTTP for the AI Summary tab, token-gated), **saucebunny-dictate**
(microphone capture for voice dictation), and **saucebunny-capture**
(ScreenCaptureKit screen sharing in co-review) run as subprocesses with
argument arrays (never shell strings). The last two are listed explicitly
because they hold the most sensitive permissions in the app: each is spawned
only in response to a direct user action (pressing dictate; starting a screen
share), and macOS gates both behind its own TCC prompt.

They are self-contained static builds; the fetch/build scripts enforce with
`otool -L` that no binary references non-system dylib paths. Sidecars are
spawned only from the Rust backend (`app.shell()`); the webview capability
file (`src-tauri/capabilities/`) deliberately grants NO shell permissions, so
the renderer cannot spawn a process directly.

**Asset-protocol scope.** The `asset://` protocol, which is how the webview
loads a video, an audio file, or a poster off disk, is scoped to `$APPCACHE/**`
(the app's own cache folder) plus, at runtime, each individual file you open.
That per-file grant is made in Rust by `probe_local_file`, the one command every
local source passes through; the webview cannot grant itself anything. This
replaced a `**` scope under which the renderer could read any file on the
machine over `asset://`. Both halves are pinned by
`src/lib/asset-scope-contract.test.ts`.

**Known gap, stated plainly:** the renderer is still not sandboxed. The app's
own file commands (`write_text_to_path`, `write_bytes_to_path`,
`read_text_file_capped`) accept absolute paths with no scope of their own, so
code running in the webview can still read and write files as you. Treat "no
shell grants, narrow asset scope" as two walls, not a containment boundary.
Scoping those commands is tracked work, not a claimed property.

### 4. What the app deliberately does NOT do

- No network calls except (a) user-initiated downloads (media, captions,
  models, the yt-dlp updater), (b) user-initiated co-review sessions, and
  (c) **cloud AI, only if you opt in and supply your own API key**: choosing
  Claude or ChatGPT in Settings ▸ AI APIs sends your transcript text to
  `api.anthropic.com` or `api.openai.com` from the Rust backend. That is a
  real third party receiving your content, which is why the local Qwen model
  is the default and the cloud option ships switched off. Nothing is sent
  until you both add a key and select that provider.
  Co-review is peer-to-peer and end-to-end encrypted, but reaching the other
  Macs uses third-party plumbing: iroh's public discovery/relay
  infrastructure for the session channel, a public STUN server for the
  webcam mesh, and an optional TURN relay if you configure one. Media and
  review data are never stored or processed by any Sauce Bunny server (there
  are none); encrypted traffic may transit that discovery/relay
  infrastructure, and session peers can learn your network address.
- No JavaScript execution from fetched pages — yt-dlp parses them out of
  process.
- No analytics or crash reporting of any kind.

## Scope notes

Downloading content you don't have rights to is a usage issue, not a security
one. yt-dlp extractor breakage (YouTube changes) is tracked as ordinary bugs.
