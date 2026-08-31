//! Tauri command surface, organised by domain.
//!
//! Submodules each own a slice of the invoke API + their domain-local
//! helpers. mod.rs holds the cross-cutting helpers (`short_err`,
//! `sidecar_path`, `current_triple`, `HOMEBREW_PATH`, `validate_source_url`,
//! `timecode_to_seconds`, `sanitize_filename`, `find_audio_in_cache`,
//! `is_ytdlp_progress`, `is_ffmpeg_progress`, `parse_ffmpeg_time`) and the
//! shared event types (`LogEvent`, `ProgressEvent`, `DoneEvent`) that
//! flow through every long-running pipeline.
//!
//! mod.rs re-exports every submodule via `pub use foo::*;` so `lib.rs`
//! can keep its existing `commands::foo` invoke-handler paths unchanged.
//!
//! r47 split (2026-05-24) — before this the entire backend was one
//! 4155-line file. See CLAUDE.md refactor priority #1.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use tokio::io::AsyncWriteExt;

pub mod sniff;
pub use sniff::*;
pub mod frames;
pub use frames::*;
pub mod tags;
pub mod system;
pub use tags::*;
pub use system::*;
pub mod download;
pub use download::*;
pub mod media;
pub use media::*;
pub mod transcript;
pub use transcript::*;
pub mod llm;
pub use llm::*;
pub mod cloud_ai;
pub use cloud_ai::*;
pub mod session_key;
pub use session_key::*;
// Tier B bridge (no invoke commands of its own; used by stream_proxy + session).
pub mod peer_stream;
// Tier B quality ladder (host half of src/lib/stream-rung.ts).
pub mod rung;
pub mod session;
pub use session::*;
pub mod library;
pub use library::*;




// Helpers shared across spawn commands.
fn is_ytdlp_progress(line: &str) -> bool {
    let l = line.trim_start();
    l.starts_with("[download]") && l.contains('%')
}




/// The OS's own directories. Always present, never ours to shadow.
const SYSTEM_PATH: &str = "/usr/bin:/bin:/usr/sbin:/sbin";

/// Homebrew, and it goes LAST.
///
/// One tool genuinely justifies its presence: yt-dlp's `web` player client
/// deobfuscates YouTube's `nsig` with a JS runtime, and without `deno` on PATH
/// it silently degrades to lower-resolution clients (see `YT_EXTRACTOR_ARGS`).
/// We cannot bundle deno, so if the user has it we should find it.
///
/// It used to come FIRST, which handed `/opt/homebrew/bin` and `/usr/local/bin`
/// the ability to shadow every tool a spawned yt-dlp resolves by name. Two
/// distinct problems, and neither is hypothetical:
///
///   · Correctness. Our ffmpeg is built with libzimg because the 10-bit/HDR
///     playback prep emits zscale/tonemap chains that swscale cannot do, and
///     `check:release` refuses to ship one without it. A Homebrew ffmpeg has
///     no such guarantee, so any spawn that did not pass `--ffmpeg-location`
///     explicitly behaved differently on a machine with Homebrew installed
///     than on a clean one. Seven of the ~14 yt-dlp spawn sites passed that
///     flag; the rest inherited whatever was first on PATH.
///
///   · Integrity. `/opt/homebrew/bin` is owned by the installing USER
///     wherever Homebrew is present, which on an Apple Silicon Mac is the
///     whole of `/opt/homebrew`. (`/usr/local/bin` is the same story on an
///     Intel or Rosetta Homebrew; on a native arm64 install it is normally
///     absent or root:wheel, so it is here for completeness rather than
///     because it is the exposure.) A signed, notarized app that puts a
///     user-writable directory ahead of its own binaries will execute an
///     attacker-planted `ffmpeg` with its own entitlements — including the
///     microphone, camera and screen-recording grants this app holds. That
///     is precisely the property the `otool -L`
///     self-containment guard rails and sidecars.lock.json exist to protect.
///
/// Last place keeps deno reachable and makes shadowing impossible.
const HOMEBREW_PATH: &str = "/opt/homebrew/bin:/usr/local/bin";

