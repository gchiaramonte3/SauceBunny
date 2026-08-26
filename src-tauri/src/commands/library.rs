//! Library scan — backend for the Library view (r110, phase 2).
//!
//! A Netflix-style browser over user-added local folders. The FRONTEND owns
//! the list of root folders (localStorage `saucebunny.libraryRoots`) and
//! passes one root path per call — Rust holds no root-list state.
//!
//! `scan_library_folder` is deliberately a FAST metadata walk: names, sizes,
//! mtimes, and an extension-based video/audio kind. It never probes duration
//! and never spawns ffmpeg — the Library UI fetches duration and thumbnails
//! lazily, per visible card, through the existing `probe_local_file` /
//! `generate_local_thumbnail` commands (media.rs).
//!
//! There is intentionally NO `pick_library_folder` command: the frontend
//! calls tauri-plugin-dialog directly (`open({ directory: true })`), exactly
//! like the export-folder and transcript-library pickers already do
//! (Sidebar.tsx `chooseFolder`, SettingsModal.tsx). A command here would
//! just duplicate a plugin capability.

use super::*;
use std::path::Path;

/// Accepted media extensions — a MIRROR of `src/lib/import-extensions.ts`
/// (`VIDEO_EXTENSIONS` / `AUDIO_EXTENSIONS`), the frontend's single source
/// of truth for what the import surfaces accept. Rust can't read that TS
/// module, so the lists are duplicated by hand: when you add a format there,
/// add it HERE too (and vice versa). Transcript extensions (.srt/.vtt) are
/// deliberately absent — the library browses playable media only.
const VIDEO_EXTENSIONS: &[&str] = &["mp4", "mov", "m4v", "mkv", "webm", "avi"];
const AUDIO_EXTENSIONS: &[&str] = &["mp3", "m4a", "wav", "flac", "ogg", "aac"];

/// Media kind of one library item, decided purely by file extension.
/// Serializes lowercase, so the TS side sees `"video" | "audio"`.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum LibraryItemKind {
    Video,
    Audio,
}

/// One playable file found by the scan. Duration/thumbnail are deliberately
/// absent — fetched lazily by the frontend (see module docs).
#[derive(Serialize, Debug, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct LibraryItem {
    pub name: String,
    pub path: String,
    // See Metadata::view_count for the bigint→number rationale (r49).
    #[ts(type = "number")]
    pub size_bytes: u64,
    /// Last-modified time as Unix milliseconds; 0 when the FS won't say.
    #[ts(type = "number")]
    pub modified_ms: u64,
    pub kind: LibraryItemKind,
}

/// One folder node of the scanned tree, root included.
#[derive(Serialize, Debug, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct LibraryFolder {
    pub name: String,
    pub path: String,
    pub folders: Vec<LibraryFolder>,
    pub items: Vec<LibraryItem>,
    /// True when this folder has subfolders the scan did NOT descend into,
    /// because it had run out of depth.
    ///
    /// The scan stops at LIBRARY_SCAN_DEPTH levels and, until now, simply
    /// omitted whatever was below - "omit, don't stub", with nothing said to
    /// anyone. Three levels is shallow for this app in particular: a
    /// perfectly ordinary Footage / Project / Shoot day / Camera A layout
    /// puts the clips on level four, so the library looked empty and correct
    /// at the same time. Reporting it is the same fix the search truncation
    /// note got: say what was left out, rather than quietly leaving it out.
    #[serde(default)]
    pub deeper: bool,
}

/// `Some(kind)` when the file's extension (lowercased — same semantics as
/// the TS `fileExtension` helper) is on one of the mirrored lists.
fn media_kind(path: &Path) -> Option<LibraryItemKind> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    if VIDEO_EXTENSIONS.contains(&ext.as_str()) {
        Some(LibraryItemKind::Video)
    } else if AUDIO_EXTENSIONS.contains(&ext.as_str()) {
        Some(LibraryItemKind::Audio)
    } else {
        None
    }
}

/// Recursive walk. `depth_remaining` counts folder levels we may still
/// descend: a node scanned with 0 lists its own media files but omits its
/// subfolders entirely (they are not returned as empty stubs).
///
/// Skips: hidden entries (dot-prefixed), symlinks (file OR directory —
/// `DirEntry::file_type()` never follows links, and following them could
/// loop or wander outside the chosen root), `.app` bundles (packages that
/// read as directories but are opaque applications to the user), and any
/// entry whose path is not valid UTF-8 (the frontend round-trips paths as
/// UTF-8 `String`s — a lossy `to_string_lossy` path points at the wrong
/// file, so probe/thumbnail/open would silently fail; skipping is honest).
///
/// Returns `None` when the directory itself can't be read (permission /
/// TCC denial) or its own path isn't valid UTF-8 — the caller OMITS such a
/// subfolder rather than surfacing it as an empty stub. Individual bad
/// files (un-stat'able, non-UTF-8 name) are skipped without failing the
/// whole folder. Root-level readability is checked separately by
/// `scan_library_root`, so a bad root errors loudly instead of returning
/// `None`.
fn scan_dir(dir: &Path, depth_remaining: u32) -> Option<LibraryFolder> {
    // A non-UTF-8 folder path can't round-trip to the frontend — omit it.
    let dir_path = dir.to_str()?;
    let name = dir
        .file_name()
        .and_then(|n| n.to_str())
        // A root like "/" has no file_name — fall back to the full path.
        .unwrap_or(dir_path)
        .to_string();

    // Unreadable directory → None so the caller omits it (no empty stub).
    let entries = std::fs::read_dir(dir).ok()?;

    let mut folders: Vec<LibraryFolder> = Vec::new();
    let mut items: Vec<LibraryItem> = Vec::new();
    let mut deeper = false;

    for entry in entries.flatten() {
        let entry_name_os = entry.file_name();
        // Non-UTF-8 name can't round-trip to the frontend — skip.
        let Some(entry_name) = entry_name_os.to_str() else {
            continue;
        };
        if entry_name.starts_with('.') {
            continue; // hidden
        }
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() {
            if entry_name.to_ascii_lowercase().ends_with(".app") {
                continue; // package-like bundle
            }
            if depth_remaining == 0 {
                // Omit, but REMEMBER: the caller reports this rather than
                // letting the folder look empty.
                deeper = true;
                continue;
            }
            // scan_dir yields None for an unreadable / non-UTF-8 subfolder;
            // extend() with the Option then adds nothing (no empty stub).
            folders.extend(scan_dir(&path, depth_remaining - 1));
        } else if file_type.is_file() {
            let kind = match media_kind(&path) {
                Some(k) => k,
                None => continue, // not a media file
            };
            // Non-UTF-8 path → skip: a lossy path is an un-openable trap.
            let Some(path_str) = path.to_str() else {
                continue;
            };
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            let modified_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            items.push(LibraryItem {
                name: entry_name.to_string(),
                path: path_str.to_string(),
                size_bytes: meta.len(),
                modified_ms,
                kind,
            });
        }
        // Anything else (fifo, socket, device) is ignored.
    }

    // Case-insensitive name sort; original-name tiebreak keeps the order
    // deterministic when two names differ only by case.
    folders.sort_by(|a, b| {
        a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.name.cmp(&b.name))
    });
    items.sort_by(|a, b| {
        a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.name.cmp(&b.name))
    });

    Some(LibraryFolder {
        name,
        path: dir_path.to_string(),
        deeper,
        folders,
        items,
    })
}

