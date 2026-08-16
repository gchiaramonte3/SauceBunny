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
            // Same degrade for a browser that has no cookie database at all
            // (not installed, or never run). Passing the flag anyway makes
            // yt-dlp hard-error — "could not find firefox cookies database" —
            // and that error repeats on every resolve and every transcribe,
            // which reads as the app being broken rather than a setting being
            // stale. No cookies beats no anything.
            if !b.eq_ignore_ascii_case("safari") && !cookie_db_present(b) {
                eprintln!("[cookies] {b} has no cookie database on this Mac — proceeding without cookies");
                return vec![];
            }
            vec!["--cookies-from-browser".into(), b.into()]
        }
        _ => vec![],
    }
}

/// Does this browser have a cookie database where yt-dlp will look for one?
///
/// Mirrors yt-dlp's own search paths on macOS. A missing database means the
/// browser is not installed or has never run, and passing
/// `--cookies-from-browser` for it is a guaranteed hard error.
pub(crate) fn cookie_db_present(browser: &str) -> bool {
    let home = std::env::var("HOME").unwrap_or_default();
    let app_support = format!("{home}/Library/Application Support");
    let chromium_like = |dir: &str| -> bool {
        // Default profile or any numbered profile; both hold a `Cookies` file.
        let base = format!("{app_support}/{dir}");
        let Ok(entries) = std::fs::read_dir(&base) else { return false };
        entries.flatten().any(|e| e.path().join("Cookies").is_file())
    };
    match browser.to_ascii_lowercase().as_str() {
        "chrome" => chromium_like("Google/Chrome"),
        "brave" => chromium_like("BraveSoftware/Brave-Browser"),
        "edge" => chromium_like("Microsoft Edge"),
        "firefox" => {
            let profiles = format!("{app_support}/Firefox/Profiles");
            let Ok(entries) = std::fs::read_dir(&profiles) else { return false };
            entries.flatten().any(|e| e.path().join("cookies.sqlite").is_file())
        }
        "safari" => safari_cookies_readable(),
        _ => false,
    }
}

/// Frontend probe: would picking this browser actually send cookies? Drives
/// the Settings note the moment a browser with no database is selected, so the
/// user learns at the click rather than from a failed fetch later.
#[tauri::command]
pub fn cookie_browser_ready(browser: String) -> bool {
    if browser == "none" || browser.is_empty() { return true; }
    cookie_db_present(&browser)
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

/// Frontend-visible Full Disk Access probe (r123): can the app actually read
/// Safari's cookie store? Drives the "one more step" guidance the moment a
/// user picks Safari sign-in - without it, cookies_args silently degrades to
/// no-auth and the user believes they're signed in when they aren't.
#[tauri::command]
pub fn safari_fda_status() -> bool {
    safari_cookies_readable()
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
) -> Result<tauri_plugin_shell::process::Output, crate::AppError> {
    match tokio::time::timeout(std::time::Duration::from_secs(secs), cmd.output()).await {
        Ok(Ok(out)) => Ok(out),
        Ok(Err(e)) => Err(crate::AppError::internal(format!("yt-dlp failed: {e}"))),
        Err(_) => Err(crate::AppError::internal(format!("timed out after {secs}s"))),
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
///
/// PATH order is ours → the OS → Homebrew, composed by `compose_spawn_path`;
/// see `HOMEBREW_PATH` for why last place matters. The practical effect is that
/// the bundled ffmpeg and ffprobe now resolve by NAME, so a spawn site that
/// forgets `--ffmpeg-location` gets our libzimg build instead of whatever the
/// user happens to have installed. The explicit flags stay where they are —
/// belt and braces, and they also survive a debug build where the repo's
/// binaries are triple-suffixed and unfindable by name.
pub(crate) fn ytdlp(
    app: &AppHandle,
) -> Result<tauri_plugin_shell::process::Command, crate::AppError> {
    let sidecars = super::sidecar_dir();
    if let Ok(data) = app.path().app_data_dir() {
        let bin_dir = data.join("bin");
        if bin_dir.join("yt-dlp").is_file() {
            // 10a: make WHICH copy runs inspectable - every call site (resolve,
            // metadata, captions, downloads) funnels through here.
            eprintln!("[yt-dlp] using {} copy: {}", resolved_ytdlp_kind(true), bin_dir.join("yt-dlp").display());
            let path = super::compose_spawn_path(Some(&bin_dir), sidecars.as_deref());
            // --no-update: self-updating is the app's job (update_ytdlp), and
            // without it every spawn of an >90-day binary dumps a 4-line
            // "run yt-dlp -U" lecture into the pipeline log that users can't
            // act on (the bundled copy isn't theirs to -U).
            return Ok(app.shell().command("yt-dlp").arg("--no-update").env("PATH", path));
        }
    }
    eprintln!("[yt-dlp] using {} copy (sidecar)", resolved_ytdlp_kind(false));
    Ok(app
        .shell()
        .sidecar("yt-dlp")
        // `invalid` (bare Display), not SidecarMissing: several callers embed
        // this in their own "yt-dlp sidecar not found: {e}" strings and the
        // established message text must survive the r108 AppError sweep.
        .map_err(|e| crate::AppError::invalid(format!("sidecar yt-dlp not found: {e}")))?
        .arg("--no-update")
        .env("PATH", super::compose_spawn_path(None, sidecars.as_deref())))
}

/// Pure (unit-tested): the resolution order in one word - an existing
/// user-updated copy ALWAYS wins over the bundled sidecar.
pub(crate) fn resolved_ytdlp_kind(updated_exists: bool) -> &'static str {
    if updated_exists { "updated" } else { "bundled" }
}

/// Pure (unit-tested): yt-dlp versions are date-shaped (YYYY.MM.DD, dev
/// builds append segments). Anything else means the downloaded file is NOT
/// a working yt-dlp - the guard that keeps a bad download from replacing a
/// good binary.
pub(crate) fn parse_ytdlp_version(output: &str) -> Option<String> {
    let v = output.trim();
    let b = v.as_bytes();
    if b.len() < 10 {
        return None;
    }
    let date_ok = b[..10]
        .iter()
        .enumerate()
        .all(|(i, c)| if i == 4 || i == 7 { *c == b'.' } else { c.is_ascii_digit() });
    if !date_ok || v.lines().count() != 1 {
        return None;
    }
    Some(v.to_string())
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
#[derive(serde::Serialize, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
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
    let out = ytdlp(&app)?
        .arg("--version")
        .output()
        .await
        .map_err(|e| crate::AppError::internal(format!("yt-dlp --version failed: {e}")))?;
    let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok(YtdlpStatus { version, updated })
}

/// Hard cap on the updater download — the real binary is ~35 MB.
const MAX_YTDLP_BYTES: u64 = 200 * 1024 * 1024;

/// Download the latest official self-contained macOS yt-dlp into app-data and
/// make it the active binary. yt-dlp ships fixes for YouTube extractor changes
/// often, so this lets users refresh without reinstalling the app.
///
/// Integrity (r140): the old flow fetched the MUTABLE `latest` asset URL and
/// ran `--version` on whatever arrived — proof it executes, not that it's
/// authentic. Now the release TAG is resolved once via the GitHub API, and
/// both the binary and its `SHA2-256SUMS` manifest come from that same
/// immutable tagged release; the checksum must match BEFORE the file is made
/// executable, the download is size-capped, and only then does the
/// `--version` probe run. Writes to a temp path + atomically renames.
#[tauri::command]
pub async fn update_ytdlp(app: AppHandle) -> Result<YtdlpStatus, crate::AppError> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| crate::AppError::internal(format!("app_data_dir: {e}")))?;
    let bin_dir = data.join("bin");
    std::fs::create_dir_all(&bin_dir)
        .map_err(|e| crate::AppError::internal(format!("create bin dir: {e}")))?;
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| crate::AppError::internal(format!("http client: {e}")))?;

    // 1. Resolve the release tag (the one read of a mutable pointer).
    #[derive(serde::Deserialize)]
    struct Release {
        tag_name: String,
    }
    let rel: Release = client
        .get("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest")
        .header("user-agent", "sauce-bunny-updater")
        .header("accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| crate::AppError::internal(format!("resolve release: {e}")))?
        .error_for_status()
        .map_err(|e| crate::AppError::internal(format!("resolve release: {e}")))?
        .json()
        .await
        .map_err(|e| crate::AppError::internal(format!("resolve release: {e}")))?;
    let tag = rel.tag_name;
    if tag.is_empty()
        || tag.len() > 40
        || !tag.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return Err(crate::AppError::internal(format!("suspicious release tag: {tag:?}")));
    }

    // 2. The checksum manifest from the SAME immutable release.
    let sums = client
        .get(format!("https://github.com/yt-dlp/yt-dlp/releases/download/{tag}/SHA2-256SUMS"))
        .header("user-agent", "sauce-bunny-updater")
        .send()
        .await
        .map_err(|e| crate::AppError::internal(format!("fetch checksums: {e}")))?
        .error_for_status()
        .map_err(|e| crate::AppError::internal(format!("fetch checksums: {e}")))?
        .text()
        .await
        .map_err(|e| crate::AppError::internal(format!("read checksums: {e}")))?;
    let expected = sums
        .lines()
        .find_map(|line| {
            let mut parts = line.split_whitespace();
            let hash = parts.next()?;
            let name = parts.next()?;
            (name == "yt-dlp_macos" && hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()))
                .then(|| hash.to_ascii_lowercase())
        })
        .ok_or_else(|| crate::AppError::internal(format!("release {tag} has no yt-dlp_macos checksum")))?;

    // 3. The binary, size-capped while streaming.
    let mut resp = client
        .get(format!("https://github.com/yt-dlp/yt-dlp/releases/download/{tag}/yt-dlp_macos"))
        .header("user-agent", "sauce-bunny-updater")
        .send()
        .await
        .map_err(|e| crate::AppError::internal(format!("download yt-dlp: {e}")))?
        .error_for_status()
        .map_err(|e| crate::AppError::internal(format!("download yt-dlp: {e}")))?;
    if resp.content_length().is_some_and(|l| l > MAX_YTDLP_BYTES) {
        return Err(crate::AppError::internal("yt-dlp download is implausibly large"));
    }
    let mut bytes: Vec<u8> = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| crate::AppError::internal(format!("read yt-dlp: {e}")))?
    {
        if bytes.len() as u64 + chunk.len() as u64 > MAX_YTDLP_BYTES {
            return Err(crate::AppError::internal("yt-dlp download is implausibly large"));
        }
        bytes.extend_from_slice(&chunk);
    }

    // 4. Verify BEFORE anything is made executable.
    use sha2::{Digest, Sha256};
    let got = Sha256::digest(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    if got != expected {
        return Err(crate::AppError::internal(format!(
            "yt-dlp {tag} failed checksum verification (got {got}, expected {expected}); keeping the previous copy"
        )));
    }

    let tmp = bin_dir.join("yt-dlp.download");
    std::fs::write(&tmp, &bytes)
        .map_err(|e| crate::AppError::internal(format!("write yt-dlp: {e}")))?;
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| crate::AppError::internal(format!("chmod yt-dlp: {e}")))?;
    // 10a guard rail: verify the download actually RUNS and reports a
    // date-shaped version before it replaces the working copy. A failed
    // verification keeps the previous binary and fails loud.
    let probe = tokio::process::Command::new(&tmp)
        .arg("--version")
        .output()
        .await
        .map_err(|e| {
            let _ = std::fs::remove_file(&tmp);
            crate::AppError::internal(format!("downloaded yt-dlp would not run: {e}"))
        })?;
    let version_out = String::from_utf8_lossy(&probe.stdout).to_string();
    if !probe.status.success() || parse_ytdlp_version(&version_out).is_none() {
        let _ = std::fs::remove_file(&tmp);
        return Err(crate::AppError::internal(format!(
            "downloaded yt-dlp failed verification (output: {:?}); keeping the previous copy",
            version_out.trim()
        )));
    }
    std::fs::rename(&tmp, bin_dir.join("yt-dlp"))
        .map_err(|e| crate::AppError::internal(format!("install yt-dlp: {e}")))?;
    // No cached resolved path exists to clear - ytdlp() re-resolves on every
    // spawn (same reason Reset needs no invalidation beyond removing the file).
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
    Check the yt-dlp line just above: if it says \"(no cookies)\", open Settings → YouTube auth \
    and pick the browser you're already logged into YouTube on. If it names a browser, the \
    cookies were sent but YouTube rejected them - sign in again in that browser, then retry.";

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
        // The const, not a second copy of the prose. The comment on YT_AUTH_HINT
        // claimed these were "kept identical" while they were two literals that
        // had to be edited in lockstep - which is how they drift.
        return YT_AUTH_HINT.into();
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

