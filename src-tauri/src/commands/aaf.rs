//! Local, read-only AAF import and microphone-track transcription.
//! Existing Clip/Review playback and global transcription commands are untouched.
mod audio;
/// Settings counts and clears AAF Audio's playback windows by this name.
pub(crate) use audio::is_playback_file;
mod diagnostics;
pub use diagnostics::*;
mod health;
pub use health::*;
mod pcm;
mod peaks;
mod linked;
mod linked_paths;
mod linked_probe;
mod linked_audio;
mod local_read;
mod mxf_header;
pub mod model;
pub mod ownership;
pub mod voices;
mod process;
pub(crate) mod store;
mod transcribe;

use crate::{commands::JobRegistry, AppError};
use model::*;
use tauri::{AppHandle, Manager, Emitter};

#[tauri::command]
pub async fn aaf_import(app: AppHandle, path: String, job_id: String, sequence_id: Option<String>) -> Result<AafDocument, AppError> {
    diagnostics::operation(&app, &job_id, "import", &diagnostics::describe_path(std::path::Path::new(&path)), async {
    let _job = process::JobGuard::begin(&app, &job_id)?;
    let source = std::fs::canonicalize(path)?;
    if source.extension().is_none_or(|extension| !extension.to_string_lossy().eq_ignore_ascii_case("aaf")) {
        return Err(AppError::invalid("Choose an Avid AAF file"));
    }
    let metadata = std::fs::metadata(&source)?;
    if !metadata.is_file() { return Err(AppError::invalid("Choose an AAF file, not a folder")); }
    process::progress(&app, &job_id, None, "inspecting", 0, 0);
    let local = local_read::for_parser(&app, &job_id, &source).await?;
    let mut args = vec!["inspect".into(), "--graph".into(), "--input".into(), local.to_string_lossy().into_owned()];
    if let Some(sequence) = sequence_id { args.extend(["--sequence".into(), sequence]); }
    let result = process::run(&app, &job_id, "inspect", "saucebunny-aaf", args).await?;
    result.require_success("saucebunny-aaf")?;
    let manifest: AafManifest = serde_json::from_str(&result.stdout)
        .map_err(|e| AppError::invalid(format!("AAF reader returned an invalid manifest: {e}")))?;
    validate_manifest(&manifest)?;
    let root = store::root(&app)?;
    let labels = manifest.tracks.iter().map(|track| AafTrackLabel {
        track_id: track.id.clone(), owner_name: if track.name.trim().is_empty() { format!("Track {}", track.id) } else { track.name.clone() },
        cast_member_id: None, color: None, gender: None, marker_color: None,
    }).collect();
    let id = blake3::hash(crate::stream_proxy::mint_token()?.as_bytes()).to_hex().to_string();
    let document = AafDocument { schema_version: DOCUMENT_SCHEMA_VERSION, shoot_date_override: None, ownership: None, id,
        source_path: source.to_string_lossy().into_owned(), source_size: metadata.len(),
        source_modified_ms: store::modified_ms(&metadata), manifest, labels, transcripts: Vec::new() };
    store::source_ready(&document)?;
    // Reopen an unchanged document (including all committed transcripts) or
    // commit the offline timeline before any linked-media I/O begins.
    let registry = app.state::<JobRegistry>();
    let document = store::import_gated(&root, document, &|commit| registry.while_active(&job_id, commit))?;
    let _ = app.emit("saucebunny:multitrack-changed", &document.id);
    diagnostics::log(&app, &job_id, "ok", "saved", &format!("Timeline saved: {} · {} lanes · {} committed transcripts", document.manifest.name, document.manifest.tracks.len(), document.transcripts.len()));
    Ok(document)
    }).await
}

#[tauri::command]
pub async fn aaf_sequences(app: AppHandle, path: String, job_id: String) -> Result<Vec<AafSequenceChoice>, AppError> {
    diagnostics::operation(&app, &job_id, "sequences", &diagnostics::describe_path(std::path::Path::new(&path)), async {
    let _job = process::JobGuard::begin(&app, &job_id)?;
    let local = local_read::for_parser(&app, &job_id, &std::fs::canonicalize(&path)?).await?;
    let result = process::run(&app, &job_id, "sequences", "saucebunny-aaf", vec!["sequences".into(), "--input".into(), local.to_string_lossy().into_owned()]).await?;
    result.require_success("saucebunny-aaf")?;
    Ok(serde_json::from_str(&result.stdout)?)
    }).await
}

