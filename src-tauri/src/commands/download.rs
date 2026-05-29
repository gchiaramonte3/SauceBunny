//! Source acquisition commands — every flow that talks to yt-dlp.
//!
//! Lives here:
//!   - Metadata fetch + validation (`fetch_metadata`).
//!   - Caption download (`download_captions`).
//!   - Thumbnail save (`save_thumbnail`).
//!   - Direct stream URL resolution (`get_direct_stream_url`).
//!   - Web-preview download (`download_web_preview`) — fallback for
//!     Referer-gated sources where direct-stream playback fails.
//!   - YouTube-specific helpers: cookie args, auth-error detection,
//!     humanised error messages.
//!
//! Shared cross-module helpers (`short_err`, `sidecar_path`,
//! `current_triple`, `HOMEBREW_PATH`) and shared event types
//! (`LogEvent`, `ProgressEvent`, `DoneEvent`) stay in mod.rs.
//!
//! Extracted from the 4155-line commands.rs monolith in r47 per the
//! constitution's refactor priority #1.

use super::*;

/// yt-dlp tries several YouTube "player clients" in order; we exclude `tv`
/// (needs PO Token negotiation that often fails) but allow the rest. The
/// `web` client deobfuscates YouTube's `nsig` parameter via a JS runtime
/// — requires `deno` on PATH (brew install deno) for 1080p+ formats; without
/// it, yt-dlp falls back to lower-resolution clients automatically.
pub(crate) const YT_EXTRACTOR_ARGS: [&str; 2] = ["--extractor-args", "youtube:player_client=default,-tv"];

/// Hosts where we KNOW yt-dlp's optimized extractor exists and the
/// playback flow goes through our IFrame fast-path. Everything else
/// still routes through yt-dlp (which covers ~1,800 sites via dedicated
/// extractors plus a `generic` fallback for arbitrary pages with embedded
/// video), it just plays via the direct-stream-URL path instead.
const YOUTUBE_HOSTS: &[&str] = &[
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
];

/// True if the URL is a YouTube canonical host. Reserved for future
/// server-side branching (e.g. format-selector tweaks) — frontend has
/// its own copy of this check today.
#[allow(dead_code)]
fn is_youtube_url(url: &str) -> bool {
    let parsed = match url::Url::parse(url) {
        Ok(u) => u,
        Err(_) => return false,
    };
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    YOUTUBE_HOSTS.iter().any(|h| host == *h)
}

/// Build the `--cookies-from-browser <name>` argv fragment if the user
/// has picked a browser in Settings. Returns an empty Vec for `None` /
/// `"none"` so callers can `cmd_args.extend(cookies_args(...))` blindly.
pub(crate) fn cookies_args(browser: Option<&str>) -> Vec<String> {
    match browser {
        Some(b) if b != "none" && !b.is_empty() => {
            vec!["--cookies-from-browser".into(), b.into()]
        }
        _ => vec![],
    }
}

/// Cheap per-line check used by the streaming loops (which don't have
/// access to a single accumulated stderr buffer). Set a captured boolean
/// when this returns true; on termination, swap the generic
/// "yt-dlp exited with code X" message for the bot-detection hint.
pub(crate) fn is_youtube_auth_error_line(line: &str) -> bool {
    let l = line.to_ascii_lowercase();
    l.contains("sign in to confirm")
        || l.contains("login_required")
        || l.contains("not a bot")
        || (l.contains("age") && l.contains("restricted"))
}

/// Standard auth-issue message — kept identical to `humanize_ytdlp_error`'s
/// branch so the user sees the same text whether the failure was caught at
/// the one-shot `output()` boundary or in a streaming loop.
pub(crate) const YT_AUTH_HINT: &str = "YouTube is asking for sign-in to confirm you're not a bot. \
    Open Settings → YouTube auth and pick the browser you're already logged into YouTube on \
    (Chrome/Safari/etc.) so yt-dlp can reuse those cookies.";

