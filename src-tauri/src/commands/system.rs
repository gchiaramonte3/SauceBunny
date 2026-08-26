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
    // Jobs the user asked to cancel. A `kill()` only reaches a process that
    // is registered THIS instant, but a transcription pipeline spends real
    // time BETWEEN spawns — fetching the Silero VAD model before whisper-cli,
    // running the diarizer after it — with no child to kill. Those stages
    // poll `is_cancelled` at their boundaries and bail. `finish_job` clears
    // the flag on the pipelines' main exit paths; a path that misses it only
    // strands one job-id string (ids are UUIDs, never reused, so a stale
    // flag can't cancel a future job).
    cancelled: Mutex<std::collections::HashSet<String>>,
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
    /// Record that a job should stop. Read by pipeline stages that run
    /// between child spawns (VAD fetch, diarize) — see the `cancelled` field.
    pub(crate) fn mark_cancelled(&self, id: &str) {
        if let Ok(mut g) = self.cancelled.lock() {
            g.insert(id.to_string());
        }
    }
    /// True if `cancel_job` flagged this job. Pipeline stages poll this at
    /// their boundaries to bail out of an otherwise-unkillable window.
    pub(crate) fn is_cancelled(&self, id: &str) -> bool {
        self.cancelled.lock().map(|g| g.contains(id)).unwrap_or(false)
    }
    /// Drop all bookkeeping for a finished job — the cancel flag plus any
    /// lingering child handle. Pipeline tasks call this on every exit path so
    /// the cancel set can't accumulate stale entries across a session.
    pub(crate) fn finish_job(&self, id: &str) {
        if let Ok(mut g) = self.cancelled.lock() { g.remove(id); }
        if let Ok(mut g) = self.children.lock() { g.remove(id); }
    }
}

#[tauri::command]
pub fn cancel_job(registry: State<'_, JobRegistry>, job_id: String) -> Result<bool, crate::AppError> {
    // Flag the intent first so a pipeline stage running BETWEEN spawns (VAD
    // fetch, diarize) notices even though there's no child to kill this
    // instant. `kill()` handles the case where a sidecar is actually running.
    registry.mark_cancelled(&job_id);
    if let Some(child) = registry.take(&job_id) {
        child.kill().map_err(|e| format!("kill failed: {e}"))?;
        Ok(true)
    } else {
        Ok(false)
    }
}

// ============================================================
// SIDECAR EXECUTE-BIT REPAIR (r122)
// iCloud Drive eviction/restore (and some copy paths) can strip the
// execute bit from sidecar binaries. tauri-plugin-shell's .sidecar()
// only resolves a path — a present-but-non-executable file passes
// resolution and dies at spawn with EACCES ("Permission denied
// (os error 13)"), which used to leak verbatim into the pipeline log.
// This sweep runs once at startup and restores +x on any known sidecar
// that lost it. Restricted to the tauri.conf.json externalBin name set
// so a stray file can never be made executable.
// ============================================================
const SIDECAR_NAMES: [&str; 8] = [
    "yt-dlp", "ffmpeg", "ffprobe", "whisper-cli",
    "saucebunny-diarize", "saucebunny-dictate", "saucebunny-capture",
    "llama-server",
];

