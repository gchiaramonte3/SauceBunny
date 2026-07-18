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

/// Resolve the bundled ffprobe sidecar via the SHARED resolver — the same
/// one nightly/download use, which also knows the debug-build layout
/// (CARGO_MANIFEST_DIR/binaries) and the plain-vs-triple bundle naming.
/// (Review fix: a local copy of ffmpeg_path's next-to-exe walk silently
/// returned None in layouts only sidecar_path handles, degrading every
/// seek to keyframe precision with no error.)
fn ffprobe_path() -> Option<std::path::PathBuf> {
    static FFPROBE: OnceLock<Option<std::path::PathBuf>> = OnceLock::new();
    FFPROBE
        .get_or_init(|| {
            crate::commands::sidecar_path("ffprobe")
                .ok()
                .filter(|p| p.exists())
        })
        .clone()
}

/// Probe the first video packet at-or-before `start` in `upstream` — the
/// keyframe that ffmpeg's input-side `-ss {start}` lands on, whose dts is
/// exactly the constant the fragmented-MP4 muxer subtracts from the whole
/// remux (RC7). Both use the same avformat backward seek, so they land on
/// the same packet. `%+#48` bounds the read window while guaranteeing a
/// video packet shows up even when a muxed source interleaves audio first.
fn probe_stream_epoch(upstream: &str, start: f64) -> Option<f64> {
    // Memoized per (upstream, start): scrubbing back to a spot re-serves the
    // same remux, and the epoch is a pure function of the seek landing point.
    static CACHE: OnceLock<std::sync::Mutex<std::collections::HashMap<(String, u64), f64>>> =
        OnceLock::new();
    let cache = CACHE.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()));
    let key = (upstream.to_string(), start.to_bits());
    if let Ok(map) = cache.lock() {
        if let Some(&e) = map.get(&key) {
            return Some(e);
        }
    }

    let fp = ffprobe_path()?;
    let mut child = std::process::Command::new(fp)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            // Per-read network bound (µs); the WALL-CLOCK bound below is what
            // actually protects the seek path — rw_timeout alone lets a
            // dripping CDN stretch 48 bounded reads into minutes.
            "-rw_timeout",
            "4000000",
            "-user_agent",
            SAFARI_UA,
            "-select_streams",
            "v:0",
            "-show_entries",
            "packet=pts_time,dts_time",
            "-of",
            "json",
            "-read_intervals",
        ])
        .arg(format!("{start}%+#48"))
        .arg(upstream)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;

    // Overall deadline: past ~4s the probe costs more than the precision is
    // worth — kill it and fall back to the rebased header (safe since the
    // player commits its clock per-pipeline from that same header).
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(4);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    eprintln!("[media-proxy] epoch probe timed out (4s) for start={start}");
                    return None;
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            Err(_) => {
                let _ = child.kill();
                return None;
            }
        }
    };
    if !status.success() {
        return None;
    }
    let mut buf = String::new();
    use std::io::Read as _;
    child.stdout.take()?.read_to_string(&mut buf).ok()?;
    let epoch = parse_stream_epoch(&buf)?;
    if let Ok(mut map) = cache.lock() {
        if map.len() > 64 {
            map.clear(); // tiny working set; wholesale clear beats an LRU here
        }
        map.insert(key, epoch);
    }
    Some(epoch)
}

