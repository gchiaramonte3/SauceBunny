//! Transcription commands — Whisper (speech-to-text) + diarizer
//! (speaker labeling) pipelines.
//!
//! Lives here:
//!   - Whisper model management: list / download / delete + the
//!     `WHISPER_MODELS` registry.
//!   - URL-source transcription pipeline: `generate_transcript`
//!     (yt-dlp → wav → whisper-cli → optional diarizer-merge).
//!   - Local-source transcription: `transcribe_prepared_wav`,
//!     `transcribe_local_file`.
//!   - Diarizer wrapping: `probe_diarizer`,
//!     `prepare_diarizer_models`, plus the SRT merge logic
//!     (`merge_diarization_into_srt`, `run_diarize_and_merge`).
//!   - Whisper output parsers (`parse_whisper_segment_end`, etc.) +
//!     `TranscriptPhaseEvent` for the pipeline phase UI.
//!
//! Shared cross-module helpers stay in mod.rs.
//!
//! Extracted from the 4155-line commands.rs monolith in r47 per the
//! constitution's refactor priority #1.

use super::*;

/// Stage marker emitted at well-known transitions in the transcript
/// pipeline. The Sidebar reads these to label the progress bar
/// ("Whisper" → "Diarize" → "Merge") instead of scraping log strings.
///
/// Known phases (extensible):
///   "whisper"          — whisper-cli is running
///   "diarize-prepare"  — FluidAudio loading / downloading Core ML models
///   "diarize-process"  — diarization is running on the audio
///   "diarize-merge"    — stitching speaker labels into the SRT
#[derive(Serialize, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub(crate) struct TranscriptPhaseEvent {
    pub(crate) job_id: String,
    pub(crate) phase: String,
}

// ============================================================
// WHISPER LOCAL TRANSCRIPTION
// ============================================================

#[derive(Serialize, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct WhisperModel {
    pub id: String,
    pub name: String,
    // See Metadata::view_count for the bigint→number rationale (r49).
    #[ts(type = "number")]
    pub size_bytes: u64,
    pub url: String,
    pub downloaded: bool,
    pub path: Option<String>,
}

/// Curated set of GGML Whisper models. URLs point at the canonical
/// HuggingFace mirror maintained by the whisper.cpp authors.
const WHISPER_MODELS: &[(&str, &str, u64)] = &[
    ("tiny.en",   "Tiny (English)",   77_700_000),
    ("base.en",   "Base (English)",   147_700_000),
    ("small.en",  "Small (English)",  487_700_000),
    ("medium.en", "Medium (English)", 1_530_000_000),
];

fn whisper_models_dir(app: &AppHandle) -> Result<PathBuf, crate::AppError> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| crate::AppError::internal(format!("app_data_dir: {e}")))?;
    let dir = base.join("models").join("whisper");
    std::fs::create_dir_all(&dir)
        .map_err(|e| crate::AppError::internal(format!("mkdir models: {e}")))?;
    Ok(dir)
}

fn model_path(app: &AppHandle, id: &str) -> Result<PathBuf, crate::AppError> {
    Ok(whisper_models_dir(app)?.join(format!("ggml-{id}.bin")))
}

/// Normalize a requested transcription language for whisper-cli's `-l` flag
/// (r108 — retires the hardcoded `-l en`).
///
/// Accepts "auto" (whisper.cpp's language auto-detect) or a 2–8 letter code
/// ("en", "fr", "yue", …), lowercased. Absent, empty, or malformed input
/// falls back to "auto" rather than erroring — a bad preference string must
/// never kill a transcription run.
fn normalize_whisper_lang(lang: Option<&str>) -> String {
    let l = lang.unwrap_or("").trim().to_ascii_lowercase();
    if l == "auto"
        || ((2..=8).contains(&l.len()) && l.chars().all(|c| c.is_ascii_alphabetic()))
    {
        l
    } else {
        "auto".into()
    }
}

/// Advisory pipeline-log line when an English-only Whisper model (`*.en`)
/// is asked for a non-English language (r108). whisper-cli copes on its own
/// (it forces English and prints its own warning), so we deliberately do NOT
/// fail — this line just makes the mismatch visible in the pipeline log so
/// the user (and the wave-2 language UI) can see why the output is English.
/// `model` is a model id ("small.en") or a "ggml-small.en" file stem — both
/// end in ".en" exactly when the model is English-only.
fn warn_if_english_only_mismatch(app: &AppHandle, job_id: &str, model: &str, lang: &str) {
    if model.ends_with(".en") && lang != "en" && lang != "auto" {
        emit_transcript_log(
            app,
            job_id,
            "warn",
            format!(
                "Model '{model}' is English-only but language '{lang}' was requested — \
                 the transcript will come out in English. Use a multilingual model \
                 (one without the .en suffix) for other languages."
            ),
        );
    }
}

// ── Parakeet ASR engine (r90) ───────────────────────────────────────
// FluidAudio's Parakeet TDT v3 (Core ML), run via the saucebunny-diarize
// sidecar's --asr mode. The ~0.5 GB model lives in an app-managed dir
// (mirrors whisper_models_dir); Settings downloads it on demand.

fn parakeet_models_dir(app: &AppHandle) -> Result<PathBuf, crate::AppError> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| crate::AppError::internal(format!("app_data_dir: {e}")))?;
    let dir = base.join("models").join("parakeet");
    std::fs::create_dir_all(&dir)
        .map_err(|e| crate::AppError::internal(format!("mkdir parakeet models: {e}")))?;
    Ok(dir)
}

/// Where FluidAudio ACTUALLY writes the Parakeet v3 Core ML bundles.
///
/// `AsrModels.download(to:)` / `load(from:)` both transform the dir we pass
/// (`--models-dir <…/models/parakeet>`) into `parent.appendingPathComponent(repo.folderName)`
/// — i.e. `<…/models/parakeet-tdt-0.6b-v3>`, a SIBLING of the dir we pass, not a
/// child. So the model lands beside `parakeet/`, and any readiness check has to
/// look there (this mismatch is why a downloaded model previously read as
/// "not downloaded" and bounced the user to Settings).
fn parakeet_repo_dir(app: &AppHandle) -> Result<PathBuf, crate::AppError> {
    let models = parakeet_models_dir(app)?; // ensures <…/models> exists
    let parent = models
        .parent()
        .ok_or_else(|| crate::AppError::internal("parakeet models dir has no parent"))?;
    Ok(parent.join("parakeet-tdt-0.6b-v3"))
}

/// True when the Parakeet repo dir holds the compiled Core ML bundles. We require
/// both the Encoder and Decoder `.mlmodelc` (stable names across v3) so a
/// half-finished download doesn't read as ready.
#[tauri::command]
pub fn parakeet_model_downloaded(app: AppHandle) -> bool {
    let Ok(dir) = parakeet_repo_dir(&app) else { return false };
    dir.join("Encoder.mlmodelc").is_dir() && dir.join("Decoder.mlmodelc").is_dir()
}

/// Remove the downloaded Parakeet model (frees ~0.5 GB). Mirrors
/// `delete_whisper_model`; the Settings "Delete" button calls this.
#[tauri::command]
pub fn delete_parakeet_model(app: AppHandle) -> Result<(), crate::AppError> {
    let dir = parakeet_repo_dir(&app)?;
    if dir.exists() {
        std::fs::remove_dir_all(&dir)
            .map_err(|e| format!("failed to delete Parakeet model: {e}"))?;
    }
    Ok(())
}

/// Download + compile the Parakeet Core ML model into the app-managed dir.
/// Drives the Settings "Download" button; cancellable via the JobRegistry.
#[tauri::command]
pub async fn download_parakeet_model(app: AppHandle, job_id: String) -> Result<(), crate::AppError> {
    let dir = parakeet_models_dir(&app)?;
    let dir_str = dir.to_string_lossy().to_string();
    let cmd = app
        .shell()
        .sidecar("saucebunny-diarize")
        .map_err(|e| format!("saucebunny-diarize sidecar not bundled: {e}. Run `npm run build:diarizer`."))?;
    let (mut rx, child) = cmd
        .args(["--prepare-asr-models", "--models-dir", &dir_str, "--emit-progress"])
        .spawn()
        .map_err(|e| format!("failed to spawn saucebunny-diarize: {e}"))?;
    app.state::<JobRegistry>().insert(job_id.clone(), child);
    let _ = app.emit(
        "transcript-phase",
        TranscriptPhaseEvent { job_id: job_id.clone(), phase: "parakeet-download".into() },
    );
    emit_transcript_log(&app, &job_id, "info", "Downloading Parakeet model (~0.5 GB, first run only)…".into());
    let mut stderr_tail = String::new();
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stderr(b) => {
                let raw = String::from_utf8_lossy(&b).to_string();
                stderr_tail.push_str(&raw);
                if stderr_tail.len() > 4096 {
                    let mut cut = stderr_tail.len() - 2048;
                    while cut < stderr_tail.len() && !stderr_tail.is_char_boundary(cut) { cut += 1; }
                    stderr_tail = stderr_tail[cut..].to_string();
                }
            }
            CommandEvent::Terminated(payload) => {
                let _ = app.state::<JobRegistry>().take(&job_id);
                if payload.code != Some(0) {
                    return Err(crate::AppError::SidecarFailed {
                        name: "saucebunny-diarize".into(),
                        exit_code: payload.code,
                        tail: stderr_tail.trim().to_string(),
                    });
                }
                break;
            }
            _ => {}
        }
    }
    Ok(())
}

/// Run Parakeet ASR on a 16 kHz WAV → SRT (same contract as whisper-cli).
/// Registered under `job_id` so Stop cancels it.
async fn run_parakeet_asr(
    app: &AppHandle, job_id: &str, wav_path: &std::path::Path, srt_path: &str,
) -> Result<(), crate::AppError> {
    let dir = parakeet_models_dir(app)?;
    let dir_str = dir.to_string_lossy().to_string();
    let wav_str = wav_path.to_string_lossy().to_string();
    let cmd = app
        .shell()
        .sidecar("saucebunny-diarize")
        .map_err(|e| format!("saucebunny-diarize sidecar not bundled: {e}"))?;
    let (mut rx, child) = cmd
        .args(["--asr", "--input", &wav_str, "--output", srt_path, "--models-dir", &dir_str, "--emit-progress"])
        .spawn()
        .map_err(|e| format!("failed to spawn saucebunny-diarize --asr: {e}"))?;
    app.state::<JobRegistry>().insert(job_id.to_string(), child);
    let mut stderr_tail = String::new();
    let mut cancelled = false;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(b) => {
                let raw = String::from_utf8_lossy(&b).to_string();
                for line in raw.lines() {
                    let t = line.trim();
                    // FluidAudio's transcribe() is one shot — no per-segment
                    // percent — so we drive the UI by PHASE instead of a fake
                    // bar: emit transcript-phase so the button shows an honest
                    // "Transcribing with Parakeet…" rather than a frozen 0%.
                    if t.contains("\"phase\":\"process\"") {
                        let _ = app.emit(
                            "transcript-phase",
                            TranscriptPhaseEvent { job_id: job_id.to_string(), phase: "parakeet".into() },
                        );
                        emit_transcript_log(app, job_id, "info", "Transcribing with Parakeet…".into());
                    } else if t.contains("\"phase\":\"prepare\"") {
                        let _ = app.emit(
                            "transcript-phase",
                            TranscriptPhaseEvent { job_id: job_id.to_string(), phase: "parakeet-load".into() },
                        );
                        emit_transcript_log(app, job_id, "info", "Loading Parakeet model…".into());
                    }
                }
            }
            CommandEvent::Stderr(b) => {
                let raw = String::from_utf8_lossy(&b).to_string();
                stderr_tail.push_str(&raw);
                if stderr_tail.len() > 4096 {
                    let mut cut = stderr_tail.len() - 2048;
                    while cut < stderr_tail.len() && !stderr_tail.is_char_boundary(cut) { cut += 1; }
                    stderr_tail = stderr_tail[cut..].to_string();
                }
            }
            CommandEvent::Terminated(payload) => {
                let _ = app.state::<JobRegistry>().take(job_id);
                if payload.signal.is_some() { cancelled = true; }
                if payload.code != Some(0) {
                    if cancelled { return Err("Cancelled".into()); }
                    return Err(crate::AppError::SidecarFailed {
                        name: "saucebunny-diarize --asr".into(),
                        exit_code: payload.code,
                        tail: stderr_tail.trim().to_string(),
                    });
                }
                break;
            }
            _ => {}
        }
    }
    Ok(())
}

// ── Voice dictation (r91) ───────────────────────────────────────────
// Mic → text for the Review composer. We capture the mic with the
// bundled ffmpeg (avfoundation) rather than the WebView's getUserMedia
// (WKWebView's capture-permission path is unreliable on this stack), then
// reuse the existing ASR sidecars (Parakeet preferred, Whisper fallback)
// to turn the WAV into text. The recording is registered in the
// JobRegistry under `job_id`; `dictate_stop` sends ffmpeg an interactive
// `q` (clean WAV finalize) and a background drain task runs ASR and emits
// `dictate-done`. Mic access needs NSMicrophoneUsageDescription in the
// bundle's Info.plist (the ffmpeg child inherits the app's TCC grant).

#[derive(Serialize, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub(crate) struct DictateDoneEvent {
    pub(crate) job_id: String,
    pub(crate) success: bool,
    pub(crate) text: Option<String>,
    pub(crate) error: Option<String>,
    /// Non-error advisory shown to the user (e.g. recording hit the time cap).
    pub(crate) note: Option<String>,
}

/// Live mic level (0..1) emitted ~20×/s while recording, for the waveform UI.
#[derive(Serialize, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub(crate) struct DictateLevelEvent {
    pub(crate) job_id: String,
    pub(crate) level: f64,
}

/// Turn an ASR failure into plain language for the composer. The raw sidecar
/// error (exit codes, "no token timings", etc.) is for the logs, not the user.
fn humanize_dictation_error(raw: &str) -> String {
    let r = raw.to_lowercase();
    if r.contains("no transcript") || r.contains("no token") || r.contains("empty") {
        "I didn't catch any words. Make sure the right microphone is picked (Settings → Transcription) and try again.".to_string()
    } else if r.contains("not downloaded") || r.contains("no transcription model") {
        "No transcription model is ready. Download Parakeet or a Whisper model in Settings → Transcription first.".to_string()
    } else {
        "Something went wrong transcribing that. Give it another try.".to_string()
    }
}

/// An avfoundation audio input the user can dictate from (for the mic chooser).
#[derive(Serialize, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub(crate) struct AudioInputDevice {
    /// avfoundation enumeration index, as a string (e.g. "0").
    pub(crate) index: String,
    pub(crate) name: String,
}

