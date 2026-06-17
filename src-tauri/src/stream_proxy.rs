//! Localhost HTTP media proxy (`127.0.0.1`) — feeds WKWebView's `<video>`.
//!
//! ## Why this exists (and why it's the ONLY thing that works)
//!
//! WKWebView's `<video>` element will not play YouTube's `googlevideo.com`
//! URLs three different ways we tried:
//!   - IFrame Player API → Error 153 (YouTube tightened Referer Dec 2025).
//!   - `<video src="https://googlevideo…">` directly → `loadedmetadata`
//!     never fires (the media engine's headers get gated by the CDN).
//!   - `<video src="sbstream://…">` custom URI scheme → r57 proved the
//!     scheme handler is NEVER invoked. WKWebView's media engine refuses
//!     to issue requests for custom schemes on media elements, full stop.
//!
//! The one path that works: a real `http://127.0.0.1:<port>` URL. WebKit's
//! media engine treats loopback http as a first-class network resource and
//! drives it through its well-tested Range/206 streaming code path. So we
//! run a tiny HTTP server on loopback that proxies the upstream CDN URL
//! with headers WE control. This is exactly what mpv/VLC do internally
//! (libcurl); we just expose it on loopback so WebKit can consume it.
//!
//! ## Local-only guarantee
//!
//! The server binds to `127.0.0.1` (loopback), NOT `0.0.0.0`. It is not on
//! the LAN, not on the internet, not discoverable. The only outbound
//! traffic is the same user-initiated yt-dlp/CDN fetch the app already
//! makes. No cloud, no accounts, no telemetry — consistent with the
//! local-first constitution. (Constitution note: the "no server" rule
//! targets backend *frameworks* as an app architecture; this is a
//! media-streaming primitive in the same category as `asset://`.)
//!
//! ## Wire format
//!
//! `http://127.0.0.1:<port>/v1/<urlsafe-base64-of-upstream-url>`
//!
//! The frontend (src/lib/stream-proxy.ts) base64url-encodes the upstream
//! URL into the path. `/v1/` versions the scheme.
//!
//! ## Threading
//!
//! `reqwest::blocking` MUST NOT run inside a tokio runtime. tiny_http's
//! worker threads are plain std threads with no tokio context, so the
//! blocking client is correct here. One thread per request — fine for a
//! single-user desktop app playing one preview at a time, and it's what
//! lets us tolerate Safari's habit of closing the connection every few MB
//! and reopening with a fresh Range (each reopen is just a new request).

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use std::sync::OnceLock;

/// Base URL of the running proxy, e.g. `http://127.0.0.1:52431`. Set once
/// at startup by `start()`. `None` until the server is up (or if it
/// failed to bind — callers fall back to the download path).
static BASE: OnceLock<String> = OnceLock::new();

/// Per-session capability token, minted at `start()`. Every request path must
/// be prefixed `/t/<token>/` or it's rejected with 403. Without it, ANY local
/// process — or any web page that port-scans 127.0.0.1 — could drive this proxy
/// to fetch arbitrary attacker-supplied URLs (open proxy / SSRF) or read the
/// media the user is currently watching. The token rides inside the base URL
/// the frontend receives, so all existing URL construction (`buildProxyUrl` +
/// the `/fmp4/` string-replace) carries it transparently — no frontend change.
static TOKEN: OnceLock<String> = OnceLock::new();

/// 24 crypto-random bytes from `/dev/urandom` (always present on macOS — the
/// only target), base64url-encoded → an unguessable 32-char token. Reads the
/// OS CSPRNG directly so we add no `rand`/`getrandom` dependency.
fn mint_token() -> String {
    let mut buf = [0u8; 24];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        use std::io::Read;
        let _ = f.read_exact(&mut buf);
    }
    URL_SAFE_NO_PAD.encode(buf)
}

/// Safari UA — yt-dlp resolves `web_safari`-compatible URLs, and the CDN
/// treats Safari-shaped requests as well-formed without extra handshakes.
const SAFARI_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) \
     AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15";

