//! User corrections are durable documents, never mutations of model evidence.
//! Serialize read/compare/write across the main and detached webviews. A stale
//! editor cannot overwrite another window's row, and unrelated rows merge.
use crate::AppError;
use super::model::VideoAnalysisSource;
use serde::{Deserialize, Serialize};
use std::{collections::{BTreeMap, HashSet}, io::Read, path::{Path, PathBuf}, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager};
use sha2::{Digest, Sha256};

static EDIT_LOCK: Mutex<()> = Mutex::new(());
const CAP: u64 = 16 * 1024 * 1024;

#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AnalysisEditRow {
    pub id: u32,
    #[ts(type = "number")]
    pub start_us: u64,
    #[ts(type = "number")]
    pub end_us: u64,
    pub picture: String,
    pub dialogue: String,
    pub summary: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AnalysisRowCorrection {
    pub revision: u32,
    pub label: Option<String>,
    #[ts(type = "number | null")]
    pub start_us: Option<u64>,
    #[ts(type = "number | null")]
    pub end_us: Option<u64>,
    pub picture: Option<String>,
    pub dialogue: Option<String>,
    pub summary: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AnalysisEditDocument {
    pub schema_version: u32,
    pub revision: u32,
    pub source: VideoAnalysisSource,
    pub fps: f64,
    pub model: Option<String>,
    pub rows: Vec<AnalysisEditRow>,
    pub corrections: BTreeMap<String, AnalysisRowCorrection>,
}

fn anchor(row: &AnalysisEditRow) -> String { format!("{}:{}", row.start_us, row.end_us) }

fn location(root: &Path, hash: &str) -> Result<PathBuf, AppError> {
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) {
        return Err(AppError::invalid("Invalid analysis source fingerprint"));
    }
    Ok(root.join(format!("{hash}.json")))
}

fn validate(doc: &AnalysisEditDocument) -> Result<(), AppError> {
    if doc.schema_version != 1 { return Err(AppError::invalid("These analysis corrections need a newer Sauce Bunny. The file was not changed.")); }
    location(Path::new(""), &doc.source.sha256)?;
    if !doc.fps.is_finite() || doc.fps < 1.0 || doc.fps > 240.0 || doc.source.duration_us == 0
        || doc.rows.is_empty() || doc.rows.len() > 10000 || doc.corrections.len() > 20000 {
        return Err(AppError::invalid("Invalid analysis correction document"));
    }
    let mut keys = HashSet::new();
    for row in &doc.rows {
        if row.id == 0 || row.start_us >= row.end_us || row.end_us > doc.source.duration_us || !keys.insert(anchor(row)) {
            return Err(AppError::invalid("Invalid original shot boundaries"));
        }
        for text in [&row.picture, &row.dialogue, &row.summary] {
            if text.len() > 128 * 1024 { return Err(AppError::invalid("Analysis text is too long")); }
        }
    }
    for edit in doc.corrections.values() {
        if edit.label.as_ref().is_some_and(|s| s.trim().is_empty() || s.chars().count() > 48) {
            return Err(AppError::invalid("Shot labels need 1 to 48 characters"));
        }
        for text in [&edit.picture, &edit.dialogue, &edit.summary].into_iter().flatten() {
            if text.len() > 128 * 1024 { return Err(AppError::invalid("Analysis text is too long")); }
        }
        for time in [edit.start_us, edit.end_us].into_iter().flatten() {
            let frames = time as f64 * doc.fps / 1e6;
            if time > doc.source.duration_us || (frames - frames.round()).abs() * 1e6 / doc.fps > 1.1 {
                return Err(AppError::invalid("Timecode must be on a source frame within the clip"));
            }
        }
    }
    for row in &doc.rows {
        if let Some(edit) = doc.corrections.get(&anchor(row)) {
            let start_frame = ((edit.start_us.unwrap_or(row.start_us) as f64 + 0.51) * doc.fps / 1e6).floor();
            let end_frame = ((edit.end_us.unwrap_or(row.end_us) as f64 + 0.51) * doc.fps / 1e6).floor();
            if end_frame <= start_frame {
                return Err(AppError::invalid("End timecode must be at least one frame after start"));
            }
        }
    }
    Ok(())
}

fn read(root: &Path, hash: &str) -> Result<Option<AnalysisEditDocument>, AppError> {
    let path = location(root, hash)?;
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let mut data = Vec::new();
    file.take(CAP + 1).read_to_end(&mut data)?;
    if data.len() as u64 > CAP { return Err(AppError::invalid("Analysis corrections exceed the safe size limit")); }
    let doc: AnalysisEditDocument = serde_json::from_slice(&data)?;
    validate(&doc)?;
    if doc.source.sha256 != hash { return Err(AppError::invalid("Analysis correction source does not match")); }
    Ok(Some(doc))
}

