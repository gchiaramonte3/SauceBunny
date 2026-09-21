//! Small durable project metadata; audio stays rebuildable in the media cache.
use super::model::*;
use crate::AppError;
use std::{path::{Path, PathBuf}, sync::Mutex};
use std::io::{Read, Seek, SeekFrom};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

static DOCUMENT_WRITER: Mutex<()> = Mutex::new(());
const MAX_DOCUMENT_BYTES: u64 = 32 * 1024 * 1024;

pub fn root(app: &AppHandle) -> Result<PathBuf, AppError> {
    let path = app.path().document_dir().map_err(|e| AppError::internal(e.to_string()))?
        .join("Sauce Bunny").join("Transcripts").join("Multitrack");
    std::fs::create_dir_all(&path)?;
    Ok(path)
}

pub fn cache(app: &AppHandle) -> Result<PathBuf, AppError> {
    let path = app.path().app_cache_dir().map_err(|e| AppError::internal(e.to_string()))?
        .join("media").join("aaf");
    std::fs::create_dir_all(&path)?;
    Ok(path)
}

fn document_path(root: &Path, id: &str) -> Result<PathBuf, AppError> {
    if id.len() != 64 || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AppError::invalid("Invalid multitrack document ID"));
    }
    Ok(root.join(format!("{id}.json")))
}

pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, AppError> {
    if std::fs::metadata(path)?.len() > MAX_DOCUMENT_BYTES {
        return Err(AppError::invalid("Multitrack document is too large"));
    }
    Ok(serde_json::from_slice(&std::fs::read(path)?)?)
}

pub fn load(root: &Path, id: &str) -> Result<AafDocument, AppError> {
    let mut document: AafDocument = read_json(&document_path(root, id)?)?;
    if !(1..=DOCUMENT_SCHEMA_VERSION).contains(&document.schema_version) {
        return Err(AppError::invalid("This multitrack document was saved by an unsupported version. Update Sauce Bunny."));
    }
    if document.id != id { return Err(AppError::invalid("Multitrack document identity does not match its filename")); }
    validate_manifest(&document.manifest)?;
    document.schema_version = DOCUMENT_SCHEMA_VERSION;
    Ok(document)
}

fn write(root: &Path, document: &AafDocument) -> Result<(), AppError> {
    if !(1..=DOCUMENT_SCHEMA_VERSION).contains(&document.schema_version) { return Err(AppError::invalid("Unsupported multitrack schema version")); }
    let mut document = document.clone();
    document.schema_version = DOCUMENT_SCHEMA_VERSION;
    validate_manifest(&document.manifest)?;
    let path = document_path(root, &document.id)?;
    if path.exists() {
        // Refuse newer files before overwrite, even if the in-memory copy is older.
        let _: AafDocument = load(root, &document.id)?;
    }
    let json = serde_json::to_vec_pretty(&document)?;
    if json.len() as u64 > MAX_DOCUMENT_BYTES { return Err(AppError::invalid("Multitrack document exceeds the save limit")); }
    crate::commands::system::write_bytes_impl(&path.to_string_lossy(), &json, false, false, true)?;
    Ok(())
}

#[cfg(test)]
pub fn create(root: &Path, document: &AafDocument) -> Result<(), AppError> {
    let _guard = DOCUMENT_WRITER.lock().map_err(|_| AppError::internal("Multitrack save lock unavailable"))?;
    if document_path(root, &document.id)?.exists() { return Err(AppError::invalid("Multitrack document already exists")); }
    write(root, document)
}

pub fn import(root: &Path, document: AafDocument) -> Result<AafDocument, AppError> {
    let _guard = DOCUMENT_WRITER.lock().map_err(|_| AppError::internal("Multitrack save lock unavailable"))?;
    if let Some(mut existing) = reopen(root, Path::new(&document.source_path), &document.manifest.source_fingerprint)? {
        if document.manifest.recording_dates.is_some() { existing.manifest.recording_dates = document.manifest.recording_dates; }
        write(root, &existing)?;
        return Ok(existing);
    }
    if document_path(root, &document.id)?.exists() { return Err(AppError::invalid("Multitrack document already exists")); }
    write(root, &document)?;
    Ok(document)
}

/// Reopen an unchanged source without deleting or combining historical imports.
/// Prefer the most complete saved document, then the most recently written one.
pub fn reopen(root: &Path, source: &Path, fingerprint: &str) -> Result<Option<AafDocument>, AppError> {
    let mut candidates = Vec::new();
    for item in list(root)? {
        if Path::new(&item.source_path) != source { continue; }
        let doc = load(root, &item.id)?;
        if doc.manifest.source_fingerprint == fingerprint {
            candidates.push((doc.transcripts.len(), item.modified_ms.unwrap_or(0), doc));
        }
    }
    candidates.sort_by_key(|(count, modified, _)| (*count, *modified));
    Ok(candidates.pop().map(|(_, _, doc)| doc))
}

