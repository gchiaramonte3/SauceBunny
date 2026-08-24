//! Frames — the grabbed-stills shelf.
//!
//! A snapshot used to open a save dialog, so the frames someone grabbed
//! during a review landed wherever they happened to click: the Desktop, a
//! Downloads folder, the export folder, three different places across one
//! session. The app then had no idea they existed, so nothing could show
//! them, group them, or reveal them.
//!
//! They live in ONE managed folder now, and the Library shows them the way
//! it shows cached web sources.
//!
//! WHY DOCUMENTS AND NOT THE CACHE. The user asked for a "screenshot
//! cache", and the managed-by-the-app half of that is exactly right - but
//! the durability class is not cache. `docs/DATA-MODEL.md` states the rule
//! this app runs on: nothing regenerable sits in user documents, and
//! nothing precious sits in a cache. A frame someone deliberately grabbed
//! at a timecode they chose is precious: re-creating it needs the source
//! still on disk AND the timecode remembered. Putting it under
//! `app_cache_dir()` would put it behind the 24h sweep and the Clear-all
//! button, which is the data-loss class this codebase has spent a week
//! removing. So: `~/Documents/Sauce Bunny/Frames/`, beside Transcripts,
//! Casts, Reviews and Screenings, backed up with them.
//!
//! GROUPING IS BY SOURCE, and it needs no sidecar. The filename carries
//! `<source stem>_<timecode>.<ext>`, which is what the shelf groups on -
//! the direct analogue of the web shelf grouping by site. A file the user
//! renames in Finder simply groups under its new stem; nothing breaks,
//! because there is no index to fall out of step with the directory. The
//! directory IS the truth, exactly as it is for transcript projects.

use serde::Serialize;
use tauri::{AppHandle, Manager};

/// One grabbed frame, as the Library's Frames shelf needs it.
#[derive(Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct FrameItem {
    /// Absolute path - a real file, so every path verb (reveal, Quick Look,
    /// drag) works on it without translation.
    pub path: String,
    /// Filename including extension.
    pub name: String,
    /// The source stem the shelf groups on, derived from the filename.
    pub source: String,
    /// Which folder this frame sits in, RELATIVE to the Frames root; empty
    /// for the root itself. A container here is a real directory, so this is
    /// read off the path rather than stored anywhere.
    pub folder: String,
    /// The timecode tail, when the name carries one ("00012304").
    pub timecode: Option<String>,
    /// Unix seconds, file mtime. `ts(type)` because ts-rs maps u64 to
    /// bigint, and JSON never produces one - the same annotation
    /// CachedWebItem carries for the same reason.
    #[ts(type = "number")]
    pub created_at: u64,
    #[ts(type = "number")]
    pub size_bytes: u64,
}

/// Image extensions the shelf lists. Deliberately short: these are the two
/// the grabber writes, and listing arbitrary images would turn a frames
/// shelf into a second, worse photo browser.
const FRAME_EXTS: [&str; 3] = ["jpg", "jpeg", "png"];

/// `~/Documents/Sauce Bunny/Frames`, resolved through Tauri's path API so a
/// localized Documents folder works. Does NOT create the directory.
pub fn frames_dir(app: &AppHandle) -> Result<std::path::PathBuf, crate::AppError> {
    let docs = app
        .path()
        .document_dir()
        .map_err(|e| crate::AppError::internal(format!("document_dir: {e}")))?;
    Ok(docs.join("Sauce Bunny").join("Frames"))
}

/// Split `<stem>_<timecode>` into its two halves.
///
/// The timecode tail is what `handleSnapshot` appends: the frame's timecode
/// with the colons stripped, so 6+ digits. Anything else is all stem - a
/// file called `my_holiday.jpg` must not be read as source "my" at timecode
/// "holiday", and a user who renames a frame in Finder should get the whole
/// new name as its group.
pub fn split_frame_name(stem: &str) -> (String, Option<String>) {
    if let Some((head, tail)) = stem.rsplit_once('_') {
        if !head.is_empty() && tail.len() >= 6 && tail.chars().all(|c| c.is_ascii_digit()) {
            return (head.to_string(), Some(tail.to_string()));
        }
    }
    (stem.to_string(), None)
}

/// The managed folder's path, for the grabber and for Reveal in Finder.
#[tauri::command]
pub async fn frames_dir_path(app: AppHandle) -> Result<String, crate::AppError> {
    Ok(frames_dir(&app)?.to_string_lossy().into_owned())
}