/// Restore the execute bit on any sidecar binary that lost it. Returns the
/// number of files repaired. Best-effort: an iCloud dataless stub can still
/// fail to spawn until the file materializes, so callers treat this as a
/// reliability sweep, not a guarantee.
pub(crate) fn ensure_sidecars_executable(app: &AppHandle) -> usize {
    use std::os::unix::fs::PermissionsExt;
    let mut dirs: Vec<std::path::PathBuf> = Vec::new();
    // Where the shell plugin actually spawns from: next to the executable
    // (release: SauceBunny.app/Contents/MacOS; dev: target/debug).
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            dirs.push(dir.to_path_buf());
        }
    }
    // Dev builds also resolve some paths straight out of the repo.
    if cfg!(debug_assertions) {
        dirs.push(std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries"));
    }
    // The user-updated yt-dlp copy (update_ytdlp installs to app_data/bin).
    if let Ok(data) = app.path().app_data_dir() {
        dirs.push(data.join("bin"));
    }
    let mut repaired = 0usize;
    for dir in &dirs {
        for name in SIDECAR_NAMES {
            let plain = dir.join(name);
            let suffixed = dir.join(format!("{}-{}", name, current_triple()));
            for path in [plain, suffixed] {
                let Ok(meta) = std::fs::metadata(&path) else { continue };
                if !meta.is_file() {
                    continue;
                }
                let mode = meta.permissions().mode();
                if mode & 0o111 == 0 {
                    let mut perms = meta.permissions();
                    perms.set_mode(mode | 0o755);
                    if std::fs::set_permissions(&path, perms).is_ok() {
                        eprintln!("[startup] repaired execute bit: {}", path.display());
                        repaired += 1;
                    }
                }
            }
        }
    }
    repaired
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
///
/// The cache root used to be one organized subtree plus a flat pile of
/// `saucebunny-`prefixed FILES, which is what a user saw on Reveal. Inside
/// the app's own cache directory that prefix says nothing - the folder is
/// already `…/Caches/com.saucebunny.desktop/` - so the layout is three
/// named directories now:
///
///   app_cache_dir()/
///     media/        downloads/ audio/ meta/   never swept, "download once"
///     thumbnails/   poster JPEGs              never swept, Settings purges
///     scratch/      job temps, prep copies,   swept at 24h
///                   whisper wavs
///
/// `migrate_cache_layout` moves an old install over, once, at startup.
pub(crate) const MEDIA_CACHE_DIRNAME: &str = "media";
/// Files RECEIVED from a co-review peer, inside the media cache but not OF it.
///
/// Everything else under `media/` is derived and regenerable — a download can
/// be re-fetched, an audio track re-extracted, metadata re-read. A transfer
/// cannot: the source was another person's machine and the session is over.
/// It is also the guest's permanent copy, registered against the source's
/// fingerprint the moment it verifies, which is the whole point of CLAUDE.md's
/// "streaming converges to a copy" rule.
///
/// Named here rather than inline so `enforce_media_cache_cap`'s exemption and
/// `session_fetch_file`'s write site cannot drift apart.
pub(crate) const TRANSFERS_DIRNAME: &str = "transfers";
/// What the media cache was called before the layout tidy.
const LEGACY_MEDIA_DIRNAME: &str = "saucebunny-media";
pub(crate) const THUMBS_DIRNAME: &str = "thumbnails";
pub(crate) const SCRATCH_DIRNAME: &str = "scratch";

/// Where regenerable, job-scoped artifacts go.
///
/// ENSURES the directory, which is why it is not a pure join: its callers
/// are spread across four modules and every one of them is about to write
/// into the result, so a helper that only computed the path would need a
/// matching `create_dir_all` at each site - five today, and one forgotten
/// next year surfaces as a yt-dlp template failing on a directory that does
/// not exist. Best-effort: the write that follows reports the real error
/// with the real context, and duplicating it here would only make the
/// failure arrive twice.
pub(crate) fn scratch_dir(cache_root: &std::path::Path) -> PathBuf {
    let dir = cache_root.join(SCRATCH_DIRNAME);
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Where poster JPEGs go. Ensures the directory, for the reason above.
pub(crate) fn thumbs_dir(cache_root: &std::path::Path) -> PathBuf {
    let dir = cache_root.join(THUMBS_DIRNAME);
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Move an old cache layout to the new one. Idempotent, best-effort, and
/// deliberately NOT fatal: a cache that fails to migrate costs a re-download,
/// while refusing to start over it would cost the whole app.
///
/// The multi-GB media subtree is RENAMED rather than copied - same
/// filesystem, so it is a metadata operation and nobody re-downloads a
/// season. Thumbnails move file by file (they are small, and the prefix is
/// stripped because the directory now carries that meaning). Loose scratch
/// files at the root are deliberately left where they are: they are
/// regenerable, some may be in flight from a previous run, and the legacy
/// arm of the sweep clears them within a day.
pub(crate) fn migrate_cache_layout(cache_root: &std::path::Path) -> u32 {
    let mut moved = 0u32;
    let legacy_media = cache_root.join(LEGACY_MEDIA_DIRNAME);
    let media = cache_root.join(MEDIA_CACHE_DIRNAME);
    if legacy_media.is_dir() && !media.exists() {
        match std::fs::rename(&legacy_media, &media) {
            Ok(()) => moved += 1,
            Err(e) => eprintln!("[cache-migrate] media: {e}"),
        }
    }
    let thumbs = thumbs_dir(cache_root);
    if let Ok(entries) = std::fs::read_dir(cache_root) {
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
            let Some(rest) = name.strip_prefix("saucebunny-thumb-") else { continue };
            if !path.is_file() {
                continue;
            }
            if std::fs::create_dir_all(&thumbs).is_err() {
                break;
            }
            if std::fs::rename(&path, thumbs.join(rest)).is_ok() {
                moved += 1;
            }
        }
    }
    moved
}

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
    /// Files received from co-review peers. Exempt from the size cap (they do
    /// not regenerate), so they are reported separately and cleared only by
    /// an explicit choice.
    pub transfers: CacheCategoryStats,
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
pub async fn get_cache_stats(app: AppHandle) -> Result<CacheStats, crate::AppError> {
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
    let transfers = dir_category_stats(&media_cache_dir(&cache, TRANSFERS_DIRNAME));
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
        + thumbnails.file_count + scratch.file_count + transfers.file_count;
    let bytes_total = downloads.bytes_total + audio.bytes_total + meta_cat.bytes_total
        + thumbnails.bytes_total + scratch.bytes_total + transfers.bytes_total;
    Ok(CacheStats {
        file_count,
        bytes_total,
        path,
        downloads,
        audio,
        meta: meta_cat,
        thumbnails,
        scratch,
        transfers,
    })
}

/// Marker-file name for "clear the media cache on quit". A FILE under
/// app_data, not a webview pref: the exit handler runs after the webview
/// (and its localStorage) is already gone.
pub(crate) const CLEAR_ON_QUIT_FLAG: &str = "clear-media-cache-on-quit";

#[tauri::command]
pub fn set_clear_cache_on_quit(app: AppHandle, enabled: bool) -> Result<(), crate::AppError> {
    let data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let flag = data.join(CLEAR_ON_QUIT_FLAG);
    if enabled {
        std::fs::create_dir_all(&data).map_err(|e| format!("create app data dir: {e}"))?;
        std::fs::write(&flag, b"1").map_err(|e| format!("write flag: {e}"))?;
    } else if flag.exists() {
        std::fs::remove_file(&flag).map_err(|e| format!("remove flag: {e}"))?;
    }
    Ok(())
}

/// LRU-prune the persistent media cache (full downloads, cached audio, saved
/// metadata) down to `max_bytes`: oldest files by mtime go first, and files
/// belonging to an active job or on the caller's exclude list (the source
/// currently playing) are never touched. Returns how many files were removed.
/// The cache is deliberately keep-forever by default; this cap is the opt-in
/// retention policy from Settings.
/// Every file under the media cache the size cap may evict, with its size and
/// mtime — i.e. the DERIVED cache, and deliberately not `transfers/`.
///
/// Lifted out of the command so the exemption is testable. The command needs
/// an `AppHandle` and the `JobRegistry`, which is why the cap had no test at
/// all, which is how it spent its life quietly deleting files that do not come
/// back.
fn evictable_media_files(media: &std::path::Path) -> Vec<(PathBuf, u64, std::time::SystemTime)> {
    fn walk(dir: &std::path::Path, out: &mut Vec<(PathBuf, u64, std::time::SystemTime)>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                // NEVER the transfers dir. This cap is an LRU over DERIVED
                // cache — every other subdirectory here can be rebuilt from
                // the network. A received co-review file cannot: it came off a
                // peer's machine, the session is gone, and the frontend has
                // already registered it as the permanent copy for that
                // source's fingerprint. Evicting it destroyed the only copy of
                // a multi-GB screening master that both sides deliberately
                // paid to transfer — silently, at boot, against a size
                // threshold the user set thinking about web downloads.
                if p.file_name().and_then(|n| n.to_str()) == Some(TRANSFERS_DIRNAME) {
                    continue;
                }
                walk(&p, out);
            } else if let Ok(m) = e.metadata() {
                out.push((p, m.len(), m.modified().unwrap_or(std::time::UNIX_EPOCH)));
            }
        }
    }
    let mut out = Vec::new();
    walk(media, &mut out);
    out
}