/// Sync core of `scan_library_folder`, split out so unit tests can call it
/// without async ceremony (same pattern as `read_file_range_bytes`).
fn scan_library_root(path: &str, max_depth: u32) -> Result<LibraryFolder, crate::AppError> {
    let root = PathBuf::from(path);
    // `try_exists()` distinguishes genuinely-missing (Ok(false) → NotFound,
    // the frontend's advertised stale-root prune signal) from a stat /
    // permission failure (Err → Invalid). Plain `Path::exists()` collapses
    // both to `false`, which would mislabel an inaccessible NAS root as
    // NotFound and make the frontend wrongly prune a still-valid root.
    match root.try_exists() {
        Ok(true) => {}
        Ok(false) => return Err(crate::AppError::not_found(path.to_string())),
        Err(e) => {
            return Err(crate::AppError::invalid(format!(
                "Can't access folder {path}: {e}"
            )))
        }
    }
    if !root.is_dir() {
        return Err(crate::AppError::invalid(format!("Not a folder: {path}")));
    }
    // Surface a root-level read failure (permissions, macOS TCC denial on
    // e.g. ~/Movies) as a real error instead of a silently-empty library.
    // Unreadable SUBfolders during the walk are skipped, not fatal.
    std::fs::read_dir(&root)?;
    // scan_dir returns None only on a read/UTF-8 failure the checks above
    // already ruled out for the root (barring a TOCTOU race) — treat that
    // rare case as an internal error rather than silently blanking.
    scan_dir(&root, max_depth)
        .ok_or_else(|| crate::AppError::internal(format!("Could not scan folder: {path}")))
}

/// Scan one user-added library root to `max_depth` folder levels (the
/// Library view passes 3) and return the folder tree of playable media.
///
/// The synchronous `std::fs` walk is offloaded to a blocking thread via
/// `spawn_blocking`. Tauri runs `async` commands on the tokio worker pool,
/// so doing the walk inline would pin a worker thread — and a recursive
/// walk of a cold or hung network volume (SMB/NFS) can block for a long
/// time, starving the executor. The dedicated blocking pool is sized for
/// exactly this kind of stall-prone I/O.
#[tauri::command]
pub async fn scan_library_folder(
    path: String,
    max_depth: u32,
) -> Result<LibraryFolder, crate::AppError> {
    tokio::task::spawn_blocking(move || scan_library_root(&path, max_depth))
        .await
        .map_err(|e| crate::AppError::internal(format!("Library scan task failed: {e}")))?
}

// ── Transcript library scan (the "all transcripts" auto-folder) ──────────────
//
// Separate from scan_library_folder because transcripts are the OPPOSITE
// filter: this walks ~/Documents/Sauce Bunny/Transcripts/ (organized in
// YYYY-MM subfolders) for the .srt/.vtt files the media scan deliberately
// skips, so every transcript on disk is discoverable — not just the 50 most
// recent the localStorage history caps at. Fast metadata walk, same as the
// media scan: no parsing, just existence of the r132 `.diarization.json`
// sidecar as a "has speakers" flag.

/// One transcript file found under the Transcripts library.
#[derive(Serialize, Debug, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct TranscriptFile {
    /// Filename stem, no extension — the display title.
    pub name: String,
    /// Absolute path to the .srt / .vtt on disk.
    pub path: String,
    /// Immediate parent folder name (e.g. "2026-07"); "" when directly in root.
    pub folder: String,
    #[ts(type = "number")]
    pub size_bytes: u64,
    #[ts(type = "number")]
    pub modified_ms: u64,
    /// A co-located `<stem>.diarization.json` sidecar exists (r132) → the
    /// transcript carries speaker turns.
    pub has_diarization: bool,
    /// A co-located `<stem>.analysis.json` sidecar exists → the transcript has
    /// a saved AI analysis to reuse.
    pub has_analysis: bool,
    /// "srt" | "vtt".
    pub format: String,
}

fn transcript_ext(path: &Path) -> Option<String> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    (ext == "srt" || ext == "vtt").then_some(ext)
}

/// Recursive collector: appends every transcript under `dir` (to
/// `depth_remaining` folder levels) into `out`. Mirrors scan_dir's skip rules
/// (hidden, symlinks, non-UTF-8, unreadable dirs) but flattens instead of
/// building a tree — the frontend groups by `folder`.
/// Cheap content probe: does this transcript carry speaker labels? True for the
/// in-app diarizer's `[SPEAKER_NN]` machine tags AND VTT `<v Name>` voice cues.
/// This lets an IMPORTED transcript that already names speakers light the
/// "Speakers" badge even when it has no sibling `.diarization.json` (the badge
/// used to key on that sidecar alone, so labeled imports read as un-diarized).
/// Bounded read — speaker labels appear from the first cue — keeps the scan cheap.
fn transcript_has_speaker_labels(path: &Path) -> bool {
    use std::io::Read;
    let Ok(f) = std::fs::File::open(path) else { return false };
    // read_to_end on a Take handles short reads (a single read() can return < 128 KB);
    // covers `[SPEAKER_NN]` machine tags and VTT `<v Name>` / `<v.class Name>` voices.
    let mut buf = Vec::new();
    if f.take(128 * 1024).read_to_end(&mut buf).is_err() { return false; }
    let head = String::from_utf8_lossy(&buf).to_ascii_lowercase();
    head.contains("[speaker_") || head.contains("<v ") || head.contains("<v.")
}

fn collect_transcripts(dir: &Path, folder_label: &str, depth_remaining: u32, out: &mut Vec<TranscriptFile>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let name_os = entry.file_name();
        let Some(entry_name) = name_os.to_str() else { continue };
        if entry_name.starts_with('.') { continue; }
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_symlink() { continue; }
        let path = entry.path();
        if ft.is_dir() {
            if depth_remaining == 0 || entry_name.to_ascii_lowercase().ends_with(".app") { continue; }
            collect_transcripts(&path, entry_name, depth_remaining - 1, out);
        } else if ft.is_file() {
            let Some(format) = transcript_ext(&path) else { continue };
            let Some(path_str) = path.to_str() else { continue };
            let Ok(meta) = entry.metadata() else { continue };
            let modified_ms = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            out.push(TranscriptFile {
                name: path.file_stem().and_then(|s| s.to_str()).unwrap_or(entry_name).to_string(),
                path: path_str.to_string(),
                folder: folder_label.to_string(),
                size_bytes: meta.len(),
                modified_ms,
                has_diarization: path.with_extension("diarization.json").is_file()
                    || transcript_has_speaker_labels(&path),
                has_analysis: path.with_extension("analysis.json").is_file(),
                format,
            });
        }
    }
}

fn scan_transcript_root(path: &str) -> Vec<TranscriptFile> {
    let root = PathBuf::from(path);
    // A missing library (nothing transcribed yet) is the normal first-run case,
    // not an error — return an empty list rather than surfacing a scary error.
    if !root.is_dir() { return Vec::new(); }
    let mut out = Vec::new();
    collect_transcripts(&root, "", 3, &mut out);
    // Newest first — the library's default and what "recent" wants.
    out.sort_by(|a, b| b.modified_ms.cmp(&a.modified_ms).then_with(|| a.name.cmp(&b.name)));
    out
}

