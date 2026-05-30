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
// CACHE SWEEP
// Every transient artifact we write to app_cache_dir() shares the
// `saucebunny-` prefix (playback prep copies, audio raw downloads, whisper
// wavs, etc). On startup we glob that prefix and delete anything older
// than 24 hours so the cache can't grow unbounded across sessions.
// ============================================================
const CACHE_TTL_SECONDS: u64 = 24 * 60 * 60;

/// Cache stats for the Settings UI — sum of all `saucebunny-*` files in
/// app_cache_dir(). Returns `(file_count, bytes_total, path)`.
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
}

#[tauri::command]
pub fn get_cache_stats(app: AppHandle) -> Result<CacheStats, crate::AppError> {
    // Proof-of-concept migration for r50 — first command on the typed-error
    // (AppError) surface. See CLAUDE.md refactor priority #4. The rest of
    // the commands still return `Result<T, String>` and migrate
    // opportunistically (or in an r51 bulk sweep).
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| crate::AppError::internal(format!("app_cache_dir: {e}")))?;
    let path = cache.to_string_lossy().to_string();
    if !cache.is_dir() {
        return Ok(CacheStats { file_count: 0, bytes_total: 0, path });
    }
    let mut file_count: u32 = 0;
    let mut bytes_total: u64 = 0;
    if let Ok(entries) = std::fs::read_dir(&cache) {
        for entry in entries.flatten() {
            let name = match entry.file_name().to_str() {
                Some(n) => n.to_string(),
                None => continue,
            };
            if !name.starts_with("saucebunny-") { continue; }
            let meta = match entry.metadata() { Ok(m) => m, Err(_) => continue };
            if meta.is_dir() { continue; }
            file_count += 1;
            bytes_total += meta.len();
        }
    }
    Ok(CacheStats { file_count, bytes_total, path })
}

/// Purge `saucebunny-*` cache files. Files whose names contain a currently-
/// active job ID are SKIPPED so we don't yank the rug out from under an
/// in-flight ffmpeg playback prep / audio download / etc — those would
/// otherwise complete and emit "saved" pointing at a file we just deleted.
#[tauri::command]
pub fn clear_all_cache(app: AppHandle, registry: State<'_, JobRegistry>) -> Result<u32, crate::AppError> {
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
    let mut removed: u32 = 0;
    if let Ok(entries) = std::fs::read_dir(&cache) {
        for entry in entries.flatten() {
            let name = match entry.file_name().to_str() {
                Some(n) => n.to_string(),
                None => continue,
            };
            if !name.starts_with("saucebunny-") { continue; }
            if active.iter().any(|jid| name.contains(jid)) {
                // In-flight job is writing to this file — skip.
                continue;
            }
            let meta = match entry.metadata() { Ok(m) => m, Err(_) => continue };
            if meta.is_dir() { continue; }
            if std::fs::remove_file(entry.path()).is_ok() {
                removed += 1;
            }
        }
    }
    Ok(removed)
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
    let now = std::time::SystemTime::now();
    let mut removed: u32 = 0;
    let entries = match std::fs::read_dir(&cache) {
        Ok(it) => it,
        Err(_) => return Ok(0), // missing cache dir is fine
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
        if age.as_secs() > CACHE_TTL_SECONDS {
            if std::fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
    }
    Ok(removed)
}

/// Write raw bytes (e.g. a frame Blob marshalled from the frontend) to
/// `path`. Used by the mediabunny snapshot path so we can produce the
/// JPEG/PNG entirely in JS land and just persist the buffer here.
/// Validates the parent dir exists; refuses to overwrite the saveDialog
/// would have already vetted the path the user chose.
#[tauri::command]
pub fn write_bytes_to_path(path: String, bytes: Vec<u8>) -> Result<(), crate::AppError> {
    let p = PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(format!("Folder does not exist: {}", parent.display()).into());
        }
    }
    std::fs::write(&p, &bytes).map_err(|e| format!("write failed: {e}"))?;
    Ok(())
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
pub const BACKEND_BUILD_ID: &str = "2026-05-30-r73-ytdlp-updater";

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