/// Headers we copy verbatim from the upstream CDN response back to
/// WKWebView. The media engine needs Content-Type + the Range trio
/// (Content-Range / Accept-Ranges / Content-Length) to scrub.
// NOTE: `content-length` is deliberately NOT forwarded. tiny_http sets it
// itself from the `data_length` we pass to Response::new — forwarding it
// manually too produced a conflict that made tiny_http fall back to
// `Transfer-Encoding: chunked`, which WKWebView's media engine refuses
// for 206 partial video. We compute an authoritative length from the
// Content-Range instead (see `body_len_from_range`).
const FORWARD_HEADERS: &[&str] = &[
    "content-type",
    "content-range",
    "accept-ranges",
    "cache-control",
    "last-modified",
    "etag",
];

/// The proxy's base URL once started. `None` if the server isn't up.
pub fn base_url() -> Option<String> {
    BASE.get().cloned()
}

/// Bind the loopback server and spawn its accept loop on a background
/// thread. Returns the base URL (`http://127.0.0.1:<port>`). Call once
/// at app setup.
pub fn start() -> std::io::Result<String> {
    let server = tiny_http::Server::http("127.0.0.1:0")
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .ok_or_else(|| std::io::Error::other("no loopback port"))?;
    let token = mint_token();
    let _ = TOKEN.set(token.clone());
    // Token lives in the path, not the authority, so it's still a valid
    // `http://127.0.0.1:<port>/…` URL WebKit will stream.
    let base = format!("http://127.0.0.1:{port}/t/{token}");
    let _ = BASE.set(base.clone());

    std::thread::Builder::new()
        .name("sb-media-proxy".into())
        .spawn(move || {
            // One blocking client, cloned per request (cheap — shares the
            // connection pool). Built INSIDE the thread so no tokio
            // context is in scope.
            let client = match reqwest::blocking::Client::builder()
                .redirect(reqwest::redirect::Policy::limited(3))
                // Bound a never-completing TCP/TLS connect so a dead upstream
                // can't park a worker thread forever. Deliberately NO total
                // `.timeout()` — that caps the whole request including the body
                // read, which would abort legitimate long/backpressured streams
                // (our buffer-ahead cap intentionally stalls reads on pause).
                .connect_timeout(std::time::Duration::from_secs(15))
                .build()
            {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("[media-proxy] client init failed: {e}");
                    return;
                }
            };
            for request in server.incoming_requests() {
                let client = client.clone();
                // Thread-per-request: a slow/stalled stream can't block
                // the accept loop or sibling requests.
                std::thread::spawn(move || {
                    if let Err(e) = serve(&client, request) {
                        eprintln!("[media-proxy] serve error: {e}");
                    }
                });
            }
        })?;

    Ok(base)
}