pub fn metadata(root: &Path, id: &str, override_date: Option<String>, dates: Option<Vec<AafRecordingDate>>) -> Result<AafDocument, AppError> {
    let _guard = DOCUMENT_WRITER.lock().map_err(|_| AppError::internal("Multitrack save lock unavailable"))?;
    let mut document = load(root, id)?;
    if let Some(dates) = dates { document.manifest.recording_dates = Some(dates); }
    else { document.shoot_date_override = override_date; }
    if document.shoot_date_override.as_ref().is_some_and(|value| !value.is_empty() && !valid_date(value)) {
        return Err(AppError::invalid("Enter a valid shoot date as YYYY-MM-DD"));
    }
    write(root, &document)?;
    Ok(document)
}

pub fn valid_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-'
        || bytes.iter().enumerate().any(|(i, c)| i != 4 && i != 7 && !c.is_ascii_digit()) { return false; }
    let year = value[..4].parse::<u32>().unwrap_or(0);
    let month = value[5..7].parse::<usize>().unwrap_or(0);
    let day = value[8..].parse::<u32>().unwrap_or(0);
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    year > 0 && (1..=12).contains(&month) && day > 0
        && day <= [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
}

pub fn labels(root: &Path, id: &str, labels: Vec<AafTrackLabel>) -> Result<AafDocument, AppError> {
    let _guard = DOCUMENT_WRITER.lock().map_err(|_| AppError::internal("Multitrack save lock unavailable"))?;
    let mut document = load(root, id)?;
    let mut seen = std::collections::HashSet::new();
    if labels.len() != document.manifest.tracks.len() {
        return Err(AppError::invalid("Confirm a name for each microphone track"));
    }
    for label in &labels {
        if !document.manifest.tracks.iter().any(|track| track.id == label.track_id)
            || !seen.insert(&label.track_id) || label.owner_name.trim().is_empty()
            || label.owner_name.len() > 256 || label.cast_member_id.as_ref().is_some_and(|s| s.len() > 256)
            || label.color.as_ref().is_some_and(|s| s.len() > 64)
        { return Err(AppError::invalid("Invalid microphone track label")); }
    }
    document.labels = labels;
    write(root, &document)?;
    Ok(document)
}

pub fn save_transcript(root: &Path, id: &str, transcript: AafTrackTranscript) -> Result<(), AppError> {
    let _guard = DOCUMENT_WRITER.lock().map_err(|_| AppError::internal("Multitrack save lock unavailable"))?;
    let mut document = load(root, id)?;
    if !document.manifest.tracks.iter().any(|track| track.id == transcript.track_id) {
        return Err(AppError::invalid("Transcript track is not in this document"));
    }
    document.transcripts.retain(|item| item.track_id != transcript.track_id);
    document.transcripts.push(transcript);
    write(root, &document)
}

pub fn list(root: &Path) -> Result<Vec<AafDocumentSummary>, AppError> {
    let mut results = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let path = entry?.path();
        if path.extension().is_none_or(|ext| ext != "json") { continue; }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else { continue; };
        let document = load(root, id)?;
        results.push(AafDocumentSummary { id: document.id, name: document.manifest.name,
            track_count: document.manifest.tracks.len() as u32,
            transcribed_tracks: document.transcripts.len() as u32, source_path: document.source_path,
            modified_ms: Some(modified_ms(&std::fs::metadata(&path)?)) });
    }
    results.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(results)
}

pub fn source_ready(document: &AafDocument) -> Result<(), AppError> {
    let metadata = std::fs::metadata(&document.source_path)
        .map_err(|_| AppError::not_found("The original AAF is unavailable. Reconnect its drive or import it again."))?;
    if metadata.len() != document.source_size || modified_ms(&metadata) != document.source_modified_ms
        || source_fingerprint(Path::new(&document.source_path))? != document.manifest.source_fingerprint {
        return Err(AppError::invalid("The original AAF has changed. Import the new file before preparing more audio."));
    }
    Ok(())
}

