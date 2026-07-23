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
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_shell::{
    process::{CommandChild, CommandEvent},
    ShellExt,
};
use tokio::io::AsyncWriteExt;

pub mod system;
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
pub mod session;
pub use session::*;
pub mod library;
pub use library::*;




// Helpers shared across spawn commands.
fn is_ytdlp_progress(line: &str) -> bool {
    let l = line.trim_start();
    l.starts_with("[download]") && l.contains('%')
}




/// Ensure spawned binaries can find Homebrew tools (deno, ffmpeg's runtime
/// libs, etc.) regardless of how the .app was launched.
const HOMEBREW_PATH: &str = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

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

/// Permissive URL validation — any http(s) URL with a real host is
/// accepted. yt-dlp's per-site extractors (or its `generic` fallback for
/// pages that just embed video) decide whether the source is actually
/// usable. We only enforce the bare minimum so the rest of the pipeline
/// gets a parseable URL instead of a malformed string.
fn validate_source_url(url: &str) -> Result<(), crate::AppError> {
    let parsed =
        url::Url::parse(url).map_err(|_| crate::AppError::invalid("Not a valid URL"))?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err(crate::AppError::invalid("URL must be http(s)"));
    }
    if parsed.host_str().unwrap_or("").is_empty() {
        return Err(crate::AppError::invalid("URL has no host"));
    }
    Ok(())
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
        _ => unreachable!(),
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