fn serve(client: &reqwest::blocking::Client, request: tiny_http::Request) -> std::io::Result<()> {
    let raw_path_full = request.url().to_string();
    // Capability gate: every request must carry the per-session token as the
    // path prefix `/t/<token>/`. This is what stops a local process or a
    // port-scanning web page from using us as an open proxy / reading the
    // user's media. The token is base64url (no '/'), so the split is exact.
    let token = TOKEN.get().map(String::as_str).unwrap_or("");
    let raw_path = match raw_path_full
        .strip_prefix("/t/")
        .and_then(|r| r.strip_prefix(token))
    {
        Some(rest) if !token.is_empty() && rest.starts_with('/') => rest.to_string(),
        _ => {
            return request.respond(
                tiny_http::Response::from_string("forbidden").with_status_code(403),
            );
        }
    };

    // ── fMP4 remux route (r63) ──────────────────────────────────────
    // `/fmp4/v1/<b64-upstream>?start=<secs>` → spawn the ffmpeg sidecar to
    // transmux the upstream stream to fragmented MP4 (`-c copy`, both
    // tracks) and pipe it straight to the response. The frontend fetch()es
    // this and feeds MSE. We do this with ffmpeg (not mediabunny) because
    // mediabunny's muxed fMP4 plays video but NOT audio in WKWebView,
    // whereas ffmpeg's reference muxing plays both. `-ss` gives clean
    // keyframe seeks for scrubbing.
    if raw_path.trim_start_matches('/').starts_with("fmp4/v1/") {
        match decode_after("fmp4/v1/", &raw_path) {
            Some(u) => return serve_fmp4(request, u, parse_start_query(&raw_path), parse_audio_query(&raw_path)),
            None => {
                return request.respond(
                    tiny_http::Response::from_string("bad fmp4 path").with_status_code(400),
                );
            }
        }
    }

    let upstream = match decode_upstream(&raw_path) {
        Some(u) => u,
        None => {
            eprintln!("[media-proxy] REQ path={raw_path} -> 400 (bad path)");
            return request.respond(
                tiny_http::Response::from_string("bad proxy path").with_status_code(400),
            );
        }
    };

    // Forward the webview's Range header verbatim. WKWebView always sends
    // an explicit byte range (often a tiny probe first, then real chunks).
    let range = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Range"))
        .map(|h| h.value.as_str().to_string());

    let mut rb = client
        .get(&upstream)
        .header(reqwest::header::USER_AGENT, SAFARI_UA)
        .header(reqwest::header::ACCEPT, "*/*");
    if let Some(r) = &range {
        rb = rb.header(reqwest::header::RANGE, r.as_str());
    }

    let resp = match rb.send() {
        Ok(r) => r,
        Err(e) => {
            return request.respond(
                tiny_http::Response::from_string(format!("upstream fetch failed: {e}"))
                    .with_status_code(502),
            );
        }
    };

    let status = resp.status().as_u16();
    // Authoritative body length so tiny_http frames with Content-Length
    // (NOT chunked) — WKWebView's media engine requires it on 206. Prefer
    // the Content-Range span (end-start+1), which is exact for partial
    // responses; fall back to reqwest's content_length() for plain 200s.
    let content_range = resp
        .headers()
        .get("content-range")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    let body_len = content_range
        .as_deref()
        .and_then(body_len_from_range)
        .or_else(|| resp.content_length().map(|l| l as usize));

    let mut headers: Vec<tiny_http::Header> = Vec::new();
    for &name in FORWARD_HEADERS {
        if let Some(value) = resp.headers().get(name) {
            if let Ok(vs) = value.to_str() {
                if let Ok(h) = tiny_http::Header::from_bytes(name.as_bytes(), vs.as_bytes()) {
                    headers.push(h);
                }
            }
        }
    }
    // If upstream didn't advertise range support, hint it ourselves so
    // WebKit will issue Range requests for scrubbing.
    let advertises_ranges = resp.headers().contains_key("accept-ranges");
    if !advertises_ranges {
        if let Ok(h) = tiny_http::Header::from_bytes(&b"Accept-Ranges"[..], &b"bytes"[..]) {
            headers.push(h);
        }
    }
    // CORS: the page origin (tauri://localhost in prod, http://localhost:1420
    // in dev) is cross-origin to http://127.0.0.1:<port>. `<video src>`
    // doesn't enforce CORS, but `fetch()` and any future crossorigin use do —
    // and it costs nothing to be correct. `*` is safe: this server only ever
    // serves loopback and proxies URLs our own frontend already resolved.
    for (name, value) in [
        ("Access-Control-Allow-Origin", "*"),
        ("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS"),
        ("Access-Control-Allow-Headers", "Range"),
        ("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges"),
    ] {
        if let Ok(h) = tiny_http::Header::from_bytes(name.as_bytes(), value.as_bytes()) {
            headers.push(h);
        }
    }

    // reqwest::blocking::Response implements `Read`, so tiny_http streams
    // it straight to the socket — no full-file buffering. `content_length`
    // tells tiny_http how many bytes to expect (None → read to EOF).
    let response = tiny_http::Response::new(
        tiny_http::StatusCode(status),
        headers,
        resp,
        body_len,
        None,
    )
    // tiny_http defaults to chunked transfer encoding for any known-length
    // body above 32 KB. WKWebView's media engine refuses chunked on a 206
    // partial-video response — it wants an explicit Content-Length. Raising
    // the threshold to usize::MAX forces Content-Length whenever we know the
    // length (always true for our 206 ranged responses). This was the
    // difference between the 2-byte probe working and the real chunk failing.
    .with_chunked_threshold(usize::MAX);
    request.respond(response)
}

/// Resolve the bundled ffmpeg sidecar. In dev and in the packaged app the
/// sidecar sits next to the main executable (Tauri copies it there). We
/// check the plain name first (dev) then the target-triple name (some
/// bundle layouts). Cached after first resolution.
fn ffmpeg_path() -> Option<std::path::PathBuf> {
    static FFMPEG: OnceLock<Option<std::path::PathBuf>> = OnceLock::new();
    FFMPEG
        .get_or_init(|| {
            let dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
            for name in ["ffmpeg", "ffmpeg-aarch64-apple-darwin"] {
                let p = dir.join(name);
                if p.exists() {
                    return Some(p);
                }
            }
            None
        })
        .clone()
}