/// Scan the Transcripts library (default `~/Documents/Sauce Bunny/Transcripts/`,
/// or the caller's custom path) for every transcript on disk. Offloaded to the
/// blocking pool like scan_library_folder — the walk can touch a cold volume.
#[tauri::command]
pub async fn scan_transcript_library(path: String) -> Result<Vec<TranscriptFile>, crate::AppError> {
    tokio::task::spawn_blocking(move || scan_transcript_root(&path))
        .await
        .map_err(|e| crate::AppError::internal(format!("Transcript scan task failed: {e}")))
}

/// Validate a user-entered file/folder name: non-empty, a SINGLE path segment
/// (no separators / traversal), not hidden. Trailing dots/spaces trimmed
/// (Windows-hostile, confusing on macOS).
fn valid_stem(s: &str) -> Result<String, crate::AppError> {
    let t = s.trim();
    if t.is_empty() {
        return Err(crate::AppError::invalid("Enter a name."));
    }
    if t.contains('/') || t.contains('\\') || t.contains('\0') || t == "." || t == ".." || t.starts_with('.') {
        return Err(crate::AppError::invalid("Names can't contain slashes or start with a dot."));
    }
    let cleaned = t.trim_end_matches([' ', '.']).to_string();
    if cleaned.is_empty() {
        return Err(crate::AppError::invalid("Enter a name."));
    }
    Ok(cleaned)
}

/// Move a transcript's co-located sidecars (`.diarization.json` / `.analysis.json`)
/// to sit beside `dest`. Best-effort AND non-clobbering: it never overwrites a
/// sidecar already at the destination (that would be another transcript's data —
/// `ensure_dest_clear` rejects such moves up front, but this is the belt-and-
/// braces). An orphaned sidecar only costs a row badge, never the transcript.
fn move_sidecars(src: &Path, dest: &Path) {
    for side in ["diarization.json", "analysis.json"] {
        let old = src.with_extension(side);
        let new = dest.with_extension(side);
        if old.is_file() && !new.exists() {
            let _ = std::fs::rename(&old, &new);
        }
    }
}

/// A destination is only clear when neither the transcript file NOR either of its
/// sidecars already exists there — because `.srt` and `.vtt` of the same stem
/// share sidecar names, a name that clears the transcript-file check could still
/// clobber a sibling's `.diarization.json` / `.analysis.json` (silent, expensive
/// data loss). Reject the whole operation before anything is moved.
fn ensure_dest_clear(dest: &Path) -> Result<(), crate::AppError> {
    if dest.exists() {
        let name = dest.file_name().and_then(|n| n.to_str()).unwrap_or("that name");
        return Err(crate::AppError::invalid(format!("\"{name}\" already exists in that folder.")));
    }
    for side in ["diarization.json", "analysis.json"] {
        if dest.with_extension(side).exists() {
            return Err(crate::AppError::invalid(
                "That name would overwrite another transcript's speaker or analysis data in the destination.",
            ));
        }
    }
    Ok(())
}

/// Rename a transcript file (.srt/.vtt) to `<new_stem>.<ext>` in place, carrying
/// its sidecars along. Returns the new path. The SOURCE media file is untouched.
#[tauri::command]
pub fn rename_transcript(srt_path: String, new_stem: String) -> Result<String, crate::AppError> {
    let src = PathBuf::from(&srt_path);
    if !src.is_file() {
        return Err(crate::AppError::not_found(srt_path.as_str()));
    }
    let stem = valid_stem(&new_stem)?;
    let dir = src.parent().ok_or_else(|| crate::AppError::invalid("The transcript has no parent folder."))?;
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("srt");
    let dest = dir.join(format!("{stem}.{ext}"));
    if dest == src {
        return Ok(srt_path);
    }
    // A case-only rename ("Talk.srt" → "talk.srt") on a case-insensitive volume:
    // dest != src as paths but they resolve to the SAME file, so the clear-check
    // would wrongly reject it. Allow it through to the rename (which changes case).
    let same_file = dest.exists()
        && std::fs::canonicalize(&dest).ok() == std::fs::canonicalize(&src).ok();
    if !same_file {
        ensure_dest_clear(&dest)?;
    }
    // Rename the transcript FIRST (the critical file); a failure leaves everything
    // untouched. Then move the sidecars best-effort.
    std::fs::rename(&src, &dest)
        .map_err(|e| crate::AppError::internal(format!("Couldn't rename the transcript: {e}")))?;
    move_sidecars(&src, &dest);
    dest.to_str().map(str::to_string).ok_or_else(|| crate::AppError::internal("Renamed path isn't valid UTF-8."))
}

/// Create a one-level subfolder in the transcript library. Returns its path.
#[tauri::command]
pub fn create_transcript_folder(library_path: String, name: String) -> Result<String, crate::AppError> {
    let stem = valid_stem(&name)?;
    let dir = PathBuf::from(&library_path).join(&stem);
    if dir.exists() {
        return Err(crate::AppError::invalid(format!("A folder named \"{stem}\" already exists.")));
    }
    std::fs::create_dir_all(&dir)
        .map_err(|e| crate::AppError::internal(format!("Couldn't create the folder: {e}")))?;
    dir.to_str().map(str::to_string).ok_or_else(|| crate::AppError::internal("Folder path isn't valid UTF-8."))
}

/// Every one-level subfolder of the transcript library, whether or not it
/// holds any transcripts.
///
/// The projects panel used to derive its folder list from the SCAN, which
/// returns transcript files — so a folder existed, as far as the app was
/// concerned, only while something was already filed in it. That made the New
/// Project button a no-op: it created the directory, the scan found no files
/// inside it, and the shelf never showed it. It also meant moving the last
/// transcript out of a project silently erased that project's title, poster
/// and colour on the next write.
///
/// A project IS a directory, so the directory listing is the truth. Hidden
/// entries are skipped: `.DS_Store` is a file, but a stray dot-directory is
/// not something anybody made here.
#[tauri::command]
pub fn list_transcript_folders(library_path: String) -> Result<Vec<String>, crate::AppError> {
    let root = PathBuf::from(&library_path);
    let Ok(entries) = std::fs::read_dir(&root) else {
        // A library that does not exist yet is not an error — it is a fresh
        // install, and the answer is honestly "no folders".
        return Ok(Vec::new());
    };
    let mut out: Vec<String> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter(|n| !n.starts_with('.'))
        .collect();
    out.sort();
    Ok(out)
}

