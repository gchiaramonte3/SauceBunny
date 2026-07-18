//! System-level commands and cross-cutting infra.
//!
//! Lives here:
//!   - JobRegistry — tracks live sidecar child processes for cancellation.
//!   - Cache management — disk-cache stats, sweep, full clear.
//!   - Generic file-system commands used across the app (read_text_file_capped,
//!     write_bytes_to_path, reveal_in_finder, ensure_dir_exists, defaults).
//!   - Build-ID handshake (BACKEND_BUILD_ID + get_backend_build_id).
//!   - Multi-window plumbing (open_panel_window, close_panel_window).
//!
//! Extracted from the 4155-line commands.rs monolith in r47 per the
//! constitution's refactor priority #1. Sibling modules: download,
//! media, transcript.

use super::*;

// ============================================================
// JOB REGISTRY — tracks live child processes so the UI can
// cancel them via a single `cancel_job(job_id)` command.
// ============================================================
#[derive(Default)]
pub struct JobRegistry {
    children: Mutex<HashMap<String, CommandChild>>,
}

impl JobRegistry {
    // `pub(crate)` so sibling commands modules (download, media,
    // transcript) can register their spawned children. Private was
    // fine when commands.rs was a monolith (r47 split exposed this).
    pub(crate) fn insert(&self, id: String, child: CommandChild) {
        if let Ok(mut g) = self.children.lock() {
            g.insert(id, child);
        }
    }
    pub(crate) fn take(&self, id: &str) -> Option<CommandChild> {
        self.children.lock().ok()?.remove(id)
    }
    /// Write to a live child's stdin WITHOUT removing it from the registry.
    /// Used by voice dictation to send ffmpeg the interactive `q` command,
    /// which makes it finalize the WAV header and exit GRACEFULLY (a plain
    /// `.kill()`/SIGKILL would truncate the RIFF header → unreadable WAV).
    /// The child stays registered until its drain task sees Terminated and
    /// `take()`s it. Returns false if no such job is live.
    pub(crate) fn write_stdin(&self, id: &str, buf: &[u8]) -> bool {
        if let Ok(mut g) = self.children.lock() {
            if let Some(child) = g.get_mut(id) {
                return child.write(buf).is_ok();
            }
        }
        false
    }
    /// Snapshot of currently-active job IDs. Used by `clear_all_cache`
    /// to skip files belonging to in-flight jobs (would otherwise pull
    /// the file out from under an ffmpeg/yt-dlp child mid-write).
    pub(crate) fn active_ids(&self) -> Vec<String> {
        self.children
            .lock()
            .ok()
            .map(|g| g.keys().cloned().collect())
            .unwrap_or_default()
    }
}

#[tauri::command]
pub fn cancel_job(registry: State<'_, JobRegistry>, job_id: String) -> Result<bool, crate::AppError> {
    if let Some(child) = registry.take(&job_id) {
        child.kill().map_err(|e| format!("kill failed: {e}"))?;
        Ok(true)
    } else {
        Ok(false)
    }
}

// ============================================================
// CACHE SWEEP + MEDIA-CACHE LAYOUT (r112)
// Every transient artifact we write to app_cache_dir() shares the
// `saucebunny-` prefix (playback prep copies, whisper wavs, in-flight
// download temps, etc). On startup we glob that prefix and delete anything
// older than 24 hours so the cache can't grow unbounded across sessions.
//
// Deliberately-REUSABLE artifacts are different: full downloaded source
// copies, cached audio tracks, and the warm-boot metadata files are
// "download once, reuse forever" by design — the sweep used to destroy
// them, defeating that design. They now live under an organized,
// sweep-exempt subtree:
//
//   app_cache_dir()/saucebunny-media/
//     downloads/   full source copies   (saucebunny-download-<urlhash>.<ext>)
//     audio/       cached audio tracks  (saucebunny-audio-<urlhash>.<ext>)
//     meta/        warm-boot metadata   (<urlhash>.json — see download.rs)
//
// The user still has full control: Settings → Cache shows per-category
// sizes with per-category Clear buttons (everything regenerates). No
// automatic size caps.
// ============================================================
const CACHE_TTL_SECONDS: u64 = 24 * 60 * 60;

/// Directory name of the sweep-exempt media cache under `app_cache_dir()`.
pub(crate) const MEDIA_CACHE_DIRNAME: &str = "saucebunny-media";