/// Pull the `start=<seconds>` query value out of the request path. Returns
/// 0.0 when absent/malformed. Fractional seconds are allowed (ffmpeg `-ss`).
fn parse_start_query(url_path: &str) -> f64 {
    url_path
        .split('?')
        .nth(1)
        .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("start=")))
        .and_then(|v| v.parse::<f64>().ok())
        // Reject inf/NaN (str::parse accepts "inf"/"nan") and clamp to a sane
        // upper bound before it reaches ffmpeg `-ss` — `-ss inf` spawns an
        // ffmpeg that does no useful work. 24h is far past any real media.
        .filter(|f| f.is_finite())
        .map(|f| f.clamp(0.0, 86_400.0))
        .unwrap_or(0.0)
}

/// Pull the optional `audio=<base64url>` query value — a SECOND upstream URL
/// (the audio track of a DASH-split source) for the 2-input fMP4 remux.
/// Returns the decoded http(s) URL, or None when absent/malformed.
fn parse_audio_query(url_path: &str) -> Option<String> {
    let b64 = url_path
        .split('?')
        .nth(1)?
        .split('&')
        .find_map(|kv| kv.strip_prefix("audio="))?;
    let bytes = URL_SAFE_NO_PAD.decode(b64.as_bytes()).ok()?;
    let url = String::from_utf8(bytes).ok()?;
    if url.starts_with("http://") || url.starts_with("https://") {
        Some(url)
    } else {
        None
    }
}