/// Same bounded identity as the reader: size, nanosecond mtime, first/last 64 KiB.
/// This detects replacement for cached assets without claiming a full-file hash.
fn source_fingerprint(path: &Path) -> Result<String, AppError> {
    let mut file = std::fs::File::open(path)?;
    let metadata = file.metadata()?;
    let modified_ns = metadata.modified()?.duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| AppError::invalid("AAF modification time is outside the supported range"))?.as_nanos();
    let mut hash = Sha256::new();
    hash.update(format!("{}:{modified_ns}", metadata.len()).as_bytes());
    let mut buffer = vec![0_u8; metadata.len().min(65_536) as usize];
    file.read_exact(&mut buffer)?;
    hash.update(&buffer);
    file.seek(SeekFrom::Start(metadata.len().saturating_sub(65_536)))?;
    file.read_exact(&mut buffer)?;
    hash.update(&buffer);
    Ok(format!("{:x}", hash.finalize()))
}

pub fn modified_ms(metadata: &std::fs::Metadata) -> u64 {
    metadata.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis().min(u128::from(u64::MAX)) as u64).unwrap_or(0)
}

pub fn track<'a>(document: &'a AafDocument, id: &str) -> Result<&'a AafTrack, AppError> {
    document.manifest.tracks.iter().find(|track| track.id == id)
        .ok_or_else(|| AppError::invalid("Unknown AAF track"))
}

