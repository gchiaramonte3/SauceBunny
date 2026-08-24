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
    // ONE directory glob, granted once, rather than a grant per frame.
    // `allow_asset_read`'s own header forbids per-item grants: Scope's
    // is_allowed is a linear scan over the pattern set on EVERY asset
    // request, so a few hundred grants would put that scan on the playback
    // byte-range path. A shelf whose every item lives in one folder the app
    // owns outright is the case a single directory pattern is for, and it
    // stays one pattern no matter how many frames accumulate.
    let scope = app.asset_protocol_scope();
    if !scope.is_allowed(dir.join("probe.jpg")) {
        if let Err(e) = scope.allow_directory(&dir, false) {
            eprintln!("[asset-scope] could not grant the Frames folder: {e}");
        }
    }
    let Ok(entries) = std::fs::read_dir(&dir) else { return Ok(Vec::new()) };

    let mut out: Vec<FrameItem> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase());
        if !ext.map(|e| FRAME_EXTS.contains(&e.as_str())).unwrap_or(false) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let stem = path
            .file_stem()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let (source, timecode) = split_frame_name(&stem);
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
            timecode,
            created_at,
            size_bytes: meta.len(),
        });
    }
    out.sort_by_key(|f| std::cmp::Reverse(f.created_at));
    Ok(out)
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
    if canon_target.parent() != Some(canon_dir.as_path()) {
        return Err(crate::AppError::Invalid(
            "that file is not in the Frames folder".into(),
        ));
    }
    std::fs::remove_file(&canon_target)
        .map_err(|e| crate::AppError::Io(format!("delete frame: {e}")))
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