/// A subdirectory of the persistent media cache ("downloads" / "audio" /
/// "meta"). Does not create it — writers `create_dir_all` before writing.
pub(crate) fn media_cache_dir(cache_root: &std::path::Path, sub: &str) -> PathBuf {
    cache_root.join(MEDIA_CACHE_DIRNAME).join(sub)
}

/// Per-category slice of the cache, for the Settings breakdown.
#[derive(serde::Serialize, Default, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct CacheCategoryStats {
    pub file_count: u32,
    // See Metadata::view_count for the bigint→number rationale (r49).
    #[ts(type = "number")]
    pub bytes_total: u64,
}

/// Cache stats for the Settings UI. `file_count`/`bytes_total` are the grand
/// totals across every category; the named fields break them down so the
/// user can see (and clear) each kind independently:
///   - `downloads` / `audio` / `meta` — the persistent media cache (r112).
///   - `thumbnails` — the keyed `saucebunny-thumb-*` files in the cache root.
///   - `scratch` — every other `saucebunny-*` root file (job temps, playback
///     prep copies, whisper wavs); the 24h startup sweep owns these.
///
/// The `path` field surfaces the cache location in Settings so users
/// can find / reveal it. Settable-from-Settings is r40 work; r39 just
/// shows where files land.
#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct CacheStats {
    pub file_count: u32,
    // See Metadata::view_count for the bigint→number rationale (r49).
    #[ts(type = "number")]
    pub bytes_total: u64,
    pub path: String,
    pub downloads: CacheCategoryStats,
    pub audio: CacheCategoryStats,
    pub meta: CacheCategoryStats,
    pub thumbnails: CacheCategoryStats,
    pub scratch: CacheCategoryStats,
}

/// Flat (non-recursive) file count + byte total of one directory.
fn dir_category_stats(dir: &std::path::Path) -> CacheCategoryStats {
    let mut out = CacheCategoryStats::default();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let meta = match entry.metadata() { Ok(m) => m, Err(_) => continue };
            if meta.is_dir() { continue; }
            out.file_count += 1;
            out.bytes_total += meta.len();
        }
    }
    out
}

#[tauri::command]
pub fn get_cache_stats(app: AppHandle) -> Result<CacheStats, crate::AppError> {
    // Proof-of-concept migration for r50 — first command on the typed-error
    // (AppError) surface. See CLAUDE.md refactor priority #4. The migration
    // completed in r108: every command + helper now returns
    // `Result<T, AppError>`.
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| crate::AppError::internal(format!("app_cache_dir: {e}")))?;
    let path = cache.to_string_lossy().to_string();

    let downloads = dir_category_stats(&media_cache_dir(&cache, "downloads"));
    let audio = dir_category_stats(&media_cache_dir(&cache, "audio"));
    let meta_cat = dir_category_stats(&media_cache_dir(&cache, "meta"));
    let mut thumbnails = CacheCategoryStats::default();
    let mut scratch = CacheCategoryStats::default();
    if let Ok(entries) = std::fs::read_dir(&cache) {
        for entry in entries.flatten() {
            let name = match entry.file_name().to_str() {
                Some(n) => n.to_string(),
                None => continue,
            };
            if !name.starts_with("saucebunny-") { continue; }
            let meta = match entry.metadata() { Ok(m) => m, Err(_) => continue };
            if meta.is_dir() { continue; }
            let bucket = if name.starts_with("saucebunny-thumb-") { &mut thumbnails } else { &mut scratch };
            bucket.file_count += 1;
            bucket.bytes_total += meta.len();
        }
    }
    let file_count = downloads.file_count + audio.file_count + meta_cat.file_count
        + thumbnails.file_count + scratch.file_count;
    let bytes_total = downloads.bytes_total + audio.bytes_total + meta_cat.bytes_total
        + thumbnails.bytes_total + scratch.bytes_total;
    Ok(CacheStats {
        file_count,
        bytes_total,
        path,
        downloads,
        audio,
        meta: meta_cat,
        thumbnails,
        scratch,
    })
}