/// Every frame in the managed folder, newest first.
///
/// A missing folder is an EMPTY shelf, not an error: not having grabbed a
/// frame yet is the normal first-run state, and an error banner there would
/// be the app complaining about something the user has not done.
#[tauri::command]
pub async fn list_frames(app: AppHandle) -> Result<Vec<FrameItem>, crate::AppError> {
    let dir = frames_dir(&app)?;
    // ONE directory glob, granted once and RECURSIVE, rather than a grant per
    // frame. `allow_asset_read`'s own header forbids per-item grants: Scope's
    // is_allowed is a linear scan over the pattern set on EVERY asset
    // request, so a few hundred grants would put that scan on the playback
    // byte-range path. A shelf whose every item lives under one folder the
    // app owns outright is the case a single directory pattern is for, and it
    // stays one pattern no matter how many frames or subfolders accumulate.
    //
    // The `true` MUST land with the recursive walk below: a denied asset read
    // is HTTP 403 with an EMPTY body, so a frame in a subfolder would render
    // as a broken thumbnail and never as an error.
    let scope = app.asset_protocol_scope();
    if !scope.is_allowed(dir.join("sub").join("probe.jpg")) {
        if let Err(e) = scope.allow_directory(&dir, true) {
            eprintln!("[asset-scope] could not grant the Frames folder: {e}");
        }
    }
    let mut out: Vec<FrameItem> = Vec::new();
    walk_frames(&dir, &dir, 0, &mut out);
    out.sort_by_key(|f| std::cmp::Reverse(f.created_at));
    Ok(out)
}

/// How deep a Frames tree is walked. Matches the library scan's cap so the
/// crumb bar stays readable; the app only ever writes frames flat, so this
/// is only reachable by someone organising in Finder.
const FRAMES_MAX_DEPTH: u32 = 3;

fn walk_frames(root: &std::path::Path, dir: &std::path::Path, depth: u32, out: &mut Vec<FrameItem>) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        // SKIP SYMLINKS, and note `file_type` rather than `metadata`:
        // metadata FOLLOWS a link, which was harmless while this listing was
        // flat but in a recursive walk lets a symlinked subfolder loop, or
        // wander outside the managed folder entirely. Same rule, same
        // reason, as the library scan.
        let Ok(ft) = entry.file_type() else { continue };
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            if depth < FRAMES_MAX_DEPTH {
                walk_frames(root, &path, depth + 1, out);
            }
            continue;
        }
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase());
        if !ext.map(|e| FRAME_EXTS.contains(&e.as_str())).unwrap_or(false) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let stem = path
            .file_stem()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let (source, timecode) = split_frame_name(&stem);
        let folder = path
            .parent()
            .and_then(|p| p.strip_prefix(root).ok())
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        let created_at = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        out.push(FrameItem {
            path: path.to_string_lossy().into_owned(),
            name,
            source,
            folder,
            timecode,
            created_at,
            size_bytes: meta.len(),
        });
    }
}

/// Delete one frame. Scoped to the managed folder: a caller cannot hand us
/// a path outside it, which is the same rule the screenings index follows
/// for the same reason.
#[tauri::command]
pub async fn delete_frame(app: AppHandle, path: String) -> Result<(), crate::AppError> {
    let dir = frames_dir(&app)?;
    let target = std::path::PathBuf::from(&path);
    let Ok(canon_dir) = dir.canonicalize() else {
        return Err(crate::AppError::not_found("the Frames folder does not exist"));
    };
    let Ok(canon_target) = target.canonicalize() else {
        return Err(crate::AppError::not_found("that frame is already gone"));
    };
    // starts_with, not parent-equals: frames live in subfolders now. Still on
    // the CANONICALISED paths - dropping that would turn a scoped one-file
    // delete into a delete-anywhere primitive via a symlinked subfolder.
    if !canon_target.starts_with(&canon_dir) {
        return Err(crate::AppError::Invalid(
            "that file is not in the Frames folder".into(),
        ));
    }
    std::fs::remove_file(&canon_target)
        .map_err(|e| crate::AppError::Io(format!("delete frame: {e}")))
}