#[tauri::command]
pub async fn enforce_media_cache_cap(
    app: AppHandle,
    registry: State<'_, JobRegistry>,
    max_bytes: u64,
    exclude: Option<Vec<String>>,
) -> Result<u32, crate::AppError> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("app_cache_dir: {e}"))?;
    let media = cache.join(MEDIA_CACHE_DIRNAME);
    if !media.is_dir() {
        return Ok(0);
    }
    let active: std::collections::HashSet<String> = registry.active_ids().into_iter().collect();
    let excluded: std::collections::HashSet<String> = exclude.unwrap_or_default().into_iter().collect();

    let mut files = evictable_media_files(&media);
    let total: u64 = files.iter().map(|(_, s, _)| *s).sum();
    if total <= max_bytes {
        return Ok(0);
    }
    files.sort_by_key(|(_, _, m)| *m); // oldest first
    let mut removed: u32 = 0;
    let mut freed: u64 = 0;
    for (p, size, _) in files {
        if total.saturating_sub(freed) <= max_bytes {
            break;
        }
        let path_str = p.to_string_lossy().to_string();
        if excluded.contains(&path_str) {
            continue;
        }
        let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if active.iter().any(|id| name.contains(id.as_str())) {
            continue;
        }
        if std::fs::remove_file(&p).is_ok() {
            freed += size;
            removed += 1;
        }
    }
    Ok(removed)
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
pub async fn clear_all_cache(
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
            // `active`/`excluded` are already references here (unlike the
            // owned sets at the two call sites in clear_all_cache).
            removed += remove_cache_file(&entry.path(), &name, active, excluded);
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
pub async fn clear_cache_category(
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
        // `transfers` is here on purpose. It is exempt from the automatic
        // size cap because a received file does not regenerate — but exempt
        // from EVICTION is not the same as undeletable, and a category the
        // Settings panel lists must actually clear when its button is pressed.
        // Without this arm the row would render, count bytes, and answer
        // "unknown cache category" on click: a control the UI advertises and
        // does not honour, which is the exact defect the sortable list headers
        // were fixed for.
        "downloads" | "audio" | "meta" | "transfers" => {
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

/// Not a `#[tauri::command]`: lib.rs calls this directly during setup, and
/// the renderer never did. Registering it only widened the IPC surface.
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

/// Delete every FILE in `dir` older than the TTL. Used for `scratch/`, whose
/// entire contents are job-scoped temporaries; a missing directory is the
/// normal state on a fresh install and yields zero rather than an error.
fn sweep_dir_by_age(dir: &std::path::Path, now: std::time::SystemTime) -> u32 {
    let mut removed = 0u32;
    let Ok(entries) = std::fs::read_dir(dir) else { return 0 };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let stale = meta
            .modified()
            .ok()
            .and_then(|m| now.duration_since(m).ok())
            .map(|age| age.as_secs() > CACHE_TTL_SECONDS)
            .unwrap_or(false);
        if stale && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Core of the startup sweep, parameterised on `now` so the >24h cutoff is
/// unit-testable without faking file mtimes. Deletes stale `saucebunny-*`
/// FILES in the cache root only; `saucebunny-media/` (the persistent
/// downloads/audio/meta cache, r112) is exempt by name AND by the
/// directories-are-skipped rule — its artifacts are downloaded once and
/// deliberately reused across sessions, so aging them out would just make
/// the user re-pay yt-dlp's full extraction cost.
fn sweep_stale_files(cache: &std::path::Path, now: std::time::SystemTime) -> u32 {
    // The scratch directory is the sweep's real subject now: everything in
    // it is job-scoped and regenerable by construction. The root pass below
    // is kept as the LEGACY arm - it clears the loose `saucebunny-*` files an
    // install from before the layout tidy still has, and costs one read_dir
    // on a directory that is now three entries wide.
    let mut removed: u32 = sweep_dir_by_age(&scratch_dir(cache), now);
    let entries = match std::fs::read_dir(cache) {
        Ok(it) => it,
        Err(_) => return removed, // missing cache dir is fine
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
        // Posters are cheap to keep and expensive to regenerate daily; the
        // Settings cache panel's thumbnails bucket is the manual purge.
        if name.starts_with("saucebunny-thumb-") {
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
/// Shared by `write_text_to_path` and the raw-body `write_raw_to_path`.
/// `write_bytes_to_path` used to be the third caller; its last TypeScript
/// use went away when the frame snapshot moved to the raw body, so the
/// command is gone and this stayed.
fn write_bytes_impl(
    path: &str,
    bytes: &[u8],
    if_not_exists: bool,
    unique: bool,
    atomic: bool,
) -> Result<String, crate::AppError> {
    let mut p = PathBuf::from(path);
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(format!("Folder does not exist: {}", parent.display()).into());
        }
    }
    if unique {
        let dir = p.parent().map(std::path::Path::to_path_buf).unwrap_or_default();
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("bin")
            .to_string();
        p = super::media::unique_output_path(&dir, &p, &ext);
    } else if if_not_exists && p.exists() {
        return Err(format!("File already exists: {}", p.display()).into());
    }
    if atomic {
        // Transactional overwrite for app documents (review/screening JSON):
        // write a sibling temp file, flush it to disk, then rename over the
        // target. Same directory → same filesystem → the rename is atomic, so
        // a crash mid-save leaves either the OLD complete file or the NEW
        // complete file, never a truncated one. A plain fs::write truncates
        // FIRST — a crash in that window destroyed the only copy.
        let file_name = p
            .file_name()
            .and_then(|n| n.to_str())
            .ok_or_else(|| crate::AppError::invalid(format!("Not a file path: {}", p.display())))?;
        // UNIQUE PER CALL, not per process. Keying the staging file on the
        // destination plus the PID meant two concurrent saves of the SAME file
        // from this process shared one temp path - and Tauri runs invokes
        // concurrently. Writer B's `File::create` opens O_TRUNC on the inode A
        // still holds an fd to; A goes on writing at its old offset, so the
        // staged file becomes a NUL hole plus A's tail, fsyncs, and renames
        // cleanly over the destination. Full length, valid rename, and
        // `JSON.parse` rejects it.
        //
        // That is worst for casts.json, whose recovery path then finishes the
        // job: the parse throws into hydrate's `catch { /* fresh shelf */ }`,
        // the shelf boots empty, and the next merge writes `{"casts":[]}` over
        // the file - underneath the pre-hydration write refusal, the merge and
        // the tombstones that all exist to prevent exactly that.
        //
        // The error-path cleanup below was part of the same bug: a failing
        // writer deleted the temp a healthy concurrent writer was about to
        // rename, turning a good save into a bogus ENOENT. With a per-call name
        // each writer only ever removes its own.
        // PID keeps two processes apart; the counter keeps two concurrent
        // calls in THIS process apart, which is the half that was missing.
        // Relaxed is enough - the only requirement is that no two calls read
        // the same value, not that anything is ordered against it.
        static STAGE_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let seq = STAGE_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let tmp = p.with_file_name(format!(".{file_name}.tmp-{}-{seq}", std::process::id()));
        let write_and_sync = || -> std::io::Result<()> {
            use std::io::Write;
            let mut f = std::fs::File::create(&tmp)?;
            f.write_all(bytes)?;
            f.sync_all()?;
            Ok(())
        };
        if let Err(e) = write_and_sync() {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("write failed: {e}").into());
        }
        if let Err(e) = std::fs::rename(&tmp, &p) {
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("rename failed: {e}").into());
        }
    } else {
        std::fs::write(&p, bytes).map_err(|e| format!("write failed: {e}"))?;
    }
    Ok(p.to_string_lossy().into_owned())
}

/// `write_bytes_to_path` for TEXT. A JSON string arg crosses the IPC boundary
/// as-is, so callers must never do `Array.from(new TextEncoder().encode(s))` —
/// that decimal-prints every byte (~3x inflation, built synchronously on the
/// main thread; a multi-MB review doc paid tens of ms per debounced save).
#[tauri::command]
pub async fn write_text_to_path(
    path: String,
    text: String,
    if_not_exists: Option<bool>,
    unique: Option<bool>,
    atomic: Option<bool>,
) -> Result<String, crate::AppError> {
    write_bytes_impl(&path, text.as_bytes(), if_not_exists.unwrap_or(false), unique.unwrap_or(false), atomic.unwrap_or(false))
}

/// `write_bytes_to_path` for LARGE payloads (the local clip exporter): the
/// bytes travel as the raw IPC body instead of a JSON number array. The JSON
/// route decimal-prints every byte — a 100 MB clip became a ~345M-char string
/// built synchronously on the WKWebView main thread (~2s frozen UI, ~2.2 GB
/// peak), repeated per queue item. The raw body is a straight buffer copy.
///
/// The destination path rides in the `x-dest-path` header, percent-encoded
/// (`encodeURIComponent`): headers are Latin-1 and export names carry user
/// media titles. `x-unique: 1` opts into the same collision-walking behaviour
/// as `write_bytes_to_path { unique: true }`.
#[tauri::command]
pub async fn write_raw_to_path(request: tauri::ipc::Request<'_>) -> Result<String, crate::AppError> {
    let enc = request
        .headers()
        .get("x-dest-path")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| crate::AppError::internal("write_raw_to_path: missing x-dest-path header"))?;
    let path = percent_decode_utf8(enc)?;
    let unique = request
        .headers()
        .get("x-unique")
        .and_then(|v| v.to_str().ok())
        == Some("1");
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err(crate::AppError::internal(
            "write_raw_to_path: expected a raw body (pass the Uint8Array as the invoke payload)",
        ));
    };
    // ATOMIC. This is the finished export landing in the user's own folder,
    // under the name they chose, and a plain write truncates first: a crash or
    // a full disk mid-write left a short file wearing that name, which plays
    // as a corrupt clip rather than announcing itself as a failure. Worse in
    // combination with `unique`, which is always on here - the retry walked
    // past the wreckage to `clip-2.mov`, so the user was left with a broken
    // file AND a suffixed one, neither of them obviously the good copy.
    //
    // The temp is a sibling dotfile, so the rename is same-filesystem and
    // therefore atomic, and peak disk stays at one copy rather than two. The
    // fsync before the rename costs about a second on a large clip, which is
    // the right trade against handing someone a silently truncated master.
    write_bytes_impl(&path, bytes, false, unique, true)
}

/// Decode a percent-encoded UTF-8 string (the output of JS
/// `encodeURIComponent`). Malformed escapes pass through as literal bytes;
/// only invalid UTF-8 in the decoded result is an error.
pub(crate) fn percent_decode_utf8(s: &str) -> Result<String, crate::AppError> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            if let Some(hex) = s.get(i + 1..i + 3) {
                if let Ok(v) = u8::from_str_radix(hex, 16) {
                    out.push(v);
                    i += 3;
                    continue;
                }
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8(out)
        .map_err(|_| crate::AppError::internal("x-dest-path is not valid percent-encoded UTF-8"))
}

/// The real camera + microphone TCC state, from AVFoundation. WKWebView's
/// JS Permissions API is unreliable for capture (it collapses to "prompt"/
/// throws, so the app can't otherwise tell "granted" from "denied" or from
/// "the OS grant hasn't taken effect until relaunch"). AVCaptureDevice's
/// authorizationStatus is the authoritative answer the UI needs.
#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AvAuthStatus {
    /// "authorized" | "denied" | "notDetermined" | "restricted"
    pub camera: String,
    pub microphone: String,
    /// Screen recording (r122): "authorized" | "notDetermined" only.
    /// CGPreflightScreenCaptureAccess can't distinguish denied from
    /// never-asked without prompting, so the UI must style non-authorized
    /// as neutral not-yet, never as an error.
    pub screen: String,
}