// Deserialize + Clone (r112): the warm-boot cache persists the parsed
// Metadata to disk (media/meta/<urlhash>.json) and reads it back on re-open,
// so the struct must round-trip through serde, not just serialize out.
#[derive(Serialize, Deserialize, Clone, ts_rs::TS)]
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
    /// The creator's OWN chapters, when the site publishes them.
    ///
    /// This app used to infer chapters from the transcript with a local LLM -
    /// slow, and a guess - while yt-dlp had the real ones sitting in the same
    /// `--dump-json` probe we already run. Real beats inferred on both speed
    /// and accuracy; the LLM stays as the fallback for sources that publish
    /// none.
    pub chapters: Vec<SourceChapter>,
    /// The video description. Free context for the AI summary: creators put
    /// guest names, timestamps and links here, and none of it was reaching us.
    /// Capped, because a description can be pathologically long and it rides
    /// in a struct that gets cached to disk and passed across the IPC boundary.
    pub description: Option<String>,
}

/// One chapter as the site published it.
#[derive(Serialize, Deserialize, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct SourceChapter {
    /// Start time in seconds. Named to match the frontend's `Chapter.time`.
    pub time: f64,
    pub title: String,
}

/// One `--dump-json` metadata probe for a given cookie setting, wall-clock
/// bounded. Returns the raw process output so the caller can branch on
/// success / retry-without-cookies.
async fn run_metadata_ytdlp(
    app: &AppHandle,
    url: &str,
    cookies_browser: Option<&str>,
) -> Result<tauri_plugin_shell::process::Output, crate::AppError> {
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

/// A description longer than this is a link farm, not context. Chars, not
/// bytes, so a multi-byte script is not silently cut mid-character.
const MAX_DESCRIPTION_CHARS: usize = 8_000;

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max { return s.to_string(); }
    s.chars().take(max).collect()
}

/// The creator's own chapters, in order, skipping anything malformed.
///
/// yt-dlp emits `chapters: [{start_time, end_time, title}]`. A chapter with no
/// title or a non-finite start is dropped rather than repaired: a marker in
/// the wrong place on the timeline is worse than one marker fewer, and the
/// LLM fallback is right there for a source whose data is unusable.
fn parse_chapters(v: &serde_json::Value) -> Vec<SourceChapter> {
    let Some(arr) = v["chapters"].as_array() else { return Vec::new() };
    let mut out: Vec<SourceChapter> = arr
        .iter()
        .filter_map(|c| {
            let time = c["start_time"].as_f64().filter(|t| t.is_finite() && *t >= 0.0)?;
            let title = c["title"].as_str().map(str::trim).filter(|t| !t.is_empty())?;
            Some(SourceChapter { time, title: title.to_string() })
        })
        .collect();
    // Sites are not required to emit these in order, and the timeline draws
    // them in the order it receives them.
    out.sort_by(|a, b| a.time.partial_cmp(&b.time).unwrap_or(std::cmp::Ordering::Equal));
    out
}

/// Choose a poster URL out of yt-dlp's metadata.
///
/// The singular `thumbnail` field is a CONVENIENCE that many extractors never
/// populate - it was the only field read here, which is why a Reddit post came
/// back with an empty poster box while yt-dlp had perfectly good images all
/// along. The canonical field is `thumbnails[]`, an array each extractor fills
/// with every image it found.
///
/// Selection: the extractor's own `preference` first, because it knows which
/// of its images is the real poster and which is an avatar or a sprite sheet.
/// Then the largest image that is not absurd for a card - a 4K still is a slow
/// fetch to render at 300px - falling back to the smallest when everything on
/// offer is huge.
fn pick_thumbnail(v: &serde_json::Value) -> Option<String> {
    if let Some(t) = v["thumbnail"].as_str().filter(|t| is_http_url(t)) {
        return Some(t.to_string());
    }
    let arr = v["thumbnails"].as_array()?;
    let mut best: Option<(i64, i64, String)> = None;
    for t in arr {
        // Reddit and friends put tokens like "default", "self", "nsfw" and
        // "spoiler" where a URL belongs, so requiring http(s) is what filters
        // those out - not a list of magic words that would go stale.
        let Some(url) = t["url"].as_str().filter(|u| is_http_url(u)) else { continue };
        let pref = t["preference"].as_i64().unwrap_or(0);
        let w = t["width"].as_i64().unwrap_or(0);
        let h = t["height"].as_i64().unwrap_or(0);
        // Unknown dimensions sort as mid-sized AND as sane. An entry with no
        // width is usually the extractor's primary image; treating it as
        // zero-area, or as oversized, both reliably pick the worst option.
        let known = w > 0 && h > 0;
        let area = if known { w * h } else { 640 * 360 };
        // Oversized images sort BELOW every reasonable one but still above
        // nothing, so a source offering only a 4K still gets a poster.
        let score = if known && w > 1920 { -area } else { area };
        let cand = (pref, score, url.to_string());
        // `map_or(true, …)`, not `is_none_or`: the latter is stable since
        // 1.82 and this crate declares rust-version 1.77.2, so clippy's
        // incompatible_msrv fires and CI runs it with -D warnings. Raising the
        // declared MSRV would also silence it, but that is a policy change
        // about who can build this, not a cleanup.
        #[allow(clippy::unnecessary_map_or)]
        if best.as_ref().map_or(true, |b| (b.0, b.1) < (cand.0, cand.1)) {
            best = Some(cand);
        }
    }
    best.map(|(_, _, url)| url)
}

/// A real fetchable image, not a placeholder token.
fn is_http_url(s: &str) -> bool {
    let t = s.trim();
    t.starts_with("http://") || t.starts_with("https://")
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
    let output = result?;

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
                } else if h_val == cur {
                    // Same height, higher fps (1080p60 after 1080p30): the
                    // fps is the interesting part of the tie.
                    match (fr, max_fps) {
                        (Some(f_new), Some(f_cur)) if f_new > f_cur => max_fps = Some(f_new),
                        (Some(_), None) => max_fps = fr,
                        _ => {}
                    }
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

    let m = Metadata {
        title: v["title"].as_str().unwrap_or("Untitled").to_string(),
        duration: v["duration"].as_f64(),
        thumbnail: pick_thumbnail(&v),
        chapters: parse_chapters(&v),
        description: v["description"]
            .as_str()
            .map(|d| d.trim())
            .filter(|d| !d.is_empty())
            .map(|d| truncate_chars(d, MAX_DESCRIPTION_CHARS)),
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
    };
    // Warm-boot cache (r112): remember the parsed metadata so re-opening this
    // source hydrates the UI instantly instead of re-paying the ~1-3s probe.
    // Best-effort — a cache write failure must never fail the fetch.
    persist_metadata_cache(&app, &url, &m);
    Ok(m)
}