/// Decode `<prefix><base64url>[?query]` → upstream http(s) URL. Generalizes
/// `decode_upstream` for both the raw-proxy (`v1/`) and fMP4 (`fmp4/v1/`)
/// routes. Returns `None` for malformed paths or non-http(s) values.
fn decode_after(prefix: &str, url_path: &str) -> Option<String> {
    let after = url_path.trim_start_matches('/').strip_prefix(prefix)?;
    let b64 = after.split(['?', '#']).next().unwrap_or(after);
    if b64.is_empty() {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD.decode(b64.as_bytes()).ok()?;
    let url = String::from_utf8(bytes).ok()?;
    if url.starts_with("http://") || url.starts_with("https://") {
        Some(url)
    } else {
        None
    }
}

/// Spawn ffmpeg to transmux `upstream` → fragmented MP4 and stream its
/// stdout to the response. ffmpeg is killed when the client disconnects
/// (MSE torn down on seek/source-change) or when it finishes — `respond`
/// returns once the socket closes either way.
fn serve_fmp4(request: tiny_http::Request, upstream: String, start: f64, audio: Option<String>) -> std::io::Result<()> {
    let ff = match ffmpeg_path() {
        Some(p) => p,
        None => {
            eprintln!("[media-proxy] FMP4 -> 500 (ffmpeg sidecar not found)");
            return request.respond(
                tiny_http::Response::from_string("ffmpeg not found").with_status_code(500),
            );
        }
    };
    eprintln!(
        "[media-proxy] FMP4 start={start} host={}{}",
        upstream.split('/').nth(2).unwrap_or("?"),
        if audio.is_some() { " +audio(2-input)" } else { "" }
    );

    let mut cmd = std::process::Command::new(ff);
    cmd.arg("-hide_banner").arg("-loglevel").arg("error");
    // ── input 0: video (a muxed progressive, OR the video-only track of a
    // DASH-split source). NOTE: deliberately NO `-fflags +genpts` — it
    // fabricates timestamps and can mask AAC priming → manufactured drift;
    // `-c copy` carries the source PTS verbatim. Input-side `-ss` (fast,
    // keyframe-accurate) is applied to EACH input so a 2-input merge stays
    // in sync on scrub-rebuilds.
    if start > 0.0 { cmd.arg("-ss").arg(format!("{start}")); }
    cmd.arg("-user_agent").arg(SAFARI_UA).arg("-i").arg(&upstream);
    // ── input 1: a separate audio track for DASH-split sources (Reddit,
    // YouTube >360p). ffmpeg merges the two into one fMP4 — full audio, no
    // download wait. `-map` pins video from input 0, audio from input 1.
    if let Some(a) = &audio {
        if start > 0.0 { cmd.arg("-ss").arg(format!("{start}")); }
        cmd.arg("-user_agent").arg(SAFARI_UA).arg("-i").arg(a);
        cmd.arg("-map").arg("0:v:0").arg("-map").arg("1:a:0");
    }
    cmd.arg("-c").arg("copy");
    // HLS segments carry AAC in ADTS framing; the MP4 muxer DROPS the audio
    // ("Malformed AAC bitstream") unless it's converted to ASC. Apply ONLY for
    // HLS inputs — running it on already-ASC MP4/DASH audio would corrupt those.
    if upstream.contains("m3u8") || audio.as_deref().is_some_and(|a| a.contains("m3u8")) {
        cmd.arg("-bsf:a").arg("aac_adtstoasc");
    }
    // Re-base the output timeline to zero so the MSE <video>'s currentTime
    // maps 1:1 to real media time. Without this, the source's start-PTS
    // offset rides into the fMP4 and the playhead drifts from the audio,
    // making captions show late. muxpreload/muxdelay 0 drop mux offsets.
    // make_zero shifts ALL tracks by a single offset, so audio/video stay
    // aligned (it is NOT a per-stream shift).
    cmd.arg("-avoid_negative_ts").arg("make_zero")
        .arg("-muxpreload").arg("0")
        .arg("-muxdelay").arg("0")
        // Pin the video track to a clean 90kHz timescale. A weird source
        // timescale can round each frame's duration and make WKWebView's
        // currentTime tick slightly slower than real seconds — a RATE error
        // that compounds into growing caption drift. 90000 is the MP4 standard
        // and divides evenly for common frame rates.
        .arg("-video_track_timescale").arg("90000")
        .arg("-movflags").arg("frag_keyframe+empty_moov+default_base_moof")
        .arg("-f").arg("mp4")
        .arg("pipe:1")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            return request.respond(
                tiny_http::Response::from_string(format!("ffmpeg spawn failed: {e}"))
                    .with_status_code(500),
            );
        }
    };
    let stdout = match child.stdout.take() {
        Some(s) => s,
        None => {
            let _ = child.kill();
            return request.respond(
                tiny_http::Response::from_string("no ffmpeg stdout").with_status_code(500),
            );
        }
    };

    let mut headers: Vec<tiny_http::Header> = Vec::new();
    for (name, value) in [
        ("Content-Type", "video/mp4"),
        ("Access-Control-Allow-Origin", "*"),
        ("Cache-Control", "no-store"),
    ] {
        if let Ok(h) = tiny_http::Header::from_bytes(name.as_bytes(), value.as_bytes()) {
            headers.push(h);
        }
    }
    // Unknown length → chunked transfer encoding. That's fine here: the
    // consumer is fetch() + MSE appendBuffer (which handle chunked), NOT a
    // <video src> (which refused chunked). When the WebView stops reading
    // (buffer-ahead cap), TCP backpressure stalls ffmpeg automatically.
    let response = tiny_http::Response::new(
        tiny_http::StatusCode(200),
        headers,
        stdout,
        None,
        None,
    );
    let result = request.respond(response);
    // Client done or disconnected → tear ffmpeg down so it can't linger.
    let _ = child.kill();
    let _ = child.wait();
    result
}

/// Parse the byte count out of a `Content-Range: bytes <start>-<end>/<total>`
/// header → `end - start + 1`. Returns `None` for malformed values or the
/// unsatisfied-range form (`bytes */total`).
fn body_len_from_range(content_range: &str) -> Option<usize> {
    // e.g. "bytes 0-2000000/28523658"
    let spec = content_range.trim().strip_prefix("bytes ")?;
    let range = spec.split('/').next()?; // "0-2000000"
    let (start, end) = range.split_once('-')?;
    let start: usize = start.trim().parse().ok()?;
    let end: usize = end.trim().parse().ok()?;
    if end >= start {
        Some(end - start + 1)
    } else {
        None
    }
}