/// Purge `saucebunny-*` cache files. Files whose names contain a currently-
/// active job ID are SKIPPED so we don't yank the rug out from under an
/// in-flight ffmpeg playback prep / audio download / etc — those would
/// otherwise complete and emit "saved" pointing at a file we just deleted.
///
/// `exclude`: full filesystem paths the CURRENT session is actively playing
/// from (web download-cache file, audio-master track, playback-prep copy).
/// Those were produced by jobs that already finished — the JobRegistry no
/// longer knows about them — so without this list, Clear cache would delete
/// the file backing the video that's on screen right now.
#[tauri::command]
pub fn clear_all_cache(
    app: AppHandle,
    registry: State<'_, JobRegistry>,
    exclude: Option<Vec<String>>,
) -> Result<u32, crate::AppError> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("app_cache_dir: {e}"))?;
    if !cache.is_dir() {
        return Ok(0);
    }
    // Snapshot active job IDs so we can match them against filenames
    // below. Holding the registry lock for the whole scan would be fine
    // (clear-cache is rare) but a snapshot is simpler and lock-free.
    let active: std::collections::HashSet<String> = registry.active_ids().into_iter().collect();
    let excluded: std::collections::HashSet<String> = exclude.unwrap_or_default().into_iter().collect();
    let mut removed: u32 = 0;
    if let Ok(entries) = std::fs::read_dir(&cache) {
        for entry in entries.flatten() {
            let name = match entry.file_name().to_str() {
                Some(n) => n.to_string(),
                None => continue,
            };
            if !name.starts_with("saucebunny-") { continue; }
            let meta = match entry.metadata() { Ok(m) => m, Err(_) => continue };
            if meta.is_dir() { continue; }
            removed += remove_cache_file(&entry.path(), &name, &active, &excluded);
        }
    }
    // "Clear all" really means all: the persistent media cache (downloads /
    // audio / meta) is sweep-EXEMPT but user-clearable — everything in it
    // regenerates on demand.
    for sub in ["downloads", "audio", "meta"] {
        removed += remove_files_in_dir(&media_cache_dir(&cache, sub), &active, &excluded);
    }
    Ok(removed)
}

/// Delete one cache file unless an in-flight job is writing it or the
/// current session is playing from it. Returns 1 on delete, 0 otherwise.
fn remove_cache_file(
    path: &std::path::Path,
    name: &str,
    active: &std::collections::HashSet<String>,
    excluded: &std::collections::HashSet<String>,
) -> u32 {
    if active.iter().any(|jid| name.contains(jid)) {
        // In-flight job is writing to this file — skip.
        return 0;
    }
    if excluded.contains(&path.to_string_lossy().to_string()) {
        // The current session is playing from this file — skip.
        return 0;
    }
    u32::from(std::fs::remove_file(path).is_ok())
}

/// Delete every file (flat, no recursion) in `dir`, honoring the same
/// active-job and exclusion guards as `clear_all_cache`.
fn remove_files_in_dir(
    dir: &std::path::Path,
    active: &std::collections::HashSet<String>,
    excluded: &std::collections::HashSet<String>,
) -> u32 {
    let mut removed: u32 = 0;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = match entry.file_name().to_str() {
                Some(n) => n.to_string(),
                None => continue,
            };
            let meta = match entry.metadata() { Ok(m) => m, Err(_) => continue };
            if meta.is_dir() { continue; }
            removed += remove_cache_file(&entry.path(), &name, &active, &excluded);
        }
    }
    removed
}

/// Clear ONE cache category (Settings → Cache row buttons). Categories:
///   - "downloads" / "audio" / "meta" — the persistent media cache dirs.
///   - "thumbnails" — keyed `saucebunny-thumb-*` files in the cache root.
/// Clearing is always safe: every artifact regenerates on demand. The same
/// active-job / currently-playing guards as `clear_all_cache` apply.
#[tauri::command]
pub fn clear_cache_category(
    app: AppHandle,
    registry: State<'_, JobRegistry>,
    category: String,
    exclude: Option<Vec<String>>,
) -> Result<u32, crate::AppError> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("app_cache_dir: {e}"))?;
    if !cache.is_dir() {
        return Ok(0);
    }
    let active: std::collections::HashSet<String> = registry.active_ids().into_iter().collect();
    let excluded: std::collections::HashSet<String> = exclude.unwrap_or_default().into_iter().collect();
    match category.as_str() {
        "downloads" | "audio" | "meta" => {
            Ok(remove_files_in_dir(&media_cache_dir(&cache, &category), &active, &excluded))
        }
        "thumbnails" => {
            let mut removed: u32 = 0;
            if let Ok(entries) = std::fs::read_dir(&cache) {
                for entry in entries.flatten() {
                    let name = match entry.file_name().to_str() {
                        Some(n) => n.to_string(),
                        None => continue,
                    };
                    if !name.starts_with("saucebunny-thumb-") { continue; }
                    let meta = match entry.metadata() { Ok(m) => m, Err(_) => continue };
                    if meta.is_dir() { continue; }
                    removed += remove_cache_file(&entry.path(), &name, &active, &excluded);
                }
            }
            Ok(removed)
        }
        other => Err(crate::AppError::invalid(format!("unknown cache category: {other}"))),
    }
}