#[cfg(target_os = "macos")]
fn av_status(media_type: &objc2_foundation::NSString) -> String {
    use objc2::runtime::AnyClass;
    let Some(cls) = AnyClass::get(c"AVCaptureDevice") else {
        return "notDetermined".into();
    };
    // AVAuthorizationStatus: 0 notDetermined, 1 restricted, 2 denied, 3 authorized.
    let raw: isize = unsafe { objc2::msg_send![cls, authorizationStatusForMediaType: media_type] };
    match raw {
        3 => "authorized",
        2 => "denied",
        1 => "restricted",
        _ => "notDetermined",
    }
    .into()
}

#[cfg(target_os = "macos")]
#[tauri::command]
pub fn av_permission_status() -> AvAuthStatus {
    use objc2_foundation::NSString;
    // AVMediaTypeVideo == "vide", AVMediaTypeAudio == "soun" (documented raw
    // values) - constructing them avoids an extern-static dance while the
    // AVCaptureDevice class lookup forces AVFoundation to be present.
    AvAuthStatus {
        camera: av_status(&NSString::from_str("vide")),
        microphone: av_status(&NSString::from_str("soun")),
        screen: if super::media::screen_recording_preflight() {
            "authorized".into()
        } else {
            "notDetermined".into()
        },
    }
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn av_permission_status() -> AvAuthStatus {
    AvAuthStatus {
        camera: "authorized".into(),
        microphone: "authorized".into(),
        screen: "authorized".into(),
    }
}

/// Open a System Settings privacy pane. The opener plugin's default scope
/// allows only http(s), so x-apple.systempreferences: links silently no-op
/// from the frontend - macOS `open` via std::process is the app's proven
/// escape hatch (see open_youtube_signin / open_full_disk_access). The
/// anchor is allowlisted so this can't become an arbitrary-URL opener.
#[tauri::command]
pub fn open_privacy_pane(anchor: String) -> Result<(), crate::AppError> {
    if !matches!(anchor.as_str(), "Privacy_Camera" | "Privacy_Microphone" | "Privacy_ScreenCapture") {
        return Err(crate::AppError::invalid("Unknown settings pane"));
    }
    std::process::Command::new("open")
        .arg(format!("x-apple.systempreferences:com.apple.preference.security?{anchor}"))
        .spawn()
        .map_err(|e| crate::AppError::internal(format!("open settings pane: {e}")))?;
    Ok(())
}

/// Read plain text off the system clipboard.
///
/// WHY THIS IS RUST AND NOT `navigator.clipboard.readText()`. The web API
/// raises macOS's "Paste from clipboard?" system modal on every call - a
/// second confirmation for a button the user just pressed on purpose. Reading
/// through the OS from the app's own process does not. That property is the
/// entire reason this command exists, and it is the thing to check first if
/// anyone is ever tempted to "simplify" the paste button back to the web API.
///
/// Replaces `tauri-plugin-clipboard-manager`, which brought `arboard` and with
/// it an entire image and colour-management stack - `image`, `tiff`,
/// `zune-jpeg`, `moxcms`, `fax`, `weezl` and more, fourteen crates in total -
/// because arboard's `image-data` feature is on by default and the plugin does
/// not disable it. All of that was compiled so the app could copy a join code.
/// The three `writeText` call sites moved to `navigator.clipboard.writeText`,
/// which three other places in this codebase were already using; only this
/// read had a reason to stay native.
///
/// Returns an empty string when the clipboard holds no text (an image, a file
/// promise, or nothing) - "nothing to paste" is a normal state, not an error.
#[tauri::command]
pub fn read_clipboard_text() -> Result<String, crate::AppError> {
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSPasteboard, NSPasteboardTypeString};
        // SAFETY: generalPasteboard() and stringForType: are both documented
        // as callable from any thread; nothing here is retained past the call.
        let text = unsafe {
            NSPasteboard::generalPasteboard().stringForType(NSPasteboardTypeString)
        };
        Ok(text.map(|s| s.to_string()).unwrap_or_default())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(String::new())
    }
}

/// Open an http(s) URL in the user's default browser.
///
/// Replaces `tauri-plugin-opener`, which the app used for exactly two links
/// (the update download and the AI provider key pages) while its `default`
/// permission set granted three commands. One of those, `reveal_item_in_dir`,
/// takes a `Vec<PathBuf>` and - unlike its two siblings - performs NO scope
/// check whatsoever, so granting `opener:default` handed the renderer an
/// unscoped "reveal any path on disk in Finder" it never once called. The app
/// already reveals paths through `reveal_in_finder` below, which checks that
/// the path exists, and already opens four URLs through `std::process` because
/// the plugin's own scope could not express what those links needed.
///
/// The only thing the plugin was buying was scheme validation, and that is the
/// three lines below. Everything else it brought was surface.
///
/// The scheme allowlist is the security boundary and is not optional: `open`
/// will happily launch `file:///`, `x-apple.systempreferences:`, or any
/// registered custom scheme, which would turn a compromised webview into an
/// arbitrary-application launcher. System Settings deep links keep going
/// through `open_privacy_pane`, where the anchor is allowlisted.
#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), crate::AppError> {
    let parsed = url::Url::parse(&url).map_err(|_| crate::AppError::invalid("Not a URL"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(crate::AppError::invalid("Only http and https links can be opened"));
    }
    // Pass the REPARSED url, not the caller's string: parsing normalises the
    // input, so what gets handed to `open` is exactly what was validated.
    std::process::Command::new("open")
        .arg(parsed.as_str())
        .spawn()
        .map_err(|e| crate::AppError::internal(format!("open url: {e}")))?;
    Ok(())
}