pub fn cache_key(document: &AafDocument, track: &str, purpose: &str) -> String {
    blake3::hash(format!("aaf-v1:{}:{track}:{purpose}", document.manifest.source_fingerprint).as_bytes())
        .to_hex().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> AafDocument {
        AafDocument { schema_version: 1, shoot_date_override: None, id: "a".repeat(64), source_path: "/tmp/source.aaf".into(),
            source_size: 1, source_modified_ms: 0,
            manifest: AafManifest { schema_version: 1, recording_dates: None, name: "Test".into(), source_fingerprint: "b".repeat(64),
                edit_rate: AafRate { numerator: 24000, denominator: 1001 }, start_frame: 0, duration_frames: 240,
                timecode_fps: 24, drop_frame: false,
                tracks: vec![AafTrack { id: "10".into(), name: "Café".into(), physical_track_number: None, clips: vec![AafClip {
                    start_frame: 0, duration_frames: 240, kind: "gap".into(), master_id: None, source_id: None,
                    source_start_sample: None, sample_rate: None, warnings: vec![] }], warnings: vec![] }], warnings: vec![] },
            labels: vec![AafTrackLabel { track_id: "10".into(), owner_name: "Café".into(), cast_member_id: None, color: None, gender: None, marker_color: None }],
            transcripts: vec![] }
    }

    #[test]
    fn save_reopen_and_label_updates_preserve_transcripts_and_unicode() {
        let root = std::env::temp_dir().join(format!("aaf-store-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let doc = fixture();
        create(&root, &doc).unwrap();
        let transcript = AafTrackTranscript { track_id: "10".into(), start_frame: 24, duration_frames: 48,
            engine: AafEngine::Parakeet, model_id: "test".into(), status: AafTranscriptStatus::Review,
            sample_rate: 16000, cues: vec![AafCue { id: "cue".into(), start_sample: 16016, end_sample: 24024, text: "Hello, Café".into(), boundary_review: false }], timing_issues: vec![AafTimingIssue { id: "untimed".into(), text: "Kept without invented timing".into(), reported_timing: "00:00:10,000 --> 00:00:10,000".into(), chunk_start_frame: 24, reason: "Empty time range".into() }], warnings: vec![] };
        save_transcript(&root, &doc.id, transcript).unwrap();
        let updated = labels(&root, &doc.id, vec![AafTrackLabel { track_id: "10".into(), owner_name: "かが Élodie".into(), cast_member_id: None, color: None, gender: None, marker_color: None }]).unwrap();
        assert_eq!(updated.transcripts.len(), 1);
        let reopened = load(&root, &doc.id).unwrap();
        assert_eq!(reopened.labels[0].owner_name, "かが Élodie");
        assert_eq!(reopened.transcripts[0].start_frame, 24);
        assert_eq!(reopened.transcripts[0].duration_frames, 48);
        assert_eq!(reopened.transcripts[0].cues[0].text, "Hello, Café");
        assert_eq!(reopened.transcripts[0].timing_issues[0].text, "Kept without invented timing");
        assert!(matches!(reopened.transcripts[0].status, AafTranscriptStatus::Review));
        let mut legacy = serde_json::to_value(&reopened).unwrap();
        legacy["transcripts"][0].as_object_mut().unwrap().remove("timing_issues");
        legacy["transcripts"][0]["status"] = "completed".into();
        assert!(serde_json::from_value::<AafDocument>(legacy).unwrap().transcripts[0].timing_issues.is_empty());
        let mut future = reopened;
        future.schema_version = DOCUMENT_SCHEMA_VERSION + 1;
        let path = document_path(&root, &doc.id).unwrap();
        let bytes = serde_json::to_vec(&future).unwrap();
        std::fs::write(&path, &bytes).unwrap();
        assert!(labels(&root, &doc.id, doc.labels).is_err());
        assert_eq!(std::fs::read(path).unwrap(), bytes, "newer saved work must not be overwritten");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn bounded_identity_detects_same_size_same_mtime_head_replacement() {
        let root = std::env::temp_dir().join(format!("aaf-identity-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("fixture.aaf");
        std::fs::write(&path, vec![1_u8; 150_000]).unwrap();
        let original_time = std::fs::metadata(&path).unwrap().modified().unwrap();
        let identity = source_fingerprint(&path).unwrap();
        assert_eq!(identity.len(), 64);
        std::fs::write(&path, vec![2_u8; 150_000]).unwrap();
        std::fs::File::options().write(true).open(&path).unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(original_time)).unwrap();
        assert_ne!(identity, source_fingerprint(&path).unwrap());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn document_ids_cannot_escape_the_store() {
        assert!(document_path(Path::new("/tmp/store"), &"a".repeat(64)).is_ok());
        for bad in ["../doc", "", "/tmp/doc", "abcdef"] {
            assert!(document_path(Path::new("/tmp/store"), bad).is_err());
        }
    }

    #[test]
    fn unchanged_import_preserves_all_historical_versions_and_committed_empty_results() {
        let root = std::env::temp_dir().join(format!("aaf-reimport-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let mut original = fixture();
        original.transcripts.push(AafTrackTranscript { track_id: "10".into(), engine: AafEngine::Parakeet,
            model_id: "test".into(), start_frame: 0, duration_frames: 240, status: AafTranscriptStatus::Empty,
            sample_rate: 16000, cues: vec![], timing_issues: vec![], warnings: vec![] });
        create(&root, &original).unwrap();
        let mut duplicate = fixture(); duplicate.id = "c".repeat(64); create(&root, &duplicate).unwrap();
        let mut fresh = fixture(); fresh.id = "d".repeat(64);
        assert_eq!(import(&root, fresh.clone()).unwrap().id, original.id);
        assert_eq!(list(&root).unwrap().len(), 2);
        assert_eq!(load(&root, &original.id).unwrap().transcripts.len(), 1);
        fresh.manifest.source_fingerprint = "e".repeat(64);
        assert_eq!(import(&root, fresh).unwrap().id, "d".repeat(64));
        assert_eq!(list(&root).unwrap().len(), 3);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn metadata_and_manual_preferences_migrate_without_discarding_saved_content() {
        let root = std::env::temp_dir().join(format!("aaf-date-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap(); let doc = fixture(); create(&root, &doc).unwrap();
        let dates = vec![AafRecordingDate { source_id: "one".into(), date: "2026-08-01".into(), provenance: "bwf-origination-date".into() },
            AafRecordingDate { source_id: "two".into(), date: "2026-08-02".into(), provenance: "bwf-origination-date".into() }];
        metadata(&root, &doc.id, None, Some(dates.clone())).unwrap();
        metadata(&root, &doc.id, Some("2026-08-03".into()), None).unwrap();
        let mut prefs = doc.labels; prefs[0].gender = Some(AafGender::Woman); prefs[0].marker_color = Some(AafMarkerColor::Pink);
        let saved = labels(&root, &doc.id, prefs).unwrap();
        assert_eq!(saved.shoot_date_override.as_deref(), Some("2026-08-03"));
        assert_eq!(saved.manifest.recording_dates.unwrap().len(), 2);
        let saved = metadata(&root, &doc.id, None, Some(dates)).unwrap();
        assert!(matches!(saved.labels[0].marker_color, Some(AafMarkerColor::Pink)));
        assert_eq!(saved.shoot_date_override.as_deref(), Some("2026-08-03"));
        assert!(metadata(&root, &doc.id, Some("2026-02-29".into()), None).is_err());
        assert!(metadata(&root, &doc.id, None, None).unwrap().shoot_date_override.is_none());
        assert_eq!(load(&root, &doc.id).unwrap().schema_version, DOCUMENT_SCHEMA_VERSION);
        for (date, expected) in [("2024-02-29", true), ("1900-02-29", false), ("2000-02-29", true), ("0000-01-01", false), ("2026-13-01", false)] { assert_eq!(valid_date(date), expected); }
        std::fs::remove_dir_all(root).unwrap();
    }
}
