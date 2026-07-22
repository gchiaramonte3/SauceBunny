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
                continue; // depth limit reached — omit, don't stub
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
            let sidecar = path.with_extension("diarization.json");
            out.push(TranscriptFile {
                name: path.file_stem().and_then(|s| s.to_str()).unwrap_or(entry_name).to_string(),
                path: path_str.to_string(),
                folder: folder_label.to_string(),
                size_bytes: meta.len(),
                modified_ms,
                has_diarization: sidecar.is_file(),
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

#[cfg(test)]
mod tests {
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
        // Only the .srt with a same-stem sidecar reads as diarized.
        assert!(by_name("Diarized").has_diarization);
        assert!(!by_name("July Clip").has_diarization);
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
}