/// The directory holding the bundled sidecars, when PATH lookup can actually
/// find them there.
///
/// In a packaged .app that is `Contents/MacOS`, where Tauri strips the target
/// triple, so `ffmpeg` and `ffprobe` are plain-named and resolvable by name.
/// In a debug build the binaries live in `src-tauri/binaries` still carrying
/// the `-aarch64-apple-darwin` suffix, so a lookup for `ffmpeg` finds nothing
/// and dev falls through to whatever is installed. That is the dev behaviour
/// we want, so this returns the directory in both cases and lets the name
/// mismatch do the work.
pub(crate) fn sidecar_dir() -> Option<PathBuf> {
    sidecar_path("ffmpeg").ok()?.parent().map(PathBuf::from)
}

/// Pure (unit-tested): compose the PATH a spawned sidecar sees.
///
/// Order is the whole point. Ours first, the OS next, Homebrew last.
fn compose_spawn_path(updated_bin: Option<&Path>, sidecars: Option<&Path>) -> String {
    let mut parts: Vec<String> = Vec::with_capacity(4);
    if let Some(p) = updated_bin {
        parts.push(p.display().to_string());
    }
    if let Some(p) = sidecars {
        parts.push(p.display().to_string());
    }
    parts.push(SYSTEM_PATH.to_string());
    parts.push(HOMEBREW_PATH.to_string());
    parts.join(":")
}

#[cfg(test)]
mod spawn_path_tests {

    /// `is_ytdlp_progress` decides whether a stdout line is PROGRESS NOISE or
    /// something worth keeping. Three call sites depend on it, and it had no
    /// test.
    ///
    /// Both failure directions are real. Stop recognising progress and the
    /// pipeline log fills with hundreds of near-identical percentage lines,
    /// burying the one line that says why a download failed. Recognise too
    /// much and a genuine error carrying a percentage is swallowed silently.
    #[test]
    fn ytdlp_progress_lines_are_recognised() {
        // The canary: a predicate that always said false would satisfy every
        // rejection below.
        assert!(is_ytdlp_progress("[download]  45.2% of 123.45MiB at 1.23MiB/s ETA 00:59"));
        assert!(is_ytdlp_progress("[download] 100% of 12.00MiB in 00:03"));
        // yt-dlp indents some lines; the check trims first.
        assert!(is_ytdlp_progress("   [download]   0.0% of ~1.00GiB at Unknown B/s"));
    }

    #[test]
    fn other_lines_are_kept() {
        // A destination line has the tag but no percentage — it is worth
        // logging once, so it must NOT be treated as noise.
        assert!(!is_ytdlp_progress("[download] Destination: /tmp/video.mp4"));
        // An error carrying a percentage must survive: it is not a
        // [download] line, and swallowing it would hide the reason a job died.
        assert!(!is_ytdlp_progress("ERROR: fragment 3 failed, 45% complete"));
        assert!(!is_ytdlp_progress("[info] Writing metadata"));
        assert!(!is_ytdlp_progress(""));
    }

    use super::*;

    fn dirs(path: &str) -> Vec<&str> {
        path.split(':').collect()
    }

    #[test]
    fn ours_comes_before_homebrew() {
        let p = compose_spawn_path(None, Some(Path::new("/Apps/X.app/Contents/MacOS")));
        let d = dirs(&p);
        let ours = d.iter().position(|s| s.contains("Contents/MacOS")).unwrap();
        let brew = d.iter().position(|s| *s == "/opt/homebrew/bin").unwrap();
        assert!(ours < brew, "bundled sidecars must win over Homebrew: {p}");
    }

