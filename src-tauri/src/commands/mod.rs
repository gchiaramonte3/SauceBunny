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
    // Cap absurdly long URLs etc. so the UI hint stays scannable.
    if trimmed.len() > 400 {
        format!("{}…", &trimmed[..400])
    } else {
        trimmed
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

fn sidecar_path(name: &str) -> Result<PathBuf, crate::AppError> {
    let filename = format!("{}-{}", name, current_triple());
    if cfg!(debug_assertions) {
        let manifest = env!("CARGO_MANIFEST_DIR");
        Ok(PathBuf::from(manifest).join("binaries").join(filename))
    } else {
        let exe = std::env::current_exe()?;
        let dir = exe.parent().ok_or_else(|| crate::AppError::internal("exe has no parent"))?;
        Ok(dir.join(filename))
    }
}

/// Permissive URL validation — any http(s) URL with a real host is
/// accepted. yt-dlp's per-site extractors (or its `generic` fallback for
/// pages that just embed video) decide whether the source is actually
/// usable. We only enforce the bare minimum so the rest of the pipeline
/// gets a parseable URL instead of a malformed string.
fn validate_source_url(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|_| "Not a valid URL".to_string())?;
    if parsed.scheme() != "https" && parsed.scheme() != "http" {
        return Err("URL must be http(s)".into());
    }
    if parsed.host_str().unwrap_or("").is_empty() {
        return Err("URL has no host".into());
    }
    Ok(())
}

// HH:MM:SS:FF (frame-accurate) → fractional seconds. Falls back to HH:MM:SS.
fn timecode_to_seconds(tc: &str, fps: f64) -> Result<f64, String> {
    let parts: Vec<&str> = tc.trim().split(':').collect();
    if parts.is_empty() || parts.len() > 4 {
        return Err(format!("Invalid timecode: {tc}"));
    }
    let mut nums: Vec<u32> = Vec::with_capacity(parts.len());
    for p in &parts {
        let n: u32 = p
            .parse()
            .map_err(|_| format!("Invalid timecode: {tc}"))?;
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
        return Err(format!("Invalid timecode: {tc}"));
    }
    let fps = if fps > 0.0 { fps } else { 24.0 };
    if f as f64 >= fps {
        return Err(format!("Frame index {f} out of range for {fps:.3} fps"));
    }
    let seconds = h as f64 * 3600.0 + m as f64 * 60.0 + s as f64 + (f as f64 / fps);
    Ok(seconds)
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
    cleaned.trim_matches('.').to_string()
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










































