/// Rename a project folder. Returns its new path.
///
/// The DIRECTORY is a project's identity, so renaming one is a real move on
/// disk rather than a label change in a JSON file — which is what keeps the
/// transcripts findable in Finder under the name the user chose.
#[tauri::command]
pub fn rename_transcript_folder(
    library_path: String,
    folder: String,
    new_name: String,
) -> Result<String, crate::AppError> {
    let stem = valid_stem(&new_name)?;
    let root = PathBuf::from(&library_path);
    let src = root.join(&folder);
    if !src.is_dir() {
        return Err(crate::AppError::not_found(folder.as_str()));
    }
    // A month bucket is the app's own filing, not something anyone named, and
    // renaming one would strand every transcript the grouping expects to find
    // there.
    if is_month_folder(&folder) {
        return Err(crate::AppError::invalid(
            "That folder is one the app files into by date, so it can't be renamed.",
        ));
    }
    let dest = root.join(&stem);
    if dest == src {
        return Ok(src.to_string_lossy().into_owned());
    }
    // A case-only rename ("rushes" -> "Rushes") is a real rename people make,
    // and on the default macOS filesystem it is not a collision - APFS is
    // case-INSENSITIVE, so `dest.exists()` is true for the very directory
    // being renamed and a bare existence check refuses the operation as a
    // clash with itself. Canonicalising both sides answers the question that
    // was actually being asked: is something ELSE already there?
    // `rename_transcript` next door already does this; the folder path did not.
    let same_dir = dest.exists()
        && std::fs::canonicalize(&dest).ok() == std::fs::canonicalize(&src).ok();
    if dest.exists() && !same_dir {
        return Err(crate::AppError::invalid(format!("A folder named \"{stem}\" already exists.")));
    }
    std::fs::rename(&src, &dest)
        .map_err(|e| crate::AppError::internal(format!("Couldn't rename the folder: {e}")))?;
    dest.to_str().map(str::to_string).ok_or_else(|| crate::AppError::internal("Folder path isn't valid UTF-8."))
}

/// Delete a project folder, but only once it is EMPTY of transcripts.
///
/// Deliberately not recursive. A project holds hours of someone's work, and a
/// one-click recursive delete of a folder full of transcripts is the kind of
/// thing that gets reported as data loss rather than a mis-click. The caller
/// moves the transcripts out first, which makes the destructive step explicit
/// and reversible up to that point.
#[tauri::command]
pub fn delete_transcript_folder(library_path: String, folder: String) -> Result<(), crate::AppError> {
    let root = PathBuf::from(&library_path);
    let dir = root.join(&folder);
    if !dir.is_dir() {
        return Err(crate::AppError::not_found(folder.as_str()));
    }
    if is_month_folder(&folder) {
        return Err(crate::AppError::invalid(
            "That folder is one the app files into by date, so it can't be deleted here.",
        ));
    }
    let left = transcripts_in(&dir);
    if left > 0 {
        return Err(crate::AppError::invalid(format!(
            "That project still holds {left} transcript{}. Move them out first.",
            if left == 1 { "" } else { "s" }
        )));
    }
    // Only the folder itself, and only when nothing but incidental files (a
    // .DS_Store) remain — remove_dir refuses a non-empty directory, which is
    // the backstop if the count above ever disagrees with reality.
    for entry in std::fs::read_dir(&dir).into_iter().flatten().flatten() {
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    std::fs::remove_dir(&dir)
        .map_err(|e| crate::AppError::internal(format!("Couldn't delete the folder: {e}")))?;
    Ok(())
}

/// `YYYY-MM` — a bucket the app created, never a project someone named.
pub(crate) fn is_month_folder(folder: &str) -> bool {
    let b = folder.as_bytes();
    b.len() == 7
        && b[4] == b'-'
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[5..].iter().all(u8::is_ascii_digit)
}

/// How many transcripts a folder holds, ignoring sidecars and dotfiles.
pub(crate) fn transcripts_in(dir: &Path) -> usize {
    std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| {
            let n = e.file_name();
            let n = n.to_string_lossy();
            !n.starts_with('.')
                && (n.ends_with(".srt") || n.ends_with(".vtt"))
        })
        .count()
}

/// Move a library file into `dest_dir`. Returns the new path.
///
/// The Library had no move verb AT ALL - not a drag, not a menu item, not a
/// command. `rename_path` refuses a directory change on purpose ("A rename may
/// not move a file to another folder"), so filing a clip into a folder you can
/// see in the app meant leaving for Finder. This is the backend half of
/// drag-to-folder.
///
/// A plain rename, so it is atomic within a volume and instant. It deliberately
/// does NOT fall back to copy+delete across volumes: that turns a gesture the
/// user thinks is instant into a multi-gigabyte copy with no progress and no
/// cancel, on media files. Across volumes this fails and says so.
#[tauri::command]
pub fn move_library_file(src_path: String, dest_dir: String) -> Result<String, crate::AppError> {
    let src = PathBuf::from(&src_path);
    if !src.is_file() {
        return Err(crate::AppError::not_found(src_path.as_str()));
    }
    let dir = PathBuf::from(&dest_dir);
    if !dir.is_dir() {
        return Err(crate::AppError::not_found(dest_dir.as_str()));
    }
    let name = src
        .file_name()
        .ok_or_else(|| crate::AppError::invalid("That path has no filename."))?;
    let dest = dir.join(name);
    // Already there: a no-op, not an error. Dropping a file on the folder it
    // is already in is a thing people do, and it should do nothing quietly.
    if dest == src {
        return Ok(src_path);
    }
    if dest.exists() {
        let n = name.to_string_lossy();
        return Err(crate::AppError::invalid(format!(
            "\"{n}\" already exists in that folder."
        )));
    }
    std::fs::rename(&src, &dest).map_err(|e| {
        crate::AppError::internal(format!(
            "Couldn't move the file: {e}. Moving between volumes isn't supported - copy it in Finder instead."
        ))
    })?;
    dest.to_str()
        .map(str::to_string)
        .ok_or_else(|| crate::AppError::internal("Moved path isn't valid UTF-8."))
}

/// Move a transcript (+ its sidecars) into `dest_dir`. Returns the new path.
#[tauri::command]
pub fn move_transcript_to_folder(srt_path: String, dest_dir: String) -> Result<String, crate::AppError> {
    let src = PathBuf::from(&srt_path);
    if !src.is_file() {
        return Err(crate::AppError::not_found(srt_path.as_str()));
    }
    let dir = PathBuf::from(&dest_dir);
    if !dir.is_dir() {
        return Err(crate::AppError::not_found(dest_dir.as_str()));
    }
    let name = src.file_name().ok_or_else(|| crate::AppError::invalid("Bad transcript path."))?;
    let dest = dir.join(name);
    if dest == src {
        return Ok(srt_path);
    }
    ensure_dest_clear(&dest)?;
    std::fs::rename(&src, &dest)
        .map_err(|e| crate::AppError::internal(format!("Couldn't move the transcript: {e}")))?;
    move_sidecars(&src, &dest);
    dest.to_str().map(str::to_string).ok_or_else(|| crate::AppError::internal("Moved path isn't valid UTF-8."))
}

#[cfg(test)]
mod tests {

    /// `valid_stem` is the path-traversal guard for library renames, and it
    /// had no test. Its output is used DIRECTLY as a path segment —
    /// `PathBuf::from(&library_path).join(&stem)` and `dir.join(stem.ext)` —
    /// so anything it admits lands on disk where it says. `Path::join` with an
    /// absolute segment REPLACES the base entirely, which is what makes the
    /// slash rejection load-bearing rather than cosmetic.
    #[test]
    fn valid_stem_accepts_an_ordinary_name() {
        // The canary: every rejection below would pass on a function that
        // rejected everything.
        assert_eq!(valid_stem("Interview with Ada").unwrap(), "Interview with Ada");
        assert_eq!(valid_stem("  Reel A  ").unwrap(), "Reel A");
    }