    #[test]
    fn homebrew_is_last_so_it_can_shadow_nothing() {
        let p = compose_spawn_path(
            Some(Path::new("/data/bin")),
            Some(Path::new("/Apps/X.app/Contents/MacOS")),
        );
        let d = dirs(&p);
        // Every writable-by-the-user Homebrew dir sits after every other dir.
        let brew_first = d.iter().position(|s| *s == "/opt/homebrew/bin").unwrap();
        assert_eq!(
            brew_first,
            d.len() - 2,
            "only /usr/local/bin may follow /opt/homebrew/bin: {p}"
        );
        assert_eq!(d.last(), Some(&"/usr/local/bin"));
    }

    #[test]
    fn a_user_updated_ytdlp_still_outranks_the_bundled_one() {
        let p = compose_spawn_path(
            Some(Path::new("/data/bin")),
            Some(Path::new("/Apps/X.app/Contents/MacOS")),
        );
        assert!(p.starts_with("/data/bin:"), "{p}");
    }

    #[test]
    fn the_system_is_always_reachable() {
        for p in [
            compose_spawn_path(None, None),
            compose_spawn_path(Some(Path::new("/data/bin")), None),
        ] {
            for d in ["/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
                assert!(dirs(&p).contains(&d), "missing {d} in {p}");
            }
        }
    }

    #[test]
    fn deno_stays_reachable() {
        // The one thing Homebrew is here for. If a future edit drops these
        // entries, YouTube quietly stops offering 1080p+ and nothing errors.
        let p = compose_spawn_path(None, None);
        assert!(dirs(&p).contains(&"/opt/homebrew/bin"), "{p}");
        assert!(dirs(&p).contains(&"/usr/local/bin"), "{p}");
    }
}

/// Pull the most actionable line out of a stderr blob — usually the last
/// non-empty, non-WARNING line. yt-dlp and ffmpeg both append the real error
/// at the end after a long warning preamble.
fn short_err(stderr: &str) -> String {
    let trimmed: String = stderr
        .lines()
        .rev()
        .find(|l| {
            let t = l.trim();
            !t.is_empty() && !t.starts_with("WARNING")
        })
        .unwrap_or(stderr.trim())
        .trim()
        .to_string();
    // Cap absurdly long URLs etc. so the UI hint stays scannable. Truncate on a
    // CHAR boundary — yt-dlp/ffmpeg error lines carry multibyte UTF-8 (CJK/emoji
    // titles, curly quotes), and byte-slicing mid-codepoint panics, which would
    // kill the spawned task right as it tries to report a failure (UI hangs).
    if trimmed.len() > 400 {
        let mut end = 400;
        while end > 0 && !trimmed.is_char_boundary(end) { end -= 1; }
        format!("{}…", &trimmed[..end])
    } else {
        trimmed
    }
}








/// Human duration for the pipeline log, so a user can read (and paste back)
/// how long a stage actually took: "820ms", "45.2s", "6m 08s", "1h 04m".
/// Tuned for reporting, not precision - the unit steps down as the number
/// grows so the string stays short and scannable.
pub(crate) fn fmt_elapsed(d: std::time::Duration) -> String {
    let ms = d.as_millis();
    if ms < 1000 {
        return format!("{ms}ms");
    }
    let secs = d.as_secs_f64();
    if secs < 60.0 {
        return format!("{secs:.1}s");
    }
    let total = d.as_secs();
    let (h, m, s) = (total / 3600, (total % 3600) / 60, total % 60);
    if h > 0 {
        format!("{h}h {m:02}m")
    } else {
        format!("{m}m {s:02}s")
    }
}

#[cfg(test)]
mod elapsed_tests {
    use super::fmt_elapsed;
    use std::time::Duration;

    #[test]
    fn reads_naturally_at_every_scale() {
        assert_eq!(fmt_elapsed(Duration::from_millis(820)), "820ms");
        assert_eq!(fmt_elapsed(Duration::from_millis(45_200)), "45.2s");
        assert_eq!(fmt_elapsed(Duration::from_secs(368)), "6m 08s");
        assert_eq!(fmt_elapsed(Duration::from_secs(3840)), "1h 04m");
        // Boundaries stay on the right side of each unit switch.
        assert_eq!(fmt_elapsed(Duration::from_millis(999)), "999ms");
        assert_eq!(fmt_elapsed(Duration::from_secs(59)), "59.0s");
        assert_eq!(fmt_elapsed(Duration::from_secs(60)), "1m 00s");
    }
}