/// Decode `/v1/<base64url>` → upstream http(s) URL. Returns `None` for any
/// malformed path or a decoded value that isn't http(s).
fn decode_upstream(url_path: &str) -> Option<String> {
    let trimmed = url_path.trim_start_matches('/');
    let after_v1 = trimmed.strip_prefix("v1/")?;
    // Drop any trailing query/fragment WebKit might append.
    let b64 = after_v1.split(['?', '#']).next().unwrap_or(after_v1);
    if b64.is_empty() {
        return None;
    }
    let bytes = URL_SAFE_NO_PAD.decode(b64.as_bytes()).ok()?;
    let url = String::from_utf8(bytes).ok()?;
    if url.starts_with("http://") || url.starts_with("https://") {
        Some(url)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64(url: &str) -> String {
        URL_SAFE_NO_PAD.encode(url.as_bytes())
    }

    // ── parse_start_query — feeds ffmpeg -ss; attacker-reachable ────────
    #[test]
    fn start_query_parses_fractional_seconds() {
        assert!((parse_start_query("/fmp4/v1/abc?start=19.933") - 19.933).abs() < 1e-9);
        assert!((parse_start_query("/fmp4/v1/abc?start=0") - 0.0).abs() < 1e-9);
    }

    #[test]
    fn start_query_defaults_to_zero_when_absent_or_malformed() {
        assert_eq!(parse_start_query("/fmp4/v1/abc"), 0.0);
        assert_eq!(parse_start_query("/fmp4/v1/abc?start=banana"), 0.0);
        assert_eq!(parse_start_query("/fmp4/v1/abc?other=1"), 0.0);
    }

    #[test]
    fn start_query_rejects_non_finite_and_clamps() {
        // str::parse::<f64> accepts these spellings — they must never reach -ss.
        assert_eq!(parse_start_query("/fmp4/v1/abc?start=inf"), 0.0);
        assert_eq!(parse_start_query("/fmp4/v1/abc?start=NaN"), 0.0);
        assert_eq!(parse_start_query("/fmp4/v1/abc?start=-5"), 0.0);
        assert_eq!(parse_start_query("/fmp4/v1/abc?start=999999999"), 86_400.0);
    }

    // ── decode_upstream / decode_after — the b64 URL envelope ───────────
    #[test]
    fn decode_upstream_roundtrips_http_urls() {
        let url = "https://example.com/video.mp4?sig=abc";
        assert_eq!(decode_upstream(&format!("/v1/{}", b64(url))).as_deref(), Some(url));
    }

    #[test]
    fn decode_upstream_rejects_non_http_and_garbage() {
        assert_eq!(decode_upstream(&format!("/v1/{}", b64("file:///etc/passwd"))), None);
        assert_eq!(decode_upstream(&format!("/v1/{}", b64("ftp://host/x"))), None);
        assert_eq!(decode_upstream("/v1/"), None);
        assert_eq!(decode_upstream("/v1/!!!not-base64!!!"), None);
        assert_eq!(decode_upstream("/other/abc"), None);
        // Invalid UTF-8 after decode must not panic.
        let bad = URL_SAFE_NO_PAD.encode([0xff, 0xfe, 0xfd]);
        assert_eq!(decode_upstream(&format!("/v1/{bad}")), None);
    }

    #[test]
    fn decode_after_strips_query_and_fragment() {
        let url = "https://example.com/seg.m3u8";
        let path = format!("/fmp4/v1/{}?start=3.5#frag", b64(url));
        assert_eq!(decode_after("fmp4/v1/", &path).as_deref(), Some(url));
    }

    // ── parse_audio_query — second upstream for DASH-split merges ───────
    #[test]
    fn audio_query_decodes_http_only() {
        let url = "https://cdn.example.com/audio.m4a";
        let path = format!("/fmp4/v1/abc?start=1&audio={}", b64(url));
        assert_eq!(parse_audio_query(&path).as_deref(), Some(url));
        let evil = format!("/fmp4/v1/abc?audio={}", b64("file:///etc/hosts"));
        assert_eq!(parse_audio_query(&evil), None);
        assert_eq!(parse_audio_query("/fmp4/v1/abc"), None);
    }

    // ── body_len_from_range — WKWebView needs exact Content-Length ──────
    #[test]
    fn range_length_math() {
        assert_eq!(body_len_from_range("bytes 0-1/28523658"), Some(2));
        assert_eq!(body_len_from_range("bytes 100-199/500"), Some(100));
        assert_eq!(body_len_from_range("bytes */500"), None); // unsatisfied form
        assert_eq!(body_len_from_range("bytes 5-1/10"), None); // end < start
        assert_eq!(body_len_from_range("garbage"), None);
    }
}