fn save(root: &Path, mut snapshot: AnalysisEditDocument, key: &str, expected_revision: u32, mut edit: AnalysisRowCorrection) -> Result<AnalysisEditDocument, AppError> {
    let _lock = EDIT_LOCK.lock().map_err(|_| AppError::internal("Analysis save lock unavailable"))?;
    // The client supplies a baseline, not a replacement for the correction map.
    snapshot.corrections.clear();
    validate(&snapshot)?;
    if !snapshot.rows.iter().any(|row| anchor(row) == key) { return Err(AppError::invalid("The edited shot is no longer in this analysis")); }
    if let Some(stored) = read(root, &snapshot.source.sha256)? {
        if stored.source.origin_us != snapshot.source.origin_us || stored.source.duration_us != snapshot.source.duration_us || (stored.fps - snapshot.fps).abs() > 0.000001 {
            return Err(AppError::invalid("Source timing changed. Reopen the clip before editing."));
        }
        snapshot.revision = stored.revision;
        snapshot.corrections = stored.corrections;
    } else { snapshot.revision = 0; }
    let actual_revision = snapshot.corrections.get(key).map_or(0, |row| row.revision);
    if actual_revision != expected_revision {
        return Err(AppError::invalid("This row was edited in another window. Cancel and reopen the cell to use the latest version. Your draft is unchanged."));
    }
    edit.revision = actual_revision.checked_add(1).ok_or_else(|| AppError::invalid("Correction revision limit reached"))?;
    snapshot.corrections.insert(key.into(), edit);
    snapshot.revision = snapshot.revision.checked_add(1).ok_or_else(|| AppError::invalid("Document revision limit reached"))?;
    validate(&snapshot)?;
    let bytes = serde_json::to_vec_pretty(&snapshot)?;
    if bytes.len() as u64 > CAP { return Err(AppError::invalid("Analysis corrections exceed the safe size limit")); }
    std::fs::create_dir_all(root)?;
    super::super::system::write_bytes_impl(&location(root, &snapshot.source.sha256)?.to_string_lossy(), &bytes, false, false, true)?;
    Ok(snapshot)
}

fn root(app: &AppHandle) -> Result<PathBuf, AppError> {
    Ok(app.path().document_dir().map_err(|e| AppError::internal(e.to_string()))?.join("Sauce Bunny/Analysis Corrections"))
}

fn load_source(root: &Path, path: &Path) -> Result<Option<AnalysisEditDocument>, AppError> {
        if !root.exists() { return Ok(None); }
        // Reopening verifies contents, not filenames or Finder dates. A changed
        // file at the same path must never inherit corrections for other media.
        let mut file = std::fs::File::open(path)?;
        let before = file.metadata()?;
        let mut hash = Sha256::new();
        std::io::copy(&mut file, &mut hash)?;
        let after = file.metadata()?;
        let current = std::fs::metadata(path)?;
        let mut replaced = before.len() != current.len() || before.modified()? != current.modified()?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            replaced |= before.dev() != current.dev() || before.ino() != current.ino();
        }
        if replaced || before.len() != after.len() || before.modified()? != after.modified()? {
            return Err(AppError::invalid("The source changed while loading corrections. Reopen the clip."));
        }
        let _lock = EDIT_LOCK.lock().map_err(|_| AppError::internal("Analysis load lock unavailable"))?;
        read(root, &format!("{:x}", hash.finalize()))
}

#[tauri::command]
pub async fn load_analysis_corrections(app: AppHandle, path: String) -> Result<Option<AnalysisEditDocument>, AppError> {
    let root = root(&app)?;
    tauri::async_runtime::spawn_blocking(move || load_source(&root, Path::new(&path)))
        .await.map_err(|e| AppError::internal(e.to_string()))?
}