#[tauri::command]
pub fn cleanup_stale_cache(app: AppHandle) -> Result<u32, crate::AppError> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("app_cache_dir: {e}"))?;
    if !cache.is_dir() {
        return Ok(0);
    }
    Ok(sweep_stale_files(&cache, std::time::SystemTime::now()))
}

/// Core of the startup sweep, parameterised on `now` so the >24h cutoff is
/// unit-testable without faking file mtimes. Deletes stale `saucebunny-*`
/// FILES in the cache root only; `saucebunny-media/` (the persistent
/// downloads/audio/meta cache, r112) is exempt by name AND by the
/// directories-are-skipped rule — its artifacts are downloaded once and
/// deliberately reused across sessions, so aging them out would just make
/// the user re-pay yt-dlp's full extraction cost.
fn sweep_stale_files(cache: &std::path::Path, now: std::time::SystemTime) -> u32 {
    let mut removed: u32 = 0;
    let entries = match std::fs::read_dir(cache) {
        Ok(it) => it,
        Err(_) => return 0, // missing cache dir is fine
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        if !name.starts_with("saucebunny-") {
            continue;
        }
        // The persistent media cache is NEVER swept — explicit by name so
        // the exemption survives any future recursive-sweep refactor.
        if name == MEDIA_CACHE_DIRNAME {
            continue;
        }
        // Whisper model files live under a separate `whisper-models/`
        // subdir so they're never matched here. Belt + braces though:
        // skip directories explicitly.
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_dir() {
            continue;
        }
        let modified = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
        let age = now.duration_since(modified).unwrap_or_default();
        if age.as_secs() > CACHE_TTL_SECONDS
            && std::fs::remove_file(&path).is_ok() {
                removed += 1;
            }
    }
    removed
}

/// Write raw bytes (e.g. a frame Blob marshalled from the frontend) to
/// `path`. Used by the mediabunny snapshot + local clip-export paths so we
/// can produce the file entirely in JS land and just persist the buffer here.
/// Validates the parent dir exists. Returns the path actually written.
/// Callers whose destination is DERIVED (the clip exporters build names
/// themselves) pass `unique` — a collision walks -2, -3, … exactly like
/// create_clip's unique_output_path, and NEVER fails (review fix: the local
/// export path used to hard-error on collision while the web path silently
/// uniquified). `if_not_exists` remains for callers that genuinely want a
/// refuse-to-overwrite error.
#[tauri::command]
pub fn write_bytes_to_path(
    path: String,
    bytes: Vec<u8>,
    if_not_exists: Option<bool>,
    unique: Option<bool>,
) -> Result<String, crate::AppError> {
    let mut p = PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(format!("Folder does not exist: {}", parent.display()).into());
        }
    }
    if unique.unwrap_or(false) {
        let dir = p.parent().map(std::path::Path::to_path_buf).unwrap_or_default();
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("bin")
            .to_string();
        p = super::media::unique_output_path(&dir, &p, &ext);
    } else if if_not_exists.unwrap_or(false) && p.exists() {
        return Err(format!("File already exists: {}", p.display()).into());
    }
    std::fs::write(&p, &bytes).map_err(|e| format!("write failed: {e}"))?;
    Ok(p.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn reveal_in_finder(path: String) -> Result<(), crate::AppError> {
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("Path does not exist: {path}").into());
    }
    std::process::Command::new("open")
        .args(["-R", &path])
        .spawn()
        .map_err(|e| format!("failed to reveal: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn new_job_id() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// Read a text file from disk with a hard size cap. Used by the Transcripts
/// tab to slurp SRT files (yt-dlp captions or Whisper output) into the
/// renderer for parsing + display.
///
/// We bound the read explicitly rather than relying on tauri-plugin-fs:
///   - the only thing we read from JS is plain-text transcripts;
///   - SRTs in the real world are <2 MB even for very long videos;
///   - bypassing tauri-plugin-fs avoids broad disk-allow scopes in
///     capabilities.json (the plugin grants the whole filesystem).
///
/// The `max_bytes` cap is a guard against accidentally pointing this at a
/// 4 GB video file from JS; 8 MB is roughly 100 hours of SRT cues.
#[tauri::command]
pub fn read_text_file_capped(path: String, max_bytes: Option<u64>) -> Result<String, crate::AppError> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("Not a file: {path}").into());
    }
    let cap = max_bytes.unwrap_or(8 * 1024 * 1024); // 8 MB default
    let meta = std::fs::metadata(&p)
        .map_err(|e| format!("stat failed: {e}"))?;
    if meta.len() > cap {
        return Err(crate::AppError::Invalid(format!(
            "File too large ({} bytes, cap {} bytes)",
            meta.len(), cap
        )));
    }
    std::fs::read_to_string(&p)
        .map_err(|e| crate::AppError::Io(format!("read failed: {e}")))
}

