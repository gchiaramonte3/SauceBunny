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
//!     humanized error messages.
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

/// Build the `--cookies-from-browser <name>` argv fragment if the user
/// has picked a browser in Settings. Returns an empty Vec for `None` /
/// `"none"` so callers can `cmd_args.extend(cookies_args(...))` blindly.
pub(crate) fn cookies_args(browser: Option<&str>) -> Vec<String> {
    match browser {
        Some(b) if b != "none" && !b.is_empty() => {
            // Safari's cookies live in a TCC-protected container that's only
            // readable with Full Disk Access. Without it, yt-dlp dies with
            // "Operation not permitted" and breaks the ENTIRE resolve. Skip
            // the cookies instead of breaking — degrade to no-auth (which
            // works unless YouTube is actively bot-checking, in which case the
            // sign-in modal pops). The frontend warns that Safari needs FDA.
            if b.eq_ignore_ascii_case("safari") && !safari_cookies_readable() {
                eprintln!("[cookies] Safari cookies need Full Disk Access — proceeding without cookies");
                return vec![];
            }
            vec!["--cookies-from-browser".into(), b.into()]
        }
        _ => vec![],
    }
}

/// True if we can open Safari's cookie store — i.e. the app has Full Disk
/// Access. The file lives in a sandboxed container; opening it returns
/// "Operation not permitted" without FDA.
fn safari_cookies_readable() -> bool {
    let home = std::env::var("HOME").unwrap_or_default();
    let p = format!(
        "{home}/Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies"
    );
    std::fs::File::open(&p).is_ok()
}

/// True when `cookies_args` would actually inject `--cookies-from-browser` for
/// this browser (set, not "none", and — for Safari — readable). Lets callers
/// decide whether a no-cookies *retry* would even differ from the first attempt
/// before paying for it.
fn cookies_active(browser: Option<&str>) -> bool {
    !cookies_args(browser).is_empty()
}

/// Wall-clock ceiling for a single stream-URL / metadata resolve attempt.
const RESOLVE_TIMEOUT_SECS: u64 = 40;

/// Run a one-shot yt-dlp command with a hard wall-clock ceiling.
///
/// yt-dlp's own `--socket-timeout` bounds individual reads, but a wedged
/// extractor — or a site that serves a logged-in page our extractor can't
/// parse and then retries (LinkedIn does exactly this with auth cookies) — can
/// still run for minutes. This guarantees the call RETURNS so the caller can
/// retry without cookies or fall back to download, instead of the UI hanging
/// (the stream watchdog only arms *after* resolution returns). On timeout the
/// child is abandoned; the bounded `--socket-timeout` we pass keeps it
/// short-lived rather than a long-running orphan.
async fn output_timed(
    cmd: tauri_plugin_shell::process::Command,
    secs: u64,
) -> Result<tauri_plugin_shell::process::Output, String> {
    match tokio::time::timeout(std::time::Duration::from_secs(secs), cmd.output()).await {
        Ok(Ok(out)) => Ok(out),
        Ok(Err(e)) => Err(format!("yt-dlp failed: {e}")),
        Err(_) => Err(format!("timed out after {secs}s")),
    }
}

/// Resolve the `yt-dlp` to run. Prefers a user-updated copy in app-data
/// (`<app_data>/bin/yt-dlp`, installed via Settings → YouTube → Update yt-dlp);
/// falls back to the bundled sidecar. Either way PATH is set here so yt-dlp can
/// find ffmpeg for muxing — call sites must NOT set PATH again, or they'd clobber
/// the app-data dir that makes the updated binary resolvable by name.
///
/// The updated copy is run by NAME (`yt-dlp`, allowed in capabilities) with the
/// app-data bin dir first on PATH, so command resolution picks it deterministically.
pub(crate) fn ytdlp(app: &AppHandle) -> Result<tauri_plugin_shell::process::Command, String> {
    if let Ok(data) = app.path().app_data_dir() {
        let bin_dir = data.join("bin");
        if bin_dir.join("yt-dlp").is_file() {
            let path = format!("{}:{}", bin_dir.display(), HOMEBREW_PATH);
            return Ok(app.shell().command("yt-dlp").env("PATH", path));
        }
    }
    Ok(app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| format!("sidecar yt-dlp not found: {e}"))?
        .env("PATH", HOMEBREW_PATH))
}