#[derive(Deserialize)]
pub struct CaptionsArgs {
    pub url: String,
    pub output_dir: String,
    pub filename: String,
    pub job_id: String,
    pub cookies_browser: Option<String>,
    /// Preferred caption locale, e.g. "pt-BR" (r108). When present we request
    /// that track plus its base form ("pt-BR,pt"); when absent/invalid we keep
    /// the battle-tested English defaults. See `caption_lang_prefs`.
    #[serde(default)]
    pub locale: Option<String>,
}

/// Resolve the subtitle-language preferences for a caption download (r108).
///
/// Returns `(sub_langs_arg, rank_order)`:
///   - `sub_langs_arg` feeds yt-dlp's `--sub-langs` (finite, explicit list —
///     see the comment at the call site for why globs are banned).
///   - `rank_order` feeds `scan_best`'s preference ladder (first = best).
///
/// No locale (or a malformed one) → the historical English defaults:
/// download "en-US,en-orig,en", rank en-US > en > en-orig (note the two
/// orders differ deliberately — that is the pre-r108 behavior, preserved).
/// A locale like "pt-BR" → download + rank "pt-BR" then its base "pt".
fn caption_lang_prefs(locale: Option<&str>) -> (String, Vec<String>) {
    let english = || {
        (
            "en-US,en-orig,en".to_string(),
            vec!["en-US".to_string(), "en".to_string(), "en-orig".to_string()],
        )
    };
    let loc = locale.unwrap_or("").trim();
    // BCP-47-ish sanity: letters/digits/hyphens only, bounded length. Anything
    // else (empty, path-y garbage) falls back to the English defaults.
    let valid = !loc.is_empty()
        && loc.len() <= 16
        && loc.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if !valid {
        return english();
    }
    let base = loc.split('-').next().unwrap_or("");
    if base.eq_ignore_ascii_case("en") {
        // English requested explicitly — the defaults already cover every
        // English variant YouTube serves (incl. en-US/en-orig).
        return english();
    }
    let mut langs = vec![loc.to_string()];
    if !base.is_empty() && !base.eq_ignore_ascii_case(loc) {
        langs.push(base.to_string());
    }
    (langs.join(","), langs)
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
    let caption_ffmpeg_str = sidecar_path("ffmpeg")?
        .to_str()
        .ok_or_else(|| crate::AppError::internal("ffmpeg path not utf-8"))?
        .to_string();
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

    // Requested-locale (plus base form) or the English defaults — one list
    // drives yt-dlp's download, the other scan_best's preference ladder.
    let (sub_langs, rank_langs) = caption_lang_prefs(args.locale.as_deref());

    let caption_args: Vec<String> = vec![
        "--write-subs".into(),
        "--write-auto-subs".into(),
        // Explicit, finite list of language codes. The earlier glob
        // `en.*` matched YouTube's `en-en-US` auto-translation track,
        // which 429s reliably and made yt-dlp exit nonzero even though
        // the real English tracks (en, en-US, en-orig) had already
        // written cleanly to disk. The explicit English defaults below
        // cover every English track YouTube actually serves for human +
        // auto + original-language; a caller-provided locale swaps in
        // that code + its base form instead. yt-dlp silently skips codes
        // that don't exist on a given video — no error.
        "--sub-langs".into(), sub_langs,
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
        // Bundled ffmpeg - conversion must not depend on a PATH/Homebrew
        // install that user machines don't have.
        "--ffmpeg-location".into(), caption_ffmpeg_str,
        "--skip-download".into(),
        "--no-playlist".into(),
        "--newline".into(),
        YT_EXTRACTOR_ARGS[0].into(),
        YT_EXTRACTOR_ARGS[1].into(),
        "-o".into(), template_str.clone(),
    ];
    // `caption_args` stays the cookie-free, URL-free base; each attempt appends
    // the cookie flag (or not) + the URL, so a cookied failure can be retried
    // public (mirrors spawn_video_clip — some sites serve logged-in pages
    // yt-dlp can't parse). The command itself returns immediately (fire-and-
    // forget), so the retry must live HERE in the monitor task, not in a
    // frontend invoke wrapper that resolves before the download finishes.
    let cookied = cookies_active(args.cookies_browser.as_deref());
    let mut first_args = caption_args.clone();
    first_args.extend(cookies_args(args.cookies_browser.as_deref()));
    first_args.push(args.url.clone());
    let (rx, child) = cmd
        .args(first_args)
        .spawn()
        .map_err(|e| format!("failed to spawn yt-dlp: {e}"))?;
    // Register so the UI's Stop / a source switch can cancel — caption runs can
    // sleep+retry for a long time on YouTube 429s, exactly when cancel matters.
    app.state::<JobRegistry>().insert(args.job_id.clone(), child);

    let job_id = args.job_id.clone();
    let job_for = job_id.clone();
    let app_for = app.clone();
    let out_dir_for = out_dir.clone();
    let safe_for = safe.clone();
    let base_args = caption_args;
    let url_for = args.url.clone();

    tokio::spawn(async move {
        // Scan the output dir for caption files — runs after EVERY attempt,
        // even on nonzero exit. yt-dlp can 429 on a single phantom translation
        // track and still have written 1–3 perfectly good English tracks before
        // the failure. The presence of the file on disk is the source of truth,
        // not the exit code.
        //
        // Pick the best variant by preference — for the English defaults:
        //   en-US  > en  > en-orig  > anything else
        // (a caller-provided locale substitutes its own ladder, e.g.
        // pt-BR > pt; see caption_lang_prefs).
        // (has_speakers, is_auto, lang/format rank, path). Sort keys in
        // priority order:
        //   1. has_speakers — a creator track with `<v Name>` voice tags
        //      carries the "who's talking" data we want.
        //   2. NOT auto-generated — manual/creator captions are human-corrected
        //      and far more accurate than YouTube's ASR auto-captions.
        //   3. language/format tier.
        fn scan_best(
            dir: &std::path::Path,
            safe_for: &str,
            rank_langs: &[String],
        ) -> Option<String> {
            let mut candidates: Vec<(bool, bool, u8, String)> = Vec::new();
            if let Ok(entries) = std::fs::read_dir(dir) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    let name = p
                        .file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("")
                        .to_string();
                    // Only THIS job's language variants: `<safe>.<lang>.<vtt|srt>`.
                    // Requiring `<safe>.` rejects a different video that merely
                    // shares a title prefix ("My Video" vs "My Video Part 2");
                    // requiring a language segment (≥2 dots after the base)
                    // rejects a stale bare `<safe>.srt` from an earlier Whisper
                    // run in the same dir — which the manual-preferred sort would
                    // otherwise rank ABOVE the freshly downloaded caption.
                    let rest = match name.strip_prefix(safe_for) {
                        Some(r) if r.starts_with('.') => r,
                        _ => continue,
                    };
                    if !(rest.ends_with(".vtt") || rest.ends_with(".srt"))
                        || rest.matches('.').count() < 2
                    {
                        continue;
                    }
                    // Lower rank = preferred. ALL .vtt tiers outrank ALL
                    // .srt tiers — vtt is what we now write and it's the
                    // format that still carries speaker voice tags (a
                    // stray .srt would have lost them). Within a format,
                    // rank_langs order wins (English defaults reproduce
                    // the historical en-US > en > en-orig ladder).
                    let unranked = (rank_langs.len() * 2) as u8;
                    let mut rank: u8 = unranked;
                    for (i, lg) in rank_langs.iter().enumerate() {
                        if name.ends_with(&format!(".{lg}.vtt")) {
                            rank = i as u8;
                            break;
                        }
                    }
                    if rank == unranked {
                        for (i, lg) in rank_langs.iter().enumerate() {
                            if name.ends_with(&format!(".{lg}.srt")) {
                                rank = (rank_langs.len() + i) as u8;
                                break;
                            }
                        }
                    }
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
            candidates.into_iter().next().map(|(_, _, _, p)| p)
        }

        let mut saw_auth_error = false;
        let mut attempt = 1;
        let mut rx = rx;
        loop {
            let mut exit_code: Option<i32> = None;
            let mut signalled = false;
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
                        let _ = app_for.state::<JobRegistry>().take(&job_for);
                        exit_code = payload.code;
                        signalled = payload.signal.is_some();
                        break;
                    }
                    _ => {}
                }
            }
            let found = scan_best(&out_dir_for, &safe_for, &rank_langs);

            // Cookied attempt produced nothing → retry once WITHOUT cookies
            // (LinkedIn/public-post failure mode; mirrors spawn_video_clip).
            // Never resurrect a user cancel (signalled), and keep the second
            // child registered under the SAME job_id so Stop still works.
            if found.is_none() && attempt == 1 && cookied && !signalled {
                if let Ok(cmd2) = ytdlp(&app_for) {
                    let mut second = base_args.clone();
                    second.push(url_for.clone());
                    if let Ok((rx2, child2)) = cmd2.args(second).spawn() {
                        let _ = app_for.emit(
                            "captions-log",
                            LogEvent {
                                job_id: job_for.clone(),
                                stream: "stdout".into(),
                                tag: "info".into(),
                                line: "Caption download failed with sign-in cookies — retrying without…".into(),
                            },
                        );
                        app_for.state::<JobRegistry>().insert(job_for.clone(), child2);
                        rx = rx2;
                        attempt = 2;
                        continue;
                    }
                }
            }

            let exit_ok = exit_code == Some(0);
            let success = found.is_some();
            let error = if !success {
                Some(if signalled {
                    "Cancelled".into()
                } else if saw_auth_error {
                    YT_AUTH_HINT.into()
                } else if !exit_ok {
                    format!("yt-dlp exited with code {exit_code:?} and no captions were written")
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
                    code: exit_code,
                    path: found,
                    error,
                },
            );
            break;
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

#[derive(Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
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
    /// Audio codec of the selected stream (e.g. "mp4a.40.2"). Lets the frontend
    /// build an exact MSE MIME without probing the raw stream. None/NA ⇒ the
    /// frontend assumes AAC (the resolver constrains the avc tiers to mp4a).
    pub acodec: Option<String>,
}

#[tauri::command]
pub async fn get_direct_stream_url(
    app: AppHandle,
    url: String,
    cookies_browser: Option<String>,
    // Cap the streamed video height (px) — same throwaway-preview rationale as
    // the download path. None ⇒ no cap (full source resolution). Keeps the
    // streamed bytes small so playback starts reliably on flaky CDNs.
    max_height: Option<u32>,
) -> Result<DirectStreamResult, crate::AppError> {
    validate_source_url(&url)?;
    // Cookies-first (needed for YouTube bot-checks / private content). If that
    // fails AND cookies were actually applied, retry once WITHOUT them: some
    // sites (LinkedIn) serve a logged-in page variant yt-dlp can't parse
    // ("Unable to extract video"), while the public page resolves fine.
    // Genuinely gated content still errors → download fallback / sign-in modal.
    let resolved = match resolve_stream_tiers(&app, &url, cookies_browser.as_deref(), max_height).await {
        Ok(r) => r,
        Err(e) => {
            if !cookies_active(cookies_browser.as_deref()) {
                return Err(e);
            }
            eprintln!("[stream] resolve with cookies failed; retrying without cookies");
            resolve_stream_tiers(&app, &url, None, max_height).await?
        }
    };
    // Warm-boot cache (r112): remember the signed URLs + their expiry so a
    // re-open inside the validity window skips extraction entirely.
    // Best-effort — a cache write failure must never fail the resolve.
    persist_stream_cache(&app, &url, &resolved, max_height);
    Ok(resolved)
}

/// Resolve a playable stream URL through the muxed → DASH-split → HLS tiers for
/// one cookie setting. Each yt-dlp call is wall-clock-bounded (`output_timed`)
/// so a wedged extractor can't hang the resolve.
async fn resolve_stream_tiers(
    app: &AppHandle,
    url: &str,
    cookies_browser: Option<&str>,
    max_height: Option<u32>,
) -> Result<DirectStreamResult, crate::AppError> {
    let yt = ytdlp(app)?;
    // Optional height cap injected into the primary selector terms. Fallback
    // terms stay uncapped so resolution never fails for lack of an exact match.
    let hc = max_height.map(|h| format!("[height<={h}]")).unwrap_or_default();

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
        format!(
            "b{hc}[acodec!=none][vcodec!=none][protocol^=http][protocol!*=m3u8]/\
             b[acodec!=none][vcodec!=none][ext=mp4]/\
             b[ext=mp4]/b"
        ),
        "-S".into(), "res,vbr,ext".into(),
        YT_EXTRACTOR_ARGS[0].into(),
        YT_EXTRACTOR_ARGS[1].into(),
        "--print".into(), "url".into(),
        "--print".into(), "%(width)s\t%(height)s\t%(vcodec)s\t%(acodec)s".into(),
    ];
    args.extend(cookies_args(cookies_browser));
    args.push(url.to_string());

    // A timeout/spawn failure here is systemic (wedged or slow extractor — often
    // the logged-in-page case), so propagate it: the caller retries WITHOUT
    // cookies rather than burning two more equally-slow tier calls.
    let out = output_timed(yt.args(args), RESOLVE_TIMEOUT_SECS).await?;
    if out.status.success() {
        let stdout = String::from_utf8_lossy(&out.stdout).to_string();
        let mut lines = stdout.lines().filter(|l| !l.trim().is_empty());
        if let Some(direct) = lines.next() {
            let (w, h, vcodec, acodec) = if let Some(meta) = lines.next() {
                let parts: Vec<&str> = meta.split('\t').collect();
                let w  = parts.first().and_then(|s| s.parse::<u32>().ok());
                let h  = parts.get(1).and_then(|s| s.parse::<u32>().ok());
                let vc = parts.get(2).filter(|s| !s.is_empty() && **s != "NA").map(|s| s.to_string());
                let ac = parts.get(3).filter(|s| !s.is_empty() && **s != "NA").map(|s| s.to_string());
                (w, h, vc, ac)
            } else { (None, None, None, None) };
            return Ok(DirectStreamResult { url: direct.to_string(), audio_url: None, width: w, height: h, vcodec, acodec });
        }
    }
    // No single muxed progressive (a DASH-split source — Reddit, YouTube >360p,
    // etc.). Resolve best H.264 video + best AAC audio as SEPARATE URLs so the
    // proxy can merge them on the fly and the source still STREAMS.
    let muxed_stderr = String::from_utf8_lossy(&out.stderr).to_string();
    if let Some(split) = resolve_split_stream(app, url, cookies_browser, max_height).await {
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
    max_height: Option<u32>,
) -> Option<DirectStreamResult> {
    let yt = ytdlp(app).ok()?;
    let hc = max_height.map(|h| format!("[height<={h}]")).unwrap_or_default();
    let mut args: Vec<String> = vec![
        "--no-playlist".into(),
        "--no-warnings".into(),
        "--socket-timeout".into(), "20".into(),
        "-f".into(),
        format!(
            "bv*[vcodec^=avc1]{hc}[protocol^=http][protocol!*=m3u8]+ba[acodec^=mp4a][protocol^=http][protocol!*=m3u8]/\
             bv*[vcodec^=avc1]{hc}+ba[ext=m4a]/\
             bv*+ba"
        ),
        YT_EXTRACTOR_ARGS[0].into(),
        YT_EXTRACTOR_ARGS[1].into(),
        // requested_formats.0 = video, .1 = audio for a merged (v+a) selection.
        "--print".into(),
        "%(requested_formats.0.url)s\t%(requested_formats.1.url)s\t%(width)s\t%(height)s\t%(vcodec)s\t%(requested_formats.1.acodec)s".into(),
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
    let ac = parts.get(5).filter(|s| !s.is_empty() && **s != "NA").map(|s| s.to_string());
    Some(DirectStreamResult {
        url: video.to_string(),
        audio_url: Some(audio.to_string()),
        width: w,
        height: h,
        vcodec: vc,
        acodec: ac,
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
        "%(url)s\t%(width)s\t%(height)s\t%(vcodec)s\t%(acodec)s".into(),
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
    let ac = parts.get(4).filter(|s| !s.is_empty() && **s != "NA").map(|s| s.to_string());
    Some(DirectStreamResult {
        url: url_out.to_string(),
        audio_url: None,
        width: w,
        height: h,
        vcodec: vc,
        acodec: ac,
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
    /// Max preview height (px). The preview is a throwaway scrub/mark copy,
    /// so we cap resolution to keep the download small and fast — export
    /// uses the user's real quality. None → 720 (back-compat default).
    #[serde(default)]
    pub max_height: Option<u32>,
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

    // A COMPLETE copy already in the persistent downloads cache → reuse it
    // instantly, no yt-dlp. The frontend's warm-start probe usually catches
    // this before ever entering the download path; this in-command check
    // covers the fallback chain (e.g. a cached stream URL died mid-session
    // and the machine fell back to download for a source we already hold).
    if let Some(existing) = find_cached_download(&cache, &args.url) {
        if let Some(path_str) = existing.to_str().map(String::from) {
            let app_for = app.clone();
            let job_for = args.job_id.clone();
            tokio::spawn(async move {
                let _ = app_for.emit("playback-prep-log", LogEvent {
                    job_id: job_for.clone(),
                    stream: "stderr".into(),
                    tag: "ok".into(),
                    line: "[web-preview] Reusing the downloaded copy already in cache".into(),
                });
                let _ = app_for.emit("playback-prep-done", PreparePlaybackDone {
                    job_id: job_for,
                    success: true,
                    path: Some(path_str),
                    error: None,
                });
            });
            return Ok(args.job_id);
        }
    }

    // yt-dlp picks the ext from the format selector — we let it choose
    // and probe the resulting file after to find the actual path. The
    // download lands under a JOB-scoped temp prefix in the cache ROOT (so an
    // abandoned partial is swept by the 24h cleanup), then atomically renames
    // into the persistent downloads cache on success — a file there is
    // complete by construction.
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

    // Cap resolution — the preview is for in-app scrubbing/marking, not
    // archival. Smaller file = faster download = quicker time-to-play.
    // The actual export still uses the user's selected quality via
    // create_clip's own format selector. Height is user-configurable
    // (Settings → Web sources → Preview quality); default 720 for
    // back-compat when the arg is absent.
    //
    // r56/r78: force progressive HTTPS (NOT HLS m3u8) AND cap the DASH
    // branch. Two failures this guards against, both seen in the wild:
    //   • The previous `b` catch-all happily picked a YouTube HLS
    //     playlist — 1000+ tiny fragments, half of which 401 mid-stream
    //     when the signed manifest tokens rotate (esp. with cookies).
    //     HLS is now LAST resort, behind a non-m3u8 catch-all.
    //   • The DASH merge branch had no height cap, so it grabbed 1080p
    //     (format 137, ≈1GB for a long video) even though we "cap at
    //     720". Both DASH and progressive branches now carry [height<=H].
    // Cascade: capped muxed MP4 → capped DASH MP4 merge → any progressive
    // MP4 → format 18 (legacy 360p, guaranteed-playable) → any non-HLS →
    // capped HLS → anything (HLS only if literally nothing else exists).
    //
    // r80/r81: some sources — notably past LIVE broadcasts
    // (`source/yt_live_broadcast`) — expose ONLY HLS to a signed-in client,
    // so every `[protocol!*=m3u8]` tier above misses and we'd fall to the bare
    // `b` = *best* HLS (1080p), blowing the preview height cap. The
    // `b[height<={h}]` tier keeps the cap honored on HLS-only sources (≈480p
    // instead of 1080p). HLS is downloaded by yt-dlp's native concurrent
    // downloader, then FixupM3u8 rewraps the MPEG-TS into a clean avc1/mp4a
    // faststart MP4 — this works because we now bundle ffprobe (see the
    // `--ffmpeg-location` note below); without it the AAC stayed raw ADTS and
    // WKWebView showed a black player.
    let h = args.max_height.unwrap_or(720);
    let fmt = format!(
        "b[height<={h}][ext=mp4][acodec!=none][vcodec!=none][protocol^=http][protocol!*=m3u8]/\
         bv*[height<={h}][ext=mp4][protocol^=http][protocol!*=m3u8]+ba[ext=m4a][protocol^=http][protocol!*=m3u8]/\
         b[ext=mp4][acodec!=none][vcodec!=none][protocol^=http][protocol!*=m3u8]/\
         18/\
         b[protocol!*=m3u8]/\
         b[height<={h}]/\
         b"
    );
    let mut yt_args: Vec<String> = vec![
        "-f".into(),
        fmt,
        "--no-playlist".into(),
        "--no-part".into(),
        "--newline".into(),
        "--progress".into(),
        YT_EXTRACTOR_ARGS[0].into(),
        YT_EXTRACTOR_ARGS[1].into(),
        "--concurrent-fragments".into(), "16".into(),
        "--http-chunk-size".into(), "10M".into(),
        // r81: we pass the bundled ffmpeg *file* here, and yt-dlp derives the
        // sibling ffprobe (`ffprobe-<triple>`, bundled next to ffmpeg) from
        // this path automatically — verified across dev (suffixed names) and
        // the prod layout. ffprobe is what makes the native concurrent
        // downloader safe for HLS: FixupM3u8 needs it to detect that the
        // MPEG-TS AAC requires `aac_adtstoasc`, yielding a clean avc1/mp4a
        // faststart MP4. Earlier (no ffprobe) we worked around this with
        // `--downloader m3u8:ffmpeg` — correct but SEQUENTIAL (~3.5 min for an
        // 85-min source). Native + ffprobe is ~3.4× faster (≈1 min) and just
        // as clean, so the per-protocol downloader override is gone. The DASH
        // split-A/V branch also muxes via this ffmpeg.
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
    let final_prefix_for = download_cache_prefix(&args.url);

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
                    // depends on what it picked from the format selector —
                    // then move the complete copy into the persistent
                    // downloads cache (source-keyed, atomic rename) so the
                    // next open of this URL plays from disk with no network.
                    // A failed rename falls back to the temp path: playback
                    // still works this session, reuse just isn't persisted.
                    // Every branch yields a usable path (the temp one if the
                    // move fails), so this is a `map`, not an `and_then`.
                    let written = find_audio_in_cache(&cache_for, &prefix_for).map(|p| {
                        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("mp4");
                        let dl_dir = media_cache_dir(&cache_for, "downloads");
                        if std::fs::create_dir_all(&dl_dir).is_err() {
                            return p;
                        }
                        let dest = dl_dir.join(format!("{final_prefix_for}.{ext}"));
                        match std::fs::rename(&p, &dest) {
                            Ok(()) => dest,
                            Err(_) => p,
                        }
                    });
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
// CACHED SOURCE AUDIO  (transcription head-start)
//
// Downloads ONLY the full-fidelity audio track (no video) to cache and returns
// its path. This is a HEAD START for Whisper: it's source-keyed and persistent,
// so when the user hits Transcribe the audio is already on disk (generate_transcript
// reuses it via source_audio_prefix) and the transcript is clocked against the
// exact source timeline. Playback itself does NOT use this file — the streamed
// native <video> is the single audio+picture+caption clock (see MSEStreamPlayer).
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
    let canon = canonical_cache_url(url);
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in canon.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0000_0100_0000_01B3);
    }
    format!("{h:016x}")
}

/// Strip the query params that name a VIEW of a source rather than the source
/// itself, so the same video hashes identically however it was pasted.
///
/// This was a real bug, not a nicety: the pre-cache is written under the URL
/// the user pasted (`...?v=ID&t=3930s`) but read back under the canonical
/// `webpage_url` (`...?v=ID`). Different string, different hash, permanent
/// miss - so any link carrying a timestamp, playlist, or share id could never
/// reuse its own cached audio and re-downloaded the whole track every time.
/// `v` is KEPT (it identifies the video); everything else is dropped.
pub(crate) fn canonical_cache_url(url: &str) -> String {
    let Some((base, query)) = url.split_once('?') else { return url.to_string() };
    let keep: Vec<&str> = query
        .split('&')
        .filter(|kv| kv.starts_with("v=") || kv.starts_with("video_id="))
        .collect();
    if keep.is_empty() {
        base.to_string()
    } else {
        format!("{base}?{}", keep.join("&"))
    }
}

/// The COMPLETE-file prefix. A file under this prefix is fully downloaded and
/// safe to reuse (the in-flight download lands under a different temp prefix,
/// then atomically renames here on success — so Whisper never reads a partial).
pub(crate) fn source_audio_prefix(url: &str) -> String {
    format!("saucebunny-audio-{}", source_audio_hash(url))
}

/// Locate the cached full audio track for `url`. Checks the persistent
/// media cache (`saucebunny-media/audio/`, r112) first, then the pre-r112
/// cache root — MIGRATING a legacy hit into the media dir so it stops being
/// eligible for the 24h startup sweep (one-time lazy migration). Only
/// non-empty files count; the atomic-rename convention means any file under
/// the final prefix is complete.
pub(crate) fn find_cached_source_audio(cache_root: &std::path::Path, url: &str) -> Option<PathBuf> {
    let prefix = source_audio_prefix(url);
    let nonempty = |p: &PathBuf| p.metadata().map(|m| m.len() > 0).unwrap_or(false);
    let audio_dir = media_cache_dir(cache_root, "audio");
    if let Some(p) = find_audio_in_cache(&audio_dir, &prefix).filter(nonempty) {
        return Some(p);
    }
    let legacy = find_audio_in_cache(cache_root, &prefix).filter(nonempty)?;
    if std::fs::create_dir_all(&audio_dir).is_err() {
        return Some(legacy); // can't migrate; still reusable where it is
    }
    let dest = audio_dir.join(legacy.file_name()?);
    match std::fs::rename(&legacy, &dest) {
        Ok(()) => Some(dest),
        Err(_) => Some(legacy),
    }
}

/// COMPLETE-file prefix for a full downloaded source copy in
/// `saucebunny-media/downloads/`. Same deterministic URL key (and the same
/// temp-download → atomic-rename convention) as the audio cache.
pub(crate) fn download_cache_prefix(url: &str) -> String {
    format!("saucebunny-download-{}", source_audio_hash(url))
}

/// A complete, non-empty downloaded copy of `url` in the persistent
/// downloads cache, if one exists. This is what powers the r112 fast path:
/// re-opening a source that was ever fully downloaded boots LocalMediaPlayer
/// straight from disk, skipping resolve + proxy entirely.
pub(crate) fn find_cached_download(cache_root: &std::path::Path, url: &str) -> Option<PathBuf> {
    find_audio_in_cache(&media_cache_dir(cache_root, "downloads"), &download_cache_prefix(url))
        .filter(|p| p.metadata().map(|m| m.len() > 0).unwrap_or(false))
}

// ────────────────────────────────────────────────────────────────────────
// WARM-BOOT META CACHE  (r112)
//
// Re-opening a previously loaded web source used to re-pay yt-dlp's full
// extraction (~10-15s) every time. Two artifacts make it warm instead:
//
//   1. The parsed Metadata JSON (title/duration/thumbnail/…) — hydrates the
//      UI instantly; revalidated in the background only when >24h old.
//   2. The resolved direct-stream URLs + their signed expiry — while still
//      valid (minus a 10-minute safety margin) the frontend hands them
//      straight to the proxy/MSE path and skips extraction entirely.
//
// Both live in ONE file per source: media/meta/<urlhash>.json, keyed by the
// same canonical FNV-1a URL hash as the audio/download caches. If a cached
// URL turns out dead anyway (403 after key rotation), the playback machine
// retries with ONE fresh resolve before the download fallback — see
// src/lib/web-playback-machine.ts.
// ────────────────────────────────────────────────────────────────────────

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Re-fetch metadata in the background when the cached copy is older than this.
const META_REVALIDATE_SECS: u64 = 24 * 60 * 60;
/// Don't trust a cached stream URL within this margin of its expiry — a URL
/// that dies mid-watch costs a resolve anyway, plus a visible hiccup.
const STREAM_EXPIRY_MARGIN_SECS: u64 = 10 * 60;
/// Conservative validity for signed URLs that carry no parseable expiry.
const STREAM_FALLBACK_VALIDITY_SECS: u64 = 30 * 60;

/// One source's on-disk warm-boot record (media/meta/<urlhash>.json).
/// Metadata and stream sections fill in independently — playback-first means
/// the stream resolve can land before (or without) the metadata probe.
#[derive(Serialize, Deserialize, Clone)]
pub(crate) struct SourceMeta {
    pub url: String,
    #[serde(default)]
    pub metadata: Option<Metadata>,
    /// Unix seconds when `metadata` was fetched.
    #[serde(default)]
    pub fetched_at: Option<u64>,
    #[serde(default)]
    pub stream: Option<CachedStream>,
}

/// A resolved direct-stream result + its validity window, persisted so a
/// re-open inside the window skips yt-dlp entirely.
#[derive(Serialize, Deserialize, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct CachedStream {
    pub video_url: String,
    /// Raw DASH audio URL (the proxy merges it); None when muxed.
    pub audio_url: Option<String>,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub vcodec: Option<String>,
    pub acodec: Option<String>,
    /// The preview height cap active at resolve time. A cached URL is only
    /// reused when the caller's cap matches — the resolver picks a different
    /// format per cap, and silently serving yesterday's 480p after the user
    /// bumped quality to 1080p would be wrong.
    pub max_height: Option<u32>,
    /// Unix seconds when the resolve happened.
    #[ts(type = "number")]
    pub resolved_at: u64,
    /// Unix seconds after which the signed URLs are invalid.
    #[ts(type = "number")]
    pub expires_at: u64,
}

/// Everything the frontend needs to decide the re-open path, in one call.
#[derive(Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct WarmStart {
    /// Cached parsed metadata — hydrate the UI from this immediately.
    pub metadata: Option<Metadata>,
    /// True when the metadata is missing or >24h old: revalidate in the
    /// background (the UI still hydrates from the cached copy first).
    pub metadata_stale: bool,
    /// A still-valid resolved stream (expiry margin + height cap already
    /// checked): hand it straight to the proxy/MSE path, skip extraction.
    pub stream: Option<CachedStream>,
    /// A complete downloaded copy on disk: boot LocalMediaPlayer from this
    /// and skip resolve/proxy altogether (the strongest fast path).
    pub cached_copy: Option<String>,
}

fn meta_path(cache_root: &std::path::Path, url: &str) -> PathBuf {
    media_cache_dir(cache_root, "meta").join(format!("{}.json", source_audio_hash(url)))
}

fn read_source_meta(cache_root: &std::path::Path, url: &str) -> Option<SourceMeta> {
    let bytes = std::fs::read(meta_path(cache_root, url)).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Write-temp-then-rename so a crash mid-write can't leave a truncated JSON
/// that poisons every future warm boot of this source.
fn write_source_meta(cache_root: &std::path::Path, meta: &SourceMeta) -> std::io::Result<()> {
    let dir = media_cache_dir(cache_root, "meta");
    std::fs::create_dir_all(&dir)?;
    let bytes = serde_json::to_vec_pretty(meta)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let tmp = dir.join(format!(".tmp-{}", source_audio_hash(&meta.url)));
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, meta_path(cache_root, &meta.url))
}

fn load_or_new_meta(cache_root: &std::path::Path, url: &str) -> SourceMeta {
    read_source_meta(cache_root, url).unwrap_or(SourceMeta {
        url: url.to_string(),
        metadata: None,
        fetched_at: None,
        stream: None,
    })
}

/// Best-effort: persist freshly fetched metadata (keeps any cached stream).
fn persist_metadata_cache(app: &AppHandle, url: &str, m: &Metadata) {
    let Ok(cache) = app.path().app_cache_dir() else { return };
    let mut sm = load_or_new_meta(&cache, url);
    sm.metadata = Some(m.clone());
    sm.fetched_at = Some(unix_now());
    if let Err(e) = write_source_meta(&cache, &sm) {
        eprintln!("[warm-cache] metadata write failed: {e}");
    }
}

/// Best-effort: persist a fresh stream resolve (keeps any cached metadata).
fn persist_stream_cache(app: &AppHandle, url: &str, r: &DirectStreamResult, max_height: Option<u32>) {
    let Ok(cache) = app.path().app_cache_dir() else { return };
    let now = unix_now();
    let mut sm = load_or_new_meta(&cache, url);
    sm.stream = Some(CachedStream {
        video_url: r.url.clone(),
        audio_url: r.audio_url.clone(),
        width: r.width,
        height: r.height,
        vcodec: r.vcodec.clone(),
        acodec: r.acodec.clone(),
        max_height,
        resolved_at: now,
        expires_at: stream_expires_at(&r.url, r.audio_url.as_deref(), now),
    });
    if let Err(e) = write_source_meta(&cache, &sm) {
        eprintln!("[warm-cache] stream write failed: {e}");
    }
}

/// Parse the expiry unix timestamp out of a signed CDN URL. googlevideo
/// carries `expire=<unix>` as a query param (path-style signing uses an
/// `/expire/<unix>/` segment pair instead); other hosts commonly use
/// `expires=`. Returns None for URLs with no parseable, plausible value —
/// callers then apply the conservative 30-minute fallback.
pub(crate) fn parse_url_expiry(url: &str) -> Option<u64> {
    let parsed = url::Url::parse(url).ok()?;
    // Plausibility window: 2001..2286. Rejects garbage like `expire=42`
    // without rejecting any real signed-URL timestamp.
    let plausible = |v: u64| (1_000_000_000..10_000_000_000).contains(&v);
    for (k, v) in parsed.query_pairs() {
        if k == "expire" || k == "expires" {
            if let Ok(n) = v.parse::<u64>() {
                if plausible(n) {
                    return Some(n);
                }
            }
        }
    }
    let mut segs = parsed.path_segments()?;
    while let Some(s) = segs.next() {
        if s == "expire" {
            if let Some(n) = segs.next().and_then(|v| v.parse::<u64>().ok()) {
                if plausible(n) {
                    return Some(n);
                }
            }
        }
    }
    None
}

/// Effective expiry for a resolved stream: the EARLIEST expiry across the
/// video and (optional) audio URL, where a URL with no parseable expiry
/// contributes the conservative `resolved_at + 30min`.
pub(crate) fn stream_expires_at(video_url: &str, audio_url: Option<&str>, resolved_at: u64) -> u64 {
    let one = |u: &str| {
        parse_url_expiry(u).unwrap_or(resolved_at + STREAM_FALLBACK_VALIDITY_SECS)
    };
    let mut expires = one(video_url);
    if let Some(a) = audio_url {
        expires = expires.min(one(a));
    }
    expires
}

/// The re-open fast-path probe (r112). Called by the frontend at fetch time,
/// BEFORE any yt-dlp work: returns whatever warm state exists for this
/// source so the UI can hydrate instantly and playback can skip extraction.
/// Pure local-disk reads — never touches the network.
// async (review fix): this command does disk I/O (meta JSON read +
// downloads-dir scan) on the fetch hot path, BEFORE the optimistic mount.
// A plain fn would run it on the MAIN thread; async runs it on the pool.
#[tauri::command]
pub async fn get_warm_start(
    app: AppHandle,
    url: String,
    max_height: Option<u32>,
) -> Result<WarmStart, crate::AppError> {
    validate_source_url(&url)?;
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| crate::AppError::internal(format!("app_cache_dir: {e}")))?;
    let now = unix_now();
    let meta = read_source_meta(&cache, &url);
    let (metadata, metadata_stale) = match &meta {
        Some(m) => (
            m.metadata.clone(),
            m.metadata.is_none()
                || m.fetched_at
                    .map(|t| now.saturating_sub(t) > META_REVALIDATE_SECS)
                    .unwrap_or(true),
        ),
        None => (None, true),
    };
    let stream = meta.and_then(|m| m.stream).filter(|s| {
        s.max_height == max_height && now + STREAM_EXPIRY_MARGIN_SECS < s.expires_at
    });
    let cached_copy =
        find_cached_download(&cache, &url).and_then(|p| p.to_str().map(String::from));
    Ok(WarmStart { metadata, metadata_stale, stream, cached_copy })
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
    // Checks the r112 media dir first, then lazily migrates any pre-r112
    // copy out of the sweep's reach.
    if let Some(existing) = find_cached_source_audio(&cache, &args.url) {
        if let Some(s) = existing.to_str() {
            return Ok(s.to_string());
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
    // Clear any leftover partial from a prior failed/cancelled attempt under
    // this SAME job_id — the frontend's cookie-retry reuses the job_id, and
    // yt-dlp's default --continue would otherwise resume a partial that may now
    // be a DIFFERENT format (cookie vs no-cookie resolve gives a different
    // bitrate/container), splicing mismatched bytes into the cached audio.
    if let Ok(entries) = std::fs::read_dir(&cache) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with(&dl_prefix) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }

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
    // source-keyed name in the persistent media cache (r112: sweep-exempt —
    // this track is downloaded ONCE and reused across sessions) so the cache
    // hit is all-or-nothing.
    let dl_file = find_audio_in_cache(&cache, &dl_prefix).ok_or_else(|| {
        crate::AppError::internal("yt-dlp exited cleanly but no audio file was found in cache")
    })?;
    let ext = dl_file
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("m4a");
    let audio_dir = media_cache_dir(&cache, "audio");
    std::fs::create_dir_all(&audio_dir).map_err(|e| format!("mkdir audio cache: {e}"))?;
    let final_path = audio_dir.join(format!("{final_prefix}.{ext}"));
    std::fs::rename(&dl_file, &final_path).map_err(|e| format!("cache rename: {e}"))?;
    final_path
        .to_str()
        .map(String::from)
        .ok_or_else(|| crate::AppError::internal("cached audio path not utf-8"))
}

#[cfg(test)]
mod warm_cache_tests {
    use super::{parse_url_expiry, stream_expires_at};

    // Shape of a real yt-dlp-resolved googlevideo URL (format 18), trimmed of
    // the volatile signature blobs but keeping the real param layout.
    const GOOGLEVIDEO_URL: &str = "https://rr3---sn-p5qlsnsr.googlevideo.com/videoplayback?\
        expire=1752696869&ei=xTt4aPLxEuOTsfIPxvXFyQI&ip=203.0.113.7&\
        id=o-AAeGm1kX&itag=18&source=youtube&requiressl=yes&xpc=Eghonf3xInoBAQ%3D%3D&\
        mh=8V&mm=31%2C29&mn=sn-p5qlsnsr%2Csn-p5qs7nzk&ms=au%2Crdu&mv=m&mvi=3&\
        pl=21&ratebypass=yes&dur=213.envelope&lmt=1750000000000000&\
        sig=AJfQdSswRQIhAO&lsparams=mh%2Cmm%2Cmn%2Cms%2Cmv%2Cmvi%2Cpl&lsig=ACuhMU0wRAIg";

    #[test]
    fn parses_expire_from_googlevideo_query() {
        assert_eq!(parse_url_expiry(GOOGLEVIDEO_URL), Some(1_752_696_869));
    }

    #[test]
    fn parses_expires_variant() {
        assert_eq!(
            parse_url_expiry("https://cdn.example.com/v.mp4?expires=1752700000&sig=abc"),
            Some(1_752_700_000)
        );
    }

    #[test]
    fn parses_path_style_expire_segments() {
        assert_eq!(
            parse_url_expiry("https://host.googlevideo.com/videoplayback/expire/1752696869/ei/xyz/itag/18"),
            Some(1_752_696_869)
        );
    }

    #[test]
    fn url_without_expiry_yields_none() {
        assert_eq!(parse_url_expiry("https://cdn.example.com/video.mp4?token=abc&v=2"), None);
    }

    #[test]
    fn garbage_expiry_values_yield_none() {
        // Non-numeric.
        assert_eq!(parse_url_expiry("https://h.example.com/v?expire=banana"), None);
        // Numeric but not a plausible unix timestamp (would "expire" in 1970).
        assert_eq!(parse_url_expiry("https://h.example.com/v?expire=42"), None);
        // Not a URL at all.
        assert_eq!(parse_url_expiry("expire=1752696869"), None);
    }

    #[test]
    fn stream_expiry_is_earliest_of_video_and_audio() {
        let video = "https://h.example.com/v?expire=2000000000";
        let audio = "https://h.example.com/a?expire=1900000000";
        assert_eq!(stream_expires_at(video, Some(audio), 1_800_000_000), 1_900_000_000);
    }

    #[test]
    fn stream_expiry_falls_back_to_30_minutes_when_unparseable() {
        let resolved_at = 1_800_000_000;
        // Neither URL carries an expiry → conservative fetched_at + 30min.
        assert_eq!(
            stream_expires_at("https://h.example.com/v", None, resolved_at),
            resolved_at + 30 * 60
        );
        // Video has one, audio doesn't → the audio's conservative window
        // wins when it is earlier (a dead audio leg kills the stream too).
        assert_eq!(
            stream_expires_at(
                "https://h.example.com/v?expire=2000000000",
                Some("https://h.example.com/a"),
                resolved_at
            ),
            resolved_at + 30 * 60
        );
    }
}

// ─── Nightly real-sidecar smoke (see src/nightly.rs; run with --ignored) ────
//
// yt-dlp's CLI churns on a near-weekly cadence and the nightly workflow pulls
// the LATEST build, so this is where a renamed/removed option we depend on
// surfaces — without hitting any real video site from CI.
#[cfg(test)]
mod nightly_ytdlp_tests {
    use crate::nightly;

    #[test]
    #[ignore = "nightly: needs real sidecar binaries"]
    fn nightly_ytdlp_binary_runs() {
        let out = nightly::run_ok(&nightly::sidecar("yt-dlp"), ["--version"], "yt-dlp --version");
        let version = String::from_utf8_lossy(&out.stdout).trim().to_string();
        eprintln!("[nightly] yt-dlp {version}");
        // Release versions are date-stamped (e.g. 2026.06.30).
        assert!(
            version.starts_with("20") && version.len() >= 8,
            "unexpected yt-dlp version output: {version:?}"
        );
    }

    // Every `--long-flag` string literal this module passes to yt-dlp must
    // still exist in `yt-dlp --help`. Scanning our own source keeps the list
    // self-maintaining: add a flag to any invocation and it's covered.
    #[test]
    #[ignore = "nightly: needs real sidecar binaries"]
    fn nightly_ytdlp_recognizes_every_long_flag_we_pass() {
        let src = include_str!("download.rs");
        let mut flags: Vec<String> = Vec::new();
        for line in src.lines() {
            let t = line.trim_start();
            if t.starts_with("//") {
                continue; // prose can mention hypothetical flags
            }
            // Collect "--flag" string literals: a quote, two dashes, then
            // [a-z-] up to the closing quote.
            let mut rest = t;
            while let Some(i) = rest.find("\"--") {
                let after = &rest[i + 1..];
                if let Some(end) = after.find('"') {
                    let cand = &after[..end];
                    if cand.len() >= 4 && cand[2..].chars().all(|c| c.is_ascii_lowercase() || c == '-') {
                        flags.push(cand.to_string());
                    }
                    rest = &after[end + 1..];
                } else {
                    break;
                }
            }
        }
        flags.sort();
        flags.dedup();
        // If the scan itself regresses, fail loudly rather than pass on an
        // empty list.
        assert!(
            flags.iter().any(|f| f == "--dump-json"),
            "flag scan found no known anchor; scanned flags: {flags:?}"
        );
        eprintln!("[nightly] checking {} yt-dlp flags: {flags:?}", flags.len());

        let out = nightly::run_ok(&nightly::sidecar("yt-dlp"), ["--help"], "yt-dlp --help");
        let help = String::from_utf8_lossy(&out.stdout).to_string();
        let missing: Vec<&String> = flags.iter().filter(|f| !help.contains(f.as_str())).collect();
        assert!(
            missing.is_empty(),
            "yt-dlp no longer lists flags we pass: {missing:?} — upstream \
             rename/removal? Update the invocations in commands/download.rs."
        );
    }
}

#[cfg(test)]
mod ytdlp_update_tests {
    use super::*;

    #[test]
    fn version_parse_accepts_date_shapes() {
        assert_eq!(parse_ytdlp_version("2026.07.04\n").as_deref(), Some("2026.07.04"));
        assert_eq!(
            parse_ytdlp_version("2026.07.04.232010").as_deref(),
            Some("2026.07.04.232010") // dev builds append a segment
        );
    }

    #[test]
    fn version_parse_rejects_non_ytdlp_output() {
        assert!(parse_ytdlp_version("").is_none());
        assert!(parse_ytdlp_version("404: Not Found").is_none());
        assert!(parse_ytdlp_version("<!DOCTYPE html>").is_none());
        assert!(parse_ytdlp_version("error\n2026.07.04").is_none());
    }

    #[test]
    fn updated_copy_always_outranks_bundled() {
        assert_eq!(resolved_ytdlp_kind(true), "updated");
        assert_eq!(resolved_ytdlp_kind(false), "bundled");
    }
}

#[cfg(test)]
mod cache_url_tests {
    use super::*;

    #[test]
    fn view_params_do_not_change_a_source_identity() {
        // The bug this fixes: the audio pre-cache is WRITTEN under the URL the
        // user pasted and READ back under the canonical webpage_url. A "&t="
        // timestamp made those two different strings, so a source could never
        // reuse its own cached audio and re-downloaded the whole track.
        let canonical = "https://www.youtube.com/watch?v=-8_w9zfPoQQ";
        for pasted in [
            "https://www.youtube.com/watch?v=-8_w9zfPoQQ&t=3930s",
            "https://www.youtube.com/watch?v=-8_w9zfPoQQ&list=PL123&index=4",
            "https://www.youtube.com/watch?v=-8_w9zfPoQQ&si=abc",
        ] {
            assert_eq!(
                source_audio_hash(pasted),
                source_audio_hash(canonical),
                "{pasted} must share a cache entry with its canonical form",
            );
        }
    }

    #[test]
    fn different_videos_still_get_different_entries() {
        assert_ne!(
            source_audio_hash("https://www.youtube.com/watch?v=aaaaaaaaaaa"),
            source_audio_hash("https://www.youtube.com/watch?v=bbbbbbbbbbb"),
        );
    }

    #[test]
    fn urls_without_a_query_are_untouched() {
        assert_eq!(canonical_cache_url("https://vimeo.com/12345"), "https://vimeo.com/12345");
        // A non-YouTube URL whose params we don't understand keeps only what
        // we recognise; the base still identifies the source.
        assert_eq!(canonical_cache_url("https://x.com/i/status/9?s=20"), "https://x.com/i/status/9");
    }
}

#[cfg(test)]
mod thumbnail_tests {
    use super::pick_thumbnail;
    use serde_json::json;

    #[test]
    fn prefers_the_singular_field_when_it_is_a_real_url() {
        let v = json!({ "thumbnail": "https://x/a.jpg", "thumbnails": [{ "url": "https://x/b.jpg" }] });
        assert_eq!(pick_thumbnail(&v).unwrap(), "https://x/a.jpg");
    }

    #[test]
    fn falls_back_to_the_array_when_the_singular_field_is_missing() {
        // THE bug. Reddit and many other extractors fill thumbnails[] and
        // leave `thumbnail` unset, so the card rendered an empty grey box
        // while yt-dlp had good images all along.
        let v = json!({ "thumbnails": [{ "url": "https://x/b.jpg", "width": 1280, "height": 720 }] });
        assert_eq!(pick_thumbnail(&v).unwrap(), "https://x/b.jpg");
    }

    #[test]
    fn rejects_placeholder_tokens_that_are_not_urls() {
        // Reddit puts "default"/"self"/"nsfw"/"spoiler" where a URL belongs.
        for token in ["default", "self", "nsfw", "spoiler", "", "   "] {
            let v = json!({ "thumbnail": token });
            assert!(pick_thumbnail(&v).is_none(), "{token} should not be a poster");
        }
    }

    #[test]
    fn a_placeholder_singular_still_falls_through_to_the_array() {
        let v = json!({
            "thumbnail": "nsfw",
            "thumbnails": [{ "url": "https://x/real.jpg", "width": 640, "height": 360 }],
        });
        assert_eq!(pick_thumbnail(&v).unwrap(), "https://x/real.jpg");
    }

    #[test]
    fn honours_the_extractors_own_preference_over_raw_size() {
        // The extractor knows which image is the poster and which is an avatar.
        let v = json!({ "thumbnails": [
            { "url": "https://x/huge.jpg", "width": 1920, "height": 1080, "preference": -1 },
            { "url": "https://x/right.jpg", "width": 640, "height": 360, "preference": 0 },
        ]});
        assert_eq!(pick_thumbnail(&v).unwrap(), "https://x/right.jpg");
    }

    #[test]
    fn picks_the_largest_sane_image_at_equal_preference() {
        let v = json!({ "thumbnails": [
            { "url": "https://x/small.jpg", "width": 320, "height": 180 },
            { "url": "https://x/big.jpg", "width": 1280, "height": 720 },
        ]});
        assert_eq!(pick_thumbnail(&v).unwrap(), "https://x/big.jpg");
    }

    #[test]
    fn avoids_an_absurd_still_when_a_reasonable_one_exists() {
        // A 4K JPEG is a slow fetch to render at 300px.
        let v = json!({ "thumbnails": [
            { "url": "https://x/4k.jpg", "width": 3840, "height": 2160 },
            { "url": "https://x/hd.jpg", "width": 1280, "height": 720 },
        ]});
        assert_eq!(pick_thumbnail(&v).unwrap(), "https://x/hd.jpg");
    }

    #[test]
    fn still_returns_something_when_every_option_is_huge() {
        // Better an oversized poster than none at all.
        let v = json!({ "thumbnails": [{ "url": "https://x/4k.jpg", "width": 3840, "height": 2160 }]});
        assert_eq!(pick_thumbnail(&v).unwrap(), "https://x/4k.jpg");
    }

    #[test]
    fn treats_an_entry_with_no_dimensions_as_mid_sized_rather_than_worst() {
        // An entry with no width is usually the extractor's primary image;
        // scoring it as zero-area would reliably pick the wrong one.
        let v = json!({ "thumbnails": [
            { "url": "https://x/primary.jpg" },
            { "url": "https://x/tiny.jpg", "width": 48, "height": 48 },
        ]});
        assert_eq!(pick_thumbnail(&v).unwrap(), "https://x/primary.jpg");
    }

    #[test]
    fn is_none_when_there_is_genuinely_nothing() {
        assert!(pick_thumbnail(&json!({})).is_none());
        assert!(pick_thumbnail(&json!({ "thumbnails": [] })).is_none());
        assert!(pick_thumbnail(&json!({ "thumbnails": [{ "url": "not-a-url" }] })).is_none());
    }
}

#[cfg(test)]
mod chapter_tests {
    use super::{parse_chapters, truncate_chars, MAX_DESCRIPTION_CHARS};
    use serde_json::json;

    #[test]
    fn reads_the_creators_own_chapters() {
        // The whole point: this app inferred chapters with an LLM while yt-dlp
        // had the real ones in a probe we already ran.
        let v = json!({ "chapters": [
            { "start_time": 0.0, "end_time": 61.0, "title": "Cold open" },
            { "start_time": 61.0, "end_time": 300.0, "title": "The interview" },
        ]});
        let got = parse_chapters(&v);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].time, 0.0);
        assert_eq!(got[1].title, "The interview");
    }

    #[test]
    fn sorts_by_start_time() {
        // Sites are not required to emit these in order and the timeline draws
        // them in the order it receives them.
        let v = json!({ "chapters": [
            { "start_time": 90.0, "title": "Second" },
            { "start_time": 10.0, "title": "First" },
        ]});
        let got = parse_chapters(&v);
        assert_eq!(got[0].title, "First");
        assert_eq!(got[1].title, "Second");
    }

    #[test]
    fn drops_a_malformed_chapter_rather_than_repairing_it() {
        // A marker in the WRONG place is worse than one marker fewer, and the
        // LLM fallback is right there for a source whose data is unusable.
        let v = json!({ "chapters": [
            { "start_time": 10.0, "title": "Good" },
            { "start_time": 20.0, "title": "   " },
            { "start_time": 30.0 },
            { "title": "No start time" },
            { "start_time": -5.0, "title": "Negative" },
            { "start_time": "not a number", "title": "Stringly typed" },
        ]});
        let got = parse_chapters(&v);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].title, "Good");
    }

    #[test]
    fn trims_chapter_titles() {
        let v = json!({ "chapters": [{ "start_time": 0.0, "title": "  Cold open  " }]});
        assert_eq!(parse_chapters(&v)[0].title, "Cold open");
    }

    #[test]
    fn is_empty_when_the_site_publishes_none() {
        // The common case for most of the web, and what keeps the LLM path alive.
        assert!(parse_chapters(&json!({})).is_empty());
        assert!(parse_chapters(&json!({ "chapters": [] })).is_empty());
        assert!(parse_chapters(&json!({ "chapters": null })).is_empty());
        assert!(parse_chapters(&json!({ "chapters": "nope" })).is_empty());
    }

    #[test]
    fn truncates_a_description_on_a_char_boundary() {
        // Bytes would slice a multi-byte character in half and produce a
        // string that cannot round-trip through JSON.
        let s = "→".repeat(MAX_DESCRIPTION_CHARS + 100);
        let cut = truncate_chars(&s, MAX_DESCRIPTION_CHARS);
        assert_eq!(cut.chars().count(), MAX_DESCRIPTION_CHARS);
        assert!(cut.chars().all(|c| c == '→'));
    }

    #[test]
    fn leaves_a_short_description_untouched() {
        assert_eq!(truncate_chars("hello", MAX_DESCRIPTION_CHARS), "hello");
    }
}