fn current_triple() -> &'static str {
    if cfg!(all(target_arch = "aarch64", target_os = "macos")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_arch = "x86_64", target_os = "macos")) {
        "x86_64-apple-darwin"
    } else {
        "unsupported"
    }
}

pub(crate) fn sidecar_path(name: &str) -> Result<PathBuf, crate::AppError> {
    let filename = format!("{}-{}", name, current_triple());
    if cfg!(debug_assertions) {
        let manifest = env!("CARGO_MANIFEST_DIR");
        Ok(PathBuf::from(manifest).join("binaries").join(filename))
    } else {
        let exe = std::env::current_exe()?;
        let dir = exe.parent().ok_or_else(|| crate::AppError::internal("exe has no parent"))?;
        // Tauri STRIPS the target triple when copying externalBin next to the
        // executable, so the bundled file is the PLAIN name (`ffmpeg`, not
        // `ffmpeg-aarch64-apple-darwin`). Prefer the plain name; fall back to
        // the suffixed name only for layouts that keep it. Without this, every
        // sidecar call (export / transcription / download) hard-fails in the
        // packaged .dmg while dev (debug branch, suffixed repo binaries) works.
        let plain = dir.join(name);
        if plain.is_file() {
            Ok(plain)
        } else {
            Ok(dir.join(filename))
        }
    }
}

/// Source-URL validation for every path that hands a URL to yt-dlp.
///
/// Deliberately permissive about SITES — yt-dlp's per-site extractors (or its
/// `generic` fallback for pages that just embed video) decide whether a source
/// is usable, and second-guessing that list here would only break sources.
///
/// NOT permissive about ADDRESSES. A URL reaching this function is not always
/// something the user typed: in a co-review session the presenter's
/// `LoadSource` is fetched automatically by every guest, so a hostile (or
/// merely careless) presenter could otherwise aim each guest's yt-dlp at that
/// guest's OWN loopback services or LAN devices — with their browser cookie
/// jar attached if they enabled the cookies setting. The proxy already had
/// exactly the right check for this (`is_safe_upstream`: no loopback, RFC1918,
/// link-local, unique-local, `.local`/`.localhost`, no embedded credentials),
/// and it was simply never consulted here. One implementation, both callers,
/// and the proxy's 16-URL hostile-input test now covers this path too.
fn validate_source_url(url: &str) -> Result<(), crate::AppError> {
    let parsed =
        url::Url::parse(url).map_err(|_| crate::AppError::invalid("Not a valid URL"))?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err(crate::AppError::invalid("URL must be http(s)"));
    }
    if parsed.host_str().unwrap_or("").is_empty() {
        return Err(crate::AppError::invalid("URL has no host"));
    }
    if !crate::stream_proxy::is_safe_upstream(url) {
        return Err(crate::AppError::invalid(
            "Sauce Bunny only opens public web addresses. That link points at this machine or your local network.",
        ));
    }
    Ok(())
}

