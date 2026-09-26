//! Small durable project metadata; audio stays rebuildable in the media cache.
use super::model::*;
use crate::AppError;
use std::{path::{Path, PathBuf}, sync::Mutex};
use std::io::{Read, Seek, SeekFrom};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

static DOCUMENT_WRITER: Mutex<()> = Mutex::new(());
/// Transcripts live inside the document, about 170 bytes per cue. At 32 MiB
/// (and pretty-printed JSON, ~250 bytes per cue) a 30-mic, 8-hour sequence
/// could not save its later tracks: every run after the cap failed only at
/// commit, once all the recognition work was done. The cap stays as a guard
/// against a corrupt or hostile file, sized well above real sequences.
const MAX_DOCUMENT_BYTES: u64 = 256 * 1024 * 1024;

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
        return Err(AppError::invalid("AAF Audio document is too large"));
    }
    Ok(serde_json::from_slice(&std::fs::read(path)?)?)
}

pub fn load(root: &Path, id: &str) -> Result<AafDocument, AppError> {
    let mut document: AafDocument = read_json(&document_path(root, id)?)?;
    if !(1..=DOCUMENT_SCHEMA_VERSION).contains(&document.schema_version) {
        return Err(AppError::invalid("This multitrack document was saved by an unsupported version. Update Sauce Bunny."));
    }
    if document.id != id { return Err(AppError::invalid("AAF Audio document identity does not match its filename")); }
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
    // Compact: indentation cost about a third of the file for nothing a reader needs.
    let json = serde_json::to_vec(&document)?;
    if json.len() as u64 > MAX_DOCUMENT_BYTES { return Err(AppError::invalid("This sequence's saved transcripts have reached the 256 MB an AAF Audio document can hold, so this run was not saved. Export the finished tracks before generating more.")); }
    crate::commands::system::write_bytes_impl(&path.to_string_lossy(), &json, false, false, true)?;
    Ok(())
}

#[cfg(test)]
pub fn create(root: &Path, document: &AafDocument) -> Result<(), AppError> {
    let _guard = DOCUMENT_WRITER.lock().map_err(|_| AppError::internal("AAF Audio save lock unavailable"))?;
    if document_path(root, &document.id)?.exists() { return Err(AppError::invalid("AAF Audio document already exists")); }
    write(root, document)
}

pub fn import(root: &Path, document: AafDocument) -> Result<AafDocument, AppError> {
    let _guard = DOCUMENT_WRITER.lock().map_err(|_| AppError::internal("AAF Audio save lock unavailable"))?;
    if let Some(mut existing) = reopen(root, &document)? {
        if document.manifest.recording_dates.is_some() { existing.manifest.recording_dates = document.manifest.recording_dates.clone(); }
        if existing.manifest.graph.is_none() && document.manifest.graph.is_some() {
            // Upgrade only an identical root layout. Labels and committed text
            // belong to stable lane IDs, not the newly read display names.
            for label in document.labels {
                if !existing.labels.iter().any(|old| old.track_id == label.track_id) { existing.labels.push(label); }
            }
            existing.manifest = document.manifest;
        } else if existing.manifest.schema_version < SCHEMA_VERSION {
            upgrade_graph(&mut existing, document.manifest)?;
        }
        write(root, &existing)?;
        return Ok(existing);
    }
    if document_path(root, &document.id)?.exists() { return Err(AppError::invalid("AAF Audio document already exists")); }
    write(root, &document)?;
    Ok(document)
}

/// Reopen an unchanged source without deleting or combining historical imports.
/// Prefer the most complete saved document, then the most recently written one.
pub fn reopen(root: &Path, incoming: &AafDocument) -> Result<Option<AafDocument>, AppError> {
    let mut candidates = Vec::new();
    for item in list(root)? {
        if item.source_path != incoming.source_path { continue; }
        let doc = load(root, &item.id)?;
        let same_sequence = match (&doc.manifest.graph, &incoming.manifest.graph) {
            (Some(old), Some(new)) => old.sequence_id == new.sequence_id,
            (None, _) => doc.manifest.name == incoming.manifest.name
                && doc.manifest.start_frame == incoming.manifest.start_frame
                && doc.manifest.duration_frames == incoming.manifest.duration_frames
                && doc.manifest.edit_rate.numerator == incoming.manifest.edit_rate.numerator
                && doc.manifest.edit_rate.denominator == incoming.manifest.edit_rate.denominator
                && doc.manifest.tracks.iter().all(|old| incoming.manifest.tracks.iter().any(|new| new.id == old.id
                    && serde_json::to_value(&new.clips).ok() == serde_json::to_value(&old.clips).ok())),
            _ => false,
        };
        if same_sequence && doc.manifest.source_fingerprint == incoming.manifest.source_fingerprint {
            candidates.push((doc.transcripts.len(), item.modified_ms.unwrap_or(0), doc));
        }
    }
    candidates.sort_by_key(|(count, modified, _)| (*count, *modified));
    Ok(candidates.pop().map(|(_, _, doc)| doc))
}