/// Path to the user-updated yt-dlp binary in app-data (whether or not it exists).
fn updated_ytdlp_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("bin").join("yt-dlp"))
}

/// Reported back to the YouTube Settings tab: the resolved yt-dlp version string
/// and whether it's the user-updated copy (`true`) or the bundled sidecar.
#[derive(serde::Serialize, Clone)]
pub struct YtdlpStatus {
    pub version: String,
    pub updated: bool,
}

/// Report the version of the yt-dlp currently in use (updated copy if present,
/// else bundled).
#[tauri::command]
pub async fn ytdlp_version(app: AppHandle) -> Result<YtdlpStatus, crate::AppError> {
    let updated = updated_ytdlp_path(&app)
        .map(|p| p.is_file())
        .unwrap_or(false);
    let out = ytdlp(&app)
        .map_err(crate::AppError::internal)?
        .arg("--version")
        .output()
        .await
        .map_err(|e| crate::AppError::internal(format!("yt-dlp --version failed: {e}")))?;
    let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(YtdlpStatus { version, updated })
}

/// Download the latest official self-contained macOS yt-dlp into app-data and
/// make it the active binary. yt-dlp ships fixes for YouTube extractor changes
/// often, so this lets users refresh without reinstalling the app. Writes to a
/// temp path + atomically renames so a partial download never leaves a broken
/// binary. Returns the new version.
#[tauri::command]
pub async fn update_ytdlp(app: AppHandle) -> Result<YtdlpStatus, crate::AppError> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| crate::AppError::internal(format!("app_data_dir: {e}")))?;
    let bin_dir = data.join("bin");
    std::fs::create_dir_all(&bin_dir)
        .map_err(|e| crate::AppError::internal(format!("create bin dir: {e}")))?;
    let url = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos";
    let resp = reqwest::get(url)
        .await
        .map_err(|e| crate::AppError::internal(format!("download yt-dlp: {e}")))?
        .error_for_status()
        .map_err(|e| crate::AppError::internal(format!("download yt-dlp: {e}")))?;
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| crate::AppError::internal(format!("read yt-dlp: {e}")))?;
    let tmp = bin_dir.join("yt-dlp.download");
    std::fs::write(&tmp, &bytes)
        .map_err(|e| crate::AppError::internal(format!("write yt-dlp: {e}")))?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| crate::AppError::internal(format!("chmod yt-dlp: {e}")))?;
    std::fs::rename(&tmp, bin_dir.join("yt-dlp"))
        .map_err(|e| crate::AppError::internal(format!("install yt-dlp: {e}")))?;
    ytdlp_version(app).await
}

/// Remove the user-updated yt-dlp so the app falls back to the bundled sidecar.
#[tauri::command]
pub fn reset_ytdlp(app: AppHandle) -> Result<(), crate::AppError> {
    if let Some(p) = updated_ytdlp_path(&app) {
        let _ = std::fs::remove_file(p);
    }
    Ok(())
}

/// macOS app name for a browser id, for `open -a`.
fn browser_app_name(b: &str) -> Option<&'static str> {
    match b.to_ascii_lowercase().as_str() {
        "chrome" => Some("Google Chrome"),
        "safari" => Some("Safari"),
        "firefox" => Some("Firefox"),
        "brave" => Some("Brave Browser"),
        "edge" => Some("Microsoft Edge"),
        _ => None,
    }
}