#[tauri::command]
pub async fn aaf_resolve_media(app: AppHandle, document_id: String, source_id: Option<String>, path: Option<String>, job_id: String) -> Result<AafDocument, AppError> {
    diagnostics::operation(&app, &job_id, "relink", &format!("Document {document_id} · source {} · {}", source_id.as_deref().unwrap_or("all"), path.as_deref().unwrap_or("refresh known paths")), async {
    let _job = process::JobGuard::begin(&app, &job_id)?;
    let _resolution = process::ResolutionGuard::begin(&document_id)?;
    let root = store::root(&app)?;
    let mut document = store::load(&root, &document_id)?;
    let mut revision = store::cache_key(&document, "all", "relink");
    store::source_ready(&document)?;
    if document.manifest.schema_version < SCHEMA_VERSION {
        if let Some(graph) = &document.manifest.graph {
            let local = local_read::for_parser(&app, &job_id, std::path::Path::new(&document.source_path)).await?;
            let result = process::run(&app, &job_id, "refresh-aaf-graph", "saucebunny-aaf", vec![
                "inspect".into(), "--graph".into(), "--input".into(), local.to_string_lossy().into_owned(),
                "--sequence".into(), graph.sequence_id.clone(), "--expected-fingerprint".into(), document.manifest.source_fingerprint.clone()]).await?;
            result.require_success("saucebunny-aaf")?;
            store::upgrade_graph(&mut document, serde_json::from_str(&result.stdout)?)?;
        }
    }
    let mut checkpoint = document.clone();
    linked::resolve(&app, &mut document, source_id.as_deref(), path.as_deref().map(std::path::Path::new), &job_id, |graph| {
        checkpoint.manifest.graph = Some(graph.clone());
        store::source_ready(&checkpoint)?;
        // Merge graph-only changes into the latest document. Concurrent label
        // edits/transcription commits survive; a competing relink is rejected.
        let registry = app.state::<JobRegistry>();
        let saved = store::save_graph_gated(&root, &checkpoint, &revision, &|commit| registry.while_active(&job_id, commit))?;
        revision = store::cache_key(&saved, "all", "relink");
        let _ = app.emit("saucebunny:multitrack-changed", &document_id);
        Ok(())
    }).await?;
    store::load(&root, &document_id)
    }).await
}

#[tauri::command]
pub async fn aaf_open(app: AppHandle, document_id: String) -> Result<AafDocument, AppError> {
    diagnostics::operation(&app, &diagnostics::new_id(), "open", &format!("Open saved document {document_id}"), async {
        store::load(&store::root(&app)?, &document_id)
    }).await
}

#[tauri::command]
pub async fn aaf_list(app: AppHandle) -> Result<Vec<AafDocumentSummary>, AppError> {
    store::shelf(&store::root(&app)?)
}

#[tauri::command]
pub async fn aaf_save_labels(app: AppHandle, document_id: String, labels: Vec<AafTrackLabel>) -> Result<AafDocument, AppError> {
    let document = store::labels(&store::root(&app)?, &document_id, labels)?;
    let _ = app.emit("saucebunny:multitrack-changed", &document_id);
    Ok(document)
}

#[tauri::command]
pub async fn aaf_save_shoot_date(app: AppHandle, document_id: String, shoot_date: Option<String>) -> Result<AafDocument, AppError> {
    let document = store::metadata(&store::root(&app)?, &document_id, shoot_date, None)?;
    let _ = app.emit("saucebunny:multitrack-changed", &document_id);
    Ok(document)
}