pub fn metadata(root: &Path, id: &str, override_date: Option<String>, dates: Option<Vec<AafRecordingDate>>) -> Result<AafDocument, AppError> {
    let _guard = DOCUMENT_WRITER.lock().map_err(|_| AppError::internal("AAF Audio save lock unavailable"))?;
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
    let _guard = DOCUMENT_WRITER.lock().map_err(|_| AppError::internal("AAF Audio save lock unavailable"))?;
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

/// Commit a run and return what the track now holds. A run over part of the
/// sequence is spliced into the saved transcript rather than replacing it.
pub fn save_transcript(root: &Path, expected: &AafDocument, transcript: AafTrackTranscript) -> Result<AafTrackTranscript, AppError> {
    let _guard = DOCUMENT_WRITER.lock().map_err(|_| AppError::internal("AAF Audio save lock unavailable"))?;
    let mut document = load(root, &expected.id)?;
    if cache_key(&document, &transcript.track_id, "commit") != cache_key(expected, &transcript.track_id, "commit") {
        return Err(AppError::invalid("Media resolution changed during transcription. The previous saved result is unchanged."));
    }
    if !document.manifest.tracks.iter().any(|track| track.id == transcript.track_id) {
        return Err(AppError::invalid("Transcript track is not in this document"));
    }
    let previous = document.transcripts.iter().position(|item| item.track_id == transcript.track_id).map(|index| document.transcripts.remove(index));
    let merged = merge_transcript(previous, transcript, &document.manifest.edit_rate)?;
    document.transcripts.push(merged.clone());
    write(root, &document)?;
    Ok(merged)
}

/// Splice a run over [start, end) into the track's saved transcript: saved
/// cues and untimed text outside the run are kept, everything the run covers
/// is replaced. A run covering all of the saved one simply replaces it.
pub fn merge_transcript(previous: Option<AafTrackTranscript>, run: AafTrackTranscript, rate: &AafRate) -> Result<AafTrackTranscript, AppError> {
    let Some(previous) = previous else { return Ok(run); };
    let (run_end, previous_end) = (run.start_frame + run.duration_frames, previous.start_frame + previous.duration_frames);
    if run.start_frame <= previous.start_frame && run_end >= previous_end { return Ok(run); }
    let (low, high) = (frame_samples(run.start_frame, rate)?, frame_samples(run_end, rate)?);
    let outside = |start: i64, end: i64| end <= low || start >= high;
    let mut cues: Vec<AafCue> = previous.cues.into_iter().filter(|cue| outside(cue.start_sample, cue.end_sample)).collect();
    let mut timing_issues: Vec<AafTimingIssue> = previous.timing_issues.into_iter()
        .filter(|issue| issue.chunk_start_frame < run.start_frame || issue.chunk_start_frame >= run_end).collect();
    // Ids name a processing chunk and its cue index, so a run starting on the
    // same chunk boundary as a saved one can reuse an id; make them unique.
    let mut taken: std::collections::HashSet<String> = cues.iter().map(|cue| cue.id.clone()).chain(timing_issues.iter().map(|issue| issue.id.clone())).collect();
    let mut unique = |id: String| { let mut candidate = id.clone(); let mut n = 1; while !taken.insert(candidate.clone()) { n += 1; candidate = format!("{id}~{n}"); } candidate };
    cues.extend(run.cues.into_iter().map(|cue| AafCue { id: unique(cue.id.clone()), ..cue }));
    timing_issues.extend(run.timing_issues.into_iter().map(|issue| AafTimingIssue { id: unique(issue.id.clone()), ..issue }));
    cues.sort_by_key(|cue| (cue.start_sample, cue.end_sample));
    let start_frame = run.start_frame.min(previous.start_frame);
    let status = if !timing_issues.is_empty() { AafTranscriptStatus::Review } else if cues.is_empty() { AafTranscriptStatus::Empty } else { AafTranscriptStatus::Completed };
    let mut warnings = run.warnings;
    warnings.push(format!("Saved results outside this run were kept from an earlier {} {} run.", engine_name(&previous.engine), previous.model_id));
    Ok(AafTrackTranscript { track_id: run.track_id, start_frame, duration_frames: run_end.max(previous_end) - start_frame,
        engine: run.engine, model_id: run.model_id, status, sample_rate: run.sample_rate, cues, timing_issues, warnings })
}

fn engine_name(engine: &AafEngine) -> &'static str {
    match engine { AafEngine::Parakeet => "Parakeet", AafEngine::Whisper => "Whisper" }
}