/// Extract the epoch from ffprobe's JSON packet list: the first video
/// packet's dts, falling back to pts when dts is absent ("N/A") — off by at
/// most the b-frame reorder delay, still far inside the keyframe gap.
fn parse_stream_epoch(json: &str) -> Option<f64> {
    let v: serde_json::Value = serde_json::from_str(json).ok()?;
    let p = v.get("packets")?.get(0)?;
    let t = ["dts_time", "pts_time"]
        .iter()
        .find_map(|k| p.get(*k)?.as_str()?.parse::<f64>().ok())?;
    (t.is_finite() && t >= 0.0).then_some(t)
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
    let hls = upstream.contains("m3u8") || audio.as_deref().is_some_and(|a| a.contains("m3u8"));
    if hls {
        cmd.arg("-bsf:a").arg("aac_adtstoasc");
    }
    // Timeline mode (X-Timeline response header tells the frontend which):
    //  · MP4/DASH → `-copyts` + X-Stream-Epoch: the goal is ABSOLUTE source
    //    time on the wire, killing the class of bug where input-side `-ss`
    //    lands on the keyframe AT-OR-BEFORE the request (up to a GOP early)
    //    while the frontend asserts the requested time: audio played content
    //    behind the transcript highlight, and the exact landing point was
    //    unknowable client-side because the rebase erased it. `-copyts` alone
    //    is NOT enough (RC7): the demuxer preserves source pts, but the
    //    fragmented-MP4 muxer re-zeros every track to its first dts (verified
    //    against ffmpeg 8.1 — first tfdt is 0 regardless of -copyts,
    //    -avoid_negative_ts disabled, or +frag_discont). The subtraction is a
    //    CONSTANT though, so serve_fmp4 probes it (probe_stream_epoch below)
    //    and ships it in X-Stream-Epoch; the player re-adds it via MSE
    //    timestampOffset, making buffered time genuinely absolute.
    //  · HLS → legacy make_zero rebase: HLS segment PTS is an arbitrary stream
    //    epoch, not media time, so absolute timestamps would break the clock.
    if hls {
        cmd.arg("-avoid_negative_ts").arg("make_zero");
    } else {
        cmd.arg("-copyts");
    }
    cmd.arg("-muxpreload").arg("0")
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

    // RC7: recover the timeline origin the muxer is about to erase (see the
    // timeline-mode comment above). NOTE the honest cost model: respond()
    // below cannot send headers until this returns, so the probe IS on the
    // seek critical path — it merely overlaps ffmpeg's own connection
    // warm-up. That is why probe_stream_epoch carries a 4s wall-clock kill
    // and a per-(upstream,start) memo. No seek (start 0) needs no probe:
    // the muxer's re-zero is the identity there. Probe failure falls back
    // to the rebased header (the player commits mode+clock per pipeline
    // from this header, so a flip is safe — only landing precision drops
    // to the keyframe gap).
    let epoch = if hls {
        None
    } else if start > 0.0 {
        let e = probe_stream_epoch(&upstream, start);
        if e.is_none() {
            eprintln!(
                "[media-proxy] epoch probe failed -> serving REBASED timeline (keyframe precision) start={start}"
            );
        }
        e
    } else {
        Some(0.0)
    };
    let timeline_mode = if epoch.is_some() { "absolute" } else { "rebased" };
    let epoch_header = epoch.map(|e| format!("{e:.6}"));

    let mut headers: Vec<tiny_http::Header> = Vec::new();
    for (name, value) in [
        ("Content-Type", "video/mp4"),
        ("Access-Control-Allow-Origin", "*"),
        // Without the expose header, cross-origin fetch() cannot READ
        // X-Timeline and the player would silently fall back to rebased math.
        ("Access-Control-Expose-Headers", "X-Timeline, X-Stream-Epoch"),
        ("X-Timeline", timeline_mode),
        ("Cache-Control", "no-store"),
    ] {
        if let Ok(h) = tiny_http::Header::from_bytes(name.as_bytes(), value.as_bytes()) {
            headers.push(h);
        }
    }
    if let Some(v) = &epoch_header {
        if let Ok(h) = tiny_http::Header::from_bytes("X-Stream-Epoch".as_bytes(), v.as_bytes()) {
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

    // ── parse_stream_epoch — RC7 timeline-origin recovery ───────────────
    #[test]
    fn stream_epoch_takes_first_video_packet_dts() {
        let json = r#"{"packets":[
            {"pts_time":"33.333333","dts_time":"33.266667"},
            {"pts_time":"33.400000","dts_time":"33.300000"}]}"#;
        assert_eq!(parse_stream_epoch(json), Some(33.266667));
    }

    #[test]
    fn stream_epoch_falls_back_to_pts_when_dts_is_na() {
        let json = r#"{"packets":[{"pts_time":"12.500000","dts_time":"N/A"}]}"#;
        assert_eq!(parse_stream_epoch(json), Some(12.5));
    }

    #[test]
    fn stream_epoch_rejects_garbage_and_negatives() {
        assert_eq!(parse_stream_epoch(""), None);
        assert_eq!(parse_stream_epoch("{}"), None);
        assert_eq!(parse_stream_epoch(r#"{"packets":[]}"#), None);
        assert_eq!(parse_stream_epoch(r#"{"packets":[{"dts_time":"-5.0"}]}"#), None);
        assert_eq!(parse_stream_epoch(r#"{"packets":[{"dts_time":"nan"}]}"#), None);
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

// ─── Nightly real-sidecar smoke (see src/nightly.rs; run with --ignored) ────
//
// End-to-end through the REAL proxy + REAL ffmpeg: a local HTTP "CDN" serves
// the fixture, the proxy's `/fmp4/v1/` route spawns the bundled ffmpeg to
// remux it, and we assert the streamed bytes are a fragmented MP4 that still
// carries BOTH tracks — the r63 invariant (ffmpeg's fMP4 plays audio in
// WKWebView where mediabunny's didn't) and the r75 DASH audio-merge.
#[cfg(test)]
mod nightly_proxy_tests {
    use super::*;
    use crate::nightly;
    use std::path::PathBuf;

    /// `serve_fmp4` resolves ffmpeg next to the running executable — for
    /// `cargo test` that's target/debug/deps/, so link the repo sidecar there.
    fn link_ffmpeg_next_to_test_exe() {
        let exe = std::env::current_exe().expect("current_exe");
        let dir = exe.parent().expect("test exe has a parent dir");
        let dst = dir.join("ffmpeg");
        let src = nightly::sidecar("ffmpeg");
        match std::fs::read_link(&dst) {
            Ok(existing) if existing == src => return,
            Ok(_) => {
                let _ = std::fs::remove_file(&dst); // stale link from another checkout
            }
            Err(_) if dst.exists() => return, // a real file is already there
            Err(_) => {}
        }
        std::os::unix::fs::symlink(&src, &dst).expect("link ffmpeg next to test exe");
    }

    /// The proxy's BASE/TOKEN are process-global OnceLocks, so `start()` must
    /// run exactly once no matter how many tests need it.
    fn proxy_base() -> &'static str {
        static BASE: OnceLock<String> = OnceLock::new();
        BASE.get_or_init(|| {
            link_ffmpeg_next_to_test_exe();
            start().expect("stream proxy failed to start")
        })
    }

    /// Tiny loopback file server standing in for the CDN. Ignores Range and
    /// always answers 200 with the full body — ffmpeg accepts that, and the
    /// fixtures are faststart so no seeking is needed to demux.
    fn serve_fixtures(files: Vec<(&'static str, PathBuf)>) -> String {
        let server = tiny_http::Server::http("127.0.0.1:0").expect("bind fixture server");
        let port = server
            .server_addr()
            .to_ip()
            .map(|a| a.port())
            .expect("fixture server port");
        std::thread::spawn(move || {
            for req in server.incoming_requests() {
                let path = req
                    .url()
                    .trim_start_matches('/')
                    .split('?')
                    .next()
                    .unwrap_or("")
                    .to_string();
                match files.iter().find(|(route, _)| *route == path) {
                    Some((_, file)) => {
                        let data = std::fs::read(file).expect("read fixture");
                        let _ = req.respond(tiny_http::Response::from_data(data));
                    }
                    None => {
                        let _ = req.respond(
                            tiny_http::Response::from_string("not found").with_status_code(404),
                        );
                    }
                }
            }
        });
        format!("http://127.0.0.1:{port}")
    }

    /// GET a proxy URL and read the (chunked) body to EOF.
    fn fetch_all(url: &str) -> (u16, Vec<u8>) {
        let client = reqwest::blocking::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(180))
            .build()
            .expect("build blocking client");
        let resp = client.get(url).send().expect("proxy request failed");
        let status = resp.status().as_u16();
        let bytes = resp.bytes().expect("read proxy stream").to_vec();
        (status, bytes)
    }

    fn assert_fmp4_with_tracks(bytes: &[u8], want_audio: bool, what: &str) {
        assert!(
            bytes.len() > 20_000,
            "{what}: fMP4 stream suspiciously small ({} bytes) — ffmpeg likely \
             failed at spawn; run the request manually to see its stderr",
            bytes.len()
        );
        let boxes = nightly::mp4_boxes(bytes);
        let names: Vec<&str> = boxes.iter().map(|(f, _, _)| f.as_str()).collect();
        assert_eq!(names.first().copied(), Some("ftyp"), "{what}: stream must open with ftyp, got {names:?}");
        assert!(
            names.iter().filter(|n| **n == "moof").count() >= 1,
            "{what}: no moof fragments — not a fragmented MP4? boxes: {names:?}"
        );
        let moov = nightly::mp4_box_bytes(bytes, "moov")
            .unwrap_or_else(|| panic!("{what}: stream has no moov init segment; boxes: {names:?}"));
        assert!(
            nightly::contains_bytes(moov, b"avc1"),
            "{what}: moov lost the H.264 video track"
        );
        if want_audio {
            assert!(
                nightly::contains_bytes(moov, b"mp4a"),
                "{what}: moov lost the AAC audio track — the r63 'ffmpeg fMP4 \
                 keeps audio' invariant is broken"
            );
        }
    }

    #[test]
    #[ignore = "nightly: needs real sidecar binaries"]
    fn nightly_fmp4_remux_streams_fragmented_mp4_with_audio() {
        let av = nightly::fixture_av();
        let cdn = serve_fixtures(vec![("av.mp4", av)]);
        let upstream = format!("{cdn}/av.mp4");
        let url = format!("{}/fmp4/v1/{}?start=0", proxy_base(), URL_SAFE_NO_PAD.encode(upstream.as_bytes()));
        let (status, bytes) = fetch_all(&url);
        assert_eq!(status, 200, "fmp4 route returned {status}");
        eprintln!("[nightly] fMP4 remux: {} bytes", bytes.len());
        assert_fmp4_with_tracks(&bytes, true, "muxed remux");
    }

    #[test]
    #[ignore = "nightly: needs real sidecar binaries"]
    fn nightly_fmp4_seek_rebuild_from_start_offset() {
        let av = nightly::fixture_av();
        let cdn = serve_fixtures(vec![("av.mp4", av)]);
        let upstream = format!("{cdn}/av.mp4");
        let b64 = URL_SAFE_NO_PAD.encode(upstream.as_bytes());
        let (s0, full) = fetch_all(&format!("{}/fmp4/v1/{b64}?start=0", proxy_base()));
        let (s3, tail) = fetch_all(&format!("{}/fmp4/v1/{b64}?start=3", proxy_base()));
        assert_eq!((s0, s3), (200, 200));
        assert_fmp4_with_tracks(&tail, true, "seek rebuild (start=3)");
        // The fixture has a keyframe every second, so -ss 3 must actually
        // drop the first ~3s — a rebuilt stream that ignores `start` would
        // come back the same size as the full one.
        assert!(
            (tail.len() as f64) < (full.len() as f64) * 0.8,
            "start=3 stream ({} bytes) is not meaningfully smaller than the \
             full stream ({} bytes) — input-side -ss seek seems broken",
            tail.len(),
            full.len()
        );
    }

    #[test]
    #[ignore = "nightly: needs real sidecar binaries"]
    fn nightly_fmp4_dash_split_audio_merge() {
        let video = nightly::fixture_video_only();
        let audio = nightly::fixture_audio_m4a();
        let cdn = serve_fixtures(vec![("v.mp4", video), ("a.m4a", audio)]);
        let v64 = URL_SAFE_NO_PAD.encode(format!("{cdn}/v.mp4").as_bytes());
        let a64 = URL_SAFE_NO_PAD.encode(format!("{cdn}/a.m4a").as_bytes());
        let url = format!("{}/fmp4/v1/{v64}?start=0&audio={a64}", proxy_base());
        let (status, bytes) = fetch_all(&url);
        assert_eq!(status, 200, "2-input fmp4 route returned {status}");
        eprintln!("[nightly] DASH-split merge: {} bytes", bytes.len());
        // The r75 invariant: video from input 0 + audio from input 1, merged
        // into ONE fMP4 with both tracks.
        assert_fmp4_with_tracks(&bytes, true, "DASH-split 2-input merge");
    }
}