/// Make a folder inside the Frames root (or inside one of its subfolders).
///
/// `parent` is a path RELATIVE to the Frames root, empty for the root, so a
/// caller can never name somewhere else: the root is joined here, and
/// `valid_stem` rejects a name carrying a separator - which matters because
/// `Path::join` with an absolute segment REPLACES the base rather than
/// appending to it.
#[tauri::command]
pub async fn create_frames_folder(
    app: AppHandle,
    parent: String,
    name: String,
) -> Result<String, crate::AppError> {
    let root = frames_dir(&app)?;
    let stem = valid_frame_stem(&name)?;
    let base = safe_join(&root, &parent)?;
    let dir = base.join(&stem);
    if dir.exists() {
        return Err(crate::AppError::invalid(format!(
            "A folder named \"{stem}\" already exists."
        )));
    }
    std::fs::create_dir_all(&dir)
        .map_err(|e| crate::AppError::internal(format!("Couldn't create the folder: {e}")))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Move one frame into a folder under the Frames root. `dest` is relative to
/// that root, empty meaning the root itself.
#[tauri::command]
pub async fn move_frame_to_folder(
    app: AppHandle,
    path: String,
    dest: String,
) -> Result<String, crate::AppError> {
    let root = frames_dir(&app)?;
    let canon_root = root
        .canonicalize()
        .map_err(|_| crate::AppError::not_found("the Frames folder does not exist"))?;
    let from = std::path::PathBuf::from(&path)
        .canonicalize()
        .map_err(|_| crate::AppError::not_found("that frame is already gone"))?;
    if !from.starts_with(&canon_root) {
        return Err(crate::AppError::invalid("that file is not in the Frames folder"));
    }
    let dir = safe_join(&root, &dest)?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| crate::AppError::internal(format!("Couldn't create the folder: {e}")))?;
    let name = from
        .file_name()
        .ok_or_else(|| crate::AppError::invalid("that path has no filename"))?;
    let to = dir.join(name);
    if to == from {
        return Ok(to.to_string_lossy().into_owned());
    }
    if to.exists() {
        return Err(crate::AppError::invalid(
            "A frame with that name is already in there.",
        ));
    }
    std::fs::rename(&from, &to)
        .map_err(|e| crate::AppError::Io(format!("move frame: {e}")))?;
    Ok(to.to_string_lossy().into_owned())
}

/// A relative subpath joined onto the Frames root, refusing anything that
/// could leave it. Each segment goes through the same name gate a new folder
/// does, so `..`, a leading dot and an absolute segment are all rejected
/// before `join` ever sees them.
fn safe_join(root: &std::path::Path, relative: &str) -> Result<std::path::PathBuf, crate::AppError> {
    let mut out = root.to_path_buf();
    for seg in relative.split('/') {
        if seg.is_empty() {
            continue;
        }
        out = out.join(valid_frame_stem(seg)?);
    }
    Ok(out)
}

/// The library's `valid_stem` rule, kept local so the two modules stay
/// independent (frames.rs deliberately shares no state with library.rs).
fn valid_frame_stem(s: &str) -> Result<String, crate::AppError> {
    let t = s.trim();
    if t.is_empty() {
        return Err(crate::AppError::invalid("Enter a name."));
    }
    if t.contains('/') || t.contains('\\') || t.contains('\0') || t == "." || t == ".." || t.starts_with('.') {
        return Err(crate::AppError::invalid(
            "Names can't contain slashes or start with a dot.",
        ));
    }
    let cleaned = t.trim_end_matches([' ', '.']).to_string();
    if cleaned.is_empty() {
        return Err(crate::AppError::invalid("Enter a name."));
    }
    Ok(cleaned)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_grabbed_frame_splits_into_source_and_timecode() {
        assert_eq!(
            split_frame_name("The Bear S3E1_00012304"),
            ("The Bear S3E1".to_string(), Some("00012304".to_string()))
        );
    }

    #[test]
    fn an_ordinary_underscore_name_is_all_stem() {
        // The failure this guards: reading "my_holiday" as source "my" at
        // timecode "holiday" would scatter a user's renamed frames across
        // invented groups.
        assert_eq!(split_frame_name("my_holiday"), ("my_holiday".to_string(), None));
        assert_eq!(split_frame_name("cut_v2"), ("cut_v2".to_string(), None));
        // Digits, but too few to be a timecode.
        assert_eq!(split_frame_name("take_12"), ("take_12".to_string(), None));
    }

    #[test]
    fn a_name_with_no_underscore_groups_under_itself() {
        assert_eq!(split_frame_name("frame"), ("frame".to_string(), None));
    }

    #[test]
    fn a_leading_underscore_does_not_produce_an_empty_group() {
        assert_eq!(split_frame_name("_00012304"), ("_00012304".to_string(), None));
    }

    #[test]
    fn a_source_whose_own_name_has_underscores_keeps_them() {
        assert_eq!(
            split_frame_name("my_long_title_00012304"),
            ("my_long_title".to_string(), Some("00012304".to_string()))
        );
    }
}