#[tauri::command]
pub async fn aaf_read_recording_dates(app: AppHandle, document_id: String, job_id: String) -> Result<AafDocument, AppError> {
    diagnostics::operation(&app, &job_id, "dates", &format!("Read recording dates · document {document_id}"), async {
    let _job = process::JobGuard::begin(&app, &job_id)?;
    let root = store::root(&app)?;
    let document = store::load(&root, &document_id)?;
    store::source_ready(&document)?;
    let local = local_read::for_parser(&app, &job_id, std::path::Path::new(&document.source_path)).await?;
    let mut args = vec!["inspect".into(), "--input".into(), local.to_string_lossy().into_owned()];
    if let Some(graph) = &document.manifest.graph { args.extend(["--graph".into(), "--sequence".into(), graph.sequence_id.clone()]); }
    let result = process::run(&app, &job_id, "inspect", "saucebunny-aaf", args).await?;
    result.require_success("saucebunny-aaf")?;
    let manifest: AafManifest = serde_json::from_str(&result.stdout)?;
    validate_manifest(&manifest)?;
    store::source_ready(&document)?;
    if manifest.source_fingerprint != document.manifest.source_fingerprint { return Err(AppError::invalid("The AAF changed. Import it again.")); }
    let registry = app.state::<JobRegistry>();
    let document = store::metadata_gated(&root, &document_id, None, Some(manifest.recording_dates.unwrap_or_default()), &|commit| registry.while_active(&job_id, commit))?;
    let _ = app.emit("saucebunny:multitrack-changed", &document_id);
    Ok(document)
    }).await
}

#[tauri::command]
pub async fn aaf_prepare_audio(app: AppHandle, document_id: String, track_id: String,
    start_frame: i64, duration_frames: i64, job_id: String) -> Result<AafAudioAsset, AppError>
{
    diagnostics::operation(&app, &job_id, "audio", &format!("Prepare document {document_id} · track {track_id} · frames {start_frame} + {duration_frames}"), async {
    let _job = process::JobGuard::begin(&app, &job_id)?;
    let document = store::playback_document(&store::root(&app)?, &document_id)?;
    audio::prepare(&app, &document, &track_id, start_frame, duration_frames, &job_id).await
    }).await
}