/// Open YouTube's sign-in/account page in a specific browser (so the user logs
/// into the same browser Sauce Bunny borrows cookies from), or the default
/// browser when none is given. Uses macOS `open` via std::process, which is not
/// gated by the Tauri shell scope.
#[tauri::command]
pub fn open_youtube_signin(browser: Option<String>) -> Result<(), crate::AppError> {
    let url = "https://www.youtube.com/account";
    let mut cmd = std::process::Command::new("open");
    if let Some(app_name) = browser.as_deref().and_then(browser_app_name) {
        cmd.arg("-a").arg(app_name);
    }
    cmd.arg(url)
        .spawn()
        .map_err(|e| crate::AppError::internal(format!("open YouTube sign-in: {e}")))?;
    Ok(())
}

/// Open System Settings → Privacy & Security → Full Disk Access so the user can
/// grant Sauce Bunny the access Safari cookie reads require.
#[tauri::command]
pub fn open_full_disk_access() -> Result<(), crate::AppError> {
    std::process::Command::new("open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles")
        .spawn()
        .map_err(|e| crate::AppError::internal(format!("open Full Disk Access settings: {e}")))?;
    Ok(())
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
        // Generic login-gated sources (Reddit now requires it; others may too):
        // yt-dlp tells the user to pass cookies. Same remedy as YouTube — reuse
        // the signed-in browser's cookies — so treat it as an auth error.
        || l.contains("account authentication is required")
        || l.contains("--cookies-from-browser")
        || l.contains("use --cookies")
}