/// Map common yt-dlp failure modes into actionable error messages.
/// YouTube's bot-detection error is the headline case — the raw stderr
/// dumps a stack trace and a wiki link; we turn it into one sentence
/// pointing at Settings → YouTube auth.
pub(crate) fn humanize_ytdlp_error(stderr: &str) -> String {
    let trimmed = stderr.trim();
    if trimmed.contains("Sign in to confirm you")
        || trimmed.contains("LOGIN_REQUIRED")
        || trimmed.contains("not a bot")
    {
        return "YouTube is asking for sign-in to confirm you're not a bot. \
                Open Settings → YouTube auth and pick the browser you're \
                already logged into YouTube on (Chrome/Safari/etc.) so \
                yt-dlp can reuse those cookies."
            .into();
    }
    if trimmed.contains("Video unavailable") {
        return "YouTube reports this video is unavailable (deleted, private, or region-locked).".into();
    }
    if trimmed.contains("age") && trimmed.contains("restricted") {
        return "Age-restricted video — set Settings → YouTube auth so yt-dlp can use your signed-in cookies.".into();
    }
    // Generic fall-through: surface the first non-empty line so we don't
    // dump the whole Python stack into the UI.
    trimmed
        .lines()
        .find(|l| !l.trim().is_empty())
        .unwrap_or("yt-dlp failed")
        .to_string()
}

#[derive(Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct Metadata {
    pub title: String,
    pub duration: Option<f64>,
    pub thumbnail: Option<String>,
    pub uploader: Option<String>,
    pub upload_date: Option<String>,
    // u64 in Rust serializes as JSON number; ts-rs defaults to `bigint`
    // for correctness, but every YouTube view count comfortably fits in
    // JS's safe integer range (< 2^53), so we keep the TS type as
    // `number | null` for API stability with the pre-r49 surface.
    #[ts(type = "number | null")]
    pub view_count: Option<u64>,
    pub webpage_url: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub fps: Option<f64>,
    pub vcodec: Option<String>,
    pub acodec: Option<String>,
    pub ext: Option<String>,
    pub has_subs: bool,
}