/// Create a directory (and all missing parents) at `path`. Used by the
/// transcript-library flow to lazily create the `YYYY-MM/` subfolder
/// the first time the user generates a transcript in a given month.
///
/// `mkdir -p` semantics — no error if the directory already exists.
/// Refuses obviously-bad inputs (empty, root) so a buggy caller can't
/// accidentally create dotfile-noise at `/`.
#[tauri::command]
pub fn ensure_dir_exists(path: String) -> Result<(), crate::AppError> {
    if path.trim().is_empty() {
        return Err("path is empty".into());
    }
    let p = PathBuf::from(&path);
    if p.parent().is_none() {
        return Err("refusing to create root-level directory".into());
    }
    std::fs::create_dir_all(&p).map_err(|e| crate::AppError::Io(format!("mkdir failed: {e}")))
}

/// Return the default Transcripts library path —
/// `~/Documents/Sauce Bunny/Transcripts/`. Resolved through Tauri's path
/// API so it follows the OS document-folder convention (handles
/// localized Documents folder names on non-English macs).
///
/// Does NOT create the directory — that's `ensure_dir_exists`'s job.
/// Caller (frontend) holds the user-overridable preference, so we
/// only return the default here.
#[tauri::command]
pub fn default_transcript_library_path(app: AppHandle) -> Result<String, crate::AppError> {
    let docs = app
        .path()
        .document_dir()
        .map_err(|e| format!("document_dir: {e}"))?;
    let library = docs.join("Sauce Bunny").join("Transcripts");
    Ok(library.to_string_lossy().to_string())
}

// ============================================================
// BUILD ID HANDSHAKE
// Stamped into the Rust binary at compile time. The frontend embeds the
// SAME string in src/lib/build-id.ts. On startup the frontend calls
// `get_backend_build_id` and compares; mismatch → red banner saying
// "your dev server needs `npm run tauri dev` to rebuild".
//
// This number is the only thing that needs to change when a new backend
// command is added. Bump it whenever you touch commands.rs in a way the
// frontend depends on.
// ============================================================
pub const BACKEND_BUILD_ID: &str = "2026-07-18-r114-review-hardening";

#[tauri::command]
pub fn get_backend_build_id() -> &'static str {
    BACKEND_BUILD_ID
}

/// Base URL of the loopback media proxy (r58), e.g.
/// `http://127.0.0.1:52431`. The frontend appends `/v1/<base64url>` to
/// build a `<video src>` that streams a yt-dlp-resolved CDN URL through
/// our Rust proxy. `None` if the proxy failed to bind at startup — the
/// frontend then falls back to the download-to-cache path.
#[tauri::command]
pub fn get_stream_proxy_base() -> Option<String> {
    crate::stream_proxy::base_url()
}

// ============================================================
// PANEL POP-OUT WINDOW (r44.B)
//
// `open_panel_window` spawns a second native WebviewWindow loading the
// same SPA bundle with `?window=panel` so main.tsx mounts <PanelApp/>
// instead of <App/>. The two windows talk via Tauri events:
//
//   main → panel: `panel:state` — a serialized snapshot of everything
//                 the drawer renders (queue, transcript path, playhead,
//                 etc.). The main App fires this on every relevant
//                 state change; PanelApp holds a mirror and renders
//                 from it.
//
//   panel → main: `panel:action:<kind>` — user actions inside the
//                 floating window (seek, remove, clear-all, etc.).
//                 The main App listens and routes back into the same
//                 handlers the docked drawer uses.
//
// When the floating window closes (user clicks the OS close button OR
// we call `close_panel_window`), we fire `panel:closed` to the main
// window so it re-mounts the docked drawer.
// ============================================================