/// Enumerate avfoundation audio inputs for the mic chooser. Runs
/// `ffmpeg -f avfoundation -list_devices true -i ""`, which prints the device
/// list to stderr and exits non-zero by design — so we read stderr regardless
/// of the exit code.
#[tauri::command]
pub async fn list_audio_input_devices(app: AppHandle) -> Result<Vec<AudioInputDevice>, crate::AppError> {
    let cmd = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("ffmpeg sidecar not found: {e}"))?;
    let out = cmd
        .args(["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""])
        .output()
        .await
        .map_err(|e| format!("failed to list audio devices: {e}"))?;
    let text = String::from_utf8_lossy(&out.stderr);
    let mut devices = Vec::new();
    let mut in_audio = false;
    for line in text.lines() {
        let l = line.trim();
        if l.contains("AVFoundation video devices") { in_audio = false; continue; }
        if l.contains("AVFoundation audio devices") { in_audio = true; continue; }
        if !in_audio { continue; }
        // "[AVFoundation indev @ 0x…] [1] MacBook Pro Microphone" → drop the
        // logger prefix, then parse the "[idx] name" tail.
        let rest = match l.find("] ") { Some(i) => l[i + 2..].trim(), None => l };
        if let Some(body) = rest.strip_prefix('[') {
            if let Some(close) = body.find(']') {
                let idx = &body[..close];
                let name = body[close + 1..].trim();
                if !idx.is_empty() && idx.chars().all(|c| c.is_ascii_digit()) && !name.is_empty() {
                    devices.push(AudioInputDevice { index: idx.to_string(), name: name.to_string() });
                }
            }
        }
    }
    Ok(devices)
}

/// ASR engine resolved for a dictation request.
enum DictEngine {
    Parakeet,
    Whisper(PathBuf),
}

/// First Whisper model present on disk (WHISPER_MODELS is ordered
/// smallest→largest, so this prefers the fastest model — ideal for short
/// dictation clips). None if no model is downloaded.
fn first_downloaded_whisper(app: &AppHandle) -> Option<PathBuf> {
    let dir = whisper_models_dir(app).ok()?;
    for (id, _, _) in WHISPER_MODELS {
        let p = dir.join(format!("ggml-{id}.bin"));
        if p.exists() {
            return Some(p);
        }
    }
    None
}

/// Pick an ASR engine for dictation: Parakeet if its Core ML bundle is
/// downloaded (best quality + ANE-fast), else any downloaded Whisper model.
fn pick_dictation_engine(app: &AppHandle) -> Result<DictEngine, crate::AppError> {
    if parakeet_model_downloaded(app.clone()) {
        return Ok(DictEngine::Parakeet);
    }
    if let Some(m) = first_downloaded_whisper(app) {
        return Ok(DictEngine::Whisper(m));
    }
    Err("No transcription model is downloaded. Open Settings → Transcription and download Parakeet or a Whisper model first.".into())
}

/// Strip SRT cue indices + timestamp lines, leaving just the spoken text
/// joined into a single line — what the composer wants.
fn srt_to_text(srt: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for line in srt.lines() {
        let t = line.trim();
        if t.is_empty() || t.contains("-->") || t.parse::<u32>().is_ok() {
            continue;
        }
        parts.push(t);
    }
    parts.join(" ").trim().to_string()
}

/// Run whisper-cli on a WAV → `<srt_base>.srt`. Greedy decode (`-bs 1 -bo 1`,
/// no VAD) — for a one-or-two-sentence dictation clip a 5-beam search just burns
/// ~5× the decode time for no accuracy gain on clean speech. Registered under
/// `job_id` so Stop cancels it. `language` is a normalize_whisper_lang output
/// ("auto" or a 2–8 letter code) — dictating in French should yield French.
async fn run_whisper_dictation(
    app: &AppHandle, job_id: &str, wav: &std::path::Path, srt_base: &str,
    model: &std::path::Path, language: &str,
) -> Result<(), crate::AppError> {
    let wsp = app
        .shell()
        .sidecar("whisper-cli")
        .map_err(|e| format!("whisper-cli sidecar not found: {e}"))?;
    let (mut rx, child) = wsp
        .args([
            "-m", &model.to_string_lossy(),
            "-f", &wav.to_string_lossy(),
            "-osrt", "-of", srt_base,
            "-l", language, "-bs", "1", "-bo", "1",
        ])
        .spawn()
        .map_err(|e| format!("whisper-cli failed to spawn: {e}"))?;
    app.state::<JobRegistry>().insert(job_id.to_string(), child);
    let mut tail = String::new();
    let mut cancelled = false;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stderr(b) | CommandEvent::Stdout(b) => {
                tail.push_str(&String::from_utf8_lossy(&b));
                if tail.len() > 4096 {
                    let mut cut = tail.len() - 2048;
                    while cut < tail.len() && !tail.is_char_boundary(cut) { cut += 1; }
                    tail = tail[cut..].to_string();
                }
            }
            CommandEvent::Terminated(payload) => {
                let _ = app.state::<JobRegistry>().take(job_id);
                if payload.signal.is_some() { cancelled = true; }
                if payload.code != Some(0) {
                    if cancelled { return Err("Cancelled".into()); }
                    return Err(crate::AppError::SidecarFailed {
                        name: "whisper-cli".into(),
                        exit_code: payload.code,
                        tail: tail.trim().to_string(),
                    });
                }
                break;
            }
            _ => {}
        }
    }
    Ok(())
}

/// Start recording the microphone for voice dictation. Spawns the bundled
/// ffmpeg (avfoundation) → 16 kHz mono WAV, registers it under `job_id`, and
/// kicks off a background task that streams live mic levels (`dictate-level`)
/// while recording and — once recording stops — transcribes the WAV and emits
/// `dictate-done`. `device` is the avfoundation audio index ("0", "1", …) or
/// None/"default" for the system default input. `language` is the dictation
/// language ("auto"/None → whisper auto-detect; see normalize_whisper_lang) —
/// applies to the Whisper engine only (Parakeet handles language itself).
/// Fails fast if no ASR model is available (so the UI never starts a
/// pointless recording).
#[tauri::command]
pub async fn dictate_start(
    app: AppHandle,
    job_id: String,
    device: Option<String>,
    language: Option<String>,
) -> Result<(), crate::AppError> {
    // Resolve the engine up front so a "no model" error surfaces before we
    // ever turn on the mic.
    let engine = pick_dictation_engine(&app)?;
    let lang = normalize_whisper_lang(language.as_deref());
    if let DictEngine::Whisper(model) = &engine {
        // English-only model + non-English request → advisory log (whisper
        // itself will fall back to English; see warn_if_english_only_mismatch).
        let stem = model.file_stem().map(|s| s.to_string_lossy().to_string());
        warn_if_english_only_mismatch(&app, &job_id, stem.as_deref().unwrap_or(""), &lang);
    }

    let cache = app.path().app_cache_dir().map_err(|e| format!("app_cache_dir: {e}"))?;
    std::fs::create_dir_all(&cache).map_err(|e| format!("mkdir cache: {e}"))?;
    let wav = cache.join(format!("saucebunny-dictate-{job_id}.wav"));
    let wav_str = wav.to_string_lossy().to_string();

    // avfoundation input: ":default" (system default) or ":<index>" for a
    // user-chosen device. The `:` with no video half means audio-only.
    let dev = device.as_deref().unwrap_or("default");
    let input = if dev.is_empty() || dev == "default" { ":default".to_string() } else { format!(":{dev}") };
    // Mic-level metering for the waveform: astats prints per-frame RMS to the log
    // (passed through untouched, so the recorded WAV is unaffected). The drain
    // task parses these and emits `dictate-level`.
    const LEVEL_AF: &str = "astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level";

    let ff = app
        .shell()
        .sidecar("ffmpeg")
        .map_err(|e| format!("ffmpeg sidecar not found: {e}"))?;
    // `-t 300` caps a runaway recording at 5 min (the drain task flags it so the
    // UI can tell the user it was cut). NOTE: do not add `-nostdin` — we need
    // stdin open so `dictate_stop` can send `q` for a graceful finalize.
    let (mut rx, child) = ff
        .args([
            "-hide_banner",
            "-f", "avfoundation",
            "-i", &input,
            "-af", LEVEL_AF,
            "-ac", "1",
            "-ar", "16000",
            "-t", "300",
            "-y", &wav_str,
        ])
        .spawn()
        .map_err(|e| format!("ffmpeg failed to spawn: {e}"))?;
    app.state::<JobRegistry>().insert(job_id.clone(), child);

    let app2 = app.clone();
    let job2 = job_id.clone();
    tokio::spawn(async move {
        let mut tail = String::new();
        let mut killed = false;
        let mut last_level = std::time::Instant::now();
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stderr(b) | CommandEvent::Stdout(b) => {
                    let chunk = String::from_utf8_lossy(&b);
                    for line in chunk.lines() {
                        // Mic level → throttled (~20 Hz) dictate-level events. The
                        // ametadata print carries an av_log prefix
                        // ("[Parsed_ametadata_1 @ 0x…] lavfi.astats…=-21.0"), so we
                        // match the value by substring, not prefix.
                        if let Some(pos) = line.find("RMS_level=") {
                            if let Ok(dbv) = line[pos + "RMS_level=".len()..].trim().parse::<f64>() {
                                // dBFS → 0..1: ~-50 dB floor (quiet) → 0, -10 dB → 1.
                                let lvl = ((dbv + 50.0) / 40.0).clamp(0.0, 1.0);
                                if last_level.elapsed().as_millis() >= 50 {
                                    last_level = std::time::Instant::now();
                                    let _ = app2.emit("dictate-level", DictateLevelEvent { job_id: job2.clone(), level: lvl });
                                }
                            }
                            continue;
                        }
                        // Skip the metering filter's own log lines; keep real ffmpeg
                        // output so the error tail stays meaningful.
                        let t = line.trim();
                        if t.is_empty() || t.contains("Parsed_ametadata") || t.contains("Parsed_astats") { continue; }
                        tail.push_str(t);
                        tail.push('\n');
                        if tail.len() > 4096 {
                            let mut cut = tail.len() - 2048;
                            while cut < tail.len() && !tail.is_char_boundary(cut) { cut += 1; }
                            tail = tail[cut..].to_string();
                        }
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let _ = app2.state::<JobRegistry>().take(&job2);
                    // SIGKILL (cancel) → discard; a clean `q` stop exits 0.
                    if payload.signal.is_some() { killed = true; }
                    break;
                }
                _ => {}
            }
        }

        let emit_err = |msg: String| {
            let _ = app2.emit("dictate-done", DictateDoneEvent {
                job_id: job2.clone(), success: false, text: None, error: Some(msg), note: None,
            });
        };

        if killed {
            let _ = std::fs::remove_file(&wav);
            emit_err("Cancelled".into());
            return;
        }
        // A graceful stop leaves a finalized WAV; require some captured audio.
        // 16 kHz mono s16 = 32000 bytes/s, so <1 KB ≈ a sub-30 ms clip.
        let captured = std::fs::metadata(&wav).map(|m| m.len()).unwrap_or(0);
        if captured < 1024 {
            let _ = std::fs::remove_file(&wav);
            // Distinguish a real mic-access failure (ffmpeg's avfoundation open
            // erroring out) from a recording that was simply too short. NOTE:
            // `-hide_banner` does NOT empty stderr (stream info + progress still
            // print), so we must inspect the tail for actual permission errors.
            let t = tail.to_lowercase();
            let blocked = t.contains("operation not permitted")
                || t.contains("input/output error")
                || t.contains("permission denied")
                || t.contains("abort");
            emit_err(if blocked {
                "Microphone access was blocked. Allow it in System Settings → Privacy & Security → Microphone, then try again.".into()
            } else {
                "Recording too short — hold the mic button a moment longer.".into()
            });
            return;
        }
        // ffmpeg self-exits at the `-t` cap with code 0 (no signal), so a clean
        // stop and a hit-the-limit stop look the same; flag the latter by length.
        let approx_secs = captured.saturating_sub(44) / 32_000;
        let cap_note = if approx_secs >= 299 {
            Some("Recording reached the 5-minute limit and was cut off.".to_string())
        } else {
            None
        };

        // Transcribe the WAV with the engine resolved at start.
        let srt = wav.with_extension("srt");
        let srt_str = srt.to_string_lossy().to_string();
        let srt_base = wav.with_extension("");
        let asr = match engine {
            DictEngine::Parakeet => run_parakeet_asr(&app2, &job2, &wav, &srt_str).await,
            DictEngine::Whisper(model) => {
                run_whisper_dictation(
                    &app2, &job2, &wav, &srt_base.to_string_lossy(), &model, &lang,
                )
                .await
            }
        };
        let _ = std::fs::remove_file(&wav);

        match asr {
            Ok(()) => {
                let text = std::fs::read_to_string(&srt).map(|s| srt_to_text(&s)).unwrap_or_default();
                let _ = std::fs::remove_file(&srt);
                let _ = app2.emit("dictate-done", DictateDoneEvent {
                    job_id: job2.clone(), success: true, text: Some(text), error: None, note: cap_note,
                });
            }
            Err(e) => {
                let _ = std::fs::remove_file(&srt);
                emit_err(humanize_dictation_error(&e.to_string()));
            }
        }
    });

    Ok(())
}

/// Stop an in-progress dictation recording GRACEFULLY by sending ffmpeg the
/// interactive `q` command (finalizes the WAV header). The background task
/// from `dictate_start` then transcribes and emits `dictate-done`. Returns
/// false if no recording is live.
#[tauri::command]
pub fn dictate_stop(registry: State<'_, JobRegistry>, job_id: String) -> bool {
    registry.write_stdin(&job_id, b"q")
}

/// Live interim transcript emitted while the user is still speaking (native
/// path only). The composer replaces its in-progress dictation text with this
/// on every event, so words appear in real time.
#[derive(Serialize, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub(crate) struct DictatePartialEvent {
    pub(crate) job_id: String,
    pub(crate) text: String,
}

/// Native, on-device, LIVE-streaming dictation via the `saucebunny-dictate`
/// Swift sidecar (Apple Speech / SFSpeechRecognizer). Unlike `dictate_start`
/// (ffmpeg record → batch Whisper/Parakeet after stop), this streams partial
/// transcripts as you speak: it emits `dictate-level` (waveform), repeated
/// `dictate-partial` (interim text), and a final `dictate-done`. Stop it with
/// the shared `dictate_stop` (it writes a stdin byte the sidecar reads as stop).
#[tauri::command]
pub async fn dictate_native_start(app: AppHandle, job_id: String, locale: Option<String>) -> Result<(), crate::AppError> {
    let loc = locale.unwrap_or_else(|| "en-US".to_string());
    let cmd = app
        .shell()
        .sidecar("saucebunny-dictate")
        .map_err(|e| format!("saucebunny-dictate sidecar not found: {e}"))?;
    let (mut rx, child) = cmd
        .args([loc.as_str()])
        .spawn()
        .map_err(|e| format!("saucebunny-dictate failed to spawn: {e}"))?;
    app.state::<JobRegistry>().insert(job_id.clone(), child);

    let app2 = app.clone();
    let job2 = job_id.clone();
    tokio::spawn(async move {
        let mut last_level = std::time::Instant::now();
        let mut done = false; // a terminal dictate-done was already emitted
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(b) => {
                    let chunk = String::from_utf8_lossy(&b);
                    for line in chunk.lines() {
                        let line = line.trim();
                        if line.is_empty() { continue; }
                        let v: serde_json::Value = match serde_json::from_str(line) {
                            Ok(v) => v,
                            Err(_) => continue, // not a protocol line
                        };
                        if let Some(level) = v.get("level").and_then(|x| x.as_f64()) {
                            if last_level.elapsed().as_millis() >= 50 {
                                last_level = std::time::Instant::now();
                                let _ = app2.emit("dictate-level", DictateLevelEvent { job_id: job2.clone(), level });
                            }
                            continue;
                        }
                        if let Some(msg) = v.get("error").and_then(|x| x.as_str()) {
                            done = true;
                            let _ = app2.emit("dictate-done", DictateDoneEvent {
                                job_id: job2.clone(), success: false, text: None,
                                error: Some(msg.to_string()), note: None,
                            });
                            continue;
                        }
                        if let Some(text) = v.get("partial").and_then(|x| x.as_str()) {
                            if v.get("final").and_then(|x| x.as_bool()).unwrap_or(false) {
                                done = true;
                                let _ = app2.emit("dictate-done", DictateDoneEvent {
                                    job_id: job2.clone(), success: true, text: Some(text.to_string()),
                                    error: None, note: None,
                                });
                            } else {
                                let _ = app2.emit("dictate-partial", DictatePartialEvent {
                                    job_id: job2.clone(), text: text.to_string(),
                                });
                            }
                        }
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let _ = app2.state::<JobRegistry>().take(&job2);
                    if !done {
                        // Exited without a final/error line: SIGKILL (cancel) vs a
                        // crash/no-speech finish.
                        let (success, error) = if payload.signal.is_some() {
                            (false, "Cancelled".to_string())
                        } else {
                            (false, "I didn't catch any words. Try again.".to_string())
                        };
                        let _ = app2.emit("dictate-done", DictateDoneEvent {
                            job_id: job2.clone(), success, text: None, error: Some(error), note: None,
                        });
                    }
                    break;
                }
                _ => {} // stderr / other — ignored; the protocol is on stdout
            }
        }
    });

    Ok(())
}