#[tauri::command]
pub async fn aaf_waveform(app: AppHandle, document_id: String, track_id: String, job_id: String,
    start_frame: Option<i64>, duration_frames: Option<i64>) -> Result<AafWaveform, AppError> {
    diagnostics::operation(&app, &job_id, "waveform", &format!("Waveform · document {document_id} · track {track_id}"), async {
    let _job = process::JobGuard::begin(&app, &job_id)?;
    let document = store::load(&store::root(&app)?, &document_id)?;
    match (start_frame, duration_frames) {
        (None, None) => peaks::waveform(&app, &document, &track_id, 0, document.manifest.duration_frames, true, &job_id).await,
        (Some(start), Some(duration)) => {
            if start < 0 || duration <= 0 || start.checked_add(duration).is_none_or(|end| end > document.manifest.duration_frames) {
                return Err(AppError::invalid("Waveform interval is outside the sequence"));
            }
            peaks::waveform(&app, &document, &track_id, start, duration, false, &job_id).await
        },
        _ => Err(AppError::invalid("Waveform detail requires both a start and duration")),
    }
    }).await
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn aaf_transcribe_track(app: AppHandle, document_id: String, track_id: String,
    start_frame: i64, duration_frames: i64, engine: AafEngine, model_id: String,
    language: String, fast: bool, speech_only: Option<bool>, cast_names: Option<bool>, job_id: String) -> Result<AafTrackTranscript, AppError>
{
    diagnostics::operation(&app, &job_id, "transcribe", &format!("Transcribe document {document_id} · track {track_id} · model {model_id} · frames {start_frame} + {duration_frames} · fast {fast} · speech filter {}", speech_only.unwrap_or(false)), async {
    let _job = process::JobGuard::begin(&app, &job_id)?;
    let document = store::load(&store::root(&app)?, &document_id)?;
    super::video_intelligence::yield_video_background(&app);
    transcribe::transcribe(&app, &document, &track_id, start_frame, duration_frames, engine, &model_id, &language, fast, speech_only.unwrap_or(false), cast_names.unwrap_or(false), &job_id).await
    }).await
}

/// Speech analysis for one track: where its mic is open, loud moments no word
/// covers, and word boundaries inside its saved transcript's cues. Reads the
/// waveform overview; never decodes again. With `build` false a track whose
/// overview does not exist yet gets its words placed by length alone
/// (`measured: false`) rather than an hours-long build nobody asked for.
#[tauri::command]
pub async fn aaf_speech(app: AppHandle, document_id: String, track_id: String, build: bool, job_id: String) -> Result<crate::speech::AafSpeech, AppError> {
    diagnostics::operation(&app, &job_id, "speech", &format!("Speech analysis · document {document_id} · track {track_id} · build {build}"), async {
    let _job = process::JobGuard::begin(&app, &job_id)?;
    let document = store::load(&store::root(&app)?, &document_id)?;
    let cues: Vec<crate::speech::CueInput> = document.transcripts.iter().filter(|transcript| transcript.track_id == track_id)
        .flat_map(|transcript| transcript.cues.iter())
        .map(|cue| crate::speech::CueInput { id: &cue.id, start_sample: cue.start_sample, end_sample: cue.end_sample, text: &cue.text, words: cue.words.as_deref() })
        .collect();
    store::track(&document, &track_id)?;
    let path = peaks::overview_path(&app, &document, &track_id)?;
    if build { peaks::waveform(&app, &document, &track_id, 0, document.manifest.duration_frames, true, &job_id).await?; }
    else if !path.is_file() { return Ok(crate::speech::unmeasured(&track_id, &cues)); }
    let read = tauri::async_runtime::spawn_blocking(move || peaks::read_base(&path)).await
        .map_err(|e| AppError::internal(e.to_string()))?;
    match read {
        Ok((pairs, hz, bucket)) => Ok(crate::speech::analyse(&track_id, &pairs, hz, bucket, &cues)),
        // A damaged cache is only worth an error when a build was asked for.
        Err(_) if !build => Ok(crate::speech::unmeasured(&track_id, &cues)),
        Err(error) => Err(error),
    }
    }).await
}

/// Owner, bleed or overtalk for every transcribed word in the document
/// (accuracy spec, phase 3). With `build` false, mics with no waveform yet are
/// left unlabelled rather than read again; with it true they are measured.
#[tauri::command]
pub async fn aaf_ownership(app: AppHandle, document_id: String, build: bool, job_id: String) -> Result<ownership::AafOwnership, AppError> {
    diagnostics::operation(&app, &job_id, "ownership", &format!("Bleed labels · document {document_id} · build {build}"), async {
        let _job = process::JobGuard::begin(&app, &job_id)?;
        ownership::resolve(&app, &document_id, build, &job_id).await.map(ownership::for_page)
    }).await
}

/// Learn each mic owner's voice and settle the words the bleed resolver was
/// unsure of (accuracy spec, phase 4). Reads short clips of the mics, so it
/// runs only when asked; Stop reaches it through the job id.
#[tauri::command]
pub async fn aaf_check_voices(app: AppHandle, document_id: String, job_id: String) -> Result<ownership::AafOwnership, AppError> {
    diagnostics::operation(&app, &job_id, "voices", &format!("Voice check · document {document_id}"), async {
        let _job = process::JobGuard::begin(&app, &job_id)?;
        voices::check(&app, &document_id, &job_id).await.map(ownership::for_page)
    }).await
}

#[derive(Debug, Clone, serde::Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct VoiceprintSummary { pub documents: u32, pub voices: u32 }

/// Whether bleed is left out of All voices, String Outs and an assistant's
/// search. Off until the editor turns it on.
#[tauri::command]
pub fn bleed_hidden(app: AppHandle) -> Result<bool, AppError> {
    let app_data = app.path().app_data_dir().map_err(|e| AppError::internal(e.to_string()))?;
    Ok(ownership::hides_bleed(&app_data))
}

#[tauri::command]
pub fn set_bleed_hidden(app: AppHandle, hide: bool) -> Result<(), AppError> {
    let app_data = app.path().app_data_dir().map_err(|e| AppError::internal(e.to_string()))?;
    ownership::set_hides_bleed(&app_data, hide)
}

/// How many voiceprints are kept, for Settings.
#[tauri::command]
pub fn voiceprints_summary(app: AppHandle) -> Result<VoiceprintSummary, AppError> {
    let app_data = app.path().app_data_dir().map_err(|e| AppError::internal(e.to_string()))?;
    let (documents, voices) = voices::summary(&app_data);
    Ok(VoiceprintSummary { documents, voices })
}

/// Delete every learned voice. The labels they settled go with them: each
/// document's bleed labels are computed again without them on next open.
#[tauri::command]
pub fn delete_voiceprints(app: AppHandle) -> Result<(), AppError> {
    let app_data = app.path().app_data_dir().map_err(|e| AppError::internal(e.to_string()))?;
    let dir = voices::dir(&app_data);
    if dir.exists() { std::fs::remove_dir_all(&dir)?; }
    Ok(())
}

/// The editor's own call on one cue (Owner or Bleed), or None to go back to
/// the resolver's. Stored in the document and wins over the resolver.
#[tauri::command]
pub async fn aaf_set_cue_ownership(app: AppHandle, document_id: String, track_id: String, cue_id: String,
    label: Option<crate::bleed::AafOwnershipLabel>, heard_on: Option<String>) -> Result<AafDocument, AppError> {
    let document = store::set_ownership(&store::root(&app)?, &document_id, &track_id, &cue_id, label, heard_on)?;
    let _ = app.emit("saucebunny:multitrack-changed", &document_id);
    Ok(document)
}

/// Write an edit's head as a new AAF for Media Composer (`write-edit`). The
/// sidecar re-reads what it wrote and compares every frame before publishing,
/// and never overwrites a file.
#[tauri::command]
pub async fn aaf_export_edit(app: AppHandle, edit_id: String, output_path: String, approach: String, job_id: String) -> Result<crate::edit_export::EditExportResult, AppError> {
    diagnostics::operation(&app, &job_id, "export-edit", &format!("Export edit {edit_id} · {}", diagnostics::describe_path(std::path::Path::new(&output_path))), async {
    let _job = process::JobGuard::begin(&app, &job_id)?;
    let document = crate::commands::edits::head_document(&app, &edit_id)?;
    let sources = export_sources(&app, &job_id, &document, &mut Default::default()).await?;
    let request = writer_request(&app, &document, &sources, &approach, &output_path)?;
    Ok(serde_json::from_str(&run_writer(&app, &job_id, "write-edit", &request).await?)?)
    }).await
}

/// Several edits' heads, one AAF each, into `output_dir`, from ONE run of the
/// sidecar (`write-edits`): each source AAF is opened once and its group pack
/// built at most once. Each file is named from its edit's title as the single
/// export's dialog would name it, with " 2", " 3" and on when that name is
/// taken; nothing is overwritten. An edit that cannot be written is reported
/// in its place and the others are written anyway. Stop ends the whole batch.
#[tauri::command]
pub async fn aaf_export_edits(app: AppHandle, edit_ids: Vec<String>, output_dir: String, approach: String, job_id: String) -> Result<Vec<crate::edit_export::EditExportOutcome>, AppError> {
    use crate::edit_export::{batch_outcomes, export_stem, unique_stem, EditExportOutcome};
    diagnostics::operation(&app, &job_id, "export-edits", &format!("Export {} edits · {}", edit_ids.len(), diagnostics::describe_path(std::path::Path::new(&output_dir))), async {
    let _job = process::JobGuard::begin(&app, &job_id)?;
    let folder = std::path::Path::new(&output_dir);
    if !folder.is_absolute() || !folder.is_dir() { return Err(AppError::invalid("Choose an existing folder to export into.")); }
    if edit_ids.is_empty() { return Err(AppError::invalid("Choose at least one string out to export.")); }
    let mut outcomes: Vec<Option<EditExportOutcome>> = vec![None; edit_ids.len()];
    let (mut requests, mut sent, mut placed) = (Vec::new(), Vec::new(), Vec::new());
    let mut taken = std::collections::HashSet::new();
    let mut known = std::collections::HashMap::new();
    for (index, edit_id) in edit_ids.iter().enumerate() {
        let request = async {
            let document = crate::commands::edits::head_document(&app, edit_id)?;
            let sources = export_sources(&app, &job_id, &document, &mut known).await?;
            // Free on disk (the AAF and its marker list) and not chosen by an
            // earlier edit of this batch. Lowercased: APFS is usually case-blind.
            let stem = unique_stem(&export_stem(&document.title), |stem| !taken.contains(&stem.to_lowercase())
                && std::fs::symlink_metadata(folder.join(format!("{stem}.aaf"))).is_err()
                && std::fs::symlink_metadata(folder.join(format!("{stem} - Avid markers.txt"))).is_err())?;
            taken.insert(stem.to_lowercase());
            let output = folder.join(format!("{stem}.aaf"));
            writer_request(&app, &document, &sources, &approach, &output.to_string_lossy())
        }.await;
        match request {
            Ok(request) => { requests.push(request); sent.push(edit_id.clone()); placed.push(index); }
            Err(AppError::Cancelled) => return Err(AppError::Cancelled),
            Err(error) => outcomes[index] = Some(EditExportOutcome::failed(edit_id, error.to_string())),
        }
    }
    if !requests.is_empty() {
        let batch = serde_json::json!({ "schema_version": 1, "edits": requests });
        let written = batch_outcomes(&sent, &run_writer(&app, &job_id, "write-edits", &batch).await?)?;
        for (index, outcome) in placed.into_iter().zip(written) { outcomes[index] = Some(outcome); }
    }
    Ok(outcomes.into_iter().flatten().collect())
    }).await
}

/// What the writer needs from each AAF an edit cuts from. `known` keeps one
/// answer per imported AAF across the edits of a batch, so each document is
/// loaded and each source copied locally once.
async fn export_sources(app: &AppHandle, job_id: &str, document: &crate::edit_doc::EditDocument,
    known: &mut std::collections::HashMap<String, crate::edit_export::ExportSource>) -> Result<Vec<crate::edit_export::ExportSource>, AppError>
{
    let root = store::root(app)?;
    let mut sources = Vec::new();
    for source in &document.sources {
        if let Some(found) = known.get(&source.document_id) {
            sources.push(crate::edit_export::ExportSource { id: source.id.clone(), ..found.clone() });
            continue;
        }
        let aaf = store::load(&root, &source.document_id)?;
        store::source_ready(&aaf)?;
        let graph = aaf.manifest.graph.as_ref().ok_or_else(|| AppError::invalid(format!(
            "{} was imported before sequences could be written back. Import its AAF again, then export.", aaf.manifest.name)))?;
        // The writer reads the source AAF the way import does: from a verified
        // local copy with the original's fingerprint, not sector by sector
        // over NEXIS, where a large AAF could run into the stage limit.
        let local = local_read::for_parser(app, job_id, std::path::Path::new(&aaf.source_path)).await?;
        // V1 when it has picture, else the first track that does: the same
        // track String Outs draws, so the export carries the picture shown.
        let picture = graph.picture_tracks.iter().find(|track| track.physical_track_number == Some(1) && !track.clips.is_empty())
            .or_else(|| graph.picture_tracks.iter().find(|track| !track.clips.is_empty()));
        // Group angles, so a person who is an alternate can have a track of
        // their own that plays their mic (edit_export::build_request). Owners
        // as String Outs names people: the mic owner label, else the track name.
        let owner = |id: &str| aaf.labels.iter().find(|label| label.track_id == id).map(|label| label.owner_name.trim().to_string())
            .filter(|name| !name.is_empty())
            .or_else(|| aaf.manifest.tracks.iter().find(|track| track.id == id).map(|track| track.name.trim().to_string()))
            .unwrap_or_else(|| id.to_string());
        let lanes: Vec<crate::edit_export::GroupLane> = graph.lanes.iter().map(|lane| (lane.track_id.as_str(), lane.parent_track_id.as_deref(),
            lane.branch_id.as_deref(), owner(&lane.track_id))).collect();
        let alternates = crate::edit_export::alternates_of(&lanes);
        let found = crate::edit_export::ExportSource { id: source.id.clone(), aaf_path: local.to_string_lossy().into_owned(),
            sequence_id: graph.sequence_id.clone(), picture_slot: picture.map(|track| track.slot_id), alternates };
        known.insert(source.document_id.clone(), found.clone());
        sources.push(found);
    }
    Ok(sources)
}

/// The writer's request for one edit, with the folder where it keeps group
/// packs (`scratch/aaf-packs`): the first export of a grouped source writes
/// the closure of its group clips there once, and later exports copy it
/// rather than the whole show again (aaf-sidecar/writer.py).
fn writer_request(app: &AppHandle, document: &crate::edit_doc::EditDocument, sources: &[crate::edit_export::ExportSource],
    approach: &str, output_path: &str) -> Result<serde_json::Value, AppError>
{
    let mut request = crate::edit_export::build_request(document, sources, approach, output_path)?;
    let cache = app.path().app_cache_dir().map_err(|e| AppError::internal(format!("app_cache_dir: {e}")))?;
    request["pack_dir"] = serde_json::json!(crate::commands::system::aaf_packs_dir(&cache).to_string_lossy());
    Ok(request)
}

/// Run one of the sidecar's writing commands on a request, through a file in
/// scratch that is removed afterwards. Returns the sidecar's answer.
async fn run_writer(app: &AppHandle, job_id: &str, command: &str, request: &serde_json::Value) -> Result<String, AppError> {
    let cache = app.path().app_cache_dir().map_err(|e| AppError::internal(format!("app_cache_dir: {e}")))?;
    let request_path = crate::commands::scratch_dir(&cache).join(format!("{command}-{job_id}.json"));
    std::fs::write(&request_path, serde_json::to_vec(request)?)?;
    process::progress(app, job_id, None, "writing", 0, 0);
    let result = process::run(app, job_id, command, "saucebunny-aaf",
        vec![command.into(), "--request".into(), request_path.to_string_lossy().into_owned()]).await;
    let _ = std::fs::remove_file(&request_path);
    let result = result?;
    result.require_success("saucebunny-aaf")?;
    Ok(result.stdout)
}

#[cfg(test)]
mod native_reader_tests {
    use super::*;
    #[test]
    #[ignore = "requires the real bundled reader, ffmpeg, and SB_AAF_REAL_INPUT"]
    fn actual_reader_manifest_and_pcm_match_the_rust_contract() {
        let source = std::env::var("SB_AAF_REAL_INPUT").expect("Set SB_AAF_REAL_INPUT to a read-only test AAF");
        let reader = crate::commands::sidecar_path("saucebunny-aaf").unwrap();
        let result = std::process::Command::new(&reader).args(["inspect", "--input", &source]).output().unwrap();
        assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
        let manifest: AafManifest = serde_json::from_slice(&result.stdout).unwrap();
        validate_manifest(&manifest).unwrap();
        let metadata = std::fs::metadata(&source).unwrap();
        store::source_ready(&AafDocument { schema_version: 1, shoot_date_override: None, ownership: None, id: "f".repeat(64), source_path: source.clone(),
            source_size: metadata.len(), source_modified_ms: store::modified_ms(&metadata),
            manifest: manifest.clone(), labels: Vec::new(), transcripts: Vec::new() }).unwrap();
        let track = manifest.tracks.first().expect("test must inspect at least one track");
        let root = std::env::temp_dir().join(format!("aaf-native-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let raw = root.join("raw.wav");
        let peaks = root.join("peaks.json");
        let duration = i64::from(manifest.timecode_fps).min(manifest.duration_frames);
        let result = std::process::Command::new(reader).args(["extract", "--input", &source,
            "--track", &track.id, "--start-frame", "0", "--duration-frames", &duration.to_string(),
            "--expected-fingerprint", &manifest.source_fingerprint,
            "--output", raw.to_str().unwrap(), "--peaks-output", peaks.to_str().unwrap()]).output().unwrap();
        assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
        let wav = root.join("audio.wav");
        let args = crate::commands::transcript::wav_16k_mono_args(raw.to_str().unwrap(), None, wav.to_str().unwrap());
        let result = std::process::Command::new(crate::commands::sidecar_path("ffmpeg").unwrap()).args(args).output().unwrap();
        assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
        let info = audio::inspect_wav(&wav).unwrap();
        let expected = frame_samples(duration, &manifest.edit_rate).unwrap();
        assert!((info.sample_count - expected).abs() <= 2);
        let peaks_json: serde_json::Value = store::read_json(&peaks).unwrap();
        assert!(peaks_json["peaks"].as_array().unwrap().len() > 1);
        std::fs::remove_dir_all(root).unwrap();
    }
}