#[tauri::command]
pub async fn open_panel_window(app: AppHandle) -> Result<(), crate::AppError> {
    use tauri::{WebviewUrl, WebviewWindowBuilder};
    // If the panel is already open, just focus it. Prevents stacking
    // duplicates if the user clicks pop-out twice.
    if let Some(existing) = app.get_webview_window("panel") {
        existing.set_focus().map_err(|e| e.to_string())?;
        // Also re-emit `panel:popped-out` so the main window's docked
        // drawer stays hidden — covers the corner case where main
        // missed the original emit (window event ordering races).
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.emit("panel:popped-out", ());
        }
        return Ok(());
    }

    let win = WebviewWindowBuilder::new(
        &app,
        "panel",
        WebviewUrl::App("index.html?window=panel".into()),
    )
    .title("Sauce Bunny — Side Panel")
    .inner_size(420.0, 760.0)
    .min_inner_size(320.0, 480.0)
    .resizable(true)
    .build()
    .map_err(|e| e.to_string())?;

    // Wire the window's lifecycle: on close, tell main to re-dock.
    let app_for_event = app.clone();
    win.on_window_event(move |event| {
        if matches!(
            event,
            tauri::WindowEvent::Destroyed | tauri::WindowEvent::CloseRequested { .. }
        ) {
            if let Some(main) = app_for_event.get_webview_window("main") {
                let _ = main.emit("panel:closed", ());
            }
        }
    });

    // Tell main the panel is up so it can hide the docked drawer
    // BEFORE the panel's first `panel:state` arrives (avoids a flash
    // of duplicated UI).
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.emit("panel:popped-out", ());
    }
    Ok(())
}

#[tauri::command]
pub async fn close_panel_window(app: AppHandle) -> Result<(), crate::AppError> {
    if let Some(w) = app.get_webview_window("panel") {
        w.close().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod cache_tests {
    use super::{media_cache_dir, sweep_stale_files, MEDIA_CACHE_DIRNAME};
    use std::time::{Duration, SystemTime};

    /// Fresh scratch dir per test (tests run in parallel in one process, so
    /// each gets its own name).
    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("sb-cache-test-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("mkdir scratch");
        dir
    }

    // The heart of part B3: artifacts inside `saucebunny-media/` are
    // downloaded once and REUSED — the >24h sweep must never touch them,
    // while an equally-old sibling in the cache root is still cleaned.
    #[test]
    fn sweep_exempts_media_cache_but_cleans_stale_siblings() {
        let cache = scratch("exempt");
        let downloads = media_cache_dir(&cache, "downloads");
        std::fs::create_dir_all(&downloads).unwrap();
        let kept = downloads.join("saucebunny-download-abc123.mp4");
        std::fs::write(&kept, b"full source copy").unwrap();
        let stale = cache.join("saucebunny-webcache-oldjob.mp4");
        std::fs::write(&stale, b"temp remux output").unwrap();
        let foreign = cache.join("unrelated.txt");
        std::fs::write(&foreign, b"not ours").unwrap();

        // Both files were written just now; pretending "now" is 25h in the
        // future makes them both older than the 24h TTL.
        let removed = sweep_stale_files(&cache, SystemTime::now() + Duration::from_secs(25 * 60 * 60));

        assert_eq!(removed, 1, "exactly the stale root sibling is swept");
        assert!(kept.exists(), "media-cache artifact must survive the sweep");
        assert!(!stale.exists(), "stale saucebunny-* root file must be swept");
        assert!(foreign.exists(), "non-saucebunny files are never touched");
        let _ = std::fs::remove_dir_all(&cache);
    }

    // Fresh files (younger than the TTL) stay, even in the root.
    #[test]
    fn sweep_keeps_fresh_root_files() {
        let cache = scratch("fresh");
        let fresh = cache.join("saucebunny-playback-live.mp4");
        std::fs::write(&fresh, b"in use").unwrap();

        let removed = sweep_stale_files(&cache, SystemTime::now());

        assert_eq!(removed, 0);
        assert!(fresh.exists());
        let _ = std::fs::remove_dir_all(&cache);
    }

    #[test]
    fn media_cache_dir_layout_is_stable() {
        let root = std::path::Path::new("/cache");
        assert_eq!(
            media_cache_dir(root, "audio"),
            root.join(MEDIA_CACHE_DIRNAME).join("audio")
        );
    }
}