#[tauri::command]
pub async fn fetch_metadata(
    app: AppHandle,
    url: String,
    cookies_browser: Option<String>,
) -> Result<Metadata, crate::AppError> {
    validate_source_url(&url)?;

    let cmd = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| format!("sidecar yt-dlp not found: {e}"))?;

    let mut args: Vec<String> = vec![
        "--dump-json".into(),
        "--no-warnings".into(),
        "--no-playlist".into(),
        "--no-check-formats".into(),
        "--socket-timeout".into(), "10".into(),
        YT_EXTRACTOR_ARGS[0].into(),
        YT_EXTRACTOR_ARGS[1].into(),
    ];
    args.extend(cookies_args(cookies_browser.as_deref()));
    args.push(url.clone());

    let output = cmd
        .env("PATH", HOMEBREW_PATH)
        .args(args)
        .output()
        .await
        .map_err(|e| format!("failed to run yt-dlp: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(humanize_ytdlp_error(&stderr).into());
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let first = stdout.lines().next().unwrap_or("{}");
    let v: serde_json::Value =
        serde_json::from_str(first).map_err(|e| format!("failed to parse yt-dlp JSON: {e}"))?;

    let has_subs = v["subtitles"]
        .as_object()
        .map(|o| !o.is_empty())
        .unwrap_or(false)
        || v["automatic_captions"]
            .as_object()
            .map(|o| !o.is_empty())
            .unwrap_or(false);

    // ── Resolution / fps from formats[] not top-level ─────────────────
    // yt-dlp's top-level `width`/`height`/`fps` reflect whatever the default
    // format SELECTOR picked — and with --no-check-formats that's typically
    // format 18 (640×360 muxed) even on a 4K source. To get the actual
    // ceiling we walk `formats[]` and take the max by (height, width, fps).
    // This is what powers the sidebar's "Source is XxY" hint and the format
    // pill enablement.
    let mut max_w: Option<u32> = None;
    let mut max_h: Option<u32> = None;
    let mut max_fps: Option<f64> = None;
    if let Some(formats) = v["formats"].as_array() {
        for f in formats {
            // Skip storyboard / audio-only entries.
            if f["vcodec"].as_str().unwrap_or("none") == "none" { continue; }
            let h = f["height"].as_u64().map(|n| n as u32);
            let w = f["width"].as_u64().map(|n| n as u32);
            let fr = f["fps"].as_f64();
            if let (Some(h_val), Some(cur)) = (h, max_h) {
                if h_val > cur {
                    max_h = Some(h_val);
                    max_w = w.or(max_w);
                    max_fps = fr.or(max_fps);
                }
            } else if h.is_some() && max_h.is_none() {
                max_h = h;
                max_w = w;
                max_fps = fr;
            }
        }
    }
    // Fall back to top-level if formats[] was empty (e.g. live stream).
    let width  = max_w.or_else(|| v["width"].as_u64().map(|n| n as u32));
    let height = max_h.or_else(|| v["height"].as_u64().map(|n| n as u32));
    let fps    = max_fps.or_else(|| v["fps"].as_f64());

    Ok(Metadata {
        title: v["title"].as_str().unwrap_or("Untitled").to_string(),
        duration: v["duration"].as_f64(),
        thumbnail: v["thumbnail"].as_str().map(String::from),
        uploader: v["uploader"].as_str().map(String::from),
        upload_date: v["upload_date"].as_str().map(String::from),
        view_count: v["view_count"].as_u64(),
        webpage_url: v["webpage_url"].as_str().unwrap_or(&url).to_string(),
        width,
        height,
        fps,
        vcodec: v["vcodec"].as_str().map(String::from),
        acodec: v["acodec"].as_str().map(String::from),
        ext: v["ext"].as_str().map(String::from),
        has_subs,
    })
}

#[derive(Deserialize)]
pub struct CaptionsArgs {
    pub url: String,
    pub output_dir: String,
    pub filename: String,
    pub job_id: String,
    pub cookies_browser: Option<String>,
}

#[tauri::command]
pub async fn download_captions(app: AppHandle, args: CaptionsArgs) -> Result<String, crate::AppError> {
    validate_source_url(&args.url)?;
    let safe = sanitize_filename(&args.filename);
    if safe.is_empty() {
        return Err("Filename is empty".into());
    }
    let out_dir = PathBuf::from(&args.output_dir);
    if !out_dir.is_dir() {
        return Err("Output folder does not exist".into());
    }

    // Let yt-dlp append the language + extension to the base.
    let template = out_dir.join(format!("{safe}.%(ext)s"));
    let template_str = template
        .to_str()
        .ok_or_else(|| crate::AppError::internal("template path is not valid utf-8"))?
        .to_string();

    let cmd = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| format!("sidecar yt-dlp not found: {e}"))?;

    let mut caption_args: Vec<String> = vec![
        "--write-subs".into(),
        "--write-auto-subs".into(),
        // Explicit, finite list of English variants. The earlier glob
        // `en.*` matched YouTube's `en-en-US` auto-translation track,
        // which 429s reliably and made yt-dlp exit nonzero even though
        // the real English tracks (en, en-US, en-orig) had already
        // written cleanly to disk. The three explicit codes below
        // cover every English track YouTube actually serves for human +
        // auto + original-language. yt-dlp will silently skip codes
        // that don't exist on a given video — no error.
        "--sub-langs".into(), "en-US,en-orig,en".into(),
        // `--ignore-errors` makes a single failing track non-fatal — if
        // YouTube 429s one variant, the others still succeed and we
        // still exit 0. Defence-in-depth alongside the file-scan-on-
        // any-exit logic below.
        "--ignore-errors".into(),
        "--sub-format".into(), "srt/vtt/best".into(),
        "--convert-subs".into(), "srt".into(),
        "--skip-download".into(),
        "--no-playlist".into(),
        "--newline".into(),
        YT_EXTRACTOR_ARGS[0].into(),
        YT_EXTRACTOR_ARGS[1].into(),
        "-o".into(), template_str.clone(),
    ];
    caption_args.extend(cookies_args(args.cookies_browser.as_deref()));
    caption_args.push(args.url.clone());
    let (mut rx, _child) = cmd
        .env("PATH", HOMEBREW_PATH)
        .args(caption_args)
        .spawn()
        .map_err(|e| format!("failed to spawn yt-dlp: {e}"))?;

    let job_id = args.job_id.clone();
    let job_for = job_id.clone();
    let app_for = app.clone();
    let out_dir_for = out_dir.clone();
    let safe_for = safe.clone();

    tokio::spawn(async move {
        let mut saw_auth_error = false;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(b) | CommandEvent::Stderr(b) => {
                    let raw = String::from_utf8_lossy(&b).to_string();
                    for line in raw.lines() {
                        let line = line.trim_end();
                        if line.is_empty() {
                            continue;
                        }
                        if is_youtube_auth_error_line(line) { saw_auth_error = true; }
                        let tag = classify_line(line);
                        let _ = app_for.emit(
                            "captions-log",
                            LogEvent {
                                job_id: job_for.clone(),
                                stream: "stdout".into(),
                                tag,
                                line: line.to_string(),
                            },
                        );
                    }
                }
                CommandEvent::Terminated(payload) => {
                    // Always scan the output dir for SRT files, even on
                    // nonzero exit. yt-dlp can 429 on a single phantom
                    // translation track and still have written 1–3
                    // perfectly good English tracks before the failure.
                    // The presence of the file on disk is the source of
                    // truth, not the exit code.
                    //
                    // Pick the best variant by preference:
                    //   en-US  > en  > en-orig  > anything else
                    // (en-US is usually the highest-quality human or
                    // auto-cap track; en-orig is the original-language
                    // fallback and least preferred.)
                    let mut candidates: Vec<(u8, String)> = Vec::new();
                    if let Ok(entries) = std::fs::read_dir(&out_dir_for) {
                        for entry in entries.flatten() {
                            let p = entry.path();
                            let name = p
                                .file_name()
                                .and_then(|n| n.to_str())
                                .unwrap_or("")
                                .to_string();
                            if !name.starts_with(&safe_for) || !name.ends_with(".srt") {
                                continue;
                            }
                            // Lower rank = preferred.
                            let rank: u8 = if name.ends_with(".en-US.srt")  { 0 }
                                      else if name.ends_with(".en.srt")     { 1 }
                                      else if name.ends_with(".en-orig.srt"){ 2 }
                                      else                                  { 3 };
                            candidates.push((rank, p.to_string_lossy().to_string()));
                        }
                    }
                    candidates.sort_by_key(|(rank, _)| *rank);
                    let found: Option<String> = candidates.into_iter().next().map(|(_, p)| p);

                    let exit_ok = payload.code == Some(0);
                    let success = found.is_some();
                    let error = if !success {
                        Some(if saw_auth_error {
                            YT_AUTH_HINT.into()
                        } else if !exit_ok {
                            format!("yt-dlp exited with code {:?} and no captions were written", payload.code)
                        } else {
                            "No captions found for this source".into()
                        })
                    } else {
                        None
                    };
                    let _ = app_for.emit(
                        "captions-done",
                        DoneEvent {
                            job_id: job_for.clone(),
                            success,
                            code: payload.code,
                            path: found,
                            error,
                        },
                    );
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(job_id)
}

#[derive(Deserialize)]
pub struct SaveThumbArgs {
    pub url: String,
    pub dest: String,
}

/// Fetch an HTTP(S) URL and write its body to `dest` on disk.
/// Used for the "Save thumbnail…" action.
#[tauri::command]
pub async fn save_thumbnail(args: SaveThumbArgs) -> Result<(), crate::AppError> {
    let parsed = url::Url::parse(&args.url).map_err(|e| format!("invalid url: {e}"))?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err("URL must be http(s)".into());
    }
    let res = reqwest::get(&args.url)
        .await
        .map_err(|e| format!("fetch failed: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status().as_u16()).into());
    }
    let bytes = res
        .bytes()
        .await
        .map_err(|e| format!("read failed: {e}"))?;
    let dest_path = PathBuf::from(&args.dest);
    if let Some(parent) = dest_path.parent() {
        if !parent.exists() {
            return Err(format!("Folder does not exist: {}", parent.display()).into());
        }
    }
    std::fs::write(&dest_path, &bytes).map_err(|e| format!("write failed: {e}"))?;
    Ok(())
}

// ────────────────────────────────────────────────────────────────────────
// DIRECT STREAM URL
//
// yt-dlp's `-g` flag returns the signed/direct media URL for a video on
// any supported site (Vimeo, TikTok, Twitter/X, Reddit, Twitch VOD,
// Instagram, ~1,800 sites total + a `generic` fallback for arbitrary
// pages with embedded video). For non-YouTube sources we hand that
// signed URL directly to <video src> — Safari handles range requests
// to the CDN itself. No download wait, no disk usage, scrubs natively.
//
// Caveat: the signed URL expires (typically 6h, can be much less). If
// playback fails mid-session the frontend can re-resolve.
// ────────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
pub struct DirectStreamResult {
    pub url: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub vcodec: Option<String>,
}

#[tauri::command]
pub async fn get_direct_stream_url(
    app: AppHandle,
    url: String,
    cookies_browser: Option<String>,
) -> Result<DirectStreamResult, crate::AppError> {
    validate_source_url(&url)?;

    let yt = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| format!("sidecar yt-dlp not found: {e}"))?;

    // r54: Force a **single-file progressive** stream (both A+V in one
    // URL, NOT HLS or DASH split tracks). The previous selector
    // `b[ext=mp4]/b/best` happily picked YouTube's HLS playlist
    // (`manifest.googlevideo.com/.../index.m3u8`) — WKWebView claims
    // native HLS support, but the m3u8 doesn't carry
    // `Access-Control-Allow-Origin`, so <video src=m3u8> from our
    // `tauri://localhost` origin silently fails to load (loadedmetadata
    // never fires; our 5s watchdog falls back to the download path).
    //
    // The protocol filter (`http`-prefix, not `m3u8`) plus the
    // `acodec!=none][vcodec!=none]` muxed-only filter is the same
    // pattern mpv and VLC use when they want a single playable URL.
    // For YouTube this means format 18 (640×360 H.264+AAC, the only
    // progressive option). 360p is the price of in-app preview; the
    // export path uses its OWN yt-dlp call and is unaffected — users
    // still get full-quality output.
    //
    // For non-YouTube hosts (Vimeo, TikTok, Twitter, Reddit, …) most
    // sites still serve at least one progressive variant in the
    // bestquality range, so they're unaffected. Final `/b` is the
    // last-resort fallback if literally no progressive exists.
    let mut args: Vec<String> = vec![
        "--no-playlist".into(),
        "--no-warnings".into(),
        "-f".into(),
        "b[acodec!=none][vcodec!=none][protocol^=http][protocol!*=m3u8]/\
         b[acodec!=none][vcodec!=none][ext=mp4]/\
         b[ext=mp4]/b".into(),
        "-S".into(), "res,vbr,ext".into(),
        YT_EXTRACTOR_ARGS[0].into(),
        YT_EXTRACTOR_ARGS[1].into(),
        "--print".into(), "url".into(),
        "--print".into(), "%(width)s\t%(height)s\t%(vcodec)s".into(),
    ];
    args.extend(cookies_args(cookies_browser.as_deref()));
    args.push(url.clone());

    let out = yt
        .env("PATH", HOMEBREW_PATH)
        .args(args)
        .output()
        .await
        .map_err(|e| format!("yt-dlp failed: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        return Err(humanize_ytdlp_error(&stderr).into());
    }
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let mut lines = stdout.lines().filter(|l| !l.trim().is_empty());
    let direct = lines
        .next()
        .ok_or_else(|| crate::AppError::internal("yt-dlp returned no stream URL — this site may require auth or use a format Safari can't play"))?
        .to_string();
    let (w, h, vcodec) = if let Some(meta) = lines.next() {
        let parts: Vec<&str> = meta.split('\t').collect();
        let w  = parts.first().and_then(|s| s.parse::<u32>().ok());
        let h  = parts.get(1).and_then(|s| s.parse::<u32>().ok());
        let vc = parts.get(2).filter(|s| !s.is_empty() && **s != "NA").map(|s| s.to_string());
        (w, h, vc)
    } else {
        (None, None, None)
    };
    Ok(DirectStreamResult { url: direct, width: w, height: h, vcodec })
}

// ────────────────────────────────────────────────────────────────────────
// DOWNLOAD WEB PREVIEW  (fallback for Referer-gated CDNs)
//
// LinkedIn (licdn.com), Twitter/X (twimg.com), Instagram (cdninstagram.com),
// Facebook (fbcdn.net) — every major social platform — returns 403 to
// cross-origin fetches because their CDNs check the `Referer` header. Our
// WKWebView sends `Referer: tauri://localhost/` for media requests, which
// gets rejected, so <video src="..."> silently fails to load. yt-dlp
// sends the correct `Referer` itself, so the fix is to download via
// yt-dlp into the app cache and point the player at the local file via
// asset:// (no cross-origin concerns once the bytes are on disk).
//
// Reuses the playback-prep event channels (`playback-prep-progress` /
// `playback-prep-done`) so the existing pipeline UI light up the same
// way as a local-file ffmpeg prep — single user-facing pattern for
// "preparing playback".
// ────────────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct DownloadWebPreviewArgs {
    pub url: String,
    pub job_id: String,
    pub cookies_browser: Option<String>,
}

#[tauri::command]
pub async fn download_web_preview(
    app: AppHandle,
    args: DownloadWebPreviewArgs,
) -> Result<String, crate::AppError> {
    validate_source_url(&args.url)?;

    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("app_cache_dir: {e}"))?;
    std::fs::create_dir_all(&cache).map_err(|e| format!("mkdir cache: {e}"))?;
    // yt-dlp picks the ext from the format selector — we let it choose
    // and probe the resulting file after to find the actual path.
    let prefix = format!("saucebunny-webcache-{}", args.job_id);
    let template = cache
        .join(format!("{}.%(ext)s", prefix))
        .to_string_lossy()
        .to_string();

    let cmd = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| format!("sidecar yt-dlp not found: {e}"))?;

    // Cap at 720p — the preview is for in-app scrubbing/marking, not
    // archival. Smaller file = faster download = quicker time-to-play.
    // The actual export still uses the user's selected quality via
    // create_clip's own format selector.
    //
    // r56: force progressive HTTPS (NOT HLS m3u8). The previous selector
    // `b[height<=720][ext=mp4]/...` was happy to pick a YouTube HLS
    // playlist; that downloads as 1000+ tiny fragments, half of which
    // 401 mid-stream when the signed manifest tokens rotate. The new
    // selector tries: progressive MP4 ≤720p with A+V → progressive MP4
    // (any height) → DASH video+audio merged (still single HTTPS files,
    // not HLS) → format 18 (legacy 360p progressive — YouTube's
    // last-resort guaranteed-playable) → anything yt-dlp can find.
    let mut yt_args: Vec<String> = vec![
        "-f".into(),
        "b[height<=720][ext=mp4][acodec!=none][vcodec!=none][protocol^=http][protocol!*=m3u8]/\
         b[ext=mp4][acodec!=none][vcodec!=none][protocol^=http][protocol!*=m3u8]/\
         bv*[ext=mp4][protocol^=http][protocol!*=m3u8]+ba[ext=m4a][protocol^=http][protocol!*=m3u8]/\
         18/\
         b".into(),
        "--no-playlist".into(),
        "--no-part".into(),
        "--newline".into(),
        "--progress".into(),
        YT_EXTRACTOR_ARGS[0].into(),
        YT_EXTRACTOR_ARGS[1].into(),
        "--concurrent-fragments".into(), "16".into(),
        "--http-chunk-size".into(), "10M".into(),
        // Force a single-file MP4 output. If the source is DASH (split
        // A+V), yt-dlp will mux them with ffmpeg here too.
        "--merge-output-format".into(), "mp4".into(),
        "-o".into(), template.clone(),
    ];
    yt_args.extend(cookies_args(args.cookies_browser.as_deref()));
    yt_args.push(args.url.clone());

    let (mut rx, child) = cmd
        .env("PATH", HOMEBREW_PATH)
        .args(yt_args)
        .spawn()
        .map_err(|e| format!("failed to spawn yt-dlp: {e}"))?;
    app.state::<JobRegistry>().insert(args.job_id.clone(), child);

    let app_for = app.clone();
    let job_for = args.job_id.clone();
    let cache_for = cache.clone();
    let prefix_for = prefix.clone();

    tokio::spawn(async move {
        let mut saw_auth_error = false;
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(b) | CommandEvent::Stderr(b) => {
                    let raw = String::from_utf8_lossy(&b).to_string();
                    for line in raw.lines() {
                        let line = line.trim_end();
                        if line.is_empty() { continue; }
                        if is_youtube_auth_error_line(line) { saw_auth_error = true; }
                        if is_ytdlp_progress(line) {
                            if let Some(pct) = regex_lite_percent(line) {
                                let _ = app_for.emit("playback-prep-progress", ProgressEvent {
                                    job_id: job_for.clone(), percent: pct,
                                });
                            }
                        }
                        // Re-use the playback-prep-log channel so the
                        // pipeline tab tags these the same way as a
                        // local-file prep run.
                        let _ = app_for.emit("playback-prep-log", LogEvent {
                            job_id: job_for.clone(),
                            stream: "stderr".into(),
                            tag: classify_line(line),
                            line: format!("[web-preview] {}", line),
                        });
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let _ = app_for.state::<JobRegistry>().take(&job_for);
                    let success = payload.code == Some(0);
                    if !success {
                        let _ = app_for.emit("playback-prep-done", PreparePlaybackDone {
                            job_id: job_for.clone(),
                            success: false,
                            path: None,
                            error: Some(if payload.signal.is_some() {
                                "Cancelled".into()
                            } else if saw_auth_error {
                                YT_AUTH_HINT.into()
                            } else {
                                format!("Preview download failed (yt-dlp exit {:?})", payload.code)
                            }),
                        });
                        break;
                    }
                    // Locate the file yt-dlp actually wrote — the ext
                    // depends on what it picked from the format selector.
                    let written = find_audio_in_cache(&cache_for, &prefix_for);
                    let path_str = written
                        .as_ref()
                        .and_then(|p| p.to_str())
                        .map(String::from);
                    let _ = app_for.emit("playback-prep-done", PreparePlaybackDone {
                        job_id: job_for.clone(),
                        success: path_str.is_some(),
                        path: path_str.clone(),
                        error: if path_str.is_some() {
                            None
                        } else {
                            Some("yt-dlp exited cleanly but no file was found in cache".into())
                        },
                    });
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(args.job_id)
}

