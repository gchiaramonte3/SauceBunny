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

yt-dlp, ffmpeg, ffprobe, whisper-cli, and saucebunny-diarize run as
subprocesses with argument arrays (never shell strings). They are
self-contained static builds; the fetch/build scripts enforce with `otool -L`
that no binary references non-system dylib paths. Sidecars are spawned only
through Tauri's shell allow-list (`src-tauri/capabilities/`).

### 4. What the app deliberately does NOT do

- No network calls except user-initiated downloads (media, captions, models).
- No JavaScript execution from fetched pages — yt-dlp parses them out of
  process.
- No analytics or crash reporting of any kind.

## Scope notes

Downloading content you don't have rights to is a usage issue, not a security
one. yt-dlp extractor breakage (YouTube changes) is tracked as ordinary bugs.