/// Move a file to the Finder Trash.
///
/// NOT `remove_file`. This app has no undo and no trash of its own, so a
/// delete it performs itself is final - and the things being deleted here are
/// somebody's footage. `trashItemAtURL:` puts the file where macOS already
/// offers Put Back, which makes the OS the recovery path rather than leaving
/// there being none.
///
/// Uses NSFileManager through objc2-foundation, which the app already
/// depends on, so this adds no crate.
#[tauri::command]
pub fn move_to_trash(path: String) -> Result<(), crate::AppError> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};

    if path.trim().is_empty() {
        return Err(crate::AppError::invalid("No path to move to the Trash."));
    }
    let p = std::path::Path::new(&path);
    // Report a missing file as missing rather than as a Trash failure: it is
    // the ordinary case when two windows both act on the same item.
    if !p.exists() {
        return Err(crate::AppError::not_found(path.as_str()));
    }

    // No `unsafe` here: objc2 0.6 marks all three of these safe, and clippy
    // rejects an unsafe block that wraps nothing unsafe.
    let ns_path = NSString::from_str(&path);
    let url = NSURL::fileURLWithPath(&ns_path);
    let fm = NSFileManager::defaultManager();
    fm.trashItemAtURL_resultingItemURL_error(&url, None)
        .map_err(|e| crate::AppError::internal(format!("Couldn't move it to the Trash: {e}")))?;
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

// ============================================================
// UPDATE CHECK (r128)
//
// Check-only, on purpose. It reports that a newer release exists and the
// frontend links to it; it does NOT download or install. Self-installing
// updates require a notarized app (see _design/versioning-and-updates.md) --
// replacing an un-notarized bundle in place is how a working install becomes
// a Gatekeeper problem.
//
// The request lives here rather than in the webview so it is not subject to
// the page CSP and the endpoint cannot be rewritten from page context. It is
// a plain unauthenticated GET of a public listing: no account, no identifier,
// nothing about the user or their media.
// ============================================================

/// The newest published release, as the frontend needs it.
#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct LatestRelease {
    /// Tag as published, e.g. "v0.2.0". The frontend parses the semver.
    pub version: String,
    /// Human page to send the user to.
    pub url: String,
    /// Release notes body, trimmed. May be empty.
    pub notes: String,
}

const RELEASES_API: &str =
    "https://api.github.com/repos/gchiaramonte3/SauceBunny/releases/latest";
const RELEASES_PAGE: &str = "https://github.com/gchiaramonte3/SauceBunny/releases/latest";

#[tauri::command]
pub async fn latest_release() -> Result<LatestRelease, crate::AppError> {
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(10))
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| crate::AppError::internal(format!("http client: {e}")))?;
    // GitHub rejects requests without a User-Agent.
    let res = client
        .get(RELEASES_API)
        .header("User-Agent", "SauceBunny")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| crate::AppError::Network(format!("update check: {e}")))?;
    if !res.status().is_success() {
        // 404 = nothing published yet, 403 = rate limited. Neither is the
        // user's problem, and neither should look like a failure they caused.
        return Err(crate::AppError::Network(format!(
            "update check unavailable ({})",
            res.status().as_u16()
        )));
    }
    // reqwest is built without its `json` feature (default-features = false in
    // Cargo.toml), so parse the text ourselves rather than widening the dep.
    let text = res
        .text()
        .await
        .map_err(|e| crate::AppError::Network(format!("update check read: {e}")))?;
    let body: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| crate::AppError::Network(format!("update check parse: {e}")))?;
    let version = body
        .get("tag_name")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    if version.is_empty() {
        return Err(crate::AppError::Network("update check: no tag".into()));
    }
    let url = body
        .get("html_url")
        .and_then(|v| v.as_str())
        .unwrap_or(RELEASES_PAGE)
        .to_string();
    let notes = body
        .get("body")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .trim()
        .chars()
        .take(600)
        .collect();
    Ok(LatestRelease { version, url, notes })
}

/// Is `name` in the parent directory with EXACTLY this casing? `Path::exists`
/// cannot answer that on a case-insensitive volume, so the directory entries
/// are compared byte for byte.
fn name_present_exactly(path: &std::path::Path, name: &str) -> bool {
    let Some(dir) = path.parent() else { return false };
    let Ok(entries) = std::fs::read_dir(dir) else { return false };
    entries.flatten().any(|e| e.file_name().to_str() == Some(name))
}

/// Rename ONE file in place, within its own folder.
///
/// Refuses anything that is not a plain in-folder rename: the destination must
/// sit in the same directory and must not already exist. Both are guards
/// against the same catastrophe — a bulk rename silently overwriting a file the
/// user did not have selected. The frontend's plan checks collisions too, but
/// it checks them against a listing that may be seconds old, and this is the
/// check that happens at the moment of the write.
///
/// A case-only rename is allowed, and is VERIFIED rather than assumed. Measured
/// on APFS, renaming "clip.mp4" to "Clip.mp4" directly does take effect — but
/// that is not true of every volume an editor works from (SMB shares and some
/// HFS+ externals silently no-op it, leaving the old casing while reporting
/// success, after which the app's records point at a name not on disk). So the
/// direct rename is attempted, the result is checked against the directory, and
/// only a volume that ignored it falls back to a two-hop rename through a
/// temporary. That way the common path stays a single atomic rename and the
/// awkward filesystems still end up correct.
#[tauri::command]
pub async fn rename_path(from: String, to: String) -> Result<String, crate::AppError> {
    let src = PathBuf::from(&from);
    if !src.exists() {
        return Err(format!("Not found: {from}").into());
    }
    let dst = PathBuf::from(&to);
    if src.parent() != dst.parent() {
        return Err("A rename may not move a file to another folder".to_string().into());
    }
    let Some(name) = dst.file_name().and_then(|n| n.to_str()) else {
        return Err("Invalid destination name".to_string().into());
    };
    if name.is_empty() || name.contains('/') || name.contains(':') {
        return Err("Name contains / or :".to_string().into());
    }

    let case_only = from != to && from.to_lowercase() == to.to_lowercase();
    if !case_only && dst.exists() {
        return Err(format!("A file named \"{name}\" already exists").into());
    }
    std::fs::rename(&src, &dst).map_err(|e| crate::AppError::Io(format!("rename: {e}")))?;

    // Only a case-only rename can have "succeeded" without changing anything.
    if case_only && !name_present_exactly(&dst, name) {
        let tmp = dst.with_file_name(format!(".sb-rename-{}", std::process::id()));
        std::fs::rename(&dst, &tmp).map_err(|e| crate::AppError::Io(format!("rename: {e}")))?;
        std::fs::rename(&tmp, &dst).map_err(|e| crate::AppError::Io(format!("rename: {e}")))?;
    }
    Ok(to)
}

/// One transcript's text, for the cross-transcript search index.
#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct TranscriptText {
    pub path: String,
    pub text: String,
    /// Mtime in ms, so the frontend can drop a re-transcribed file from its
    /// in-memory index without stat-ing every file itself.
    pub modified_ms: f64,
}