    #[test]
    fn valid_stem_refuses_to_leave_its_directory() {
        for bad in ["..", ".", "../etc", "a/b", "a\\b", "/absolute", "sub/dir"] {
            assert!(valid_stem(bad).is_err(), "should have rejected {bad:?}");
        }
        // A NUL cannot reach a filesystem call as part of a name.
        assert!(valid_stem("a\0b").is_err());
    }

    #[test]
    fn valid_stem_refuses_hidden_names() {
        // A leading dot would make the transcript or folder invisible in
        // Finder — the user would rename something and watch it disappear.
        for hidden in [".hidden", ".DS_Store", "..twodots"] {
            assert!(valid_stem(hidden).is_err(), "should have rejected {hidden:?}");
        }
    }

    #[test]
    fn valid_stem_refuses_names_that_are_empty_once_trimmed() {
        for empty in ["", "   ", "\t\n"] {
            assert!(valid_stem(empty).is_err(), "should have rejected {empty:?}");
        }
        // Trailing dots and spaces are stripped, so a name made only of them
        // collapses to empty and must be refused rather than yielding "".
        assert!(valid_stem("...").is_err());   // also caught by the leading-dot rule
        assert!(valid_stem(" . ").is_err());
    }

    #[test]
    fn valid_stem_strips_trailing_dots_and_spaces() {
        // A trailing dot or space is legal on APFS but confuses every tool
        // that round-trips through a Windows share, and a trailing dot before
        // the extension produces "name..srt".
        assert_eq!(valid_stem("Reel A.").unwrap(), "Reel A");
        assert_eq!(valid_stem("Reel A ").unwrap(), "Reel A");
        assert_eq!(valid_stem("Reel A. . ").unwrap(), "Reel A");
        // but an interior dot is ordinary and must survive
        assert_eq!(valid_stem("v1.2 final").unwrap(), "v1.2 final");
    }

    use super::*;

    /// Unique temp dir, removed on drop (unwind included) so failed tests
    /// don't strand trees in $TMPDIR.
    struct TempTree(PathBuf);
    impl TempTree {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir()
                .join(format!("sb-library-test-{tag}-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Restores 0o755 on a path when dropped, so a test that chmod'd a dir
    /// to 0o000 doesn't strand it (TempTree's `remove_dir_all` needs to
    /// recurse in). Declare it AFTER the TempTree so it drops FIRST.
    #[cfg(unix)]
    struct PermGuard(PathBuf);
    #[cfg(unix)]
    impl Drop for PermGuard {
        fn drop(&mut self) {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o755));
        }
    }

    fn touch(path: &Path) {
        std::fs::write(path, b"x").unwrap();
    }

    #[test]
    fn rename_transcript_moves_srt_and_sidecars() {
        let t = TempTree::new("rename");
        let srt = t.path().join("Old Name.srt");
        std::fs::write(&srt, "1\n00:00:01,000 --> 00:00:02,000\n[SPEAKER_00] hi\n").unwrap();
        std::fs::write(t.path().join("Old Name.diarization.json"), "{}").unwrap();
        std::fs::write(t.path().join("Old Name.analysis.json"), "{}").unwrap();

        let out = rename_transcript(srt.to_str().unwrap().to_string(), "New Name".into()).unwrap();
        assert!(out.ends_with("New Name.srt"));
        assert!(t.path().join("New Name.srt").is_file());
        assert!(t.path().join("New Name.diarization.json").is_file(), "diarization sidecar follows");
        assert!(t.path().join("New Name.analysis.json").is_file(), "analysis sidecar follows");
        assert!(!srt.is_file(), "old transcript is gone");

        // Collision + bad-name are rejected without touching disk.
        std::fs::write(t.path().join("Taken.srt"), "x").unwrap();
        assert!(rename_transcript(t.path().join("New Name.srt").to_str().unwrap().to_string(), "Taken".into()).is_err());
        assert!(rename_transcript(t.path().join("New Name.srt").to_str().unwrap().to_string(), "a/b".into()).is_err());
    }

    #[test]
    fn move_transcript_into_created_folder() {
        let t = TempTree::new("movefolder");
        let srt = t.path().join("clip.srt");
        std::fs::write(&srt, "x").unwrap();
        std::fs::write(t.path().join("clip.analysis.json"), "{}").unwrap();

        let folder = create_transcript_folder(t.path().to_str().unwrap().to_string(), "Project A".into()).unwrap();
        assert!(PathBuf::from(&folder).is_dir());
        let out = move_transcript_to_folder(srt.to_str().unwrap().to_string(), folder.clone()).unwrap();
        assert!(out.ends_with("Project A/clip.srt"));
        assert!(PathBuf::from(&folder).join("clip.srt").is_file());
        assert!(PathBuf::from(&folder).join("clip.analysis.json").is_file(), "sidecar moves too");
        assert!(!srt.is_file());
        // A duplicate folder is rejected.
        assert!(create_transcript_folder(t.path().to_str().unwrap().to_string(), "Project A".into()).is_err());
    }