#[tauri::command]
pub fn list_whisper_models(app: AppHandle) -> Result<Vec<WhisperModel>, crate::AppError> {
    let dir = whisper_models_dir(&app)?;
    let mut out = Vec::with_capacity(WHISPER_MODELS.len());
    for (id, name, size) in WHISPER_MODELS {
        let p = dir.join(format!("ggml-{id}.bin"));
        let downloaded = p.exists();
        out.push(WhisperModel {
            id: (*id).to_string(),
            name: (*name).to_string(),
            size_bytes: *size,
            url: format!(
                "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{id}.bin"
            ),
            downloaded,
            path: if downloaded {
                p.to_str().map(String::from)
            } else {
                None
            },
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn delete_whisper_model(app: AppHandle, model_id: String) -> Result<(), crate::AppError> {
    // The id becomes a filename - separators or dot-dot would delete outside
    // the models dir.
    if model_id.contains('/') || model_id.contains('\\') || model_id.contains("..") {
        return Err(crate::AppError::invalid("Invalid model id"));
    }
    let p = model_path(&app, &model_id)?;
    if p.exists() {
        std::fs::remove_file(&p).map_err(|e| format!("remove: {e}"))?;
    }
    Ok(())
}

#[derive(Serialize, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub(crate) struct ModelProgressEvent {
    pub(crate) job_id: String,
    pub(crate) model_id: String,
    pub(crate) percent: f64,
    // See Metadata::view_count for the bigint→number rationale (r49).
    #[ts(type = "number")]
    pub(crate) bytes_done: u64,
    #[ts(type = "number")]
    pub(crate) bytes_total: u64,
}

#[derive(Deserialize)]
pub struct DownloadModelArgs {
    pub model_id: String,
    pub job_id: String,
}

#[tauri::command]
pub async fn download_whisper_model(
    app: AppHandle,
    args: DownloadModelArgs,
) -> Result<String, crate::AppError> {
    let model = WHISPER_MODELS
        .iter()
        .find(|(id, _, _)| *id == args.model_id)
        .ok_or_else(|| format!("Unknown model: {}", args.model_id))?;
    let url = format!(
        "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-{}.bin",
        model.0
    );
    let dest = model_path(&app, &args.model_id)?;
    let tmp = dest.with_extension("bin.partial");

    if dest.exists() {
        return Ok(args.job_id);
    }

    let job_id = args.job_id.clone();
    let model_id = args.model_id.clone();
    let app_for = app.clone();

    tokio::spawn(async move {
        let result = download_with_progress(&app_for, &url, &tmp, &job_id, &model_id).await;
        match result {
            Ok(()) => {
                if let Err(e) = std::fs::rename(&tmp, &dest) {
                    let _ = std::fs::remove_file(&tmp);
                    let _ = app_for.emit(
                        "model-download-done",
                        DoneEvent {
                            job_id: job_id.clone(),
                            success: false,
                            code: None,
                            path: None,
                            error: Some(format!("Rename failed: {e}")),
                        },
                    );
                    return;
                }
                let _ = app_for.emit(
                    "model-download-done",
                    DoneEvent {
                        job_id: job_id.clone(),
                        success: true,
                        code: Some(0),
                        path: dest.to_str().map(String::from),
                        error: None,
                    },
                );
            }
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                let _ = app_for.emit(
                    "model-download-done",
                    DoneEvent {
                        job_id: job_id.clone(),
                        success: false,
                        code: None,
                        path: None,
                        error: Some(e.to_string()),
                    },
                );
            }
        }
    });

    Ok(args.job_id)
}

// NB: error messages here surface verbatim in `model-download-done` events
// (stringified by the callers), so they ride the `From<String>` → `Invalid`
// bridge to keep their bare Display text — do not re-wrap them in variants
// whose Display adds a prefix.
pub(crate) async fn download_with_progress(
    app: &AppHandle,
    url: &str,
    dest: &PathBuf,
    job_id: &str,
    model_id: &str,
) -> Result<(), crate::AppError> {
    // A per-read idle timeout: a dropped connection mid-stream must not
    // hang the progress bar forever (multi-GB models on flaky Wi-Fi).
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .read_timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| format!("http client: {e}"))?;
    let mut res = client.get(url).send().await.map_err(|e| format!("fetch: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status().as_u16()).into());
    }
    let total = res.content_length().unwrap_or(0);
    // Sweep stale *.partial / *.part temps from a prior killed download in
    // this dir (they otherwise accumulate - the 24h cache sweep skips the
    // models dir).
    if let Some(dir) = dest.parent() {
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                let n = e.file_name();
                let n = n.to_string_lossy();
                if n.ends_with(".partial") || n.ends_with(".part") {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }
    }
    let mut file = tokio::fs::File::create(dest)
        .await
        .map_err(|e| format!("create: {e}"))?;
    let mut done: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    while let Some(chunk) = res.chunk().await.map_err(|e| format!("read: {e}"))? {
        file.write_all(&chunk).await.map_err(|e| format!("write: {e}"))?;
        done += chunk.len() as u64;
        if last_emit.elapsed().as_millis() > 120 {
            let pct = if total > 0 {
                (done as f64 / total as f64) * 100.0
            } else {
                0.0
            };
            let _ = app.emit(
                "model-download-progress",
                ModelProgressEvent {
                    job_id: job_id.to_string(),
                    model_id: model_id.to_string(),
                    percent: pct,
                    bytes_done: done,
                    bytes_total: total,
                },
            );
            last_emit = std::time::Instant::now();
        }
    }
    file.flush().await.map_err(|e| format!("flush: {e}"))?;
    let _ = app.emit(
        "model-download-progress",
        ModelProgressEvent {
            job_id: job_id.to_string(),
            model_id: model_id.to_string(),
            percent: 100.0,
            bytes_done: done,
            bytes_total: if total > 0 { total } else { done },
        },
    );
    Ok(())
}

/// Ensure the Silero VAD model whisper-cli's `--vad` needs is on disk, fetching
/// it once (~865 KB) into the models dir. Returns its path, or `None` on any
/// failure (offline, HTTP error) so transcription cleanly falls back to no-VAD
/// instead of breaking. VAD trims silence before decoding, which cuts Whisper's
/// silence-hallucinations and tightens segment timing — a real accuracy win.
async fn ensure_vad_model(app: &AppHandle) -> Option<PathBuf> {
    let path = whisper_models_dir(app).ok()?.join("ggml-silero-v5.1.2.bin");
    if path.exists() && path.metadata().map(|m| m.len() > 1000).unwrap_or(false) {
        return Some(path);
    }
    let url = "https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v5.1.2.bin";
    let client = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .ok()?;
    let res = client.get(url).send().await.ok()?;
    if !res.status().is_success() {
        return None;
    }
    let bytes = res.bytes().await.ok()?;
    if bytes.len() < 1000 {
        return None;
    }
    // Write to a temp then rename so a killed download can't leave a truncated
    // model that whisper-cli would choke on.
    let tmp = path.with_extension("part");
    tokio::fs::write(&tmp, &bytes).await.ok()?;
    tokio::fs::rename(&tmp, &path).await.ok()?;
    Some(path)
}

#[derive(Deserialize)]
pub struct GenerateTranscriptArgs {
    pub url: String,
    pub start: String,
    pub end: String,
    pub fps: Option<f64>,
    pub output_dir: String,
    pub filename: String,
    pub model_id: String,
    pub job_id: String,
    pub cookies_browser: Option<String>,
    /// See TranscribeLocalArgs::detect_speakers.
    #[serde(default)]
    pub detect_speakers: bool,
    /// Speaker-count hint forwarded to the diarizer when present.
    /// None / 0 → let the model auto-estimate. See `run_diarize_and_merge`.
    #[serde(default)]
    pub expected_speakers: Option<u32>,
    /// Transcription engine: None / "whisper" → whisper-cli (default);
    /// "parakeet" → FluidAudio Parakeet via the diarize sidecar's --asr mode.
    #[serde(default)]
    pub engine: Option<String>,
    /// Spoken language for whisper-cli's `-l` (r108). None/empty/invalid →
    /// "auto" (whisper.cpp auto-detect). See normalize_whisper_lang.
    #[serde(default)]
    pub language: Option<String>,
}

fn emit_transcript_done(
    app: &AppHandle,
    job_id: &str,
    success: bool,
    code: Option<i32>,
    path: Option<String>,
    error: Option<String>,
) {
    let _ = app.emit(
        "transcript-done",
        DoneEvent {
            job_id: job_id.to_string(),
            success,
            code,
            path,
            error,
        },
    );
}

fn emit_transcript_log(app: &AppHandle, job_id: &str, tag: &str, line: String) {
    let _ = app.emit(
        "transcript-log",
        LogEvent {
            job_id: job_id.to_string(),
            stream: "stdout".into(),
            tag: tag.to_string(),
            line,
        },
    );
}

#[tauri::command]
pub async fn generate_transcript(
    app: AppHandle,
    args: GenerateTranscriptArgs,
) -> Result<String, crate::AppError> {
    validate_source_url(&args.url)?;
    let fps = args.fps.unwrap_or(24.0);
    let start_s = timecode_to_seconds(&args.start, fps)?;
    let end_s = timecode_to_seconds(&args.end, fps)?;
    if end_s <= start_s + 0.04 {
        return Err("Mark out must be after mark in".into());
    }
    let safe = sanitize_filename(&args.filename);
    if safe.is_empty() {
        return Err("Filename is empty".into());
    }
    let out_dir = PathBuf::from(&args.output_dir);
    if !out_dir.is_dir() {
        return Err("Output folder does not exist".into());
    }

    let model_p = model_path(&app, &args.model_id)?;
    if !model_p.exists() {
        return Err(format!(
            "Whisper model '{}' is not downloaded. Open Settings → Transcription.",
            args.model_id
        ).into());
    }

    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("app_cache_dir: {e}"))?;
    std::fs::create_dir_all(&cache).map_err(|e| format!("mkdir cache: {e}"))?;

    // Three-phase audio path: yt-dlp downloads the raw stream (.m4a / .webm /
    // whatever YouTube serves), then ffmpeg converts to 16 kHz mono WAV
    // (whisper's native input — skips an internal conversion pass), then
    // whisper-cli reads the WAV. Decoupling these steps means a yt-dlp
    // failure won't masquerade as an ffmpeg "Invalid data" error.
    let raw_prefix = format!("saucebunny-{}-raw", args.job_id);
    let raw_template = cache
        .join(format!("{}.%(ext)s", raw_prefix))
        .to_string_lossy()
        .to_string();
    let wav_path = cache.join(format!("saucebunny-{}.wav", args.job_id));

    let ffmpeg = sidecar_path("ffmpeg")?;
    if !ffmpeg.exists() {
        return Err(format!("ffmpeg sidecar missing at {}", ffmpeg.display()).into());
    }

    // Bundled ffmpeg for the section cut below — resolved here (the fn returns
    // AppError) so the move-closure owns it; without it yt-dlp falls back to
    // PATH/Homebrew, absent on a distributed app (DISTRIBUTION.md).
    let ffmpeg_for = sidecar_path("ffmpeg")?
        .to_str()
        .ok_or_else(|| crate::AppError::internal("ffmpeg path not utf-8"))?
        .to_string();
    let job_id = args.job_id.clone();
    let job_for = job_id.clone();
    let app_for = app.clone();
    let out_dir_for = out_dir.clone();
    let safe_for = safe.clone();
    let model_p_for = model_p.clone();
    let cache_for = cache.clone();
    let raw_prefix_for = raw_prefix.clone();
    let wav_path_for = wav_path.clone();
    let detect_speakers = args.detect_speakers;
    let expected_speakers = args.expected_speakers;

    tokio::spawn(async move {
        // ─── Phase 1: obtain the source audio ───
        // Prefer the cached FULL track (already downloaded for the audio-master
        // playback clock): no re-download, AND Whisper transcribes the exact
        // audio the captions are clocked against, so they're aligned by
        // construction. Phase 2 cuts the [start,end] section from it. Otherwise
        // yt-dlp downloads just the section (the original path).
        let cached_full = find_cached_source_audio(&cache_for, &args.url);
        let (raw_path, cut_section, keep_raw) = if let Some(cached) = cached_full {
            emit_transcript_log(
                &app_for, &job_for, "info",
                "Using the cached source audio (already downloaded for playback) — no re-download.".into(),
            );
            (cached, true, true)
        } else {
        emit_transcript_log(
            &app_for,
            &job_for,
            "info",
            format!("Downloading audio for {} → {}…", args.start, args.end),
        );

        let yt = match ytdlp(&app_for) {
            Ok(c) => c,
            Err(e) => {
                emit_transcript_done(
                    &app_for, &job_for, false, None, None,
                    Some(format!("yt-dlp sidecar not found: {e}")),
                );
                return;
            }
        };

        // NO --download-sections. It forces yt-dlp off its native concurrent
        // downloader and onto a single-connection ffmpeg read of the
        // googlevideo URL, which YouTube throttles to roughly real time:
        // measured on this stack at 26 KB/s vs 82 MB/s native - a ~3000x
        // slowdown that made a 2-hour source spend ~81 minutes "downloading
        // audio" before whisper could start at all. We pull the FULL track at
        // full speed and let phase 2 cut the section (the cached-audio branch
        // above already works exactly that way), which also makes the download
        // reusable instead of thrown away.
        let mut yt_args: Vec<String> = vec![
            "--ffmpeg-location".into(), ffmpeg_for,
            "-f".into(), "bestaudio/best".into(),
            "--no-playlist".into(),
            "--no-part".into(),
            "--newline".into(),
            YT_EXTRACTOR_ARGS[0].into(),
            YT_EXTRACTOR_ARGS[1].into(),
            "-o".into(), raw_template.clone(),
        ];
        yt_args.extend(cookies_args(args.cookies_browser.as_deref()));
        yt_args.push(args.url.clone());

        // Stream the audio download instead of blocking on `.output()`. The
        // blocking call pulled the WHOLE audio track (minutes on a long video)
        // with no streamed output, so the UI sat frozen at 0% the entire time
        // — which read as "Whisper is stuck" even though Whisper hadn't even
        // started. Streaming gives a live % and lets STOP cancel the download.
        let _ = app_for.emit(
            "transcript-phase",
            TranscriptPhaseEvent { job_id: job_for.clone(), phase: "download".into() },
        );
        let (mut yt_rx, yt_child) = match yt.args(yt_args).spawn() {
            Ok(c) => c,
            Err(e) => {
                emit_transcript_done(
                    &app_for, &job_for, false, None, None,
                    Some(format!("yt-dlp failed to run: {e}")),
                );
                return;
            }
        };
        // Register so STOP can kill the download (was uncancellable before).
        app_for.state::<JobRegistry>().insert(job_for.clone(), yt_child);
        let mut yt_code: Option<i32> = None;
        let mut yt_log = String::new();
        let mut last_dl_log = std::time::Instant::now() - std::time::Duration::from_secs(1);
        while let Some(event) = yt_rx.recv().await {
            match event {
                CommandEvent::Stdout(b) | CommandEvent::Stderr(b) => {
                    let raw = String::from_utf8_lossy(&b).to_string();
                    for line in raw.lines() {
                        let line = line.trim_end();
                        if line.is_empty() { continue; }
                        yt_log.push_str(line);
                        yt_log.push('\n');
                        if let Some(pct) = regex_lite_percent(line) {
                            let _ = app_for.emit(
                                "transcript-progress",
                                ProgressEvent { job_id: job_for.clone(), percent: pct },
                            );
                            // Throttle the noisy per-chunk [download] % lines.
                            if last_dl_log.elapsed().as_millis() < 500 { continue; }
                            last_dl_log = std::time::Instant::now();
                        }
                        emit_transcript_log(&app_for, &job_for, "info", line.to_string());
                    }
                }
                CommandEvent::Terminated(p) => { yt_code = p.code; break; }
                _ => {}
            }
        }
        let _ = app_for.state::<JobRegistry>().take(&job_for);
        if yt_code != Some(0) {
            // code None ⇒ killed via STOP ⇒ surface as a clean cancel; otherwise
            // humanize_ytdlp_error maps bot-check / age-gate / unavailable to
            // actionable text pointing at Settings → YouTube auth.
            let err = if yt_code.is_none() {
                "Cancelled".to_string()
            } else {
                humanize_ytdlp_error(&yt_log)
            };
            // Don't leave a partial raw download in the cache (the sibling
            // audio-clip path already cleans up on failure).
            if let Some(p) = find_audio_in_cache(&cache_for, &raw_prefix_for) {
                let _ = std::fs::remove_file(p);
            }
            emit_transcript_done(&app_for, &job_for, false, yt_code, None, Some(err));
            return;
        }

        // Locate the file yt-dlp wrote (extension depends on the source).
        let raw_path = match find_audio_in_cache(&cache_for, &raw_prefix_for) {
            Some(p) => p,
            None => {
                emit_transcript_done(
                    &app_for, &job_for, false, None, None,
                    Some("Audio download produced no file in the cache directory".into()),
                );
                return;
            }
        };
        // Full track downloaded -> phase 2 cuts [start,end] out of it, exactly
        // like the cached branch. (Was `false`: the file used to arrive
        // pre-cut by --download-sections.)
        (raw_path, true, false)
        };

        let raw_mb = raw_path
            .metadata()
            .map(|m| m.len() as f64 / 1_000_000.0)
            .unwrap_or(0.0);
        emit_transcript_log(
            &app_for,
            &job_for,
            "info",
            format!("Got {:.1} MB of audio · normalising to 16 kHz mono…", raw_mb),
        );

        // ─── Phase 2: ffmpeg → 16 kHz mono WAV (whisper's native format) ───
        let raw_path_str = raw_path.to_string_lossy().to_string();
        let wav_path_str = wav_path_for.to_string_lossy().to_string();
        let ff = match app_for.shell().sidecar("ffmpeg") {
            Ok(c) => c,
            Err(e) => {
                let _ = std::fs::remove_file(&raw_path);
                emit_transcript_done(
                    &app_for, &job_for, false, None, None,
                    Some(format!("ffmpeg sidecar not found: {e}")),
                );
                return;
            }
        };
        // When reusing the cached FULL track, cut the [start,end] section here
        // (yt-dlp already cut it in the download path).
        let cut = cut_section.then(|| (start_s, (end_s - start_s).max(0.0)));
        let ff_out = ff.args(wav_16k_mono_args(&raw_path_str, cut, &wav_path_str)).output().await;
        if !keep_raw {
            let _ = std::fs::remove_file(&raw_path); // temp download — keep the shared cache
        }
        let ff_out = match ff_out {
            Ok(o) => o,
            Err(e) => {
                emit_transcript_done(
                    &app_for, &job_for, false, None, None,
                    Some(format!("ffmpeg failed to run: {e}")),
                );
                return;
            }
        };
        if !ff_out.status.success() {
            let stderr = String::from_utf8_lossy(&ff_out.stderr);
            let _ = std::fs::remove_file(&wav_path_for);
            emit_transcript_done(
                &app_for, &job_for, false, ff_out.status.code(), None,
                Some(format!("Audio conversion failed — {}", short_err(&stderr))),
            );
            return;
        }
        if !wav_path_for.exists() {
            emit_transcript_done(
                &app_for, &job_for, false, None, None,
                Some(format!("WAV conversion produced no file at {}", wav_path_for.display())),
            );
            return;
        }
        // ffmpeg above ran via `.output().await` — no registered child to
        // kill — so a Stop during conversion is only visible here as the flag.
        if app_for.state::<JobRegistry>().is_cancelled(&job_for) {
            let _ = std::fs::remove_file(&wav_path_for);
            app_for.state::<JobRegistry>().finish_job(&job_for);
            emit_transcript_done(&app_for, &job_for, false, None, None, Some("Cancelled".into()));
            return;
        }

        // ─── Phase 3 (Parakeet branch, r90) ───
        // When the user picked Parakeet, the diarize sidecar's --asr mode
        // produces the .srt instead of whisper-cli; the finalize steps
        // (optional diarization + section-cut re-base + emit) are identical.
        if args.engine.as_deref() == Some("parakeet") {
            emit_transcript_log(
                &app_for, &job_for, "ok",
                "Audio ready — transcribing with Parakeet…".into(),
            );
            let srt = format!("{}.srt", out_dir_for.join(&safe_for).to_string_lossy());
            if let Err(e) = run_parakeet_asr(&app_for, &job_for, &wav_path_for, &srt).await {
                let _ = std::fs::remove_file(&wav_path_for);
                let msg = e.to_string();
                if msg.contains("Cancelled") {
                    emit_transcript_done(&app_for, &job_for, false, None, None, Some("Cancelled".into()));
                } else {
                    emit_transcript_done(&app_for, &job_for, false, None, None,
                        Some(format!("Parakeet transcription failed — {msg}")));
                }
                return;
            }
            let mut warn_note: Option<String> = None;
            if detect_speakers
                && !app_for.state::<JobRegistry>().is_cancelled(&job_for) {
                if let Err(e) = run_diarize_and_merge(
                    &app_for, &job_for, &wav_path_for, std::path::Path::new(&srt), expected_speakers,
                ).await {
                    emit_transcript_log(&app_for, &job_for, "warn",
                        format!("Speaker detection failed — transcript saved without speaker labels. ({e})"));
                    warn_note = Some(format!("Diarization skipped: {e}"));
                }
            }
            if cut_section {
                if let Err(e) = shift_srt_file(std::path::Path::new(&srt), start_s) {
                    emit_transcript_log(&app_for, &job_for, "warn",
                        format!("Caption time re-base failed ({e})."));
                }
            }
            let _ = std::fs::remove_file(&wav_path_for);
            app_for.state::<JobRegistry>().finish_job(&job_for);
            emit_transcript_done(&app_for, &job_for, true, Some(0), Some(srt), warn_note);
            return;
        }

        emit_transcript_log(
            &app_for,
            &job_for,
            "ok",
            "Audio ready — transcribing with Whisper…".into(),
        );

        // ─── Phase 3: whisper-cli transcribes the WAV → .srt ───
        let output_base = out_dir_for.join(&safe_for);
        let output_base_str = output_base.to_string_lossy().to_string();
        let model_str = model_p_for.to_string_lossy().to_string();

        // Phase event — drives the Sidebar's "Whisper / Diarize /
        // Merge" indicator. Diarize phases are emitted from inside
        // run_diarize_and_merge.
        let _ = app_for.emit(
            "transcript-phase",
            TranscriptPhaseEvent { job_id: job_for.clone(), phase: "whisper".into() },
        );

        let wsp = match app_for.shell().sidecar("whisper-cli") {
            Ok(c) => c,
            Err(e) => {
                let _ = std::fs::remove_file(&wav_path_for);
                emit_transcript_done(
                    &app_for, &job_for, false, None, None,
                    Some(format!("whisper-cli sidecar not found: {e}")),
                );
                return;
            }
        };

        // No DYLD_LIBRARY_PATH override: build-whisper.sh static-links ggml
        // (`-DBUILD_SHARED_LIBS=OFF`), so the bundled whisper-cli depends only
        // on system frameworks (`otool -L` shows no Homebrew dylibs). Forcing
        // /opt/homebrew/lib onto the dyld search path was not a safety net —
        // it could shadow the system libc++/libobjc with a mismatched Homebrew
        // copy and hang the process, and it broke self-contained distribution.
        // Best-effort Silero VAD (accuracy: trims silence → fewer
        // hallucinations + tighter timing). Downloaded once; None ⇒ no-VAD.
        let vad_model = ensure_vad_model(&app_for).await
            .map(|p| p.to_string_lossy().to_string());
        if vad_model.is_some() {
            emit_transcript_log(&app_for, &job_for, "info",
                "Voice-activity detection on (Silero VAD).".into());
        }
        let lang = normalize_whisper_lang(args.language.as_deref());
        warn_if_english_only_mismatch(&app_for, &job_for, &args.model_id, &lang);
        // Stop pressed during the VAD fetch above? No whisper child existed to
        // kill, so honor the cancel here rather than transcribe regardless.
        if app_for.state::<JobRegistry>().is_cancelled(&job_for) {
            let _ = std::fs::remove_file(&wav_path_for);
            app_for.state::<JobRegistry>().finish_job(&job_for);
            emit_transcript_done(&app_for, &job_for, false, None, None, Some("Cancelled".into()));
            return;
        }
        // Wall clock for the pipeline log: users need to be able to read
        // (and paste back) how long a transcription actually took.
        let whisper_started = std::time::Instant::now();
        let spawn = wsp
            .args(whisper_cli_args(&model_str, &wav_path_str, &output_base_str, &lang, vad_model.as_deref()))
            .spawn();

        let (mut rx, child) = match spawn {
            Ok(c) => c,
            Err(e) => {
                let _ = std::fs::remove_file(&wav_path_for);
                emit_transcript_done(
                    &app_for,
                    &job_for,
                    false,
                    None,
                    None,
                    Some(format!("whisper-cli failed to spawn: {e}")),
                );
                return;
            }
        };

        // Track whisper-cli so the UI can cancel it.
        app_for.state::<JobRegistry>().insert(job_for.clone(), child);

        let total_seconds = end_s - start_s;
        let mut last_log_at = std::time::Instant::now() - std::time::Duration::from_secs(1);
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(b) | CommandEvent::Stderr(b) => {
                    let raw = String::from_utf8_lossy(&b).to_string();
                    for line in raw.lines() {
                        let line = line.trim_end();
                        if line.is_empty() {
                            continue;
                        }
                        let mut emitted_progress = false;
                        if let Some(t) = parse_whisper_segment_end(line) {
                            if total_seconds > 0.0 {
                                let pct = ((t / total_seconds) * 100.0).clamp(0.0, 100.0);
                                let _ = app_for.emit(
                                    "transcript-progress",
                                    ProgressEvent { job_id: job_for.clone(), percent: pct },
                                );
                                emitted_progress = true;
                            }
                        } else if let Some(pct) = parse_whisper_progress_line(line) {
                            let _ = app_for.emit(
                                "transcript-progress",
                                ProgressEvent { job_id: job_for.clone(), percent: pct },
                            );
                            emitted_progress = true;
                        }
                        // Throttle log lines that are purely progress noise.
                        if emitted_progress && last_log_at.elapsed().as_millis() < 500 {
                            continue;
                        }
                        if emitted_progress { last_log_at = std::time::Instant::now(); }
                        emit_transcript_log(&app_for, &job_for, "info", line.to_string());
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let _ = app_for.state::<JobRegistry>().take(&job_for);
                    emit_transcript_log(
                        &app_for, &job_for, "info",
                        format!("Whisper finished in {}.", fmt_elapsed(whisper_started.elapsed())),
                    );
                    let success = payload.code == Some(0);
                    let srt = format!("{}.srt", output_base_str);
                    let srt_exists = std::path::Path::new(&srt).exists();
                    if success && srt_exists {
                        // Optional speaker-diarization step (see the
                        // matching block in transcribe_prepared_wav for
                        // the full rationale). WAV cleanup is deferred.
                        let mut warn_note: Option<String> = None;
                        // Skip diarization if Stop landed after whisper finished
                        // — the SRT is saved; don't label speakers nobody's
                        // waiting for.
                        if detect_speakers
                            && !app_for.state::<JobRegistry>().is_cancelled(&job_for) {
                            emit_transcript_log(
                                &app_for, &job_for, "info",
                                format!(
                                    "Speaker detection requested (expected={}). Spawning saucebunny-diarize…",
                                    expected_speakers.map(|n| n.to_string()).unwrap_or_else(|| "auto".into()),
                                ),
                            );
                            if let Err(e) = run_diarize_and_merge(
                                &app_for, &job_for,
                                &wav_path_for, std::path::Path::new(&srt),
                                expected_speakers,
                            ).await {
                                emit_transcript_log(
                                    &app_for, &job_for, "warn",
                                    format!("Speaker detection failed — transcript saved without speaker labels. ({e})"),
                                );
                                warn_note = Some(format!("Diarization skipped: {e}"));
                            }
                        }
                        // Re-base sub-range cues onto the FULL source timeline.
                        // The cut WAV (and so the whisper SRT, and the diarize
                        // merge above which works on that same 0-based WAV) start
                        // at the mark-in; the player runs on absolute time, so
                        // shift the FINAL SRT by +start_s. No-op when start_s==0.
                        if cut_section {
                            if let Err(e) = shift_srt_file(std::path::Path::new(&srt), start_s) {
                                emit_transcript_log(
                                    &app_for, &job_for, "warn",
                                    format!("Caption time re-base failed ({e}); cues may be offset by the mark-in."),
                                );
                            }
                        }
                        let _ = std::fs::remove_file(&wav_path_for);
                        app_for.state::<JobRegistry>().finish_job(&job_for);
                        emit_transcript_done(
                            &app_for,
                            &job_for,
                            true,
                            payload.code,
                            Some(srt),
                            warn_note,
                        );
                    } else {
                        let _ = std::fs::remove_file(&wav_path_for);
                        app_for.state::<JobRegistry>().finish_job(&job_for);
                        let msg = if !success {
                            if payload.signal.is_some() {
                                "Cancelled".to_string() // user Stop → SIGKILL, code is None
                            } else {
                                format!("whisper-cli exited with code {:?}", payload.code)
                            }
                        } else {
                            format!("Transcript not produced at {}", srt)
                        };
                        emit_transcript_done(
                            &app_for,
                            &job_for,
                            false,
                            payload.code,
                            None,
                            Some(msg),
                        );
                    }
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(job_id)
}

/// The transcription whisper-cli invocation, shared by all three spawn sites
/// (generate_transcript, transcribe_local_file, transcribe_prepared_wav) and
/// exercised against the real binary by the nightly CI smoke — see
/// `nightly_transcript_tests`. Accuracy + caption-grade segmentation
/// (researched): pin max beam/best-of, and split-on-word at ~2-line length so
/// each cue fits the on-video overlay without breaking mid-word. `language`
/// is a `normalize_whisper_lang` output (r108); `-osrt -of <base>` writes
/// `<base>.srt`; `-pp` prints progress.
pub(crate) fn whisper_cli_args(
    model: &str,
    wav: &str,
    output_base: &str,
    language: &str,
    vad_model: Option<&str>,
) -> Vec<String> {
    let mut args: Vec<String> = [
        "-m", model,
        "-f", wav,
        "-osrt",
        "-of", output_base,
        "-l", language,
        "-bs", "5", "-bo", "5", "-sow", "-ml", "84",
        "-pp",
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    // Best-effort Silero VAD (accuracy: trims silence → fewer hallucinations
    // + tighter timing). None ⇒ no-VAD.
    if let Some(vm) = vad_model {
        args.extend(["--vad".into(), "-vm".into(), vm.into()]);
    }
    args
}

/// The ffmpeg "phase 2" invocation: normalise any audio source to the 16 kHz
/// mono WAV whisper-cli reads natively. `cut` is `(start_seconds, duration
/// seconds)` when transcribing a mark-in sub-range of a cached full track —
/// input-side -ss/-t is fast and sample-accurate enough for speech.
pub(crate) fn wav_16k_mono_args(input: &str, cut: Option<(f64, f64)>, out_wav: &str) -> Vec<String> {
    let mut args: Vec<String> = vec!["-y".into()];
    match cut {
        Some((start_s, dur_s)) => args.extend([
            "-ss".into(), format!("{start_s:.3}"),
            "-i".into(), input.into(),
            "-t".into(), format!("{dur_s:.3}"),
        ]),
        None => args.extend(["-i".into(), input.into()]),
    }
    args.extend(["-vn".into(), "-ar".into(), "16000".into(), "-ac".into(), "1".into(), out_wav.into()]);
    args
}

// Parses whisper-cli segment lines like "[00:00:04.000 --> 00:00:08.500]" → 8.5
fn parse_whisper_segment_end(line: &str) -> Option<f64> {
    let after = line.split("--> ").nth(1)?;
    let tc = after.split(']').next()?.trim();
    parse_hms_ms(tc)
}

pub(crate) fn parse_hms_ms(s: &str) -> Option<f64> {
    let mut parts = s.split(':');
    let h: f64 = parts.next()?.parse().ok()?;
    let m: f64 = parts.next()?.parse().ok()?;
    let s: f64 = parts.next()?.parse().ok()?;
    Some(h * 3600.0 + m * 60.0 + s)
}

// Parses "progress = NN%" lines emitted by whisper-cli's `-pp` flag.
fn parse_whisper_progress_line(line: &str) -> Option<f64> {
    let l = line.to_ascii_lowercase();
    if !l.contains("progress") || !l.contains('%') {
        return None;
    }
    let pct_idx = line.find('%')?;
    let head = &line[..pct_idx];
    let num: String = head
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect::<String>()
        .chars()
        .rev()
        .collect();
    let v: f64 = num.parse().ok()?;
    if (0.0..=100.0).contains(&v) { Some(v) } else { None }
}

#[derive(Deserialize)]
pub struct ReDiarizeArgs {
    /// The existing saved SRT to re-diarize IN PLACE.
    pub transcript_path: String,
    pub job_id: String,
    /// Speaker-count hint; None/0 → auto-estimate (the recommended default).
    #[serde(default)]
    pub expected_speakers: Option<u32>,
    /// Web source URL — locates the cached source audio (download_audio_track).
    #[serde(default)]
    pub url: Option<String>,
    /// Local file path — used directly for a local-file transcript.
    #[serde(default)]
    pub input_path: Option<String>,
}

/// Re-run ONLY speaker diarization on an existing transcript — no Whisper pass.
/// Reuses the cached source audio (web) or the local file, extracts a 16 kHz
/// WAV, runs the diarizer, and merges fresh speaker labels into the EXISTING
/// SRT in place. On a long source this is seconds vs. re-transcribing minutes.
/// Emits the same transcript-phase/-progress/-done events as a full run, so the
/// frontend's existing listeners drive the UI + reload the transcript.
#[tauri::command]
pub async fn re_diarize_transcript(
    app: AppHandle,
    args: ReDiarizeArgs,
) -> Result<String, crate::AppError> {
    let srt_path = PathBuf::from(&args.transcript_path);
    if !srt_path.exists() {
        return Err(format!("Transcript not found: {}", args.transcript_path).into());
    }

    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("app_cache_dir: {e}"))?;
    std::fs::create_dir_all(&cache).map_err(|e| format!("mkdir cache: {e}"))?;

    // Resolve the audio source: an explicit local file, else the cached web
    // source audio (download_audio_track pre-stages it, keyed by URL hash).
    let audio_src: PathBuf = if let Some(p) = args.input_path.as_deref().filter(|s| !s.is_empty()) {
        let pb = PathBuf::from(p);
        if !pb.exists() {
            return Err(format!("Audio source not found: {p}").into());
        }
        pb
    } else if let Some(url) = args.url.as_deref().filter(|s| !s.is_empty()) {
        validate_source_url(url)?;
        find_cached_source_audio(&cache, url)
            .ok_or_else(|| crate::AppError::not_found(
                "Source audio isn't cached — use Regenerate to transcribe and detect speakers.",
            ))?
    } else {
        return Err("No audio source provided for re-diarization".into());
    };

    let wav_path = cache.join(format!("saucebunny-{}.wav", args.job_id));
    let job_id = args.job_id.clone();
    let job_for = job_id.clone();
    let app_for = app.clone();
    let wav_path_for = wav_path.clone();
    let srt_for = srt_path.clone();
    let audio_str = audio_src.to_string_lossy().to_string();
    let wav_str = wav_path.to_string_lossy().to_string();
    let expected = args.expected_speakers;
    let transcript_path_out = args.transcript_path.clone();

    tokio::spawn(async move {
        emit_transcript_log(
            &app_for, &job_for, "info",
            "Re-detecting speakers (reusing the existing transcript — no re-transcription)…".into(),
        );
        // Extract a 16 kHz mono WAV (the diarizer's input) from the source audio.
        let ff = match app_for.shell().sidecar("ffmpeg") {
            Ok(c) => c,
            Err(e) => {
                emit_transcript_done(&app_for, &job_for, false, None, None,
                    Some(format!("ffmpeg sidecar not found: {e}")));
                return;
            }
        };
        let ff_out = ff
            .args(wav_16k_mono_args(&audio_str, None, &wav_str))
            .output()
            .await;
        match ff_out {
            Ok(o) if o.status.success() && wav_path_for.exists() => {}
            Ok(o) => {
                let stderr = String::from_utf8_lossy(&o.stderr);
                let _ = std::fs::remove_file(&wav_path_for);
                emit_transcript_done(&app_for, &job_for, false, o.status.code(), None,
                    Some(format!("Audio conversion failed — {}", short_err(&stderr))));
                return;
            }
            Err(e) => {
                emit_transcript_done(&app_for, &job_for, false, None, None,
                    Some(format!("ffmpeg failed to run: {e}")));
                return;
            }
        }
        // Diarize + merge fresh speaker labels into the existing SRT in place.
        let result = run_diarize_and_merge(&app_for, &job_for, &wav_path_for, &srt_for, expected).await;
        let _ = std::fs::remove_file(&wav_path_for);
        match result {
            Ok(()) => emit_transcript_done(
                &app_for, &job_for, true, Some(0), Some(transcript_path_out), None),
            Err(e) => emit_transcript_done(
                &app_for, &job_for, false, None, None,
                Some(format!("Speaker detection failed: {e}"))),
        }
    });

    Ok(job_id)
}

#[derive(Deserialize)]
pub struct TranscribeLocalArgs {
    pub input_path: String,
    pub output_dir: String,
    pub filename: String,
    pub model_id: String,
    pub job_id: String,
    /// When true, after Whisper writes the SRT we run saucebunny-diarize
    /// on the same WAV and merge speaker labels into the SRT (each cue
    /// prefixed with `[SPEAKER_XX] `). Off by default — diarization
    /// adds 10–60s and the model download is hundreds of MB on first
    /// run, so it's opt-in via the Sidebar toggle.
    #[serde(default)]
    pub detect_speakers: bool,
    /// Speaker-count hint forwarded to the diarizer when present.
    #[serde(default)]
    pub expected_speakers: Option<u32>,
    /// Transcription engine: None / "whisper" → whisper-cli; "parakeet" →
    /// FluidAudio Parakeet via the diarize sidecar's --asr mode.
    #[serde(default)]
    pub engine: Option<String>,
    /// Spoken language for whisper-cli's `-l` (r108). None/empty/invalid →
    /// "auto" (whisper.cpp auto-detect). See normalize_whisper_lang.
    #[serde(default)]
    pub language: Option<String>,
}

/// Frontend-provided pre-normalised audio (16 kHz mono WAV bytes). Lets
/// us skip the ffmpeg subprocess for the "extract audio → WAV" step when
/// mediabunny + WebCodecs can do it in-browser. Falls through to
/// `transcribe_local_file` whenever the frontend can't produce the WAV
/// (codec WebCodecs can't decode, etc).
#[derive(Deserialize)]
pub struct TranscribePreparedWavArgs {
    pub wav_bytes: Vec<u8>,
    pub output_dir: String,
    pub filename: String,
    pub model_id: String,
    pub job_id: String,
    /// See TranscribeLocalArgs::detect_speakers.
    #[serde(default)]
    pub detect_speakers: bool,
    /// Speaker-count hint forwarded to the diarizer when present.
    #[serde(default)]
    pub expected_speakers: Option<u32>,
    /// Spoken language for whisper-cli's `-l` (r108). None/empty/invalid →
    /// "auto" (whisper.cpp auto-detect). See normalize_whisper_lang.
    #[serde(default)]
    pub language: Option<String>,
    // NB: no `engine` field — Parakeet local-file runs route through
    // transcribe_local_file (ffmpeg WAV), not this WebCodecs fast-path.
}

#[tauri::command]
pub async fn transcribe_prepared_wav(
    app: AppHandle,
    args: TranscribePreparedWavArgs,
) -> Result<String, crate::AppError> {
    let safe = sanitize_filename(&args.filename);
    if safe.is_empty() {
        return Err("Filename is empty".into());
    }
    let out_dir = PathBuf::from(&args.output_dir);
    if !out_dir.is_dir() {
        return Err("Output folder does not exist".into());
    }
    let model_p = model_path(&app, &args.model_id)?;
    if !model_p.exists() {
        return Err(format!(
            "Whisper model '{}' is not downloaded. Open Settings → Transcription.",
            args.model_id
        ).into());
    }

    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("app_cache_dir: {e}"))?;
    std::fs::create_dir_all(&cache).map_err(|e| format!("mkdir cache: {e}"))?;
    let wav_path = cache.join(format!("saucebunny-{}.wav", args.job_id));
    std::fs::write(&wav_path, &args.wav_bytes)
        .map_err(|e| format!("failed to stage WAV: {e}"))?;

    let wav_path_str = wav_path.to_string_lossy().to_string();
    let model_str = model_p.to_string_lossy().to_string();
    let output_base = out_dir.join(&safe);
    let output_base_str = output_base.to_string_lossy().to_string();

    let job_id = args.job_id.clone();
    let job_for = job_id.clone();
    let app_for = app.clone();
    let wav_path_for = wav_path.clone();
    let detect_speakers = args.detect_speakers;
    let expected_speakers = args.expected_speakers;

    tokio::spawn(async move {
        emit_transcript_log(
            &app_for, &job_for, "ok",
            format!("Audio ready ({} MB) — transcribing with Whisper…",
                    (args.wav_bytes.len() as f64 / 1_000_000.0).round() as u32),
        );

        // Phase 2 only — whisper-cli on the pre-staged WAV. Mirrors the
        // transcribe_local_file phase-2 block via whisper_cli_args.
        let _ = app_for.emit(
            "transcript-phase",
            TranscriptPhaseEvent { job_id: job_for.clone(), phase: "whisper".into() },
        );
        let wsp = match app_for.shell().sidecar("whisper-cli") {
            Ok(c) => c,
            Err(e) => {
                let _ = std::fs::remove_file(&wav_path_for);
                emit_transcript_done(
                    &app_for, &job_for, false, None, None,
                    Some(format!("whisper-cli sidecar not found: {e}")),
                );
                return;
            }
        };
        let vad_model = ensure_vad_model(&app_for).await
            .map(|p| p.to_string_lossy().to_string());
        if vad_model.is_some() {
            emit_transcript_log(&app_for, &job_for, "info",
                "Voice-activity detection on (Silero VAD).".into());
        }
        let lang = normalize_whisper_lang(args.language.as_deref());
        warn_if_english_only_mismatch(&app_for, &job_for, &args.model_id, &lang);
        // Stop pressed during the VAD fetch above? No whisper child existed to
        // kill, so honor the cancel here rather than transcribe regardless.
        if app_for.state::<JobRegistry>().is_cancelled(&job_for) {
            let _ = std::fs::remove_file(&wav_path_for);
            app_for.state::<JobRegistry>().finish_job(&job_for);
            emit_transcript_done(&app_for, &job_for, false, None, None, Some("Cancelled".into()));
            return;
        }
        // Wall clock for the pipeline log: users need to be able to read
        // (and paste back) how long a transcription actually took.
        let whisper_started = std::time::Instant::now();
        let spawn = wsp
            // No DYLD override — whisper-cli is statically linked (see the
            // generate_transcript spawn for the full rationale).
            .args(whisper_cli_args(&model_str, &wav_path_str, &output_base_str, &lang, vad_model.as_deref()))
            .spawn();
        let (mut rx, child) = match spawn {
            Ok(c) => c,
            Err(e) => {
                let _ = std::fs::remove_file(&wav_path_for);
                emit_transcript_done(
                    &app_for, &job_for, false, None, None,
                    Some(format!("whisper-cli failed to spawn: {e}")),
                );
                return;
            }
        };
        app_for.state::<JobRegistry>().insert(job_for.clone(), child);

        let mut last_log_at = std::time::Instant::now() - std::time::Duration::from_secs(1);
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(b) | CommandEvent::Stderr(b) => {
                    let raw = String::from_utf8_lossy(&b).to_string();
                    for line in raw.lines() {
                        let line = line.trim_end();
                        if line.is_empty() { continue; }
                        let mut progress = false;
                        if let Some(pct) = parse_whisper_progress_line(line) {
                            let _ = app_for.emit("transcript-progress",
                                ProgressEvent { job_id: job_for.clone(), percent: pct });
                            progress = true;
                        }
                        if progress && last_log_at.elapsed().as_millis() < 500 { continue; }
                        if progress { last_log_at = std::time::Instant::now(); }
                        emit_transcript_log(&app_for, &job_for, "info", line.to_string());
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let _ = app_for.state::<JobRegistry>().take(&job_for);
                    emit_transcript_log(
                        &app_for, &job_for, "info",
                        format!("Whisper finished in {}.", fmt_elapsed(whisper_started.elapsed())),
                    );
                    let success = payload.code == Some(0);
                    let srt_path = format!("{}.srt", output_base_str);
                    let srt_exists = std::path::Path::new(&srt_path).exists();
                    let path = if success && srt_exists {
                        Some(srt_path.clone())
                    } else {
                        None
                    };
                    let mut error = if success {
                        if path.is_none() {
                            Some("whisper-cli exited 0 but no .srt was written".into())
                        } else {
                            None
                        }
                    } else if payload.signal.is_some() {
                        Some("Cancelled".into())
                    } else {
                        Some(format!("whisper-cli exited with code {:?}", payload.code))
                    };

                    // Optional speaker-diarization step. Runs only on the
                    // happy path (whisper succeeded + SRT on disk); WAV
                    // cleanup is deferred until after this so the diarizer
                    // has audio to chew on. A diarization failure does
                    // NOT fail the whole job — the user still gets the
                    // non-diarized SRT and a warning in the pipeline log.
                    // Skip diarization if Stop landed after whisper finished —
                    // the SRT is already saved; don't spend seconds labeling
                    // speakers nobody's waiting for.
                    if detect_speakers && path.is_some()
                        && !app_for.state::<JobRegistry>().is_cancelled(&job_for) {
                        emit_transcript_log(
                            &app_for, &job_for, "info",
                            format!(
                                "Speaker detection requested (expected={}). Spawning saucebunny-diarize…",
                                expected_speakers.map(|n| n.to_string()).unwrap_or_else(|| "auto".into()),
                            ),
                        );
                        if let Err(e) = run_diarize_and_merge(
                            &app_for, &job_for,
                            &wav_path_for, std::path::Path::new(&srt_path),
                            expected_speakers,
                        ).await {
                            emit_transcript_log(
                                &app_for, &job_for, "warn",
                                format!("Speaker detection failed — transcript saved without speaker labels. ({e})"),
                            );
                            // Stash the diarization warning in `error`
                            // for diagnostics. Whisper itself succeeded
                            // so success/path stay positive.
                            error = Some(format!("Diarization skipped: {e}"));
                        }
                    }

                    let _ = std::fs::remove_file(&wav_path_for);
                    app_for.state::<JobRegistry>().finish_job(&job_for);
                    emit_transcript_done(&app_for, &job_for, success && path.is_some(),
                                         payload.code, path, error);
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(job_id)
}

#[tauri::command]
pub async fn transcribe_local_file(
    app: AppHandle,
    args: TranscribeLocalArgs,
) -> Result<String, crate::AppError> {
    let in_path = PathBuf::from(&args.input_path);
    if !in_path.exists() {
        return Err(format!("File not found: {}", args.input_path).into());
    }
    let safe = sanitize_filename(&args.filename);
    if safe.is_empty() {
        return Err("Filename is empty".into());
    }
    let out_dir = PathBuf::from(&args.output_dir);
    if !out_dir.is_dir() {
        return Err("Output folder does not exist".into());
    }
    let model_p = model_path(&app, &args.model_id)?;
    if !model_p.exists() {
        return Err(format!(
            "Whisper model '{}' is not downloaded. Open Settings → Transcription.",
            args.model_id
        ).into());
    }

    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("app_cache_dir: {e}"))?;
    std::fs::create_dir_all(&cache).map_err(|e| format!("mkdir cache: {e}"))?;
    let wav_path = cache.join(format!("saucebunny-{}.wav", args.job_id));

    let in_path_str = in_path.to_string_lossy().to_string();
    let wav_path_str = wav_path.to_string_lossy().to_string();
    let model_str = model_p.to_string_lossy().to_string();
    let output_base = out_dir.join(&safe);
    let output_base_str = output_base.to_string_lossy().to_string();

    let job_id = args.job_id.clone();
    let job_for = job_id.clone();
    let app_for = app.clone();
    let wav_path_for = wav_path.clone();
    let detect_speakers = args.detect_speakers;
    let expected_speakers = args.expected_speakers;
    let engine = args.engine.clone().unwrap_or_default();
    let model_id = args.model_id.clone();
    let lang = normalize_whisper_lang(args.language.as_deref());

    tokio::spawn(async move {
        // Phase 1: ffmpeg → 16 kHz mono WAV (works for any video or audio in).
        emit_transcript_log(
            &app_for,
            &job_for,
            "info",
            format!("Normalising audio for {}…", in_path_str),
        );
        let ff = match app_for.shell().sidecar("ffmpeg") {
            Ok(c) => c,
            Err(e) => {
                emit_transcript_done(
                    &app_for, &job_for, false, None, None,
                    Some(format!("ffmpeg sidecar not found: {e}")),
                );
                return;
            }
        };
        let ff_out = ff
            .args(wav_16k_mono_args(&in_path_str, None, &wav_path_str))
            .output()
            .await;
        let ff_out = match ff_out {
            Ok(o) => o,
            Err(e) => {
                emit_transcript_done(
                    &app_for, &job_for, false, None, None,
                    Some(format!("ffmpeg failed to run: {e}")),
                );
                return;
            }
        };
        if !ff_out.status.success() {
            let stderr = String::from_utf8_lossy(&ff_out.stderr);
            let _ = std::fs::remove_file(&wav_path_for);
            emit_transcript_done(
                &app_for, &job_for, false, ff_out.status.code(), None,
                Some(format!("Audio conversion failed — {}", short_err(&stderr))),
            );
            return;
        }
        if !wav_path_for.exists() {
            emit_transcript_done(
                &app_for, &job_for, false, None, None,
                Some("WAV conversion produced no file".into()),
            );
            return;
        }
        // ffmpeg above ran via `.output().await` — no registered child to
        // kill — so a Stop during conversion is only visible here as the flag.
        if app_for.state::<JobRegistry>().is_cancelled(&job_for) {
            let _ = std::fs::remove_file(&wav_path_for);
            app_for.state::<JobRegistry>().finish_job(&job_for);
            emit_transcript_done(&app_for, &job_for, false, None, None, Some("Cancelled".into()));
            return;
        }

        // Phase 2 (Parakeet branch, r90) — see generate_transcript for rationale.
        if engine == "parakeet" {
            emit_transcript_log(&app_for, &job_for, "ok",
                "Audio ready — transcribing with Parakeet…".into());
            let srt = format!("{}.srt", output_base_str);
            if let Err(e) = run_parakeet_asr(&app_for, &job_for, &wav_path_for, &srt).await {
                let _ = std::fs::remove_file(&wav_path_for);
                let msg = e.to_string();
                if msg.contains("Cancelled") {
                    emit_transcript_done(&app_for, &job_for, false, None, None, Some("Cancelled".into()));
                } else {
                    emit_transcript_done(&app_for, &job_for, false, None, None,
                        Some(format!("Parakeet transcription failed — {msg}")));
                }
                return;
            }
            let mut warn_note: Option<String> = None;
            if detect_speakers
                && !app_for.state::<JobRegistry>().is_cancelled(&job_for) {
                if let Err(e) = run_diarize_and_merge(
                    &app_for, &job_for, &wav_path_for, std::path::Path::new(&srt), expected_speakers,
                ).await {
                    emit_transcript_log(&app_for, &job_for, "warn",
                        format!("Speaker detection failed — transcript saved without speaker labels. ({e})"));
                    warn_note = Some(format!("Diarization skipped: {e}"));
                }
            }
            let _ = std::fs::remove_file(&wav_path_for);
            app_for.state::<JobRegistry>().finish_job(&job_for);
            emit_transcript_done(&app_for, &job_for, true, Some(0), Some(srt), warn_note);
            return;
        }

        emit_transcript_log(
            &app_for, &job_for, "ok",
            "Audio ready — transcribing with Whisper…".into(),
        );

        // Phase 2: whisper-cli
        let _ = app_for.emit(
            "transcript-phase",
            TranscriptPhaseEvent { job_id: job_for.clone(), phase: "whisper".into() },
        );
        let wsp = match app_for.shell().sidecar("whisper-cli") {
            Ok(c) => c,
            Err(e) => {
                let _ = std::fs::remove_file(&wav_path_for);
                emit_transcript_done(
                    &app_for, &job_for, false, None, None,
                    Some(format!("whisper-cli sidecar not found: {e}")),
                );
                return;
            }
        };
        let vad_model = ensure_vad_model(&app_for).await
            .map(|p| p.to_string_lossy().to_string());
        if vad_model.is_some() {
            emit_transcript_log(&app_for, &job_for, "info",
                "Voice-activity detection on (Silero VAD).".into());
        }
        warn_if_english_only_mismatch(&app_for, &job_for, &model_id, &lang);
        // Stop pressed during the VAD fetch above? No whisper child existed to
        // kill, so honor the cancel here rather than transcribe regardless.
        if app_for.state::<JobRegistry>().is_cancelled(&job_for) {
            let _ = std::fs::remove_file(&wav_path_for);
            app_for.state::<JobRegistry>().finish_job(&job_for);
            emit_transcript_done(&app_for, &job_for, false, None, None, Some("Cancelled".into()));
            return;
        }
        // Wall clock for the pipeline log: users need to be able to read
        // (and paste back) how long a transcription actually took.
        let whisper_started = std::time::Instant::now();
        let spawn = wsp
            // No DYLD override — whisper-cli is statically linked (see the
            // generate_transcript spawn for the full rationale).
            .args(whisper_cli_args(&model_str, &wav_path_str, &output_base_str, &lang, vad_model.as_deref()))
            .spawn();
        let (mut rx, child) = match spawn {
            Ok(c) => c,
            Err(e) => {
                let _ = std::fs::remove_file(&wav_path_for);
                emit_transcript_done(
                    &app_for, &job_for, false, None, None,
                    Some(format!("whisper-cli failed to spawn: {e}")),
                );
                return;
            }
        };
        app_for.state::<JobRegistry>().insert(job_for.clone(), child);

        // We don't know total duration without re-probing; emit progress on
        // every segment but skip the percent (UI will show indeterminate).
        let mut last_log_at = std::time::Instant::now() - std::time::Duration::from_secs(1);
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(b) | CommandEvent::Stderr(b) => {
                    let raw = String::from_utf8_lossy(&b).to_string();
                    for line in raw.lines() {
                        let line = line.trim_end();
                        if line.is_empty() { continue; }
                        let mut progress = false;
                        if let Some(pct) = parse_whisper_progress_line(line) {
                            let _ = app_for.emit("transcript-progress",
                                ProgressEvent { job_id: job_for.clone(), percent: pct });
                            progress = true;
                        }
                        if progress && last_log_at.elapsed().as_millis() < 500 { continue; }
                        if progress { last_log_at = std::time::Instant::now(); }
                        emit_transcript_log(&app_for, &job_for, "info", line.to_string());
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let _ = app_for.state::<JobRegistry>().take(&job_for);
                    emit_transcript_log(
                        &app_for, &job_for, "info",
                        format!("Whisper finished in {}.", fmt_elapsed(whisper_started.elapsed())),
                    );
                    let success = payload.code == Some(0);
                    let srt = format!("{}.srt", output_base_str);
                    let srt_exists = std::path::Path::new(&srt).exists();
                    if success && srt_exists {
                        // Optional speaker-diarization step (see the
                        // matching block in transcribe_prepared_wav for
                        // the rationale + failure semantics).
                        let mut warn_note: Option<String> = None;
                        // Skip diarization if Stop landed after whisper finished
                        // — the SRT is saved; don't label speakers nobody's
                        // waiting for.
                        if detect_speakers
                            && !app_for.state::<JobRegistry>().is_cancelled(&job_for) {
                            emit_transcript_log(
                                &app_for, &job_for, "info",
                                format!(
                                    "Speaker detection requested (expected={}). Spawning saucebunny-diarize…",
                                    expected_speakers.map(|n| n.to_string()).unwrap_or_else(|| "auto".into()),
                                ),
                            );
                            if let Err(e) = run_diarize_and_merge(
                                &app_for, &job_for,
                                &wav_path_for, std::path::Path::new(&srt),
                                expected_speakers,
                            ).await {
                                emit_transcript_log(
                                    &app_for, &job_for, "warn",
                                    format!("Speaker detection failed — transcript saved without speaker labels. ({e})"),
                                );
                                warn_note = Some(format!("Diarization skipped: {e}"));
                            }
                        }
                        let _ = std::fs::remove_file(&wav_path_for);
                        app_for.state::<JobRegistry>().finish_job(&job_for);
                        emit_transcript_done(&app_for, &job_for, true, payload.code, Some(srt), warn_note);
                    } else {
                        let _ = std::fs::remove_file(&wav_path_for);
                        app_for.state::<JobRegistry>().finish_job(&job_for);
                        let msg = if !success {
                            if payload.signal.is_some() {
                                "Cancelled".to_string() // user Stop → SIGKILL, code is None
                            } else {
                                format!("whisper-cli exited with code {:?}", payload.code)
                            }
                        } else {
                            format!("Transcript not produced at {}", srt)
                        };
                        emit_transcript_done(&app_for, &job_for, false, payload.code, None, Some(msg));
                    }
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(job_id)
}

// ============================================================
// MERGE DIARIZATION INTO WHISPER SRT
//
// After Whisper writes a canonical SRT and the diarizer writes its
// JSON envelope, this stitches them together: for each Whisper cue,
// the diarizer turn with the most temporal overlap supplies the
// speaker label, and we re-emit the SRT with each cue's text
// prefixed by `[SPEAKER_XX] `.
//
// The text-prefix approach (rather than inventing an extended SRT
// dialect) means:
//   - the frontend's existing SRT parser picks up the speaker for
//     free — it already recognises `[SPEAKER_XX] text` from earlier
//     speculative diarization work in r29;
//   - users can drop the file into any other transcript tool (ASS
//     converters, Final Cut import, etc.) and the speaker labels
//     travel with the cue text instead of vanishing;
//   - we destroy zero information that whisper-cli's SRT held.
//
// The merge is sync + cheap (well under 50ms even for hour-long
// podcasts; both inputs are KB-scale, the algorithm is linear in
// the larger of the two).
// ============================================================

/// Speaker turn extracted from saucebunny-diarize JSON. Mirrors the
/// `turns[]` envelope the Swift sidecar writes.
struct DiarTurn {
    speaker: String,
    start: f64,
    end: f64,
}

fn parse_diarizer_json(raw: &str) -> Result<Vec<DiarTurn>, crate::AppError> {
    let v: serde_json::Value = serde_json::from_str(raw)?;
    let turns_arr = v
        .get("turns")
        .and_then(|x| x.as_array())
        .ok_or_else(|| crate::AppError::internal("diarizer json missing `turns` array"))?;
    let mut out = Vec::with_capacity(turns_arr.len());
    for t in turns_arr {
        let speaker = t.get("speaker").and_then(|x| x.as_str()).unwrap_or("SPEAKER_UNK");
        let start = t.get("start").and_then(|x| x.as_f64()).unwrap_or(0.0);
        let end = t.get("end").and_then(|x| x.as_f64()).unwrap_or(start);
        if end > start {
            out.push(DiarTurn { speaker: speaker.to_string(), start, end });
        }
    }
    Ok(out)
}

/// SRT timestamp `HH:MM:SS,mmm` → seconds. Returns None on garbage.
fn srt_tc_to_seconds(tc: &str) -> Option<f64> {
    // Format is fixed-width from whisper-cli; we still permit a dot
    // separator (VTT-style) just in case a future caller routes a VTT
    // through this function by mistake.
    let s = tc.trim();
    if s.len() < 9 { return None; }
    let bytes = s.as_bytes();
    let sep = bytes[8] as char;
    if sep != ',' && sep != '.' { return None; }
    let h:  u32 = s.get(0..2)?.parse().ok()?;
    let m:  u32 = s.get(3..5)?.parse().ok()?;
    let sc: u32 = s.get(6..8)?.parse().ok()?;
    let ms_str = &s[9..];
    let ms: u32 = ms_str.get(..3).and_then(|x| x.parse().ok())?;
    Some(h as f64 * 3600.0 + m as f64 * 60.0 + sc as f64 + ms as f64 / 1000.0)
}

fn seconds_to_srt_tc(secs: f64) -> String {
    let total_ms = (secs.max(0.0) * 1000.0).round() as u64;
    let h  = total_ms / 3_600_000;
    let m  = (total_ms / 60_000) % 60;
    let s  = (total_ms / 1000) % 60;
    let ms = total_ms % 1000;
    format!("{:02}:{:02}:{:02},{:03}", h, m, s, ms)
}

/// Re-base every cue timestamp in an SRT by `offset_s` seconds and return the
/// rewritten text. When a sub-range is cut for transcription (an in/out mark on
/// a web source, i.e. `generate_transcript`'s `cut_section` path), whisper writes
/// cue times relative to the cut, so the SRT starts at the mark-in instead of the
/// true source start. The player runs on the FULL source timeline, so captions,
/// the transcript highlight, and click-to-seek would all land off by exactly the
/// mark-in. Re-basing the cues to absolute source time fixes it on every playback
/// path. Identity when `offset_s <= 0` (full-source and "Fix accuracy" runs
/// already start at zero).
fn shift_srt_text(text: &str, offset_s: f64) -> String {
    if offset_s <= 0.0 {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    // split_inclusive keeps each line's trailing "\n" (or "\r\n") so non-timing
    // lines (numbers, text, blanks) pass through byte-for-byte.
    for line in text.split_inclusive('\n') {
        if let Some(arrow) = line.find(" --> ") {
            let after = &line[arrow + 5..]; // the second timestamp + any trailing
            let first = srt_tc_to_seconds(line[..arrow].trim());
            let second = after.get(..12).and_then(srt_tc_to_seconds);
            if let (Some(a), Some(b)) = (first, second) {
                out.push_str(&seconds_to_srt_tc(a + offset_s));
                out.push_str(" --> ");
                out.push_str(&seconds_to_srt_tc(b + offset_s));
                out.push_str(&after[12..]); // newline / VTT position metadata, kept
                continue;
            }
        }
        out.push_str(line);
    }
    out
}

fn shift_srt_file(path: &std::path::Path, offset_s: f64) -> std::io::Result<()> {
    if offset_s <= 0.0 {
        return Ok(());
    }
    let text = std::fs::read_to_string(path)?;
    std::fs::write(path, shift_srt_text(&text, offset_s))
}

#[cfg(test)]
mod diarization_cache_tests {
    use super::{atomic_write, diarization_sidecar_path};
    use std::path::Path;

    #[test]
    fn sidecar_path_sits_beside_the_srt() {
        let p = diarization_sidecar_path(Path::new("/x/Sauce Bunny/Transcripts/2026-07/My Clip.srt"));
        assert_eq!(p, Path::new("/x/Sauce Bunny/Transcripts/2026-07/My Clip.diarization.json"));
        // A dotted basename must not lose everything before the last dot.
        let d = diarization_sidecar_path(Path::new("/x/a.b.c.srt"));
        assert_eq!(d, Path::new("/x/a.b.c.diarization.json"));
    }

    #[test]
    fn atomic_write_lands_the_bytes_and_leaves_no_temp() {
        let dir = std::env::temp_dir().join(format!("sb-atomic-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("out.diarization.json");
        atomic_write(&dest, b"{\"turns\":[]}").unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "{\"turns\":[]}");
        // Overwrite must replace atomically and not leave the .part sibling.
        atomic_write(&dest, b"{\"turns\":[1]}").unwrap();
        assert_eq!(std::fs::read_to_string(&dest).unwrap(), "{\"turns\":[1]}");
        let mut part = dest.clone().into_os_string();
        part.push(".part");
        assert!(!Path::new(&part).exists(), "temp file must be renamed away, never left behind");
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod srt_shift_tests {
    use super::{seconds_to_srt_tc, shift_srt_text, srt_tc_to_seconds};

    #[test]
    fn srt_tc_roundtrip() {
        assert_eq!(srt_tc_to_seconds("00:00:01,500"), Some(1.5));
        assert_eq!(srt_tc_to_seconds("01:02:03,004"), Some(3723.004));
        assert_eq!(seconds_to_srt_tc(1.5), "00:00:01,500");
        assert_eq!(seconds_to_srt_tc(3723.004), "01:02:03,004");
    }

    #[test]
    fn shift_zero_or_negative_is_identity() {
        let srt = "1\n00:00:00,000 --> 00:00:02,000\nhello\n";
        assert_eq!(shift_srt_text(srt, 0.0), srt);
        assert_eq!(shift_srt_text(srt, -5.0), srt);
    }

    #[test]
    fn shift_rebases_cue_times_to_absolute() {
        // A sub-range transcript whose cues start at 0 is pushed forward by the
        // mark-in (10s) — both ends of every cue; text/numbers/blanks untouched.
        let srt = "1\n00:00:00,000 --> 00:00:02,500\nfirst line\n\n2\n00:00:02,500 --> 00:00:05,000\nsecond line\n";
        let shifted = shift_srt_text(srt, 10.0);
        assert!(shifted.contains("00:00:10,000 --> 00:00:12,500"));
        assert!(shifted.contains("00:00:12,500 --> 00:00:15,000"));
        assert!(shifted.contains("first line"));
        assert!(shifted.contains("second line"));
        assert!(shifted.starts_with("1\n"));
        assert!(shifted.contains("\n\n2\n"));
    }

    #[test]
    fn shift_handles_hour_rollover_and_crlf() {
        let srt = "1\r\n00:59:59,000 --> 01:00:01,000\r\ntext\r\n";
        let shifted = shift_srt_text(srt, 2.0);
        assert!(shifted.contains("01:00:01,000 --> 01:00:03,000"));
        assert!(shifted.contains("\r\ntext\r\n"));
    }
}

/// Walk the SRT cue by cue, stamp the best-overlap speaker on each,
/// and re-emit. Cue numbering is rebuilt from 1 because Whisper
/// occasionally skips numbers when it merges adjacent silent
/// segments — fresh numbering keeps the output canonical.
fn merge_diarization_into_srt(
    whisper_srt: &str,
    turns: &[DiarTurn],
) -> Result<String, crate::AppError> {
    if turns.is_empty() {
        return Err("diarizer returned zero turns".into());
    }
    // Sort turns by start once — lets us early-exit the overlap
    // search when we pass the cue's end (most cues fall in 2–3 turns).
    let mut sorted_turns: Vec<&DiarTurn> = turns.iter().collect();
    sorted_turns.sort_by(|a, b| a.start.partial_cmp(&b.start).unwrap_or(std::cmp::Ordering::Equal));

    // Normalise line endings; preserve everything else minimal.
    let normalised = whisper_srt.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = normalised.split('\n').collect();

    let mut out = String::with_capacity(whisper_srt.len() + (turns.len() * 16));
    let mut cue_num: u32 = 0;
    let mut i = 0;
    while i < lines.len() {
        // Skip leading blanks between cues.
        while i < lines.len() && lines[i].trim().is_empty() { i += 1; }
        if i >= lines.len() { break; }

        // Optional integer cue number. Whisper always emits it but
        // we don't depend on its value — we renumber from 1.
        if lines[i].trim().parse::<u64>().is_ok() {
            i += 1;
            if i >= lines.len() { break; }
        }

        // Timestamp line: `HH:MM:SS,mmm --> HH:MM:SS,mmm[ ...]`
        let tline = lines[i].trim();
        let arrow = match tline.find("-->") {
            Some(idx) => idx,
            None => { i += 1; continue; }
        };
        let start_s = match srt_tc_to_seconds(tline[..arrow].trim()) { Some(s) => s, None => { i += 1; continue; } };
        // Rest after `-->` may contain positioning hints; the timestamp
        // is always the first whitespace-separated token.
        let after = tline[arrow + 3..].trim();
        let end_token = after.split_whitespace().next().unwrap_or("");
        let end_s = match srt_tc_to_seconds(end_token) { Some(s) => s, None => { i += 1; continue; } };
        i += 1;

        // Text body — accumulate until next blank line / EOF.
        let mut body: Vec<&str> = Vec::new();
        while i < lines.len() && !lines[i].trim().is_empty() {
            body.push(lines[i]);
            i += 1;
        }
        let body_str = body.join(" ").trim().to_string();
        if body_str.is_empty() { continue; }
        // Re-diarizing a previously diarized SRT must not stack tags:
        // strip an existing "[TAG]: " prefix before writing the new one.
        let body_str = match body_str.strip_prefix('[') {
            Some(rest) => match rest.find("]:") {
                Some(close) => rest[close + 2..].trim_start().to_string(),
                None => body_str,
            },
            None => body_str,
        };
        if body_str.is_empty() { continue; }

        // Find the diarizer turn with the most overlap. Linear scan
        // bounded by the early-exit when a turn starts past cue end.
        let mut best_speaker: Option<&str> = None;
        let mut best_overlap = 0.0f64;
        for t in &sorted_turns {
            if t.start >= end_s { break; }
            if t.end <= start_s { continue; }
            let ov = end_s.min(t.end) - start_s.max(t.start);
            if ov > best_overlap {
                best_overlap = ov;
                best_speaker = Some(&t.speaker);
            }
        }
        let speaker = best_speaker.unwrap_or("SPEAKER_UNK");

        cue_num += 1;
        out.push_str(&cue_num.to_string());
        out.push('\n');
        out.push_str(&seconds_to_srt_tc(start_s));
        out.push_str(" --> ");
        out.push_str(&seconds_to_srt_tc(end_s));
        out.push('\n');
        // Canonical "[SPEAKER_NN]: text" prefix — colon explicit so
        // external SRT consumers and the in-app parser both recognise
        // the speaker tag. (Earlier versions wrote "] " with no colon
        // and the JS parser then silently dropped the tag.)
        out.push('[');
        out.push_str(speaker);
        out.push_str("]: ");
        out.push_str(&body_str);
        out.push_str("\n\n");
    }

    if cue_num == 0 {
        return Err("no cues parsed from Whisper SRT".into());
    }
    Ok(out)
}

/// Run saucebunny-diarize on `wav_path`, parse its output JSON, merge
/// the resulting speaker turns into `srt_path` (overwriting it),
/// and clean up the temp JSON. Emits pipeline log lines so the user
/// sees what's happening; the existing transcript-progress channel
/// is reserved for Whisper percent, not augmented here.
///
/// Errors are returned (not panicked) so callers can decide whether
/// to fall back to the non-diarized SRT.
// expected_speakers: None → let the model auto-estimate (current
// pyannote behaviour). Some(n) → passes through to the Swift sidecar
// as --num-speakers, which sets OfflineDiarizerConfig.clustering
// .numSpeakers and skips estimation entirely. Dramatically improves
// accuracy when the user actually knows the count.
/// Write bytes to `dest` via a sibling temp + rename, so a crash or an iCloud
/// sync race can't leave a truncated file. Same-volume rename is atomic on
/// macOS. Used for the single durable copies — the transcript SRT and its
/// diarization sidecar — where a half-written file is data loss, not a retry.
fn atomic_write(dest: &std::path::Path, contents: &[u8]) -> std::io::Result<()> {
    let mut tmp = dest.as_os_str().to_owned();
    tmp.push(".part");
    let tmp = std::path::PathBuf::from(tmp);
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, dest)
}

/// The diarization sidecar path for a transcript: `Foo.srt` → `Foo.diarization.json`,
/// co-located so it shares the SRT's fate (move, backup, iCloud eviction).
fn diarization_sidecar_path(srt_path: &std::path::Path) -> std::path::PathBuf {
    srt_path.with_extension("diarization.json")
}

async fn run_diarize_and_merge(
    app: &AppHandle,
    job_id: &str,
    wav_path: &std::path::Path,
    srt_path: &std::path::Path,
    expected_speakers: Option<u32>,
) -> Result<(), crate::AppError> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("app_cache_dir: {e}"))?;
    std::fs::create_dir_all(&cache).map_err(|e| format!("mkdir cache: {e}"))?;
    let diar_json = cache.join(format!("saucebunny-diarize-{}.json", job_id));
    let diar_json_str = diar_json.to_string_lossy().to_string();
    let wav_str = wav_path.to_string_lossy().to_string();

    let cmd = app
        .shell()
        .sidecar("saucebunny-diarize")
        .map_err(|e| format!(
            "saucebunny-diarize sidecar not bundled: {e}.\n\
             Run `npm run build:diarizer`."
        ))?;
    let mut diar_args: Vec<String> = vec![
        "--input".into(), wav_str,
        "--output".into(), diar_json_str.clone(),
        "--emit-progress".into(),
    ];
    if let Some(n) = expected_speakers {
        if n > 0 {
            diar_args.push("--num-speakers".into());
            diar_args.push(n.to_string());
            emit_transcript_log(
                app, job_id, "info",
                format!("Diarizer: hinting exactly {n} speakers."),
            );
        }
    }
    let (mut rx, child) = cmd
        .args(diar_args)
        .spawn()
        .map_err(|e| format!("failed to spawn saucebunny-diarize: {e}"))?;

    // Register the diarize child under the same job-id as the Whisper
    // run that just finished — the JobRegistry tracks "one child per
    // job-id at a time" so Stop hits whichever stage is currently
    // running (Whisper before, diarize now). The Whisper child was
    // already removed in the calling Terminated handler so there's no
    // collision.
    app.state::<JobRegistry>().insert(job_id.to_string(), child);

    // Emit explicit phase events so the Sidebar can label what's
    // happening RIGHT NOW without scraping pipeline-log strings.
    // Channels are job-scoped just like transcript-progress.
    let _ = app.emit(
        "transcript-phase",
        TranscriptPhaseEvent { job_id: job_id.to_string(), phase: "diarize-prepare".into() },
    );

    let mut stderr_tail = String::new();
    let mut announced_prepare = false;
    let mut announced_process = false;
    let mut cancelled = false;
    while let Some(event) = rx.recv().await {
        match event {
            CommandEvent::Stdout(b) => {
                // Newline-delimited progress JSON. We only care about
                // the `phase` field; surface a friendly pipeline line
                // once per phase so the log doesn't spam. Also fan out
                // a structured phase event for the Sidebar indicator.
                let raw = String::from_utf8_lossy(&b).to_string();
                for line in raw.lines() {
                    let trimmed = line.trim();
                    if trimmed.is_empty() { continue; }
                    if !announced_prepare && trimmed.contains("\"phase\":\"prepare\"") {
                        announced_prepare = true;
                        emit_transcript_log(
                            app, job_id, "info",
                            "Loading speaker-diarization models (first run downloads a few hundred MB)…".into(),
                        );
                    } else if !announced_process && trimmed.contains("\"phase\":\"process\"") {
                        announced_process = true;
                        let _ = app.emit(
                            "transcript-phase",
                            TranscriptPhaseEvent { job_id: job_id.to_string(), phase: "diarize-process".into() },
                        );
                        emit_transcript_log(
                            app, job_id, "info",
                            "Running diarization on audio…".into(),
                        );
                    }
                }
            }
            CommandEvent::Stderr(b) => {
                let raw = String::from_utf8_lossy(&b).to_string();
                stderr_tail.push_str(&raw);
                if stderr_tail.len() > 4096 {
                    // Round to a char boundary — from_utf8_lossy chunks can split
                    // a multibyte char (Swift '…' progress, etc.); byte-slicing
                    // mid-codepoint panics and hangs the diarize task.
                    let mut cut = stderr_tail.len() - 2048;
                    while cut < stderr_tail.len() && !stderr_tail.is_char_boundary(cut) { cut += 1; }
                    stderr_tail = stderr_tail[cut..].to_string();
                }
            }
            CommandEvent::Terminated(payload) => {
                let _ = app.state::<JobRegistry>().take(job_id);
                if payload.signal.is_some() {
                    // Stop / SIGTERM — distinguish so the caller can
                    // surface a friendlier "Diarization cancelled"
                    // pipeline message instead of an error toast.
                    cancelled = true;
                }
                if payload.code != Some(0) {
                    let _ = std::fs::remove_file(&diar_json);
                    if cancelled {
                        return Err("Cancelled".into());
                    }
                    let tail = stderr_tail.trim();
                    return Err(crate::AppError::SidecarFailed {
                        name: "saucebunny-diarize".into(),
                        exit_code: payload.code,
                        tail: tail.to_string(),
                    });
                }
                break;
            }
            _ => {}
        }
    }

    // Merge phase — instant but worth a phase event so the bar
    // doesn't show "Diarizing…" while we're already writing the SRT.
    let _ = app.emit(
        "transcript-phase",
        TranscriptPhaseEvent { job_id: job_id.to_string(), phase: "diarize-merge".into() },
    );

    // Load + merge + write.
    let json_raw = std::fs::read_to_string(&diar_json)
        .map_err(|e| { let _ = std::fs::remove_file(&diar_json); format!("read diarizer json: {e}") })?;
    let turns = parse_diarizer_json(&json_raw)?;

    // Verbose diagnostics — print BEFORE merge so the user sees what
    // the diarizer actually returned even if the merge later fails.
    // The single most common silent-failure mode is the diarizer
    // returning zero turns (e.g. on extremely short clips, or when
    // the model misfires); without this line, the user just sees
    // "No speakers in this transcript" with no clue why.
    let mut seen = std::collections::BTreeSet::new();
    for t in &turns { seen.insert(t.speaker.as_str()); }
    let unique_count = seen.len();
    emit_transcript_log(
        app, job_id, "ok",
        format!(
            "Diarizer returned {} segments across {} unique speakers.",
            turns.len(), unique_count,
        ),
    );
    if turns.is_empty() {
        // Don't try to merge an empty result — would leave the SRT
        // untouched, which the user reads as "diarization didn't run."
        // Return Err so the caller surfaces a clear warning.
        let _ = std::fs::remove_file(&diar_json);
        return Err("diarizer returned zero turns — likely a very short clip or audio with no detected speech".into());
    }

    let whisper_srt = std::fs::read_to_string(srt_path)
        .map_err(|e| { let _ = std::fs::remove_file(&diar_json); format!("read whisper srt: {e}") })?;
    let merged = merge_diarization_into_srt(&whisper_srt, &turns)?;
    atomic_write(srt_path, merged.as_bytes())
        .map_err(|e| { let _ = std::fs::remove_file(&diar_json); format!("write merged srt: {e}") })?;

    // CACHE the diarization beside the transcript instead of deleting it.
    // The sidecar already emits a versioned envelope (schema_version, model,
    // audio_seconds, turns[]); the merge only projects turns onto whisper's cue
    // grid, which is LOSSY (overlapping speakers and sub-cue boundaries
    // collapse and can't be recovered from the SRT). Persisting the raw
    // envelope means the speaker segmentation is saved with the transcript and
    // never has to be re-run. Co-located, so it moves and is evicted as one
    // unit with the SRT. NOTE: for a mark-range transcription the turns are in
    // the cut audio's 0-based timeline (the SRT cues get re-based by +start_s
    // afterwards via shift_srt_file); a future consumer must account for that.
    let diar_sidecar = diarization_sidecar_path(srt_path);
    if let Err(e) = atomic_write(&diar_sidecar, json_raw.as_bytes()) {
        emit_transcript_log(app, job_id, "warn",
            format!("Merged speakers into the SRT, but could not cache the diarization: {e}"));
    } else {
        emit_transcript_log(app, job_id, "ok",
            format!("Cached diarization beside the transcript ({} segments, {} speakers).",
                turns.len(), unique_count));
    }
    let _ = std::fs::remove_file(&diar_json);

    emit_transcript_log(
        app, job_id, "ok",
        format!("Merged speaker labels into SRT ({} speakers tagged across {} segments).",
                unique_count, turns.len()),
    );
    Ok(())
}

// ============================================================
// SPEAKER DIARIZATION (saucebunny-diarize sidecar — see swift-sidecar/)
//
// Two commands:
//
//  - `probe_diarizer`: synchronous smoke test. Runs `saucebunny-diarize
//    --version` and returns the output line. Used by Settings + the
//    command palette to confirm the Swift binary was built and is
//    callable. Tiny — no event channel.
//
//
// We deliberately keep the protocol JSON-line based (not a tight
// IPC binding) — easier to debug from a terminal (`./saucebunny-diarize
// --emit-progress --input … --output …`) and trivial to swap to a
// different diarizer in the future as long as it honours the same
// stdout/stderr/exit contract.
// ============================================================

#[derive(Serialize, Clone, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub(crate) struct DiarizeProgressEvent {
    pub(crate) job_id: String,
    /// Raw JSON line as emitted by the sidecar — e.g.
    /// `{"phase":"prepare","message":"Downloading…"}`. We forward
    /// verbatim and let the frontend parse the shape; that keeps
    /// the Rust side stable across sidecar schema bumps.
    pub(crate) line: String,
}

/// Synchronous --version probe. Used by Settings / the palette to
/// confirm the sidecar is built and callable before showing a
/// "Detect speakers" affordance.
///
/// Returns the single-line version string on success, e.g.
/// `"saucebunny-diarize 0.1.0 (FluidAudio 0.12.4)"`. On failure
/// returns a user-actionable error mentioning the build command,
/// because the most common failure is forgetting to run
/// `npm run build:diarizer` after cloning.
#[tauri::command]
pub async fn probe_diarizer(app: AppHandle) -> Result<String, crate::AppError> {
    let cmd = app
        .shell()
        .sidecar("saucebunny-diarize")
        .map_err(|e| format!(
            "saucebunny-diarize sidecar not bundled: {e}.\n\
             Run `npm run build:diarizer` from the project root."
        ))?;
    let out = cmd
        .args(["--version"])
        .output()
        .await
        .map_err(|e| format!("failed to spawn saucebunny-diarize: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(crate::AppError::SidecarFailed {
            name: "saucebunny-diarize".into(),
            exit_code: out.status.code(),
            tail: stderr.trim().to_string(),
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}


/// Pre-warm the FluidAudio Core ML model cache. Runs
/// `saucebunny-diarize --prepare-models --emit-progress` to trigger the
/// model download (a few hundred MB, one-time) without producing a
/// transcript. Streams `diarize-prepare-progress` events for the UI
/// to show a busy bar; emits `diarize-prepare-done` on exit.
///
/// Settings → Transcription wires this to a "Download speaker models"
/// button so users can get past the first-run pause proactively.
#[tauri::command]
pub async fn prepare_diarizer_models(app: AppHandle, job_id: String) -> Result<String, crate::AppError> {
    let cmd = app
        .shell()
        .sidecar("saucebunny-diarize")
        .map_err(|e| format!(
            "saucebunny-diarize sidecar not bundled: {e}.\n\
             Run `npm run build:diarizer`."
        ))?;
    let (mut rx, child) = cmd
        .args(["--prepare-models", "--emit-progress"])
        .spawn()
        .map_err(|e| format!("failed to spawn saucebunny-diarize: {e}"))?;

    // Register so Stop can cancel a mid-download warm-up.
    app.state::<JobRegistry>().insert(job_id.clone(), child);

    let job_for = job_id.clone();
    let app_for = app.clone();

    tokio::spawn(async move {
        let mut stderr_tail = String::new();
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(b) => {
                    let raw = String::from_utf8_lossy(&b).to_string();
                    for line in raw.lines() {
                        let trimmed = line.trim();
                        if trimmed.is_empty() { continue; }
                        let _ = app_for.emit(
                            "diarize-prepare-progress",
                            DiarizeProgressEvent {
                                job_id: job_for.clone(),
                                line: trimmed.to_string(),
                            },
                        );
                    }
                }
                CommandEvent::Stderr(b) => {
                    let raw = String::from_utf8_lossy(&b).to_string();
                    stderr_tail.push_str(&raw);
                    if stderr_tail.len() > 4096 {
                        // Round to a char boundary (see run_diarize_and_merge) —
                        // mid-codepoint byte-slicing panics and hangs the task.
                        let mut cut = stderr_tail.len() - 2048;
                        while cut < stderr_tail.len() && !stderr_tail.is_char_boundary(cut) { cut += 1; }
                        stderr_tail = stderr_tail[cut..].to_string();
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let _ = app_for.state::<JobRegistry>().take(&job_for);
                    let success = payload.code == Some(0);
                    let error = if success {
                        None
                    } else if payload.signal.is_some() {
                        Some("Cancelled".into())
                    } else {
                        let tail = stderr_tail.trim();
                        Some(format!(
                            "Model preparation failed (exit {:?}){}",
                            payload.code,
                            if tail.is_empty() { String::new() } else { format!(": {}", tail) }
                        ))
                    };
                    let _ = app_for.emit(
                        "diarize-prepare-done",
                        DoneEvent {
                            job_id: job_for.clone(),
                            success,
                            code: payload.code,
                            path: None,
                            error,
                        },
                    );
                    break;
                }
                _ => {}
            }
        }
    });

    Ok(job_id)
}

// ─── Nightly real-sidecar smoke (see src/nightly.rs; run with --ignored) ────
//
// Exercises `wav_16k_mono_args` + `whisper_cli_args` against the REAL bundled
// ffmpeg and whisper-cli. whisper.cpp is rebuilt from master by the nightly
// workflow, so a renamed/removed CLI flag or a broken SRT emit fails HERE
// instead of shipping silently.
#[cfg(test)]
mod nightly_transcript_tests {
    use super::{normalize_whisper_lang, wav_16k_mono_args, whisper_cli_args};
    use crate::nightly;

    #[test]
    #[ignore = "nightly: needs real sidecar binaries"]
    fn nightly_wav_conversion_produces_16k_mono() {
        let wav = nightly::fixture_speech_wav_16k(); // runs wav_16k_mono_args internally
        let probe = nightly::probe_json(&wav);
        let a = nightly::probe_stream(&probe, "audio").expect("wav has an audio stream");
        assert_eq!(a["codec_name"], "pcm_s16le", "whisper wants 16-bit PCM");
        assert_eq!(a["sample_rate"], "16000");
        assert_eq!(a["channels"], 1);
    }

    #[test]
    #[ignore = "nightly: needs real sidecar binaries"]
    fn nightly_wav_conversion_cut_section() {
        let aiff = nightly::fixture_speech_aiff();
        let out = nightly::scratch_dir().join("speech-cut.wav");
        let _ = std::fs::remove_file(&out);
        // The mark-in path: -ss 1.0 -t 2.0 must yield a ~2 s WAV.
        let args = wav_16k_mono_args(aiff.to_str().unwrap(), Some((1.0, 2.0)), out.to_str().unwrap());
        nightly::run_ok(&nightly::sidecar("ffmpeg"), &args, "cut-section wav conversion");
        let dur = nightly::probe_duration(&nightly::probe_json(&out));
        assert!((1.8..=2.3).contains(&dur), "expected ~2s cut, got {dur}s");
    }

    #[test]
    #[ignore = "nightly: needs real sidecar binaries"]
    fn nightly_whisper_cli_emits_srt() {
        let wav = nightly::fixture_speech_wav_16k();
        let model = nightly::whisper_model();
        let vad = nightly::vad_model();
        let base = nightly::scratch_dir().join("whisper-out");
        let srt = base.with_extension("srt");
        let _ = std::fs::remove_file(&srt);

        // Same normalization the commands run (r108); "en" exercises an
        // explicit language rather than auto-detect on a 5 s clip.
        let lang = normalize_whisper_lang(Some("en"));
        let args = whisper_cli_args(
            model.to_str().unwrap(),
            wav.to_str().unwrap(),
            base.to_str().unwrap(),
            &lang,
            Some(vad.to_str().unwrap()),
        );
        nightly::run_ok(&nightly::sidecar("whisper-cli"), &args, "whisper-cli transcription");

        // The contract the app depends on: `-osrt -of <base>` writes
        // `<base>.srt` with at least one timed, non-empty cue.
        let text = std::fs::read_to_string(&srt)
            .unwrap_or_else(|e| panic!("whisper-cli produced no SRT at {}: {e}", srt.display()));
        eprintln!("[nightly] whisper transcript:\n{text}");
        assert!(text.contains("-->"), "SRT has no cue timing lines:\n{text}");
        let has_spoken_text = text.lines().any(|l| {
            let t = l.trim();
            !t.is_empty() && !t.contains("-->") && t.parse::<u64>().is_err()
        });
        assert!(has_spoken_text, "SRT has cues but no text payload:\n{text}");
    }

    // Sharper diagnostics than the end-to-end run: every flag we pass must
    // still exist in whisper-cli's own help. If upstream renames one, this
    // names the exact casualty.
    #[test]
    #[ignore = "nightly: needs real sidecar binaries"]
    fn nightly_whisper_cli_recognizes_every_flag_we_pass() {
        let out = std::process::Command::new(nightly::sidecar("whisper-cli"))
            .arg("--help")
            .output()
            .expect("spawn whisper-cli --help");
        let help = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        let flags: Vec<String> = whisper_cli_args("M", "W", "O", "en", Some("V"))
            .into_iter()
            .filter(|a| a.starts_with('-'))
            .collect();
        assert!(flags.contains(&"-osrt".to_string()), "flag extraction is broken: {flags:?}");
        let missing: Vec<&String> = flags
            .iter()
            .filter(|f| !help.contains(&format!("{f},")) && !help.contains(&format!("{f} ")))
            .collect();
        assert!(
            missing.is_empty(),
            "whisper-cli no longer lists flags we pass: {missing:?} — upstream \
             rename? Fix whisper_cli_args and re-test the app.\n--help was:\n{help}"
        );
    }
}