/// First `[Extractor]` tag yt-dlp prints (e.g. "Reddit", "youtube"). Used to
/// name the site in auth-error guidance. Returns None for the `generic`
/// fallback extractor or when absent.
fn ytdlp_extractor_tag(stderr: &str) -> Option<String> {
    let s = stderr.trim_start();
    let start = s.find('[')?;
    let rest = &s[start + 1..];
    let end = rest.find(']')?;
    let tag = rest[..end].trim();
    if tag.is_empty() || tag.eq_ignore_ascii_case("generic") {
        None
    } else {
        Some(tag.to_string())
    }
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
    // Login-gated, non-YouTube sources (Reddit requires this as of late 2025).
    // yt-dlp can't even read the metadata without the user's cookies.
    if trimmed.contains("Account authentication is required")
        || trimmed.contains("--cookies-from-browser")
        || (trimmed.contains("use --cookies") && !trimmed.contains("Sign in to confirm"))
    {
        let host = ytdlp_extractor_tag(trimmed).unwrap_or_else(|| "This site".to_string());
        return format!(
            "{host} requires you to be signed in to load this video. When the \
             sign-in panel appears, pick the browser you're already logged into \
             {host} on — Sauce Bunny reuses those cookies for every site."
        );
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

/// One `--dump-json` metadata probe for a given cookie setting, wall-clock
/// bounded. Returns the raw process output so the caller can branch on
/// success / retry-without-cookies.
async fn run_metadata_ytdlp(
    app: &AppHandle,
    url: &str,
    cookies_browser: Option<&str>,
) -> Result<tauri_plugin_shell::process::Output, String> {
    let cmd = ytdlp(app)?;
    let mut args: Vec<String> = vec![
        "--dump-json".into(),
        "--no-warnings".into(),
        "--no-playlist".into(),
        "--no-check-formats".into(),
        "--socket-timeout".into(), "10".into(),
        YT_EXTRACTOR_ARGS[0].into(),
        YT_EXTRACTOR_ARGS[1].into(),
    ];
    args.extend(cookies_args(cookies_browser));
    args.push(url.to_string());
    output_timed(cmd.args(args), RESOLVE_TIMEOUT_SECS).await
}

#[tauri::command]
pub async fn fetch_metadata(
    app: AppHandle,
    url: String,
    cookies_browser: Option<String>,
) -> Result<Metadata, crate::AppError> {
    validate_source_url(&url)?;

    // Cookies-first (YouTube bot-checks / private content), then retry WITHOUT
    // cookies if that failed and cookies were actually applied — some sites
    // (LinkedIn) serve a logged-in page yt-dlp can't parse, while the public
    // page resolves fine. Mirrors get_direct_stream_url so title/duration still
    // populate when the cookied probe is the one that fails.
    let cookied = cookies_active(cookies_browser.as_deref());
    let mut result = run_metadata_ytdlp(&app, &url, cookies_browser.as_deref()).await;
    if !matches!(&result, Ok(o) if o.status.success()) && cookied {
        eprintln!("[metadata] resolve with cookies failed; retrying without cookies");
        result = run_metadata_ytdlp(&app, &url, None).await;
    }
    let output = result.map_err(crate::AppError::internal)?;

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

/// True when a WebVTT/SRT caption body carries explicit speaker labels —
/// WebVTT voice tags like `<v Vick>` (or styled `<v.loud Vick>`). Creator-
/// uploaded YouTube/Vimeo captions use these; auto-generated ASR tracks
/// never do. yt-dlp downloads BOTH the manual and the automatic English
/// track and they land under different language suffixes, so a filename-
/// only rank can pick the speaker-less auto track. Reading the file and
/// preferring the one with voice tags is the only reliable way to keep the
/// "who's talking" data the user actually wants.
fn caption_has_speaker_tags(text: &str) -> bool {
    text.contains("<v ") || text.contains("<v.")
}

/// True when a caption body is YouTube's auto-generated (ASR) track rather than
/// a human-made/corrected one. The auto tracks carry inline word-timing tags
/// (`<c>` and `<00:00:07.200>`) and roll/scroll; manual creator captions don't.
/// Manual captions are much more accurate, so we prefer them when both exist.
fn caption_is_auto_generated(text: &str) -> bool {
    text.contains("<c>") || text.contains("</c>") || text.contains("<00:")
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

    let cmd = ytdlp(&app)?;

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
        // Keep WebVTT end-to-end (NOT srt). yt-dlp's --convert-subs srt
        // flattens WebVTT `<v Speaker>` voice tags — the exact data that
        // tells us who is talking (YouTube/Vimeo creator captions use them).
        // Preferring + converting to vtt preserves those tags so the
        // frontend parser (src/lib/srt.ts) can lift speakers straight out of
        // the source's own caption file, no diarization needed. parseSrt
        // reads vtt and srt identically, so nothing downstream breaks.
        "--sub-format".into(), "vtt/srt/best".into(),
        "--convert-subs".into(), "vtt".into(),
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
                    // Always scan the output dir for caption files, even on
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
                    // (has_speakers, is_auto, lang/format rank, path). Sort keys
                    // in priority order:
                    //   1. has_speakers — a creator track with `<v Name>` voice
                    //      tags carries the "who's talking" data we want.
                    //   2. NOT auto-generated — manual/creator captions are
                    //      human-corrected and far more accurate than YouTube's
                    //      ASR auto-captions (the rolling `<c>`-tagged tracks).
                    //   3. language/format tier.
                    let mut candidates: Vec<(bool, bool, u8, String)> = Vec::new();
                    if let Ok(entries) = std::fs::read_dir(&out_dir_for) {
                        for entry in entries.flatten() {
                            let p = entry.path();
                            let name = p
                                .file_name()
                                .and_then(|n| n.to_str())
                                .unwrap_or("")
                                .to_string();
                            if !name.starts_with(&safe_for)
                                || !(name.ends_with(".vtt") || name.ends_with(".srt"))
                            {
                                continue;
                            }
                            // Lower rank = preferred. Prefer .vtt over .srt at
                            // every language tier — vtt is what we now write and
                            // it's the format that still carries speaker voice
                            // tags (a stray .srt would have lost them).
                            let rank: u8 = if name.ends_with(".en-US.vtt")   { 0 }
                                      else if name.ends_with(".en.vtt")      { 1 }
                                      else if name.ends_with(".en-orig.vtt") { 2 }
                                      else if name.ends_with(".en-US.srt")   { 3 }
                                      else if name.ends_with(".en.srt")      { 4 }
                                      else if name.ends_with(".en-orig.srt") { 5 }
                                      else                                   { 6 };
                            // Caption files are tiny — read each once to sniff
                            // for speaker labels AND auto-vs-manual.
                            let body = std::fs::read_to_string(&p).unwrap_or_default();
                            let has_speakers = caption_has_speaker_tags(&body);
                            let is_auto = caption_is_auto_generated(&body);
                            candidates.push((has_speakers, is_auto, rank, p.to_string_lossy().to_string()));
                        }
                    }
                    // Speaker-bearing first, then manual over auto, then by the
                    // language/format preference (false sorts before true).
                    candidates.sort_by_key(|(has_spk, is_auto, rank, _)| (!*has_spk, *is_auto, *rank));
                    let found: Option<String> = candidates.into_iter().next().map(|(_, _, _, p)| p);

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
    /// DASH-split sources (Reddit, YouTube >360p, …) have no single muxed
    /// progressive URL. When that's the case we resolve the best H.264 video
    /// AND best AAC audio as separate URLs; the loopback proxy merges them on
    /// the fly into fragmented MP4 (`/fmp4/v1/<b64video>?audio=<b64audio>`) so
    /// the source STREAMS (with sound) instead of falling back to download.
    /// `None` ⇒ `url` is already muxed (the common path).
    pub audio_url: Option<String>,
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
    // Cookies-first (needed for YouTube bot-checks / private content). If that
    // fails AND cookies were actually applied, retry once WITHOUT them: some
    // sites (LinkedIn) serve a logged-in page variant yt-dlp can't parse
    // ("Unable to extract video"), while the public page resolves fine.
    // Genuinely gated content still errors → download fallback / sign-in modal.
    match resolve_stream_tiers(&app, &url, cookies_browser.as_deref()).await {
        Ok(r) => Ok(r),
        Err(e) => {
            if !cookies_active(cookies_browser.as_deref()) {
                return Err(e);
            }
            eprintln!("[stream] resolve with cookies failed; retrying without cookies");
            resolve_stream_tiers(&app, &url, None).await
        }
    }
}

/// Resolve a playable stream URL through the muxed → DASH-split → HLS tiers for
/// one cookie setting. Each yt-dlp call is wall-clock-bounded (`output_timed`)
/// so a wedged extractor can't hang the resolve.
async fn resolve_stream_tiers(
    app: &AppHandle,
    url: &str,
    cookies_browser: Option<&str>,
) -> Result<DirectStreamResult, crate::AppError> {
    let yt = ytdlp(app)?;

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
        "--socket-timeout".into(), "20".into(),
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
    args.extend(cookies_args(cookies_browser));
    args.push(url.to_string());

    // A timeout/spawn failure here is systemic (wedged or slow extractor — often
    // the logged-in-page case), so propagate it: the caller retries WITHOUT
    // cookies rather than burning two more equally-slow tier calls.
    let out = output_timed(yt.args(args), RESOLVE_TIMEOUT_SECS)
        .await
        .map_err(crate::AppError::internal)?;
    if out.status.success() {
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        let mut lines = stdout.lines().filter(|l| !l.trim().is_empty());
        if let Some(direct) = lines.next() {
            let (w, h, vcodec) = if let Some(meta) = lines.next() {
                let parts: Vec<&str> = meta.split('\t').collect();
                let w  = parts.first().and_then(|s| s.parse::<u32>().ok());
                let h  = parts.get(1).and_then(|s| s.parse::<u32>().ok());
                let vc = parts.get(2).filter(|s| !s.is_empty() && **s != "NA").map(|s| s.to_string());
                (w, h, vc)
            } else { (None, None, None) };
            return Ok(DirectStreamResult { url: direct.to_string(), audio_url: None, width: w, height: h, vcodec });
        }
    }
    // No single muxed progressive (a DASH-split source — Reddit, YouTube >360p,
    // etc.). Resolve best H.264 video + best AAC audio as SEPARATE URLs so the
    // proxy can merge them on the fly and the source still STREAMS.
    let muxed_stderr = String::from_utf8_lossy(&out.stderr).to_string();
    if let Some(split) = resolve_split_stream(app, url, cookies_browser).await {
        return Ok(split);
    }
    // Tier 3: HLS-only sources (some Twitter/X). The best format is an m3u8;
    // the proxy's ffmpeg reads the HLS server-side and remuxes it to fMP4
    // (with aac_adtstoasc for the TS→MP4 audio). Single input — no `?audio=`.
    if let Some(hls) = resolve_hls_stream(app, url, cookies_browser).await {
        return Ok(hls);
    }
    Err(humanize_ytdlp_error(&muxed_stderr).into())
}

/// DASH-split resolve: best H.264 video + best AAC audio as two separate URLs
/// (for the proxy's 2-input fMP4 remux). H.264+AAC so WKWebView can decode the
/// remuxed output. Returns None when the source has no such split (the caller
/// then surfaces the original muxed error).
async fn resolve_split_stream(
    app: &AppHandle,
    url: &str,
    cookies_browser: Option<&str>,
) -> Option<DirectStreamResult> {
    let yt = ytdlp(app).ok()?;
    let mut args: Vec<String> = vec![
        "--no-playlist".into(),
        "--no-warnings".into(),
        "--socket-timeout".into(), "20".into(),
        "-f".into(),
        "bv*[vcodec^=avc1][protocol^=http][protocol!*=m3u8]+ba[acodec^=mp4a][protocol^=http][protocol!*=m3u8]/\
         bv*[vcodec^=avc1]+ba[ext=m4a]/\
         bv*+ba".into(),
        YT_EXTRACTOR_ARGS[0].into(),
        YT_EXTRACTOR_ARGS[1].into(),
        // requested_formats.0 = video, .1 = audio for a merged (v+a) selection.
        "--print".into(),
        "%(requested_formats.0.url)s\t%(requested_formats.1.url)s\t%(width)s\t%(height)s\t%(vcodec)s".into(),
    ];
    args.extend(cookies_args(cookies_browser));
    args.push(url.to_string());

    let out = output_timed(yt.args(args), RESOLVE_TIMEOUT_SECS).await.ok()?;
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let line = stdout.lines().find(|l| !l.trim().is_empty())?;
    let parts: Vec<&str> = line.split('\t').collect();
    let video = parts.first().copied().filter(|s| s.starts_with("http"))?;
    let audio = parts.get(1).copied().filter(|s| s.starts_with("http"))?;
    let w  = parts.get(2).and_then(|s| s.parse::<u32>().ok());
    let h  = parts.get(3).and_then(|s| s.parse::<u32>().ok());
    let vc = parts.get(4).filter(|s| !s.is_empty() && **s != "NA").map(|s| s.to_string());
    Some(DirectStreamResult {
        url: video.to_string(),
        audio_url: Some(audio.to_string()),
        width: w,
        height: h,
        vcodec: vc,
    })
}

/// HLS-only resolve: the best SINGLE format allowing m3u8 (some Twitter/X
/// videos are HLS-only). Returns one URL — the proxy's ffmpeg reads the HLS
/// playlist server-side and remuxes to fMP4. Last resort before the download
/// fallback. Returns None if nothing resolves.
async fn resolve_hls_stream(
    app: &AppHandle,
    url: &str,
    cookies_browser: Option<&str>,
) -> Option<DirectStreamResult> {
    let yt = ytdlp(app).ok()?;
    let mut args: Vec<String> = vec![
        "--no-playlist".into(),
        "--no-warnings".into(),
        "--socket-timeout".into(), "20".into(),
        // Best muxed format, ANY protocol (this is the tier that finally allows
        // HLS); fall back to the overall best single format.
        "-f".into(),
        "b[acodec!=none][vcodec!=none]/b".into(),
        YT_EXTRACTOR_ARGS[0].into(),
        YT_EXTRACTOR_ARGS[1].into(),
        "--print".into(),
        "%(url)s\t%(width)s\t%(height)s\t%(vcodec)s".into(),
    ];
    args.extend(cookies_args(cookies_browser));
    args.push(url.to_string());

    let out = output_timed(yt.args(args), RESOLVE_TIMEOUT_SECS).await.ok()?;
    if !out.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let line = stdout.lines().find(|l| !l.trim().is_empty())?;
    let parts: Vec<&str> = line.split('\t').collect();
    let url_out = parts.first().copied().filter(|s| s.starts_with("http"))?;
    let w = parts.get(1).and_then(|s| s.parse::<u32>().ok());
    let h = parts.get(2).and_then(|s| s.parse::<u32>().ok());
    let vc = parts.get(3).filter(|s| !s.is_empty() && **s != "NA").map(|s| s.to_string());
    Some(DirectStreamResult {
        url: url_out.to_string(),
        audio_url: None,
        width: w,
        height: h,
        vcodec: vc,
    })
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

    let cmd = ytdlp(&app)?;
    // Bundled ffmpeg for the DASH merge below — without it yt-dlp falls back to
    // PATH/Homebrew, absent on a distributed app (DISTRIBUTION.md).
    let ffmpeg_str = sidecar_path("ffmpeg")?
        .to_str()
        .ok_or_else(|| crate::AppError::internal("ffmpeg path not utf-8"))?
        .to_string();

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
        "--ffmpeg-location".into(), ffmpeg_str,
        "--merge-output-format".into(), "mp4".into(),
        "-o".into(), template.clone(),
    ];
    yt_args.extend(cookies_args(args.cookies_browser.as_deref()));
    yt_args.push(args.url.clone());

    let (mut rx, child) = cmd
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
                                // Host-neutral: this path serves ALL web sources,
                                // and Reddit/others now also gate on login cookies.
                                "This site requires you to be signed in. When the sign-in panel \
                                 appears, pick the browser you're already logged into it on — \
                                 Sauce Bunny reuses those cookies for every site.".into()
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

// ────────────────────────────────────────────────────────────────────────
// AUDIO-MASTER TRACK  (streaming caption sync)
//
// Downloads ONLY the full-fidelity audio track (no video) to cache and returns
// its path. The frontend decodes it with Web Audio `decodeAudioData` and plays
// it on a sample-accurate AudioContext clock — so captions lock to the audio
// you actually hear, instead of the MSE <video> timeline that drifts. The
// streamed <video> is kept muted for picture only. See src/lib/audio-twin.ts.
//
// Audio-only is small and fast (a fraction of the video), so the brief wait is
// negligible. Registered in the JobRegistry so a new source / STOP can cancel.
// ────────────────────────────────────────────────────────────────────────

/// Stable cache PREFIX for a source's full audio track, keyed by a
/// deterministic hash of the URL. The audio-master playback clock AND the
/// Whisper pipeline both resolve a source's audio through this prefix, so the
/// file is downloaded ONCE and reused: re-opening a source, or transcribing
/// after streaming, is instant — and Whisper transcribes the exact track the
/// captions are clocked against, so they're aligned by construction.
///
/// FNV-1a (deterministic across process runs; std `DefaultHasher` is seeded
/// randomly per-process, so its output couldn't be reused across launches).
pub(crate) fn source_audio_hash(url: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in url.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01B3);
    }
    format!("{h:016x}")
}

/// The COMPLETE-file prefix. A file under this prefix is fully downloaded and
/// safe to reuse (the in-flight download lands under a different temp prefix,
/// then atomically renames here on success — so Whisper never reads a partial).
pub(crate) fn source_audio_prefix(url: &str) -> String {
    format!("saucebunny-audio-{}", source_audio_hash(url))
}

#[derive(Deserialize)]
pub struct AudioTrackArgs {
    pub url: String,
    pub job_id: String,
    pub cookies_browser: Option<String>,
}

#[tauri::command]
pub async fn download_audio_track(
    app: AppHandle,
    args: AudioTrackArgs,
) -> Result<String, crate::AppError> {
    validate_source_url(&args.url)?;

    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("app_cache_dir: {e}"))?;
    std::fs::create_dir_all(&cache).map_err(|e| format!("mkdir cache: {e}"))?;

    // Persistent, source-keyed cache (shared with the Whisper pipeline).
    let final_prefix = source_audio_prefix(&args.url); // saucebunny-audio-<hash>
    // Already fully cached (non-empty) → reuse instantly, no re-download.
    if let Some(existing) = find_audio_in_cache(&cache, &final_prefix) {
        if existing.metadata().map(|m| m.len() > 0).unwrap_or(false) {
            if let Some(s) = existing.to_str() {
                return Ok(s.to_string());
            }
        }
    }
    // Download under a JOB-scoped temp prefix — distinct from the final name
    // (so an in-flight partial is never matched by find_audio_in_cache on the
    // final prefix) AND distinct from any concurrent call (so two downloads
    // can't write the same temp). Rename to the final name only on a clean
    // exit, making the cache hit atomic.
    let dl_prefix = format!("saucebunny-audiodl-{}", args.job_id);
    let template = cache
        .join(format!("{}.%(ext)s", dl_prefix))
        .to_string_lossy()
        .to_string();

    let cmd = ytdlp(&app)?;
    // Bundled ffmpeg for any DASH audio merge — never PATH/Homebrew (DISTRIBUTION.md).
    let ffmpeg_str = sidecar_path("ffmpeg")?
        .to_str()
        .ok_or_else(|| crate::AppError::internal("ffmpeg path not utf-8"))?
        .to_string();

    // Prefer progressive m4a/AAC: WKWebView's decodeAudioData decodes AAC
    // reliably, whereas opus/webm is far less certain. Fall back through any
    // bestaudio so non-YouTube hosts still resolve.
    let mut yt_args: Vec<String> = vec![
        "-f".into(),
        "ba[ext=m4a][protocol^=http][protocol!*=m3u8]/\
         ba[acodec^=mp4a]/bestaudio[ext=m4a]/bestaudio/best".into(),
        "--no-playlist".into(),
        "--no-part".into(),
        "--newline".into(),
        YT_EXTRACTOR_ARGS[0].into(),
        YT_EXTRACTOR_ARGS[1].into(),
        "--concurrent-fragments".into(), "16".into(),
        "--ffmpeg-location".into(), ffmpeg_str,
        "-o".into(), template.clone(),
    ];
    yt_args.extend(cookies_args(args.cookies_browser.as_deref()));
    yt_args.push(args.url.clone());

    let (mut rx, child) = cmd
        .args(yt_args)
        .spawn()
        .map_err(|e| format!("failed to spawn yt-dlp: {e}"))?;
    app.state::<JobRegistry>().insert(args.job_id.clone(), child);

    let mut saw_auth_error = false;
    let mut code: Option<i32> = None;
    let mut signalled = false;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(b) | CommandEvent::Stderr(b) => {
                let raw = String::from_utf8_lossy(&b);
                for line in raw.lines() {
                    if is_youtube_auth_error_line(line) { saw_auth_error = true; }
                }
            }
            CommandEvent::Terminated(payload) => {
                code = payload.code;
                signalled = payload.signal.is_some();
                break;
            }
            _ => {}
        }
    }
    let _ = app.state::<JobRegistry>().take(&args.job_id);

    if code != Some(0) {
        if signalled {
            return Err(crate::AppError::internal("Cancelled"));
        }
        if saw_auth_error {
            return Err(crate::AppError::internal(YT_AUTH_HINT));
        }
        return Err(crate::AppError::internal(format!(
            "audio download failed (yt-dlp exit {code:?})"
        )));
    }

    // Find the temp file yt-dlp wrote, then atomically rename it to the final
    // source-keyed name so the cache hit is all-or-nothing.
    let dl_file = find_audio_in_cache(&cache, &dl_prefix).ok_or_else(|| {
        crate::AppError::internal("yt-dlp exited cleanly but no audio file was found in cache")
    })?;
    let ext = dl_file
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("m4a");
    let final_path = cache.join(format!("{final_prefix}.{ext}"));
    std::fs::rename(&dl_file, &final_path).map_err(|e| format!("cache rename: {e}"))?;
    final_path
        .to_str()
        .map(String::from)
        .ok_or_else(|| crate::AppError::internal("cached audio path not utf-8"))
}