    #[test]
    fn move_refuses_to_clobber_a_sibling_sidecar() {
        // .srt and .vtt of the same stem share sidecar names — a move whose
        // transcript-file name is free must still not overwrite an existing
        // sidecar that belongs to a sibling in the destination.
        let t = TempTree::new("clobber");
        let proj = create_transcript_folder(t.path().to_str().unwrap().to_string(), "Project".into()).unwrap();
        // Destination already holds Interview.srt + its speaker sidecar.
        std::fs::write(PathBuf::from(&proj).join("Interview.srt"), "x").unwrap();
        std::fs::write(PathBuf::from(&proj).join("Interview.diarization.json"), r#"{"srt":true}"#).unwrap();
        // Source: a DIFFERENT Interview.vtt at the root, with its own sidecar.
        let vtt = t.path().join("Interview.vtt");
        std::fs::write(&vtt, "y").unwrap();
        std::fs::write(t.path().join("Interview.diarization.json"), r#"{"vtt":true}"#).unwrap();

        let res = move_transcript_to_folder(vtt.to_str().unwrap().to_string(), proj.clone());
        assert!(res.is_err(), "move must be rejected — it would clobber Interview.srt's sidecar");
        // The .srt's sidecar is intact; nothing was moved.
        let kept = std::fs::read_to_string(PathBuf::from(&proj).join("Interview.diarization.json")).unwrap();
        assert!(kept.contains("srt"), "the destination sidecar is untouched");
        assert!(vtt.is_file(), "the source transcript stays put");
    }

    #[test]
    fn speaker_label_probe_detects_machine_and_vtt_tags() {
        let t = TempTree::new("speakerprobe");
        let with_machine = t.path().join("a.srt");
        std::fs::write(&with_machine, "1\n00:00:01,000 --> 00:00:03,000\n[SPEAKER_00] hello there\n").unwrap();
        let with_vtt = t.path().join("b.vtt");
        std::fs::write(&with_vtt, "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Alice>hello there\n").unwrap();
        let plain = t.path().join("c.srt");
        std::fs::write(&plain, "1\n00:00:01,000 --> 00:00:03,000\nno speakers here, just text\n").unwrap();
        assert!(transcript_has_speaker_labels(&with_machine), "machine [SPEAKER_NN] labels → true");
        assert!(transcript_has_speaker_labels(&with_vtt), "VTT <v Name> voice tags → true");
        assert!(!transcript_has_speaker_labels(&plain), "un-labeled transcript → false");
        assert!(!transcript_has_speaker_labels(&t.path().join("missing.srt")), "missing file → false");
    }

    fn item_names(folder: &LibraryFolder) -> Vec<&str> {
        folder.items.iter().map(|i| i.name.as_str()).collect()
    }

    fn folder_names(folder: &LibraryFolder) -> Vec<&str> {
        folder.folders.iter().map(|f| f.name.as_str()).collect()
    }

    #[test]
    fn media_kind_classifies_by_extension() {
        let video = ["clip.mp4", "b.mov", "c.m4v", "d.mkv", "e.webm", "f.avi"];
        for f in video {
            assert_eq!(media_kind(Path::new(f)), Some(LibraryItemKind::Video), "{f}");
        }
        let audio = ["a.mp3", "b.m4a", "c.wav", "d.flac", "e.ogg", "f.aac"];
        for f in audio {
            assert_eq!(media_kind(Path::new(f)), Some(LibraryItemKind::Audio), "{f}");
        }
        // Uppercase extensions classify too (TS fileExtension lowercases).
        assert_eq!(media_kind(Path::new("SHOUT.MP4")), Some(LibraryItemKind::Video));
        assert_eq!(media_kind(Path::new("Song.Mp3")), Some(LibraryItemKind::Audio));
        // Non-media, transcripts, and extensionless names are not items.
        assert_eq!(media_kind(Path::new("notes.txt")), None);
        assert_eq!(media_kind(Path::new("captions.srt")), None);
        assert_eq!(media_kind(Path::new("no_extension")), None);
    }

    #[test]
    fn scan_skips_hidden_entries() {
        let tree = TempTree::new("hidden");
        touch(&tree.path().join("visible.mp4"));
        touch(&tree.path().join(".hidden.mp4"));
        let dot_dir = tree.path().join(".git");
        std::fs::create_dir(&dot_dir).unwrap();
        touch(&dot_dir.join("inside.mp4"));

        let root = scan_library_root(tree.path().to_str().unwrap(), 3).unwrap();
        assert_eq!(item_names(&root), ["visible.mp4"]);
        assert!(root.folders.is_empty(), "dot-dir must be skipped entirely");
    }

    #[test]
    fn scan_limits_depth() {
        // root/root.mp4, root/l1/l1.mp4, root/l1/l2/l2.mp4, root/l1/l2/l3/l3.mp4
        let tree = TempTree::new("depth");
        let l1 = tree.path().join("l1");
        let l2 = l1.join("l2");
        let l3 = l2.join("l3");
        std::fs::create_dir_all(&l3).unwrap();
        touch(&tree.path().join("root.mp4"));
        touch(&l1.join("l1.mp4"));
        touch(&l2.join("l2.mp4"));
        touch(&l3.join("l3.mp4"));

        let root = scan_library_root(tree.path().to_str().unwrap(), 2).unwrap();
        assert_eq!(item_names(&root), ["root.mp4"]);
        let f1 = &root.folders[0];
        assert_eq!(f1.name, "l1");
        assert_eq!(item_names(f1), ["l1.mp4"]);
        let f2 = &f1.folders[0];
        assert_eq!(f2.name, "l2");
        assert_eq!(item_names(f2), ["l2.mp4"]);
        // l2 was scanned with depth_remaining == 0: its files are listed,
        // its subfolder l3 is omitted (not returned as an empty stub).
        assert!(f2.folders.is_empty(), "l3 must be beyond max_depth=2");

        // max_depth 0: root files only, no folders at all.
        let flat = scan_library_root(tree.path().to_str().unwrap(), 0).unwrap();
        assert_eq!(item_names(&flat), ["root.mp4"]);
        assert!(flat.folders.is_empty());
    }

    #[test]
    fn scan_flags_the_folder_it_stopped_at() {
        // The depth limit omits what is below, so a folder whose contents were
        // never read renders exactly like an empty one. The flag is the only
        // thing that tells them apart.
        let t = TempTree::new("deeper");
        std::fs::create_dir_all(t.path().join("l1/l2/l3")).unwrap();
        std::fs::write(t.path().join("l1/l2/l3/clip.mp4"), b"x").unwrap();
        let root = scan_library_root(t.path().to_str().unwrap(), 2).unwrap();
        let l1 = &root.folders[0];
        let l2 = &l1.folders[0];
        assert!(!root.deeper, "the root itself was scanned");
        assert!(!l1.deeper, "l1 still had depth to spend");
        assert!(l2.deeper, "l2 hit the limit and dropped l3 without saying so");
        assert!(l2.folders.is_empty());
    }

    #[test]
    fn scan_skips_symlinks_and_app_bundles() {
        let tree = TempTree::new("links");
        touch(&tree.path().join("real.mp4"));
        // A bundle directory with media inside — must be skipped whole.
        let bundle = tree.path().join("Cool.app");
        std::fs::create_dir(&bundle).unwrap();
        touch(&bundle.join("embedded.mp4"));
        // File + directory symlinks — both skipped, never followed.
        let real_dir = tree.path().join("real-dir");
        std::fs::create_dir(&real_dir).unwrap();
        touch(&real_dir.join("in-dir.mp4"));
        std::os::unix::fs::symlink(tree.path().join("real.mp4"), tree.path().join("link.mp4"))
            .unwrap();
        std::os::unix::fs::symlink(&real_dir, tree.path().join("link-dir")).unwrap();

        let root = scan_library_root(tree.path().to_str().unwrap(), 3).unwrap();
        assert_eq!(item_names(&root), ["real.mp4"]);
        assert_eq!(folder_names(&root), ["real-dir"], "only the real dir, not .app or link");
    }

    #[test]
    fn scan_sorts_names_case_insensitively() {
        let tree = TempTree::new("sort");
        touch(&tree.path().join("banana.mp4"));
        touch(&tree.path().join("Apple.mp4"));
        touch(&tree.path().join("cherry.mp3"));
        std::fs::create_dir(tree.path().join("Zeta")).unwrap();
        std::fs::create_dir(tree.path().join("alpha")).unwrap();

        let root = scan_library_root(tree.path().to_str().unwrap(), 1).unwrap();
        assert_eq!(item_names(&root), ["Apple.mp4", "banana.mp4", "cherry.mp3"]);
        assert_eq!(folder_names(&root), ["alpha", "Zeta"]);
        // Kind rides along with the classification.
        assert_eq!(root.items[0].kind, LibraryItemKind::Video);
        assert_eq!(root.items[2].kind, LibraryItemKind::Audio);
    }

    #[test]
    fn scan_records_size_and_mtime() {
        let tree = TempTree::new("meta");
        std::fs::write(tree.path().join("sized.mp4"), vec![0u8; 1234]).unwrap();

        let root = scan_library_root(tree.path().to_str().unwrap(), 0).unwrap();
        assert_eq!(root.items[0].size_bytes, 1234);
        // A freshly-written file's mtime is "now" — sanity-check the unit
        // (milliseconds, not seconds): anything after 2020-01-01 passes.
        assert!(root.items[0].modified_ms > 1_577_836_800_000);
    }

    #[test]
    fn scan_validates_root_path() {
        let tree = TempTree::new("validate");
        let missing = tree.path().join("does-not-exist");
        let err = scan_library_root(missing.to_str().unwrap(), 3).unwrap_err();
        assert!(matches!(err, crate::AppError::NotFound(_)), "got {err:?}");

        let file = tree.path().join("a-file.mp4");
        touch(&file);
        let err = scan_library_root(file.to_str().unwrap(), 3).unwrap_err();
        assert!(matches!(err, crate::AppError::Invalid(_)), "got {err:?}");
    }

    // Fix 3: an unreadable SUBfolder is omitted from its parent, not
    // surfaced as an empty stub. A legitimately-empty but readable folder
    // is kept. (unix-only: needs POSIX perm bits to make read_dir fail.)
    #[cfg(unix)]
    #[test]
    fn scan_omits_unreadable_subfolder_keeps_empty_readable() {
        use std::os::unix::fs::PermissionsExt;

        let tree = TempTree::new("unreadable");
        touch(&tree.path().join("top.mp4"));
        let readable = tree.path().join("readable");
        std::fs::create_dir(&readable).unwrap();
        touch(&readable.join("inside.mp4"));
        // Empty but readable — must survive (empty ≠ unreadable).
        std::fs::create_dir(tree.path().join("empty-ok")).unwrap();
        let locked = tree.path().join("locked");
        std::fs::create_dir(&locked).unwrap();
        touch(&locked.join("cannot-see.mp4"));

        // Guard declared before the chmod so perms are restored on unwind;
        // it drops before `tree`, letting remove_dir_all recurse in.
        let _guard = PermGuard(locked.clone());
        std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000)).unwrap();
        // Root bypasses perm bits — if we can still read the dir, the
        // scenario under test can't occur, so skip the assertion.
        if std::fs::read_dir(&locked).is_ok() {
            return;
        }

        let root = scan_library_root(tree.path().to_str().unwrap(), 3).unwrap();
        assert_eq!(item_names(&root), ["top.mp4"]);
        // "locked" is omitted; "empty-ok" and "readable" are kept (sorted).
        assert_eq!(folder_names(&root), ["empty-ok", "readable"]);
    }