#[tauri::command]
pub async fn save_analysis_correction(app: AppHandle, snapshot: AnalysisEditDocument, key: String, expected_revision: u32, edit: AnalysisRowCorrection) -> Result<AnalysisEditDocument, AppError> {
    let root = root(&app)?;
    let result = tauri::async_runtime::spawn_blocking(move || save(&root, snapshot, &key, expected_revision, edit))
        .await.map_err(|e| AppError::internal(e.to_string()))??;
    // Publication follows the native commit, even if the initiating view left.
    let _ = app.emit("analysis-corrections-saved", &result);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("sauce-analysis-edits-{}-{}", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
            std::fs::create_dir_all(&path).unwrap(); Self(path)
        }
    }
    impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
    fn fixture() -> AnalysisEditDocument {
        AnalysisEditDocument { schema_version: 1, revision: 0,
            source: VideoAnalysisSource { path: "/clip.mp4".into(), sha256: "a".repeat(64), origin_us: 0, duration_us: 10_000_000 }, fps: 24.0, model: Some("model".into()),
            rows: vec![AnalysisEditRow { id: 1, start_us: 0, end_us: 2_000_000, picture: "Original".into(), dialogue: "".into(), summary: "".into() },
                AnalysisEditRow { id: 2, start_us: 2_000_000, end_us: 10_000_000, picture: "Second".into(), dialogue: "".into(), summary: "".into() }], corrections: BTreeMap::new() }
    }
    #[test]
    fn preserves_other_rows_on_stale_save_and_reopens_unicode_and_empty_text() {
        let folder = Fixture::new(); let snapshot = fixture();
        let edit = AnalysisRowCorrection { picture: Some("".into()), dialogue: Some("東京 é".into()), ..Default::default() };
        save(&folder.0, snapshot.clone(), "0:2000000", 0, edit).unwrap();
        let edit = AnalysisRowCorrection { label: Some("2B".into()), ..Default::default() };
        save(&folder.0, snapshot.clone(), "2000000:10000000", 0, edit).unwrap();
        let doc = read(&folder.0, &snapshot.source.sha256).unwrap().unwrap();
        assert_eq!(doc.revision, 2);
        assert_eq!(doc.corrections["0:2000000"].picture.as_deref(), Some(""));
        assert_eq!(doc.corrections["0:2000000"].dialogue.as_deref(), Some("東京 é"));
        assert_eq!(doc.rows[0].picture, "Original");
    }
    #[test]
    fn rejects_stale_row_and_retains_reset_tombstone_revision() {
        let folder = Fixture::new(); let snapshot = fixture();
        save(&folder.0, snapshot.clone(), "0:2000000", 0, AnalysisRowCorrection::default()).unwrap();
        assert!(save(&folder.0, snapshot.clone(), "0:2000000", 0, AnalysisRowCorrection::default()).is_err());
        let doc = save(&folder.0, snapshot, "0:2000000", 1, AnalysisRowCorrection::default()).unwrap();
        assert_eq!(doc.corrections["0:2000000"].revision, 2);
    }
    #[test]
    fn rerun_preserves_overrides_without_retargeting_changed_boundaries() {
        let folder = Fixture::new(); let mut snapshot = fixture();
        save(&folder.0, snapshot.clone(), "0:2000000", 0, AnalysisRowCorrection { picture: Some("User text".into()), ..Default::default() }).unwrap();
        snapshot.rows[0].end_us = 3_000_000; snapshot.rows[1].start_us = 3_000_000;
        let doc = save(&folder.0, snapshot, "0:3000000", 0, AnalysisRowCorrection::default()).unwrap();
        assert_eq!(doc.corrections["0:2000000"].picture.as_deref(), Some("User text"));
        assert!(doc.corrections["0:3000000"].picture.is_none());
    }
    #[test]
    fn refuses_corrupt_future_or_mismatched_files_without_overwriting() {
        let folder = Fixture::new(); let snapshot = fixture(); let path = location(&folder.0, &snapshot.source.sha256).unwrap();
        for data in ["broken".to_string(), serde_json::to_string(&AnalysisEditDocument { schema_version: 99, ..snapshot.clone() }).unwrap()] {
            std::fs::write(&path, &data).unwrap();
            assert!(save(&folder.0, snapshot.clone(), "0:2000000", 0, AnalysisRowCorrection::default()).is_err());
            assert_eq!(std::fs::read_to_string(&path).unwrap(), data);
        }
        assert!(location(&folder.0, "../../elsewhere").is_err());
    }
    #[test]
    fn frame_validation_and_source_isolation() {
        let folder = Fixture::new(); let mut snapshot = fixture(); snapshot.fps = 24000.0 / 1001.0;
        let edit = AnalysisRowCorrection { start_us: Some(41708), ..Default::default() };
        save(&folder.0, snapshot.clone(), "0:2000000", 0, edit).unwrap();
        for time in [40000, 2_000_000, 11_000_000] {
            assert!(save(&folder.0, snapshot.clone(), "0:2000000", 1, AnalysisRowCorrection { start_us: Some(time), ..Default::default() }).is_err());
        }
        assert!(read(&folder.0, &"b".repeat(64)).unwrap().is_none());
    }
    #[test]
    fn reopen_verifies_source_bytes_and_supports_a_renamed_identical_file() {
        let folder = Fixture::new(); let source = folder.0.join("source.mp4"); let copy = folder.0.join("renamed.mp4");
        std::fs::write(&source, "original media").unwrap(); std::fs::copy(&source, &copy).unwrap();
        let mut snapshot = fixture(); snapshot.source.sha256 = format!("{:x}", Sha256::digest(b"original media"));
        save(&folder.0, snapshot, "0:2000000", 0, AnalysisRowCorrection { picture: Some("User correction".into()), ..Default::default() }).unwrap();
        assert!(load_source(&folder.0, &copy).unwrap().is_some());
        std::fs::write(&source, "different media").unwrap();
        assert!(load_source(&folder.0, &source).unwrap().is_none());
    }
    #[test]
    fn simultaneous_writers_merge_different_rows() {
        let folder = Fixture::new(); let snapshot = fixture();
        std::thread::scope(|scope| {
            let first = scope.spawn(|| save(&folder.0, snapshot.clone(), "0:2000000", 0, AnalysisRowCorrection { picture: Some("First".into()), ..Default::default() }));
            let second = scope.spawn(|| save(&folder.0, snapshot.clone(), "2000000:10000000", 0, AnalysisRowCorrection { picture: Some("Second".into()), ..Default::default() }));
            first.join().unwrap().unwrap(); second.join().unwrap().unwrap();
        });
        assert_eq!(read(&folder.0, &snapshot.source.sha256).unwrap().unwrap().corrections.len(), 2);
    }
}