/// One cached web source, as the Library's web shelf needs it.
///
/// Built from the warm-start metadata the resolver already writes, so this
/// adds no new bookkeeping — it reads what "download once, reuse forever"
/// has been recording all along.
#[derive(Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct CachedWebItem {
    pub url: String,
    pub title: Option<String>,
    pub thumbnail: Option<String>,
    pub uploader: Option<String>,
    pub duration_seconds: Option<f64>,
    /// Unix seconds when the page was last resolved.
    #[ts(type = "number")]
    pub fetched_at: u64,
    /// The downloaded copy on disk, when there is one.
    pub path: Option<String>,
    #[ts(type = "number | null")]
    pub size_bytes: Option<u64>,
}

/// Every web source this machine has cached, newest metadata first.
///
/// METADATA-ONLY ENTRIES ARE INCLUDED ON PURPOSE. Most cached sources have no
/// downloaded copy — the app streams them and keeps only the resolve. Those
/// are still worth listing: re-opening one skips yt-dlp's extraction, which is
/// the ten-to-fifteen seconds the user actually feels. A shelf that showed
/// only the fully-downloaded ones would hide almost everything and would look
/// broken to someone who has watched forty clips.
///
/// A meta file that will not parse is SKIPPED rather than failing the batch:
/// one bad entry must not empty the shelf.
#[tauri::command]
pub async fn list_cached_web(app: AppHandle) -> Result<Vec<CachedWebItem>, crate::AppError> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| crate::AppError::internal(format!("app_cache_dir: {e}")))?;
    let dir = media_cache_dir(&cache, "meta");
    let Ok(entries) = std::fs::read_dir(&dir) else { return Ok(Vec::new()) };

    let mut out: Vec<CachedWebItem> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else { continue };
        let Ok(meta) = serde_json::from_slice::<SourceMeta>(&bytes) else { continue };
        let md = meta.metadata.as_ref();
        let copy = find_cached_download(&cache, &meta.url);
        let size = copy
            .as_ref()
            .and_then(|p| std::fs::metadata(p).ok())
            .map(|m| m.len());
        out.push(CachedWebItem {
            // `title` is a plain String on Metadata, not an Option: map, not and_then.
            title: md.map(|m| m.title.clone()),
            thumbnail: md.and_then(|m| m.thumbnail.clone()),
            uploader: md.and_then(|m| m.uploader.clone()),
            duration_seconds: md.and_then(|m| m.duration),
            fetched_at: meta.fetched_at.unwrap_or(0),
            path: copy.and_then(|p| p.to_str().map(String::from)),
            size_bytes: size,
            url: meta.url,
        });
    }
    // Descending by fetched_at, same as the sort_by it replaces: sorting
    // ascending on Reverse(x) IS descending on x, and both are stable sorts so
    // ties keep their original order. None sorts last either way.
    out.sort_by_key(|b| std::cmp::Reverse(b.fetched_at));
    Ok(out)
}

/// Forget one cached web source: its metadata and its downloaded copy.
///
/// Named "forget" rather than "delete" because the source itself is a URL on
/// the internet and is entirely unaffected — this reclaims disk and nothing
/// more. A missing file is success, not an error: the end state the caller
/// asked for is "this is not on my disk".
#[tauri::command]
pub async fn forget_cached_web(app: AppHandle, url: String) -> Result<(), crate::AppError> {
    validate_source_url(&url)?;
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| crate::AppError::internal(format!("app_cache_dir: {e}")))?;
    if let Some(p) = find_cached_download(&cache, &url) {
        let _ = std::fs::remove_file(p);
    }
    let _ = std::fs::remove_file(meta_path(&cache, &url));
    Ok(())
}