/// Read many transcripts in ONE round trip.
///
/// The search index needs every .srt in the library. Doing that as one invoke
/// per file is ~200 IPC hops on a real library, which is slow enough to be felt
/// on the first search; this makes it one. Unreadable files are SKIPPED rather
/// than failing the batch, because a single permission error should not cost
/// the user their whole search.
#[tauri::command]
pub async fn read_transcripts_bulk(
    paths: Vec<String>,
    max_total_bytes: Option<u64>,
) -> Result<Vec<TranscriptText>, crate::AppError> {
    // A cap so a pathological library cannot balloon the webview's heap. At the
    // default, a transcript averages well under 100 KB, so this is thousands of
    // files before it bites.
    let cap = max_total_bytes.unwrap_or(256 * 1024 * 1024);
    let mut total: u64 = 0;
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        let p = PathBuf::from(&path);
        let Ok(meta) = std::fs::metadata(&p) else { continue };
        if !meta.is_file() {
            continue;
        }
        if total.saturating_add(meta.len()) > cap {
            break;
        }
        let Ok(text) = std::fs::read_to_string(&p) else { continue };
        total = total.saturating_add(meta.len());
        let modified_ms = meta
            .modified()
            .ok()
            .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as f64)
            .unwrap_or(0.0);
        out.push(TranscriptText { path, text, modified_ms });
    }
    Ok(out)
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
// `async` is load-bearing: tauri only dispatches a command off the main thread
// when it is declared async, and the macOS IPC handler runs on the WKWebView
// main thread. The transcript library root is user-relocatable, so a sync read
// here beachballs the whole app on a hung SMB/NFS mount or an evicted iCloud
// file, with no watchdog to recover.
#[tauri::command]
pub async fn read_text_file_capped(path: String, max_bytes: Option<u64>) -> Result<String, crate::AppError> {
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

/// Where clips land when the user has not chosen a folder.
///
/// The export folder was the ONE setting with no default: `canExport` requires
/// it, so the primary button in the app sat disabled on a fresh install until
/// the user went and browsed for a folder, with only a nudge line pointing at
/// Settings. Every sibling setting has a default, and the transcript library
/// resolves one exactly this way.
///
/// `~/Movies/Sauce Bunny`, because clips are movies and Movies is where macOS
/// puts them. Resolved through Tauri's path API rather than built from a
/// string so a localized home folder works.
#[tauri::command]
pub fn default_export_path(app: AppHandle) -> Result<String, crate::AppError> {
    let base = app
        .path()
        .video_dir()
        // A machine with no Movies folder still has Documents; falling back
        // keeps the button enabled rather than reintroducing the dead end.
        .or_else(|_| app.path().document_dir())
        .map_err(|e| format!("video_dir: {e}"))?;
    Ok(base.join("Sauce Bunny").to_string_lossy().to_string())
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
pub const BACKEND_BUILD_ID: &str = "2026-08-26-r166-stop-actually-stops";

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

/// Register a LOCAL file on the proxy's peer routes (Tier B, phase 3a) and
/// return the raw route URL (`…/t/<tok>/peer/v1/<id>`). MSEStreamPlayer's
/// existing `/v1/` → `/fmp4/v1/` string-replace turns it into the remux URL,
/// so the whole streaming frontend works on it unchanged. The path itself
/// never appears in any URL; the CSPRNG id is the only thing on the wire.
#[tauri::command]
pub fn peer_media_register(path: String) -> Result<serde_json::Value, crate::AppError> {
    let p = std::path::PathBuf::from(&path);
    if !p.is_file() {
        return Err(crate::AppError::invalid("That source is not a plain file."));
    }
    let base = crate::stream_proxy::base_url()
        .ok_or_else(|| crate::AppError::internal("The media proxy is not running."))?;
    let id = crate::stream_proxy::register_peer_media(p)
        .map_err(|e| crate::AppError::internal(format!("mint peer id: {e}")))?;
    Ok(serde_json::json!({ "id": id, "url": format!("{base}/peer/v1/{id}") }))
}

/// Register the host's OFFERED file as a REMOTE stream source (Tier B 3d,
/// guest side): the returned peer URL streams it live over the session
/// substream. Same URL shape as the local registration, so the MSE player
/// needs no byte-path changes; the raw route answers 405 for it, which is
/// why callers must pass codec strings to the player (no probe).
#[tauri::command]
pub fn peer_media_register_remote(blake3: String) -> Result<serde_json::Value, crate::AppError> {
    if blake3.len() != 64 || !blake3.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err(crate::AppError::invalid("Bad file id."));
    }
    let base = crate::stream_proxy::base_url()
        .ok_or_else(|| crate::AppError::internal("The media proxy is not running."))?;
    let id = crate::stream_proxy::register_peer_media_remote(blake3)
        .map_err(|e| crate::AppError::internal(format!("mint peer id: {e}")))?;
    Ok(serde_json::json!({ "id": id, "url": format!("{base}/peer/v1/{id}") }))
}

/// Withdraw a peer media registration (source change, session end).
#[tauri::command]
pub fn peer_media_unregister(id: String) -> Result<(), crate::AppError> {
    crate::stream_proxy::unregister_peer_media(&id);
    Ok(())
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
mod raw_write_tests {
    use super::percent_decode_utf8;

    #[test]
    fn decodes_encode_uri_component_output() {
        // Plain ASCII, spaces, and non-Latin — the shapes real export names take.
        assert_eq!(percent_decode_utf8("plain.mp4").unwrap(), "plain.mp4");
        assert_eq!(
            percent_decode_utf8("%2FUsers%2Fg%2FMovies%2FMy%20Clip%20-%202.mp4").unwrap(),
            "/Users/g/Movies/My Clip - 2.mp4",
        );
        assert_eq!(percent_decode_utf8("caf%C3%A9%20%E6%97%A5%E6%9C%AC.mov").unwrap(), "café 日本.mov");
    }

    #[test]
    fn malformed_escapes_pass_through_and_bad_utf8_errors() {
        // A stray % that isn't a valid escape stays literal (encodeURIComponent
        // never emits this, but a hand-built header must not panic).
        assert_eq!(percent_decode_utf8("100%25 done%").unwrap(), "100% done%");
        assert_eq!(percent_decode_utf8("%GG").unwrap(), "%GG");
        // Decoded bytes that aren't UTF-8 are an error, not a lossy path.
        assert!(percent_decode_utf8("%FF%FE").is_err());
    }
}

#[cfg(test)]
mod atomic_write_tests {
    use super::write_bytes_impl;
    use std::path::{Path, PathBuf};

    /// Temp dir removed on drop, including on unwind.
    struct Dir(PathBuf);
    impl Dir {
        fn new(tag: &str) -> Self {
            let d = std::env::temp_dir().join(format!("sb-atomic-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&d);
            std::fs::create_dir_all(&d).unwrap();
            Self(d)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Every entry in the dir, so a leftover temp cannot hide.
    fn entries(d: &Path) -> Vec<String> {
        let mut v: Vec<String> = std::fs::read_dir(d)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        v.sort();
        v
    }

    #[test]
    fn atomic_write_leaves_the_file_and_nothing_else() {
        // The temp is a sibling, so if it were ever left behind it would be
        // sitting in the user's export folder next to the clip.
        let d = Dir::new("clean");
        let dest = d.path().join("clip.mov");
        let out = write_bytes_impl(dest.to_str().unwrap(), b"payload", false, false, true).unwrap();
        assert_eq!(out, dest.to_string_lossy());
        assert_eq!(std::fs::read(&dest).unwrap(), b"payload");
        assert_eq!(entries(d.path()), vec!["clip.mov".to_string()]);
    }

    #[test]
    fn atomic_overwrite_never_shortens_the_old_file_in_place() {
        // The reason this matters for exports: a plain write truncates FIRST,
        // so the window between truncate and finish is a real file, with the
        // real name, holding a prefix of the real bytes.
        let d = Dir::new("overwrite");
        let dest = d.path().join("clip.mov");
        std::fs::write(&dest, vec![b'x'; 4096]).unwrap();
        write_bytes_impl(dest.to_str().unwrap(), b"new", false, false, true).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"new");
        assert_eq!(entries(d.path()), vec!["clip.mov".to_string()]);
    }

    #[test]
    fn atomic_composes_with_unique_which_the_export_always_passes() {
        // write_raw_to_path sends x-unique: 1 on every call, so the two flags
        // are only ever exercised together in production.
        let d = Dir::new("unique");
        let dest = d.path().join("clip.mov");
        std::fs::write(&dest, b"first").unwrap();
        let out = write_bytes_impl(dest.to_str().unwrap(), b"second", false, true, true).unwrap();
        assert_ne!(out, dest.to_string_lossy(), "unique must not overwrite the original");
        assert_eq!(std::fs::read(&dest).unwrap(), b"first");
        assert_eq!(std::fs::read(&out).unwrap(), b"second");
        assert_eq!(entries(d.path()).len(), 2, "no temp left over: {:?}", entries(d.path()));
    }

    #[test]
    fn a_write_into_a_missing_folder_creates_nothing() {
        // Fails before any temp is created, rather than half-landing.
        let d = Dir::new("missing");
        let dest = d.path().join("nope").join("clip.mov");
        assert!(write_bytes_impl(dest.to_str().unwrap(), b"x", false, false, true).is_err());
        assert_eq!(entries(d.path()), Vec::<String>::new());
    }

    #[test]
    fn the_export_command_opts_into_the_atomic_path() {
        // Everything above tests the MECHANISM. This tests the WIRING, which
        // is one boolean at one call site and invisible to every other test
        // here - the same reason the TypeScript side guards its structural
        // facts by reading its own source.
        let src = include_str!("system.rs");
        let after = src
            .split("pub async fn write_raw_to_path")
            .nth(1)
            .expect("write_raw_to_path not found - the matcher broke, not the code");
        let call = after
            .split("write_bytes_impl(")
            .nth(1)
            .expect("write_raw_to_path no longer calls write_bytes_impl");
        let args = &call[..call.find(')').expect("unterminated call")];
        assert!(
            args.trim_end().ends_with("true"),
            "the export write must pass atomic=true; a plain write truncates \
             first and leaves a short file under the user's chosen name. Got: {args}",
        );
    }

    #[test]
    fn the_non_atomic_path_still_writes_for_its_own_callers() {
        // Small app documents opt out; that route must keep working.
        let d = Dir::new("plain");
        let dest = d.path().join("notes.json");
        write_bytes_impl(dest.to_str().unwrap(), b"{}", false, false, false).unwrap();
        assert_eq!(std::fs::read(&dest).unwrap(), b"{}");
    }
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


// ── Window geometry ──────────────────────────────────────────────────
//
// The main window re-fit itself to ~85%x90% of the monitor and re-centred on
// EVERY launch, so a window someone had sized and placed came back wrong every
// morning — while the inner chrome persisted nine different ways. Only the
// outermost thing forgot.
//
// Deliberately NOT a Tauri plugin: `tauri::Window` already exposes everything
// needed, and CLAUDE.md asks for a reason before adding one. Deliberately not
// localStorage either: the frame has to be applied before the webview paints,
// which is Rust's side of the boot.

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, Copy)]
struct WindowFrame {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

fn window_frame_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("window-frame.json"))
}

/// Restore the saved frame. Returns false when there is nothing to restore, so
/// the caller can fall back to fitting the screen.
///
/// A saved frame is REJECTED when it would land off every current monitor —
/// unplug the external display the window was on and a blind restore puts it
/// somewhere unreachable, with no way back short of deleting a file the user
/// does not know exists.
pub(crate) fn restore_window_frame(win: &tauri::WebviewWindow) -> bool {
    let Some(path) = window_frame_path(&win.app_handle().clone()) else { return false };
    let Ok(text) = std::fs::read_to_string(&path) else { return false };
    let Ok(f) = serde_json::from_str::<WindowFrame>(&text) else { return false };
    if f.width < 600 || f.height < 400 {
        return false; // corrupt or absurd; fall back
    }
    if !frame_is_visible(win, &f) {
        return false;
    }
    let _ = win.set_size(tauri::LogicalSize::new(f.width as f64, f.height as f64));
    let _ = win.set_position(tauri::LogicalPosition::new(f.x as f64, f.y as f64));
    true
}

/// True when enough of the frame's title bar lands on some attached monitor to
/// be draggable. 120x40 of overlap is the smallest patch a person can actually
/// grab.
fn frame_is_visible(win: &tauri::WebviewWindow, f: &WindowFrame) -> bool {
    let Ok(monitors) = win.available_monitors() else { return false };
    monitors.iter().any(|m| {
        let s = m.scale_factor();
        let pos = m.position().to_logical::<f64>(s);
        let size = m.size().to_logical::<f64>(s);
        let (mx, my) = (pos.x, pos.y);
        let (mw, mh) = (size.width, size.height);
        let ox = (f.x as f64 + f.width as f64).min(mx + mw) - (f.x as f64).max(mx);
        let oy = (f.y as f64 + f.height as f64).min(my + mh) - (f.y as f64).max(my);
        ox >= 120.0 && oy >= 40.0
    })
}

/// Persist the frame whenever the user finishes moving or resizing.
///
/// Written on the event rather than on exit: a crash or a force-quit should
/// not cost the user their window, and the file is ~60 bytes.
pub(crate) fn watch_window_frame(win: &tauri::WebviewWindow) {
    let w = win.clone();
    win.on_window_event(move |event| {
        if !matches!(
            event,
            tauri::WindowEvent::Moved(_) | tauri::WindowEvent::Resized(_)
        ) {
            return;
        }
        // A minimized or fullscreen window reports a frame that would be wrong
        // to restore into, so skip those rather than record them.
        if w.is_minimized().unwrap_or(false) || w.is_fullscreen().unwrap_or(false) {
            return;
        }
        let (Ok(pos), Ok(size)) = (w.outer_position(), w.inner_size()) else { return };
        let scale = w.scale_factor().unwrap_or(1.0);
        let p = pos.to_logical::<f64>(scale);
        let s = size.to_logical::<f64>(scale);
        let frame = WindowFrame {
            x: p.x as i32,
            y: p.y as i32,
            width: s.width as u32,
            height: s.height as u32,
        };
        if let Some(path) = window_frame_path(&w.app_handle().clone()) {
            if let Ok(text) = serde_json::to_string(&frame) {
                let _ = std::fs::write(path, text);
            }
        }
    });
}

#[cfg(test)]
mod cache_layout_tests {
    use super::*;
    use std::io::Write;

    fn tmp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("sb-cache-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn touch(p: &std::path::Path, body: &[u8]) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        let mut f = std::fs::File::create(p).unwrap();
        f.write_all(body).unwrap();
    }

    #[test]
    fn the_media_subtree_is_renamed_not_recopied_and_keeps_every_file() {
        // The thing that must not break: this subtree is "download once,
        // reuse forever" and can be tens of gigabytes. A migration that
        // lost it would make every user re-pay yt-dlp's full extraction.
        let cache = tmp();
        let legacy = cache.join("saucebunny-media");
        touch(&legacy.join("downloads").join("saucebunny-download-abc.mp4"), b"movie");
        touch(&legacy.join("meta").join("abc.json"), b"{}");

        let moved = migrate_cache_layout(&cache);
        assert!(moved >= 1);
        assert!(!legacy.exists(), "the old directory is still there");
        assert_eq!(
            std::fs::read(cache.join("media").join("downloads").join("saucebunny-download-abc.mp4")).unwrap(),
            b"movie",
        );
        assert!(cache.join("media").join("meta").join("abc.json").is_file());
    }

    #[test]
    fn thumbnails_move_into_their_folder_and_shed_the_prefix() {
        let cache = tmp();
        touch(&cache.join("saucebunny-thumb-KEY1.jpg"), b"jpg");
        migrate_cache_layout(&cache);
        assert!(cache.join("thumbnails").join("KEY1.jpg").is_file());
        assert!(!cache.join("saucebunny-thumb-KEY1.jpg").exists());
    }

    #[test]
    fn migration_is_idempotent_and_never_clobbers_a_new_layout() {
        let cache = tmp();
        // Both present: the NEW one is authoritative and must survive.
        touch(&cache.join("saucebunny-media").join("downloads").join("old.mp4"), b"old");
        touch(&cache.join("media").join("downloads").join("new.mp4"), b"new");
        migrate_cache_layout(&cache);
        assert_eq!(
            std::fs::read(cache.join("media").join("downloads").join("new.mp4")).unwrap(),
            b"new",
            "the migration overwrote a live media cache",
        );
        // Running it again on a tidy cache changes nothing.
        let cache2 = tmp();
        touch(&cache2.join("media").join("downloads").join("x.mp4"), b"x");
        assert_eq!(migrate_cache_layout(&cache2), 0);
    }

    #[test]
    fn the_sweep_clears_stale_scratch_and_spares_the_named_folders() {
        let cache = tmp();
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(CACHE_TTL_SECONDS + 60);
        touch(&scratch_dir(&cache).join("playback-job1.mp4"), b"tmp");
        touch(&thumbs_dir(&cache).join("KEY.jpg"), b"jpg");
        touch(&cache.join("media").join("downloads").join("keep.mp4"), b"movie");

        // `now` far in the future makes every file stale without faking mtimes.
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(CACHE_TTL_SECONDS * 2);
        let removed = sweep_stale_files(&cache, later);

        assert_eq!(removed, 1, "expected exactly the scratch file");
        assert!(!scratch_dir(&cache).join("playback-job1.mp4").exists());
        // Both persistent folders survive, which is the whole point of them.
        assert!(thumbs_dir(&cache).join("KEY.jpg").is_file());
        assert!(cache.join("media").join("downloads").join("keep.mp4").is_file());
        let _ = old;
    }

    #[test]
    fn fresh_scratch_survives_the_sweep() {
        let cache = tmp();
        touch(&scratch_dir(&cache).join("playback-live.mp4"), b"tmp");
        assert_eq!(sweep_stale_files(&cache, std::time::SystemTime::now()), 0);
        assert!(scratch_dir(&cache).join("playback-live.mp4").is_file());
    }

    #[test]
    fn the_legacy_arm_still_clears_an_un_migrated_install() {
        // An install from before the tidy has loose root files; the sweep's
        // legacy pass is what stops them lingering forever.
        let cache = tmp();
        touch(&cache.join("saucebunny-webcache-oldjob.mp4"), b"tmp");
        let later = std::time::SystemTime::now() + std::time::Duration::from_secs(CACHE_TTL_SECONDS * 2);
        assert_eq!(sweep_stale_files(&cache, later), 1);
    }
}

#[cfg(test)]
mod atomic_write_race_tests {
    use super::*;

    /// Two concurrent atomic saves of the SAME file must not corrupt it.
    ///
    /// Every other test in this module is sequential, which is why the staging
    /// collision survived: the temp path was keyed on the destination plus the
    /// PID, so within one process two writers shared it. Tauri runs invokes
    /// concurrently, so this is reachable by two windows saving one document.
    ///
    /// Real threads rather than a simulated interleave - the failure is
    /// `File::create` truncating an inode another writer still holds an fd to,
    /// which nothing but genuine concurrency reproduces.
    #[test]
    fn concurrent_atomic_writes_never_leave_a_torn_file() {
        let dir = std::env::temp_dir().join(format!("sb-atomic-race-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("casts.json");

        // Distinguishable payloads, both large enough that a torn write lands
        // mid-buffer rather than being swallowed by a single syscall.
        let a = format!("{{\"a\":\"{}\"}}", "a".repeat(400_000));
        let b = format!("{{\"b\":\"{}\"}}", "b".repeat(400_000));
        let dest_s = dest.to_string_lossy().into_owned();

        for _ in 0..12 {
            let (d1, d2) = (dest_s.clone(), dest_s.clone());
            let (p1, p2) = (a.clone(), b.clone());
            let t1 = std::thread::spawn(move || {
                write_bytes_impl(&d1, p1.as_bytes(), false, false, true)
            });
            let t2 = std::thread::spawn(move || {
                write_bytes_impl(&d2, p2.as_bytes(), false, false, true)
            });
            // Neither writer may fail: the old cleanup path had a failing
            // writer delete the temp a healthy one was about to rename.
            t1.join().unwrap().expect("writer A failed");
            t2.join().unwrap().expect("writer B failed");

            // Whoever won, the file must be exactly one of the two payloads -
            // not a splice, not a NUL hole, not a truncation.
            let got = std::fs::read_to_string(&dest).unwrap();
            assert!(
                got == a || got == b,
                "torn write: {} bytes, starts {:?}, contains NUL: {}",
                got.len(),
                &got[..got.len().min(24)],
                got.contains('\0'),
            );
        }

        // No staging files left behind.
        let strays: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".tmp-"))
            .collect();
        assert!(strays.is_empty(), "left staging files behind: {strays:?}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod media_cap_transfers_tests {
    use super::*;

    fn touch(p: &std::path::Path, bytes: usize) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, vec![b'x'; bytes]).unwrap();
    }

    fn scratch() -> PathBuf {
        let d = std::env::temp_dir()
            .join(format!("sb-mediacap-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// A file received from a co-review peer is not eviction fodder.
    ///
    /// The size cap is an LRU over the media cache, and `transfers/` lives
    /// inside it — so a guest's only copy of a screening master was being
    /// deleted oldest-first, at boot, against a threshold the user set with
    /// web downloads in mind. It does not regenerate: the host is gone.
    #[test]
    fn transfers_are_never_offered_to_the_size_cap() {
        let media = scratch();
        touch(&media.join("downloads/web-clip.mp4"), 64);
        touch(&media.join("audio/track.m4a"), 64);
        touch(&media.join("meta/source.json"), 8);
        touch(&media.join("transfers/abc12345-Rough cut.mov"), 4096);
        touch(&media.join("transfers/def67890-Grade pass.mov"), 4096);

        let got: Vec<String> = evictable_media_files(&media)
            .into_iter()
            .map(|(p, _, _)| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();

        assert!(
            !got.iter().any(|n| n.contains("Rough cut") || n.contains("Grade pass")),
            "a received co-review file was offered to the cap: {got:?}",
        );
        // And the derived cache IS still evictable — the exemption must not
        // have turned the whole cap off.
        assert!(got.iter().any(|n| n == "web-clip.mp4"), "downloads no longer evictable: {got:?}");
        assert!(got.iter().any(|n| n == "track.m4a"), "audio no longer evictable: {got:?}");
        assert!(got.iter().any(|n| n == "source.json"), "meta no longer evictable: {got:?}");
        assert_eq!(got.len(), 3, "unexpected eviction set: {got:?}");

        let _ = std::fs::remove_dir_all(&media);
    }

    /// The exemption is the directory, not the filename — a download that
    /// happens to be called "transfers.mp4" is still ordinary cache.
    #[test]
    fn the_exemption_is_a_directory_not_a_name() {
        let media = scratch();
        touch(&media.join("downloads/transfers.mp4"), 32);
        touch(&media.join("transfers/aaaaaaaa-real.mov"), 32);

        let got: Vec<String> = evictable_media_files(&media)
            .into_iter()
            .map(|(p, _, _)| p.file_name().unwrap().to_string_lossy().into_owned())
            .collect();
        assert_eq!(got, vec!["transfers.mp4".to_string()], "got {got:?}");

        let _ = std::fs::remove_dir_all(&media);
    }

    /// Nested directories under the cache are still walked, so the exemption
    /// cannot be read as "stop recursing".
    #[test]
    fn other_subdirectories_are_still_walked_recursively() {
        let media = scratch();
        touch(&media.join("downloads/2026-08/deep/clip.mp4"), 16);
        let got = evictable_media_files(&media);
        assert_eq!(got.len(), 1, "nested derived cache was skipped");

        let _ = std::fs::remove_dir_all(&media);
    }
}
