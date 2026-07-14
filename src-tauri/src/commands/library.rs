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
/// loop or wander outside the chosen root), and `.app` bundles (packages
/// that read as directories but are opaque applications to the user).
///
/// Infallible by design below the root: an unreadable subfolder or a file
/// whose metadata can't be stat'd is skipped rather than failing the whole
/// scan — one bad entry must not blank the entire library. Root-level
/// readability is checked by `scan_library_root` before recursion starts.
fn scan_dir(dir: &Path, depth_remaining: u32) -> LibraryFolder {
    let name = dir
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        // A root like "/" has no file_name — fall back to the full path.
        .unwrap_or_else(|| dir.to_string_lossy().to_string());
    let mut folders: Vec<LibraryFolder> = Vec::new();
    let mut items: Vec<LibraryItem> = Vec::new();

    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let entry_name = entry.file_name().to_string_lossy().to_string();
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
                folders.push(scan_dir(&path, depth_remaining - 1));
            } else if file_type.is_file() {
                let kind = match media_kind(&path) {
                    Some(k) => k,
                    None => continue, // not a media file
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
                    name: entry_name,
                    path: path.to_string_lossy().to_string(),
                    size_bytes: meta.len(),
                    modified_ms,
                    kind,
                });
            }
            // Anything else (fifo, socket, device) is ignored.
        }
    }

    // Case-insensitive name sort; original-name tiebreak keeps the order
    // deterministic when two names differ only by case.
    folders.sort_by(|a, b| {
        a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.name.cmp(&b.name))
    });
    items.sort_by(|a, b| {
        a.name.to_lowercase().cmp(&b.name.to_lowercase()).then_with(|| a.name.cmp(&b.name))
    });

    LibraryFolder {
        name,
        path: dir.to_string_lossy().to_string(),
        folders,
        items,
    }
}

/// Sync core of `scan_library_folder`, split out so unit tests can call it
/// without async ceremony (same pattern as `read_file_range_bytes`).
fn scan_library_root(path: &str, max_depth: u32) -> Result<LibraryFolder, crate::AppError> {
    let root = PathBuf::from(path);
    if !root.exists() {
        // Typed NotFound so the frontend can prune stale roots by branching
        // on `kind === "NotFound"` (mirrors probe_local_file's contract).
        return Err(crate::AppError::not_found(path.to_string()));
    }
    if !root.is_dir() {
        return Err(crate::AppError::invalid(format!("Not a folder: {path}")));
    }
    // Surface a root-level read failure (permissions, macOS TCC denial on
    // e.g. ~/Movies) as a real error instead of a silently-empty library.
    // Unreadable SUBfolders during the walk are skipped, not fatal.
    std::fs::read_dir(&root)?;
    Ok(scan_dir(&root, max_depth))
}

/// Scan one user-added library root to `max_depth` folder levels (the
/// Library view passes 3) and return the folder tree of playable media.
///
/// Async so the walk runs on the async runtime's pool — Tauri executes
/// non-async commands on the main thread, and a deep walk of a cold or
/// networked volume must not stall the UI.
#[tauri::command]
pub async fn scan_library_folder(
    path: String,
    max_depth: u32,
) -> Result<LibraryFolder, crate::AppError> {
    scan_library_root(&path, max_depth)
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
}