/// Grant the webview `asset://` read access to ONE file it is about to be
/// handed.
///
/// The static scope in tauri.conf.json is `$APPCACHE/**`: every artifact the
/// app writes for itself (poster JPEGs, ffmpeg playback copies, downloaded
/// sources, cached audio). It cannot cover the user's OWN media, whose paths
/// are arbitrary and known only at runtime — which is why the scope used to be
/// `**`, i.e. the entire filesystem readable by anything running in the
/// webview.
///
/// Tauri 2's asset scope is live and shared: `asset_protocol_scope()` hands
/// back a Scope whose inner Arc is the same one the protocol handler holds, so
/// a narrow static list plus a per-file grant has the reach of `**` for real
/// usage and none of its blast radius. Both windows see it; the scope is
/// app-wide, not per-webview.
///
/// Deliberately called from ONE place (`probe_local_file`), the command every
/// local source in the app passes through. Do NOT add grants to the thumbnail
/// commands: those run per library item, `Scope::is_allowed` is a linear glob
/// scan on every asset request, and a few hundred library items would put that
/// scan on the byte-range path during playback.
pub(crate) fn allow_asset_read(app: &AppHandle, path: &std::path::Path) {
    let scope = app.asset_protocol_scope();
    // Already covered (anything in the cache, or a source re-opened this
    // session): return before touching the pattern set, so it grows with
    // sources opened rather than with calls made.
    if scope.is_allowed(path) {
        return;
    }
    if let Err(e) = scope.allow_file(path) {
        eprintln!("[asset-scope] could not grant {}: {e}", path.display());
        return;
    }
    // A denied asset read is HTTP 403 with an EMPTY body, so it surfaces as a
    // black video or a broken thumbnail and never as an error. If the grant
    // did not take, say so HERE, at open time, while the path is still in
    // hand. The known case is a symlink with a RELATIVE target: Tauri reads
    // the link before canonicalizing, so the relative target misses every
    // absolute pattern. Playback still works (the native player errors into
    // the mediabunny path, which reads through IPC and is not scope-gated),
    // but this line is the difference between a diagnosable slow path and a
    // mystery.
    if !scope.is_allowed(path) {
        eprintln!(
            "[asset-scope] granted {} but the scope still refuses it (relative symlink?)",
            path.display(),
        );
    }
}

// HH:MM:SS:FF (frame-accurate) → fractional seconds. Falls back to HH:MM:SS.
fn timecode_to_seconds(tc: &str, fps: f64) -> Result<f64, crate::AppError> {
    let parts: Vec<&str> = tc.trim().split(':').collect();
    if parts.is_empty() || parts.len() > 4 {
        return Err(crate::AppError::invalid(format!("Invalid timecode: {tc}")));
    }
    let mut nums: Vec<u32> = Vec::with_capacity(parts.len());
    for p in &parts {
        let n: u32 = p
            .parse()
            .map_err(|_| crate::AppError::invalid(format!("Invalid timecode: {tc}")))?;
        nums.push(n);
    }
    // Pad to [HH, MM, SS, FF] depending on length.
    let (h, m, s, f) = match nums.len() {
        4 => (nums[0], nums[1], nums[2], nums[3]),
        3 => (nums[0], nums[1], nums[2], 0),
        2 => (0, nums[0], nums[1], 0),
        1 => (0, 0, nums[0], 0),
        // Unreachable today: the guard above rejects anything outside 1..=4.
        // It returns the same error rather than panicking so that the guard
        // and this match cannot drift apart - widen the guard to five parts
        // and a panic on typed input is the only thing that tells you.
        _ => return Err(crate::AppError::invalid(format!("Invalid timecode: {tc}"))),
    };
    if m >= 60 || s >= 60 {
        return Err(crate::AppError::invalid(format!("Invalid timecode: {tc}")));
    }
    let fps = if fps > 0.0 { fps } else { 24.0 };
    if f as f64 >= fps {
        return Err(crate::AppError::invalid(format!(
            "Frame index {f} out of range for {fps:.3} fps"
        )));
    }
    let seconds = h as f64 * 3600.0 + m as f64 * 60.0 + s as f64 + (f as f64 / fps);
    Ok(seconds)
}

/// Byte budget for the user-visible BASE filename. macOS/APFS caps a full
/// filename at 255 UTF-8 BYTES; 180 leaves room for uniquing suffixes
/// ("-12"), pipeline suffixes, and extensions. MIRRORED in
/// src/lib/filename.ts MAX_BASE_BYTES — keep both in sync (vitest parity
/// cases pin the shared behavior).
pub(crate) const MAX_BASE_BYTES: usize = 180;