#[cfg(test)]
mod folder_tests {
    use super::*;
    use std::io::Write;

    fn tmp() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("sb-frames-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }
    fn touch(p: &std::path::Path) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::File::create(p).unwrap().write_all(b"jpg").unwrap();
    }

    #[test]
    fn the_walk_finds_frames_in_subfolders_and_records_where_they_live() {
        let root = tmp();
        touch(&root.join("Bear_00000100.jpg"));
        touch(&root.join("Selects").join("Bear_00000200.jpg"));
        touch(&root.join("Selects").join("Day 2").join("Bear_00000300.jpg"));
        let mut out = Vec::new();
        walk_frames(&root, &root, 0, &mut out);
        let mut got: Vec<(String, String)> =
            out.into_iter().map(|f| (f.name, f.folder)).collect();
        got.sort();
        assert_eq!(got, vec![
            ("Bear_00000100.jpg".into(), "".into()),
            ("Bear_00000200.jpg".into(), "Selects".into()),
            ("Bear_00000300.jpg".into(), "Selects/Day 2".into()),
        ]);
    }

    #[test]
    fn the_walk_stops_at_the_depth_cap() {
        let root = tmp();
        let mut deep = root.clone();
        for i in 0..6 { deep = deep.join(format!("l{i}")); }
        touch(&deep.join("Bear_00000100.jpg"));
        let mut out = Vec::new();
        walk_frames(&root, &root, 0, &mut out);
        assert!(out.is_empty(), "the walk went past the cap");
    }

    #[test]
    fn a_symlinked_subfolder_is_skipped() {
        // Without this a symlink can loop, or walk out of the managed folder
        // entirely - and `metadata()` would follow it silently.
        let root = tmp();
        let outside = tmp();
        touch(&outside.join("Elsewhere_00000100.jpg"));
        touch(&root.join("Bear_00000100.jpg"));
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        let mut out = Vec::new();
        walk_frames(&root, &root, 0, &mut out);
        assert_eq!(out.len(), 1, "followed a symlink out of the Frames folder");
        assert_eq!(out[0].name, "Bear_00000100.jpg");
    }

    #[test]
    fn safe_join_cannot_leave_the_root() {
        let root = std::path::PathBuf::from("/Frames");
        assert_eq!(safe_join(&root, "").unwrap(), root);
        assert_eq!(safe_join(&root, "Selects").unwrap(), root.join("Selects"));
        assert_eq!(
            safe_join(&root, "Selects/Day 2").unwrap(),
            root.join("Selects").join("Day 2"),
        );
        // Traversal and hidden-dir segments are REFUSED outright.
        for hostile in ["..", "../..", "Selects/../..", ".hidden"] {
            assert!(safe_join(&root, hostile).is_err(), "{hostile} was accepted");
        }
        // A leading slash is not an escape, it is a no-op segment: the split
        // yields an empty first part which is skipped, so "/etc" NORMALISES
        // to /Frames/etc rather than escaping to /etc. The invariant this
        // function owes is "cannot leave the root", not "rejects every odd
        // string", so assert the invariant.
        assert_eq!(safe_join(&root, "/etc").unwrap(), root.join("etc"));
        for any in ["", "Selects", "Selects/Day 2", "/etc", "a//b"] {
            assert!(safe_join(&root, any).unwrap().starts_with(&root), "{any} left the root");
        }
    }

    #[test]
    fn an_absolute_segment_cannot_replace_the_base() {
        // Path::join with an absolute segment REPLACES the base, which is
        // what makes the slash rejection load-bearing rather than cosmetic.
        let root = std::path::PathBuf::from("/Frames");
        assert!(valid_frame_stem("/etc").is_err());
        assert_eq!(root.join("/etc"), std::path::PathBuf::from("/etc"));
    }
}