pub fn list(root: &Path) -> Result<Vec<AafDocumentSummary>, AppError> {
    let mut results = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let path = entry?.path();
        if path.extension().is_none_or(|ext| ext != "json") { continue; }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else { continue; };
        // A listing needs names and counts, not every cue of every sequence:
        // counting the arrays without building them keeps a shelf of large
        // multi-mic documents from costing gigabytes each time it refreshes.
        #[derive(serde::Deserialize)]
        struct Manifest { name: String, tracks: Vec<serde::de::IgnoredAny> }
        #[derive(serde::Deserialize)]
        struct Summary { schema_version: u32, id: String, source_path: String, manifest: Manifest, transcripts: Vec<serde::de::IgnoredAny> }
        let document: Summary = read_json(&document_path(root, id)?)?;
        if !(1..=DOCUMENT_SCHEMA_VERSION).contains(&document.schema_version) {
            return Err(AppError::invalid("This multitrack document was saved by an unsupported version. Update Sauce Bunny."));
        }
        if document.id != id { return Err(AppError::invalid("AAF Audio document identity does not match its filename")); }
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
pub fn source_fingerprint(path: &Path) -> Result<String, AppError> {
    let mut file = std::fs::File::open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.len() == 0 { return Err(AppError::invalid("Choose a non-empty regular media file")); }
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
    let graph = document.manifest.graph.as_ref().map(|g| if purpose == "relink" {
        format!("{}:{g:?}", document.manifest.schema_version)
    } else { format!("{}:{:?}:{:?}:{:?}", g.sequence_id,
        g.sources.iter().filter(|s| track == "all" || document.manifest.tracks.iter().any(|t| t.id == track && t.clips.iter().any(|c| c.source_id.as_deref() == Some(&s.id))))
            .map(|s| (&s.id, s.slot_id, s.channel, s.channels, s.sample_rate, s.sample_width, s.sample_count, &s.status, &s.resolved)).collect::<Vec<_>>(),
        document.manifest.tracks.iter().filter(|t| track == "all" || t.id == track).map(|t| (&t.id, &t.clips)).collect::<Vec<_>>(),
        g.positions.iter().filter(|p| track == "all" || p.track_id == track).collect::<Vec<_>>()) }).unwrap_or_default();
    blake3::hash(format!("aaf-v3:{}:{track}:{purpose}:{graph}", document.manifest.source_fingerprint).as_bytes())
        .to_hex().to_string()
}

/// Reinspect old graph semantics without renaming lanes or discarding a saved
/// result. A changed layout needs an explicit new import, never a guessed merge.
pub fn upgrade_graph(document: &mut AafDocument, mut fresh: AafManifest) -> Result<(), AppError> {
    validate_manifest(&fresh)?;
    let old = &document.manifest;
    if old.source_fingerprint != fresh.source_fingerprint || old.duration_frames != fresh.duration_frames
        || old.start_frame != fresh.start_frame || old.edit_rate.numerator != fresh.edit_rate.numerator
        || old.edit_rate.denominator != fresh.edit_rate.denominator || old.tracks.len() != fresh.tracks.len()
        || !old.tracks.iter().all(|t| fresh.tracks.iter().any(|n| t.id == n.id)) {
        return Err(AppError::invalid("Updated AAF inspection found a different lane layout. Keep this saved document and import the AAF as a new version."));
    }
    if let (Some(old), Some(new)) = (&old.graph, &mut fresh.graph) {
        if old.sequence_id != new.sequence_id { return Err(AppError::invalid("AAF sequence identity changed during inspection")); }
        new.path_mappings = old.path_mappings.clone();
        for source in &mut new.sources {
            if let Some(previous) = old.sources.iter().find(|s| s.id == source.id && same_routing(s, source)) {
                source.resolved = previous.resolved.clone();
                source.status = previous.status.clone();
            }
        }
    }
    warn_changed_routing(document, &fresh);
    fresh.recording_dates = document.manifest.recording_dates.clone();
    document.manifest = fresh;
    Ok(())
}

fn same_routing(a: &AafSource, b: &AafSource) -> bool {
    a.mob_id == b.mob_id && a.slot_id == b.slot_id && a.channel == b.channel && a.channels == b.channels
        && a.sample_rate == b.sample_rate && a.sample_width == b.sample_width && a.sample_count == b.sample_count
}

fn warn_changed_routing(document: &mut AafDocument, fresh: &AafManifest) {
    let changed: Vec<_> = document.manifest.graph.iter().flat_map(|g| &g.sources).filter(|old| {
        fresh.graph.as_ref().and_then(|g| g.sources.iter().find(|s| s.id == old.id)).is_none_or(|new|
            !same_routing(old, new) || old.resolved.as_ref().is_some_and(|binding| new.resolved.as_ref().is_some_and(|n|
                binding.fingerprint != n.fingerprint || binding.stream_index != n.stream_index)))
    }).map(|s| s.id.as_str()).collect();
    for transcript in &mut document.transcripts {
        if document.manifest.tracks.iter().find(|t| t.id == transcript.track_id).is_some_and(|t| t.clips.iter().any(|c| c.source_id.as_deref().is_some_and(|id| changed.contains(&id)))) {
            let warning = "Media routing changed after this transcript was saved. The transcript is preserved; review it against the linked recording.".to_owned();
            if !transcript.warnings.contains(&warning) { transcript.warnings.push(warning); }
        }
    }
}

pub fn save_graph(root: &Path, update: &AafDocument, expected_revision: &str) -> Result<AafDocument, AppError> {
    let _guard = DOCUMENT_WRITER.lock().map_err(|_| AppError::internal("AAF Audio save lock unavailable"))?;
    let mut current = load(root, &update.id)?;
    if cache_key(&current, "all", "relink") != expected_revision { return Err(AppError::invalid("Media resolution changed in another operation. Refresh availability and try again.")); }
    if current.manifest.source_fingerprint != update.manifest.source_fingerprint { return Err(AppError::invalid("The AAF changed during relinking")); }
    warn_changed_routing(&mut current, &update.manifest);
    current.manifest.schema_version = update.manifest.schema_version;
    current.manifest.tracks = update.manifest.tracks.clone();
    current.manifest.graph = update.manifest.graph.clone();
    write(root, &current)?;
    Ok(current)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn run(start: i64, duration: i64, cues: &[(&str, i64, i64)], issues: &[(&str, i64)]) -> AafTrackTranscript {
        AafTrackTranscript { track_id: "10".into(), start_frame: start, duration_frames: duration, engine: AafEngine::Parakeet, model_id: "m".into(),
            status: AafTranscriptStatus::Completed, sample_rate: ASR_RATE as u32, warnings: vec![],
            cues: cues.iter().map(|(id, a, b)| AafCue { id: (*id).into(), start_sample: *a, end_sample: *b, text: (*id).into(), boundary_review: false }).collect(),
            timing_issues: issues.iter().map(|(id, frame)| AafTimingIssue { id: (*id).into(), text: "t".into(), reported_timing: "x".into(), chunk_start_frame: *frame, reason: "r".into() }).collect() }
    }
    #[test]
    fn a_range_run_replaces_only_what_it_covers() {
        let rate = AafRate { numerator: 25, denominator: 1 }; // 640 samples per frame at 16 kHz
        let full = run(0, 100, &[("a", 0, 640), ("b", 20 * 640, 21 * 640), ("c", 29 * 640, 31 * 640), ("d", 60 * 640, 61 * 640)], &[("early", 5), ("inside", 25)]);
        let part = run(20, 10, &[("a", 22 * 640, 23 * 640)], &[]);
        let merged = merge_transcript(Some(full), part, &rate).unwrap();
        let texts: Vec<_> = merged.cues.iter().map(|c| (c.text.as_str(), c.id.as_str())).collect();
        // b sat inside the run and c straddled its end: both are replaced. a and d survive.
        assert_eq!(texts, vec![("a", "a"), ("a", "a~2"), ("d", "d")]);
        assert_eq!(merged.timing_issues.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(), vec!["early"]);
        assert_eq!((merged.start_frame, merged.duration_frames), (0, 100));
        assert!(matches!(merged.status, AafTranscriptStatus::Review));
        assert!(merged.warnings.iter().any(|w| w.contains("kept from an earlier Parakeet m run")));
    }
    #[test]
    fn a_run_covering_the_saved_transcript_replaces_it_and_a_first_run_is_kept_as_is() {
        let rate = AafRate { numerator: 25, denominator: 1 };
        let part = run(20, 10, &[("x", 22 * 640, 23 * 640)], &[]);
        let full = run(0, 100, &[("y", 0, 640)], &[]);
        let merged = merge_transcript(Some(part.clone()), full, &rate).unwrap();
        assert_eq!(merged.cues.len(), 1); assert_eq!(merged.cues[0].id, "y"); assert!(merged.warnings.is_empty());
        let first = merge_transcript(None, part, &rate).unwrap();
        assert_eq!((first.start_frame, first.duration_frames, first.cues.len()), (20, 10, 1));
    }
    #[test]
    fn a_later_range_extends_the_envelope_and_keeps_the_earlier_range() {
        let rate = AafRate { numerator: 25, denominator: 1 };
        let early = run(0, 10, &[("e", 640, 2 * 640)], &[]);
        let late = run(50, 10, &[("l", 51 * 640, 52 * 640)], &[]);
        let merged = merge_transcript(Some(early), late, &rate).unwrap();
        assert_eq!(merged.cues.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(), vec!["e", "l"]);
        assert_eq!((merged.start_frame, merged.duration_frames), (0, 60));
    }
    fn fixture() -> AafDocument {
        AafDocument { schema_version: 1, shoot_date_override: None, id: "a".repeat(64), source_path: "/tmp/source.aaf".into(),
            source_size: 1, source_modified_ms: 0,
            manifest: AafManifest { schema_version: 1, graph: None, recording_dates: None, name: "Test".into(), source_fingerprint: "b".repeat(64),
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
        save_transcript(&root, &doc, transcript).unwrap();
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
    fn large_sparse_identity_uses_64_bit_tail_offsets() {
        use std::io::Write;
        let path = std::env::temp_dir().join(format!("aaf-large-{}", uuid::Uuid::new_v4()));
        let mut file = std::fs::File::create(&path).unwrap();
        let size = 65_u64 * 1024 * 1024 * 1024 + 123;
        file.set_len(size).unwrap();
        file.seek(SeekFrom::Start(size - 4)).unwrap(); file.write_all(b"tail").unwrap();
        let metadata = file.metadata().unwrap();
        let nanos = metadata.modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let mut expected = Sha256::new(); expected.update(format!("{size}:{nanos}"));
        expected.update(vec![0_u8; 65536]); expected.update(vec![0_u8; 65532]); expected.update(b"tail");
        assert_eq!(source_fingerprint(&path).unwrap(), format!("{:x}", expected.finalize()));
        std::fs::remove_file(path).unwrap();
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

    fn with_graph(mut doc: AafDocument) -> AafDocument {
        doc.manifest.schema_version=2;
        doc.manifest.graph=Some(serde_json::from_value(serde_json::json!({"sequence_id":"top", "sources":[],"positions":[],"markers":[],"picture_tracks":[],"path_mappings":[],
            "lanes":[{"track_id":"10","parent_track_id":null,"branch_id":null,"group_name":null,"availability":"ready"}]})).unwrap());
        doc
    }

    #[test]
    fn graph_migration_keeps_cast_snapshots_text_and_old_ids_and_distinguishes_sequences() {
        let root=std::env::temp_dir().join(format!("aaf-migrate-{}",uuid::Uuid::new_v4())); std::fs::create_dir(&root).unwrap();
        let mut old=fixture(); old.labels[0].owner_name="User label".into(); old.labels[0].marker_color=Some(AafMarkerColor::Pink);
        old.transcripts.push(AafTrackTranscript { track_id:"10".into(),engine:AafEngine::Parakeet,model_id:"test".into(),start_frame:0,duration_frames:240,status:AafTranscriptStatus::Empty,sample_rate:16000,cues:vec![],timing_issues:vec![],warnings:vec![] });
        create(&root,&old).unwrap();
        let mut incoming=with_graph(fixture()); incoming.id="c".repeat(64);
        let saved=import(&root,incoming.clone()).unwrap();
        assert_eq!(saved.id,old.id); assert_eq!(saved.labels[0].owner_name,"User label"); assert!(matches!(saved.labels[0].marker_color,Some(AafMarkerColor::Pink)));
        assert_eq!(saved.transcripts.len(),1); assert!(saved.manifest.graph.is_some());
        incoming.manifest.graph.as_mut().unwrap().sequence_id="other".into();
        assert_eq!(import(&root,incoming).unwrap().id,"c".repeat(64)); assert_eq!(list(&root).unwrap().len(),2);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn stale_relink_and_inference_cannot_replace_committed_results() {
        let root=std::env::temp_dir().join(format!("aaf-relink-race-{}",uuid::Uuid::new_v4())); std::fs::create_dir(&root).unwrap();
        let mut doc=with_graph(fixture());
        doc.manifest.graph.as_mut().unwrap().sources.push(serde_json::from_value(serde_json::json!({"id":"s","mob_id":"mob","slot_id":1,"locators":[],"ancestors":[],"channel":0,"channels":1,"sample_rate":48000,"sample_width":2,"sample_count":480480,"descriptor":"PCMDescriptor","status":"ready",
            "resolved":{"path":"/tmp/audio.wav","fingerprint":"a".repeat(64),"stream_index":0,"size":960960,"modified_ms":1}})).unwrap());
        let clip=&mut doc.manifest.tracks[0].clips[0]; clip.kind="audio".into(); clip.source_id=Some("s".into()); clip.source_start_sample=Some(0); clip.sample_rate=Some(48000);
        doc.manifest.graph.as_mut().unwrap().positions.push(AafSourcePosition { track_id:"10".into(),clip_index:0,numerator:0,denominator:1 });
        let transcript=AafTrackTranscript { track_id:"10".into(),engine:AafEngine::Parakeet,model_id:"committed".into(),start_frame:0,duration_frames:240,status:AafTranscriptStatus::Empty,sample_rate:16000,cues:vec![],timing_issues:vec![],warnings:vec![] };
        doc.transcripts.push(transcript.clone()); create(&root,&doc).unwrap();
        let revision=cache_key(&doc,"all","relink");
        let mut replacement=doc.clone(); replacement.manifest.graph.as_mut().unwrap().sources[0].resolved.as_mut().unwrap().fingerprint="b".repeat(64);
        let saved=save_graph(&root,&replacement,&revision).unwrap();
        assert_eq!(saved.transcripts[0].model_id,"committed"); assert_eq!(saved.transcripts[0].warnings.len(),1);
        assert!(save_graph(&root,&doc,&revision).is_err());
        assert!(save_transcript(&root,&doc,transcript).is_err());
        assert_eq!(load(&root,&doc.id).unwrap().transcripts[0].model_id,"committed");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn progressive_checkpoints_keep_labels_and_commits_on_unrelated_microphones() {
        let root=std::env::temp_dir().join(format!("aaf-progressive-{}",uuid::Uuid::new_v4())); std::fs::create_dir(&root).unwrap();
        let mut doc=with_graph(fixture());
        let source: AafSource=serde_json::from_value(serde_json::json!({"id":"s","mob_id":"mob","slot_id":1,"locators":[],"ancestors":[],"channel":0,"channels":1,"sample_rate":48000,"sample_width":2,"sample_count":480480,"descriptor":"PCMDescriptor","status":"ready",
            "resolved":{"path":"/tmp/audio.wav","fingerprint":"a".repeat(64),"stream_index":0,"size":960960,"modified_ms":1}})).unwrap();
        let mut other=source.clone(); other.id="other".into(); other.status="offline".into(); other.resolved=None;
        doc.manifest.graph.as_mut().unwrap().sources=vec![source.clone(),other];
        let clip=&mut doc.manifest.tracks[0].clips[0]; clip.kind="audio".into(); clip.source_id=Some("s".into()); clip.source_start_sample=Some(0); clip.sample_rate=Some(48000);
        doc.manifest.graph.as_mut().unwrap().positions.push(AafSourcePosition {track_id:"10".into(),clip_index:0,numerator:0,denominator:1});
        create(&root,&doc).unwrap();
        let mut user_labels=doc.labels.clone(); user_labels[0].owner_name="Edited while checking".into(); labels(&root,&doc.id,user_labels).unwrap();
        let key=cache_key(&doc,"10","commit");
        let mut pending=doc.clone();
        pending.manifest.graph.as_mut().unwrap().sources[1].status="ready".into();
        pending.manifest.graph.as_mut().unwrap().sources[1].resolved=source.resolved;
        assert_eq!(key,cache_key(&pending,"10","commit"));
        let saved=save_graph(&root,&pending,&cache_key(&doc,"all","relink")).unwrap();
        assert_eq!(saved.labels[0].owner_name,"Edited while checking");
        let transcript=AafTrackTranscript {track_id:"10".into(),engine:AafEngine::Whisper,model_id:"committed during resolution".into(),start_frame:0,duration_frames:240,status:AafTranscriptStatus::Empty,sample_rate:16000,cues:vec![],timing_issues:vec![],warnings:vec![]};
        save_transcript(&root,&doc,transcript).unwrap();
        pending.manifest.graph.as_mut().unwrap().sources[1].status="offline".into();
        let last=save_graph(&root,&pending,&cache_key(&saved,"all","relink")).unwrap();
        // Stop here: only these checkpoints exist on disk; no stale full
        // document write can remove the independent transcription or label.
        assert_eq!(last.transcripts.len(),1); assert_eq!(last.labels[0].owner_name,"Edited while checking");
        assert_eq!(load(&root,&doc.id).unwrap().transcripts[0].model_id,"committed during resolution");
        pending.manifest.tracks[0].clips[0].source_start_sample=Some(1);
        assert_ne!(key,cache_key(&pending,"10","commit"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refreshing_an_old_graph_preserves_labels_results_and_server_mappings() {
        let mut doc=with_graph(fixture());
        let source: AafSource=serde_json::from_value(serde_json::json!({"id":"s","mob_id":"mob","slot_id":3,"locators":[],"ancestors":[],"channel":0,"channels":1,"sample_rate":48000,"sample_width":3,"sample_count":96000,"descriptor":"PCMDescriptor","status":"ready",
            "resolved":{"path":"/tmp/audio.mxf","fingerprint":"a".repeat(64),"stream_index":1,"size":576000,"modified_ms":1}})).unwrap();
        doc.manifest.graph.as_mut().unwrap().sources.push(source);
        doc.manifest.graph.as_mut().unwrap().path_mappings.push(AafPathMapping {from:"/Show/MXF".into(),to:"/Volumes/Renamed/MXF".into(),authority:Some("nexis".into())});
        doc.labels[0].owner_name="Edited owner".into();
        let clip=&mut doc.manifest.tracks[0].clips[0]; clip.kind="audio".into(); clip.source_id=Some("s".into());
        doc.transcripts.push(AafTrackTranscript {track_id:"10".into(),start_frame:0,duration_frames:240,engine:AafEngine::Whisper,model_id:"saved".into(),status:AafTranscriptStatus::Empty,sample_rate:16000,cues:vec![],timing_issues:vec![],warnings:vec![]});
        let mut fresh=doc.manifest.clone(); fresh.schema_version=SCHEMA_VERSION; fresh.graph.as_mut().unwrap().path_mappings.clear();
        fresh.graph.as_mut().unwrap().sources[0].resolved=None;
        upgrade_graph(&mut doc,fresh.clone()).unwrap();
        assert_eq!(doc.labels[0].owner_name,"Edited owner"); assert_eq!(doc.transcripts.len(),1);
        assert!(doc.manifest.graph.as_ref().unwrap().sources[0].resolved.is_some());
        assert_eq!(doc.manifest.graph.as_ref().unwrap().path_mappings.len(),1);
        let revision=cache_key(&doc,"all","relink");
        doc.manifest.graph.as_mut().unwrap().path_mappings[0].to="/Volumes/Other/MXF".into();
        assert_ne!(revision,cache_key(&doc,"all","relink"));
        fresh.graph.as_mut().unwrap().sources[0].channels=2;
        upgrade_graph(&mut doc,fresh).unwrap();
        assert!(doc.manifest.graph.as_ref().unwrap().sources[0].resolved.is_none());
        assert_eq!(doc.transcripts[0].model_id,"saved"); assert_eq!(doc.transcripts[0].warnings.len(),1);
        let mut changed=doc.manifest.clone(); changed.tracks[0].id="different".into(); changed.graph.as_mut().unwrap().lanes[0].track_id="different".into();
        assert!(upgrade_graph(&mut doc,changed).is_err()); assert_eq!(doc.labels[0].owner_name,"Edited owner");
    }
}