    // Fix 4: a root we can't STAT (parent dir has no execute bit) surfaces
    // as Invalid, NOT the misleading NotFound that Path::exists() gave for
    // every failure. A genuinely-missing root stays NotFound.
    #[test]
    fn transcript_scan_finds_srts_across_month_folders_and_flags_diarization() {
        let tree = TempTree::new("tx");
        // Root-level transcript + two month folders, mixed srt/vtt, plus a
        // sidecar for one and noise (media + the sidecar itself) that must not
        // appear as entries.
        touch(&tree.path().join("Loose.srt"));
        let m1 = tree.path().join("2026-06");
        let m2 = tree.path().join("2026-07");
        std::fs::create_dir_all(&m1).unwrap();
        std::fs::create_dir_all(&m2).unwrap();
        touch(&m1.join("June Clip.srt"));
        touch(&m2.join("July Clip.vtt")); // no sidecar → not diarized
        let diarized = m2.join("Diarized.srt");
        touch(&diarized);
        touch(&m2.join("Diarized.diarization.json")); // matches Diarized.srt stem
        touch(&m2.join("Diarized.analysis.json"));    // AI analysis for the same stem
        touch(&m2.join("clip.mp4")); // media — must be ignored

        let mut list = scan_transcript_root(tree.path().to_str().unwrap());
        list.sort_by(|a, b| a.name.cmp(&b.name));
        let names: Vec<&str> = list.iter().map(|t| t.name.as_str()).collect();
        assert_eq!(names, ["Diarized", "July Clip", "June Clip", "Loose"]);
        // Folder labels come from the parent dir; root-level is "".
        let by_name = |n: &str| list.iter().find(|t| t.name == n).unwrap();
        assert_eq!(by_name("Loose").folder, "");
        assert_eq!(by_name("June Clip").folder, "2026-06");
        assert_eq!(by_name("July Clip").folder, "2026-07");
        // Only the .srt with a same-stem sidecar reads as diarized / analyzed.
        assert!(by_name("Diarized").has_diarization);
        assert!(by_name("Diarized").has_analysis);
        assert!(!by_name("July Clip").has_diarization);
        assert!(!by_name("July Clip").has_analysis);
        assert_eq!(by_name("June Clip").format, "srt");
        assert_eq!(by_name("July Clip").format, "vtt");
    }