/// Truncate to a UTF-8 byte budget WITHOUT splitting a multi-byte character.
pub(crate) fn truncate_utf8_bytes(s: &str, max: usize) -> &str {
    if s.len() <= max {
        return s;
    }
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

fn sanitize_filename(name: &str) -> String {
    let trimmed = name.trim();
    let cleaned: String = trimmed
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let cleaned = cleaned.trim_matches('.');
    // Enforce the byte budget here so EVERY consumer (create_clip, the
    // download path) inherits it; trailing separators left by the cut are
    // noise, not meaning.
    truncate_utf8_bytes(cleaned, MAX_BASE_BYTES)
        .trim_end_matches(['-', '_', '.', ' '])
        .to_string()
}



#[derive(Serialize, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub(crate) struct LogEvent {
    pub(crate) job_id: String,
    pub(crate) stream: String,
    pub(crate) tag: String,
    pub(crate) line: String,
}

#[derive(Serialize, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub(crate) struct ProgressEvent {
    pub(crate) job_id: String,
    pub(crate) percent: f64,
}

#[derive(Serialize, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub(crate) struct DoneEvent {
    pub(crate) job_id: String,
    pub(crate) success: bool,
    pub(crate) code: Option<i32>,
    pub(crate) path: Option<String>,
    pub(crate) error: Option<String>,
}











































































#[cfg(test)]
mod tests {
    use super::short_err;

    #[test]
    fn short_err_picks_last_meaningful_line() {
        let blob = "WARNING: something benign\nERROR: the real problem\n\n";
        assert_eq!(short_err(blob), "ERROR: the real problem");
    }

    #[test]
    fn short_err_falls_back_to_whole_blob_when_all_warnings() {
        let blob = "WARNING: only warnings here";
        assert_eq!(short_err(blob), blob);
    }

    // Regression: byte-slicing at 400 mid-codepoint panicked, killing the
    // task right as it tried to report a failure (UI hung forever).
    #[test]
    fn short_err_truncates_multibyte_on_char_boundary() {
        // 200 × '→' (3 bytes each) = 600 bytes; byte 400 lands mid-codepoint.
        let long: String = "→".repeat(200);
        let out = short_err(&long);
        assert!(out.ends_with('…'));
        assert!(out.len() <= 404); // ≤400 content bytes + the ellipsis
        // Must be valid UTF-8 end to end (would have panicked before the fix).
        assert!(out.chars().all(|c| c == '→' || c == '…'));
    }

    #[test]
    fn short_err_leaves_short_messages_alone() {
        assert_eq!(short_err("tiny"), "tiny");
        assert_eq!(short_err(""), "");
    }
}

#[cfg(test)]
mod source_url_tests {
    use super::validate_source_url;

    #[test]
    fn public_video_urls_still_pass() {
        for url in [
            "https://www.youtube.com/watch?v=abc123",
            "https://vimeo.com/12345",
            "http://example.com/clip.mp4",
            "https://v.redd.it/xyz/DASH_720.mp4",
        ] {
            assert!(validate_source_url(url).is_ok(), "should accept {url}");
        }
    }

    #[test]
    fn a_presenter_cannot_aim_a_guests_ytdlp_at_the_guests_own_machine() {
        // Every one of these is auto-fetched by each guest when a co-review
        // presenter sends LoadSource, with the guest's browser cookies
        // attached if they enabled that setting. None may reach yt-dlp.
        for url in [
            "http://127.0.0.1:11434/api/tags",       // a local LLM server
            "http://localhost:51314/v1/models",      // our own llama-server
            "http://[::1]:8080/",                    // loopback v6
            "http://192.168.1.1/cgi-bin/admin",      // the router
            "http://10.0.0.5/nas/private.mp4",       // RFC1918
            "http://169.254.169.254/latest/meta-data/", // link-local metadata
            "http://nas.local/vault",                // mDNS
            "http://user:pass@example.com/x.mp4",    // embedded credentials
            "file:///etc/passwd",                    // not http(s)
        ] {
            assert!(validate_source_url(url).is_err(), "must refuse {url}");
        }
    }
}
