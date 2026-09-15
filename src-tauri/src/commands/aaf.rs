//! Local, read-only AAF import and microphone-track transcription.
//! Existing Clip/Review playback and global transcription commands are untouched.
mod audio;
mod pcm;
mod peaks;
pub mod model;
mod process;
mod store;
mod transcribe;

use crate::{commands::JobRegistry, AppError};
use model::*;
use tauri::{AppHandle, Manager};

#[tauri::command]
pub async fn aaf_import(app: AppHandle, path: String, job_id: String) -> Result<AafDocument, AppError> {
    let _job = process::JobGuard::begin(&app, &job_id)?;
    let source = std::fs::canonicalize(path)?;
    if source.extension().is_none_or(|extension| !extension.to_string_lossy().eq_ignore_ascii_case("aaf")) {
        return Err(AppError::invalid("Choose an Avid AAF file"));
    }
    let metadata = std::fs::metadata(&source)?;
    if !metadata.is_file() { return Err(AppError::invalid("Choose an AAF file, not a folder")); }
    process::progress(&app, &job_id, None, "inspecting", 0, 0);
    let result = process::run(&app, &job_id, "inspect", "saucebunny-aaf",
        vec!["inspect".into(), "--input".into(), source.to_string_lossy().into_owned()]).await?;
    result.require_success("saucebunny-aaf")?;
    let manifest: AafManifest = serde_json::from_str(&result.stdout)
        .map_err(|e| AppError::invalid(format!("AAF reader returned an invalid manifest: {e}")))?;
    validate_manifest(&manifest)?;
    let labels = manifest.tracks.iter().map(|track| AafTrackLabel {
        track_id: track.id.clone(), owner_name: if track.name.trim().is_empty() { format!("Track {}", track.id) } else { track.name.clone() },
        cast_member_id: None, color: None,
    }).collect();
    let id = blake3::hash(crate::stream_proxy::mint_token()?.as_bytes()).to_hex().to_string();
    let document = AafDocument { schema_version: SCHEMA_VERSION, id,
        source_path: source.to_string_lossy().into_owned(), source_size: metadata.len(),
        source_modified_ms: store::modified_ms(&metadata), manifest, labels, transcripts: Vec::new() };
    store::source_ready(&document)?;
    let root = store::root(&app)?;
    app.state::<JobRegistry>().while_active(&job_id, || store::create(&root, &document))?;
    Ok(document)
}

#[tauri::command]
pub async fn aaf_open(app: AppHandle, document_id: String) -> Result<AafDocument, AppError> {
    store::load(&store::root(&app)?, &document_id)
}

#[tauri::command]
pub async fn aaf_list(app: AppHandle) -> Result<Vec<AafDocumentSummary>, AppError> {
    store::list(&store::root(&app)?)
}

#[tauri::command]
pub async fn aaf_save_labels(app: AppHandle, document_id: String, labels: Vec<AafTrackLabel>) -> Result<AafDocument, AppError> {
    store::labels(&store::root(&app)?, &document_id, labels)
}

#[tauri::command]
pub async fn aaf_prepare_audio(app: AppHandle, document_id: String, track_id: String,
    start_frame: i64, duration_frames: i64, job_id: String) -> Result<AafAudioAsset, AppError>
{
    let _job = process::JobGuard::begin(&app, &job_id)?;
    let document = store::load(&store::root(&app)?, &document_id)?;
    audio::prepare(&app, &document, &track_id, start_frame, duration_frames, &job_id).await
}

#[tauri::command]
pub async fn aaf_waveform(app: AppHandle, document_id: String, track_id: String, job_id: String,
    start_frame: Option<i64>, duration_frames: Option<i64>) -> Result<AafWaveform, AppError> {
    let _job = process::JobGuard::begin(&app, &job_id)?;
    let document = store::load(&store::root(&app)?, &document_id)?;
    match (start_frame, duration_frames) {
        (None, None) => peaks::waveform(&app, &document, &track_id, 0, document.manifest.duration_frames, &job_id).await,
        (Some(start), Some(duration)) => {
            if start < 0 || duration <= 0 || start.checked_add(duration).is_none_or(|end| end > document.manifest.duration_frames) {
                return Err(AppError::invalid("Waveform interval is outside the sequence"));
            }
            peaks::waveform(&app, &document, &track_id, start, duration, &job_id).await
        },
        _ => Err(AppError::invalid("Waveform detail requires both a start and duration")),
    }
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn aaf_transcribe_track(app: AppHandle, document_id: String, track_id: String,
    start_frame: i64, duration_frames: i64, engine: AafEngine, model_id: String,
    language: String, fast: bool, job_id: String) -> Result<AafTrackTranscript, AppError>
{
    let _job = process::JobGuard::begin(&app, &job_id)?;
    let document = store::load(&store::root(&app)?, &document_id)?;
    transcribe::transcribe(&app, &document, &track_id, start_frame, duration_frames, engine, &model_id, &language, fast, &job_id).await
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
        store::source_ready(&AafDocument { schema_version: 1, id: "f".repeat(64), source_path: source.clone(),
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