    #[test]
    fn transcript_scan_missing_dir_is_empty_not_error() {
        let tree = TempTree::new("tx-missing");
        let gone = tree.path().join("never-transcribed");
        assert!(scan_transcript_root(gone.to_str().unwrap()).is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn scan_distinguishes_missing_from_permission_denied() {
        use std::os::unix::fs::PermissionsExt;

        let tree = TempTree::new("perm");

        let missing = tree.path().join("gone");
        let err = scan_library_root(missing.to_str().unwrap(), 3).unwrap_err();
        assert!(matches!(err, crate::AppError::NotFound(_)), "got {err:?}");

        let parent = tree.path().join("nosearch");
        std::fs::create_dir(&parent).unwrap();
        let child = parent.join("root-inside");
        std::fs::create_dir(&child).unwrap();
        let _guard = PermGuard(parent.clone());
        std::fs::set_permissions(&parent, std::fs::Permissions::from_mode(0o000)).unwrap();
        // Root bypasses perm bits — skip if we can still stat the child.
        if child.try_exists().unwrap_or(false) {
            return;
        }

        let err = scan_library_root(child.to_str().unwrap(), 3).unwrap_err();
        assert!(matches!(err, crate::AppError::Invalid(_)), "got {err:?}");
    }

    // ---- project folders -------------------------------------------------

    #[test]
    fn lists_folders_that_hold_no_transcripts() {
        // The bug this command exists for: the panel derived its folder list
        // from the transcript SCAN, so a project only existed once something
        // was filed in it - and New Project, which creates an empty one, did
        // nothing visible.
        let t = TempTree::new("list-empty");
        std::fs::create_dir(t.path().join("Empty Project")).unwrap();
        std::fs::create_dir(t.path().join("Has Work")).unwrap();
        std::fs::write(t.path().join("Has Work/a.srt"), "x").unwrap();
        let got = list_transcript_folders(t.path().to_string_lossy().into()).unwrap();
        assert_eq!(got, vec!["Empty Project", "Has Work"]);
    }

    #[test]
    fn lists_no_files_and_no_dotfolders() {
        let t = TempTree::new("list-filter");
        std::fs::create_dir(t.path().join("Show")).unwrap();
        std::fs::create_dir(t.path().join(".hidden")).unwrap();
        std::fs::write(t.path().join("loose.srt"), "x").unwrap();
        std::fs::write(t.path().join(".DS_Store"), "x").unwrap();
        assert_eq!(
            list_transcript_folders(t.path().to_string_lossy().into()).unwrap(),
            vec!["Show"],
        );
    }

    #[test]
    fn a_library_that_does_not_exist_yet_is_not_an_error() {
        // First run: the folder is created lazily. Returning Err here would
        // surface a scary message on an empty install, and the honest answer
        // is that there are no folders.
        let t = TempTree::new("list-missing");
        let missing = t.path().join("not-created-yet");
        assert_eq!(
            list_transcript_folders(missing.to_string_lossy().into()).unwrap(),
            Vec::<String>::new(),
        );
    }

    #[test]
    fn month_buckets_are_recognised() {
        for m in ["2026-08", "1999-12"] {
            assert!(is_month_folder(m), "{m}");
        }
        for f in ["", "Marry Harry", "2026-8", "2026-08 pickups", "202608"] {
            assert!(!is_month_folder(f), "{f}");
        }
    }

    #[test]
    fn renames_a_project_directory_on_disk() {
        // The directory IS the identity, so a rename has to move it. That is
        // what keeps the transcripts findable under the new name in Finder as
        // well as in the app.
        let t = TempTree::new("rename-project");
        std::fs::create_dir(t.path().join("Old")).unwrap();
        std::fs::write(t.path().join("Old/a.srt"), "x").unwrap();
        let out = rename_transcript_folder(
            t.path().to_string_lossy().into(),
            "Old".into(),
            "New".into(),
        )
        .unwrap();
        assert!(out.ends_with("/New"), "{out}");
        assert!(
            t.path().join("New/a.srt").is_file(),
            "the transcript did not come with it"
        );
        assert!(!t.path().join("Old").exists());
    }

    #[test]
    fn refuses_to_rename_a_month_bucket() {
        // Those are the app's own filing. Renaming one strands every
        // transcript the date grouping expects to find inside it.
        let t = TempTree::new("rename-month");
        std::fs::create_dir(t.path().join("2026-08")).unwrap();
        assert!(rename_transcript_folder(
            t.path().to_string_lossy().into(),
            "2026-08".into(),
            "August".into(),
        )
        .is_err());
        assert!(t.path().join("2026-08").is_dir());
    }

    #[test]
    fn allows_a_case_only_rename() {
        // macOS ships case-INSENSITIVE APFS, so dest.exists() is true for the
        // directory being renamed. A bare existence check refused "rushes" ->
        // "Rushes" as a collision with itself, which is a rename people
        // actually make after naming a project in a hurry.
        let t = TempTree::new("rename-case");
        std::fs::create_dir(t.path().join("rushes")).unwrap();
        std::fs::write(t.path().join("rushes/a.srt"), "x").unwrap();
        let out = rename_transcript_folder(
            t.path().to_string_lossy().into(),
            "rushes".into(),
            "Rushes".into(),
        )
        .expect("a case-only rename was refused");
        assert!(out.ends_with("/Rushes"), "{out}");
        // The transcript is still there under whichever spelling the
        // filesystem reports.
        assert!(t.path().join("Rushes/a.srt").is_file());
    }

    #[test]
    fn refuses_a_rename_onto_an_existing_folder() {
        let t = TempTree::new("rename-collide");
        std::fs::create_dir(t.path().join("A")).unwrap();
        std::fs::create_dir(t.path().join("B")).unwrap();
        std::fs::write(t.path().join("B/keep.srt"), "x").unwrap();
        assert!(rename_transcript_folder(
            t.path().to_string_lossy().into(),
            "A".into(),
            "B".into(),
        )
        .is_err());
        assert!(
            t.path().join("B/keep.srt").is_file(),
            "the collision ate the target folder"
        );
    }

    #[test]
    fn refuses_to_delete_a_project_that_still_holds_work() {
        // The whole reason delete is not recursive: a project holds hours of
        // someone's transcription, and a one-click recursive delete gets
        // reported as data loss, not as a mis-click.
        //
        // remove_dir would refuse a non-empty directory on its own, so the
        // count is not what saves the files - it is what makes the refusal
        // legible. Assert the SENTENCE, or this test passes against a build
        // that says "Directory not empty (os error 66)" and leaves the person
        // with no idea which folder holds what.
        let t = TempTree::new("delete-full");
        std::fs::create_dir(t.path().join("Show")).unwrap();
        std::fs::write(t.path().join("Show/ep1.srt"), "x").unwrap();
        std::fs::write(t.path().join("Show/ep2.srt"), "x").unwrap();
        let err = delete_transcript_folder(t.path().to_string_lossy().into(), "Show".into())
            .expect_err("it agreed to delete a project holding two transcripts");
        let msg = format!("{err:?}");
        assert!(msg.contains("still holds 2 transcripts"), "unhelpful refusal: {msg}");
        assert!(t.path().join("Show/ep1.srt").is_file(), "it deleted a transcript");
    }

    #[test]
    fn the_refusal_counts_one_transcript_in_the_singular() {
        // "1 transcripts" in a dialog is the tell that nobody read the string.
        let t = TempTree::new("delete-one");
        std::fs::create_dir(t.path().join("Show")).unwrap();
        std::fs::write(t.path().join("Show/ep1.srt"), "x").unwrap();
        let err = delete_transcript_folder(t.path().to_string_lossy().into(), "Show".into())
            .unwrap_err();
        assert!(format!("{err:?}").contains("holds 1 transcript."), "{err:?}");
    }

    #[test]
    fn deletes_an_empty_project() {
        let t = TempTree::new("delete-empty");
        std::fs::create_dir(t.path().join("Show")).unwrap();
        delete_transcript_folder(t.path().to_string_lossy().into(), "Show".into()).unwrap();
        assert!(!t.path().join("Show").exists());
    }

    #[test]
    fn a_dotfile_does_not_count_as_work() {
        // Finder drops .DS_Store into everything it looks at. Refusing to
        // delete an otherwise-empty project because of one would be
        // unexplainable to the person looking at an empty folder.
        let t = TempTree::new("delete-dotfile");
        std::fs::create_dir(t.path().join("Show")).unwrap();
        std::fs::write(t.path().join("Show/.DS_Store"), "x").unwrap();
        delete_transcript_folder(t.path().to_string_lossy().into(), "Show".into()).unwrap();
        assert!(!t.path().join("Show").exists());
    }

    #[test]
    fn refuses_to_delete_a_month_bucket() {
        let t = TempTree::new("delete-month");
        std::fs::create_dir(t.path().join("2026-08")).unwrap();
        assert!(
            delete_transcript_folder(t.path().to_string_lossy().into(), "2026-08".into()).is_err()
        );
        assert!(t.path().join("2026-08").is_dir());
    }

    #[test]
    fn counts_transcripts_and_ignores_sidecars() {
        // Sidecars are not work in their own right; counting them would make
        // a project that holds no transcripts undeletable.
        let t = TempTree::new("count");
        let d = t.path().join("Show");
        std::fs::create_dir(&d).unwrap();
        for f in ["a.srt", "b.vtt", "a.diarization.json", ".DS_Store", "notes.txt"] {
            std::fs::write(d.join(f), "x").unwrap();
        }
        assert_eq!(transcripts_in(&d), 2);
    }

}
