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
//!   - Diarizer wrapping: `probe_diarizer`, `run_diarizer`,
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

fn whisper_models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    let dir = base.join("models").join("whisper");
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir models: {e}"))?;
    Ok(dir)
}

fn model_path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    Ok(whisper_models_dir(app)?.join(format!("ggml-{id}.bin")))
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
                        error: Some(e),
                    },
                );
            }
        }
    });

    Ok(args.job_id)
}

async fn download_with_progress(
    app: &AppHandle,
    url: &str,
    dest: &PathBuf,
    job_id: &str,
    model_id: &str,
) -> Result<(), String> {
    let mut res = reqwest::get(url)
        .await
        .map_err(|e| format!("fetch: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status().as_u16()));
    }
    let total = res.content_length().unwrap_or(0);
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

    let section = format!("*{:.3}-{:.3}", start_s, end_s);
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
        // ─── Phase 1: yt-dlp downloads raw bestaudio (no post-processing) ───
        emit_transcript_log(
            &app_for,
            &job_for,
            "info",
            format!("Downloading audio for {} → {}…", args.start, args.end),
        );

        let yt = match app_for.shell().sidecar("yt-dlp") {
            Ok(c) => c,
            Err(e) => {
                emit_transcript_done(
                    &app_for, &job_for, false, None, None,
                    Some(format!("yt-dlp sidecar not found: {e}")),
                );
                return;
            }
        };

        let mut yt_args: Vec<String> = vec![
            "--download-sections".into(),
            section.clone(),
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

        let yt_out = match yt.env("PATH", HOMEBREW_PATH).args(yt_args).output().await {
            Ok(o) => o,
            Err(e) => {
                emit_transcript_done(
                    &app_for, &job_for, false, None, None,
                    Some(format!("yt-dlp failed to run: {e}")),
                );
                return;
            }
        };

        if !yt_out.status.success() {
            let stderr = String::from_utf8_lossy(&yt_out.stderr);
            // humanize_ytdlp_error maps "Sign in to confirm you're not a
            // bot" / age-restricted / video-unavailable to actionable text
            // pointing at Settings → YouTube auth. Falls through to the
            // first non-empty stderr line for anything else.
            emit_transcript_done(
                &app_for, &job_for, false, yt_out.status.code(), None,
                Some(humanize_ytdlp_error(&stderr)),
            );
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
        let ff_out = ff
            .args([
                "-y", "-i", &raw_path_str,
                "-vn", "-ar", "16000", "-ac", "1",
                &wav_path_str,
            ])
            .output()
            .await;
        let _ = std::fs::remove_file(&raw_path); // raw no longer needed
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

        // Safety net for the dyld @rpath issue: whisper-cli is built with
        // rpath `@loader_path/../lib`, which only resolves correctly when
        // the binary lives in /opt/homebrew/bin. If the bundled copy lost
        // its patched rpath for any reason, this env var still lets dyld
        // find libwhisper.dylib in the Homebrew prefix.
        let spawn = wsp
            .env("DYLD_LIBRARY_PATH", "/opt/homebrew/lib")
            .env("DYLD_FALLBACK_LIBRARY_PATH", "/opt/homebrew/lib")
            .args([
                "-m",
                &model_str,
                "-f",
                &wav_path_str,
                "-osrt",
                "-of",
                &output_base_str,
                "-l",
                "en",
                "-pp", // print progress
            ])
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
                    let success = payload.code == Some(0);
                    let srt = format!("{}.srt", output_base_str);
                    let srt_exists = std::path::Path::new(&srt).exists();
                    if success && srt_exists {
                        // Optional speaker-diarization step (see the
                        // matching block in transcribe_prepared_wav for
                        // the full rationale). WAV cleanup is deferred.
                        let mut warn_note: Option<String> = None;
                        if detect_speakers {
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
                        let msg = if !success {
                            format!("whisper-cli exited with code {:?}", payload.code)
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
        // existing transcribe_local_file phase-2 block; consolidate
        // these into one helper when we touch this file next.
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
        let spawn = wsp
            .env("DYLD_LIBRARY_PATH", "/opt/homebrew/lib")
            .env("DYLD_FALLBACK_LIBRARY_PATH", "/opt/homebrew/lib")
            .args([
                "-m", &model_str,
                "-f", &wav_path_str,
                "-osrt",
                "-of", &output_base_str,
                "-l", "en",
                "-pp",
            ])
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
                    if detect_speakers && path.is_some() {
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
            .args([
                "-y", "-i", &in_path_str,
                "-vn", "-ar", "16000", "-ac", "1",
                &wav_path_str,
            ])
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
        let spawn = wsp
            .env("DYLD_LIBRARY_PATH", "/opt/homebrew/lib")
            .env("DYLD_FALLBACK_LIBRARY_PATH", "/opt/homebrew/lib")
            .args([
                "-m", &model_str,
                "-f", &wav_path_str,
                "-osrt",
                "-of", &output_base_str,
                "-l", "en",
                "-pp",
            ])
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
                    let success = payload.code == Some(0);
                    let srt = format!("{}.srt", output_base_str);
                    let srt_exists = std::path::Path::new(&srt).exists();
                    if success && srt_exists {
                        // Optional speaker-diarization step (see the
                        // matching block in transcribe_prepared_wav for
                        // the rationale + failure semantics).
                        let mut warn_note: Option<String> = None;
                        if detect_speakers {
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
                        emit_transcript_done(&app_for, &job_for, true, payload.code, Some(srt), warn_note);
                    } else {
                        let _ = std::fs::remove_file(&wav_path_for);
                        let msg = if !success {
                            format!("whisper-cli exited with code {:?}", payload.code)
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

/// Walk the SRT cue by cue, stamp the best-overlap speaker on each,
/// and re-emit. Cue numbering is rebuilt from 1 because Whisper
/// occasionally skips numbers when it merges adjacent silent
/// segments — fresh numbering keeps the output canonical.
fn merge_diarization_into_srt(
    whisper_srt: &str,
    turns: &[DiarTurn],
) -> Result<String, String> {
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
                    let cut = stderr_tail.len() - 2048;
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
    std::fs::write(srt_path, merged)
        .map_err(|e| { let _ = std::fs::remove_file(&diar_json); format!("write merged srt: {e}") })?;
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
//  - `run_diarizer`: async run on a WAV file. Spawns the sidecar,
//    streams its newline-delimited progress JSON on `diarize-progress`,
//    forwards stderr lines as `diarize-log`, emits `diarize-done` on
//    exit. Mirrors the Whisper job pattern so the eventual UI plumbing
//    in B.2 can reuse the same event-listener shape.
//
// We deliberately keep the protocol JSON-line based (not a tight
// IPC binding) — easier to debug from a terminal (`./saucebunny-diarize
// --emit-progress --input … --output …`) and trivial to swap to a
// different diarizer in the future as long as it honours the same
// stdout/stderr/exit contract.
// ============================================================

#[derive(Deserialize)]
pub struct DiarizeArgs {
    /// Caller-generated UUID — used to multiplex events on the
    /// diarize-* channels when multiple diarize jobs could run
    /// concurrently. Today only one runs at a time, but the channel
    /// is wired for the future.
    pub job_id: String,
    /// Absolute path to a WAV (or any audio readable by FluidAudio
    /// via AVFoundation: m4a / mp3 / aac work too). Existence is
    /// checked here; format errors surface from the sidecar.
    pub input_wav: String,
    /// Absolute path where the JSON envelope should land. Existing
    /// file is overwritten atomically by the sidecar.
    pub output_json: String,
}

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

/// Run diarization on a local audio file. Non-blocking — emits events
/// on `diarize-progress` / `diarize-log` / `diarize-done` and returns
/// the job_id immediately so the frontend can subscribe.
///
/// First call on a fresh machine downloads FluidAudio's Core ML models
/// to ~/.cache/fluidaudio/Models/ (~few hundred MB). Subsequent calls
/// hit the cache and complete in 10–60s for a typical podcast.
#[tauri::command]
pub async fn run_diarizer(app: AppHandle, args: DiarizeArgs) -> Result<String, crate::AppError> {
    if !PathBuf::from(&args.input_wav).is_file() {
        return Err(format!("input file not found: {}", args.input_wav).into());
    }
    // Verify the output dir exists (the sidecar writes atomically
    // via NSData.write but won't create missing intermediates).
    if let Some(parent) = PathBuf::from(&args.output_json).parent() {
        if !parent.as_os_str().is_empty() && !parent.is_dir() {
            return Err(format!("output directory does not exist: {}", parent.display()).into());
        }
    }

    let cmd = app
        .shell()
        .sidecar("saucebunny-diarize")
        .map_err(|e| format!(
            "saucebunny-diarize sidecar not bundled: {e}.\n\
             Run `npm run build:diarizer` from the project root."
        ))?;

    let (mut rx, _child) = cmd
        .args([
            "--input", &args.input_wav,
            "--output", &args.output_json,
            "--emit-progress",
        ])
        .spawn()
        .map_err(|e| format!("failed to spawn saucebunny-diarize: {e}"))?;

    let job_id = args.job_id.clone();
    let job_for = job_id.clone();
    let app_for = app.clone();
    let output_path = args.output_json.clone();

    tokio::spawn(async move {
        while let Some(event) = rx.recv().await {
            match event {
                CommandEvent::Stdout(b) => {
                    // The sidecar emits newline-delimited JSON status
                    // lines on stdout. We forward verbatim — the frontend
                    // parses the `phase` field.
                    let raw = String::from_utf8_lossy(&b).to_string();
                    for line in raw.lines() {
                        let trimmed = line.trim();
                        if trimmed.is_empty() { continue; }
                        let _ = app_for.emit(
                            "diarize-progress",
                            DiarizeProgressEvent {
                                job_id: job_for.clone(),
                                line: trimmed.to_string(),
                            },
                        );
                    }
                }
                CommandEvent::Stderr(b) => {
                    let raw = String::from_utf8_lossy(&b).to_string();
                    for line in raw.lines() {
                        let trimmed = line.trim_end();
                        if trimmed.is_empty() { continue; }
                        let _ = app_for.emit(
                            "diarize-log",
                            LogEvent {
                                job_id: job_for.clone(),
                                stream: "stderr".into(),
                                tag: classify_line(trimmed),
                                line: trimmed.to_string(),
                            },
                        );
                    }
                }
                CommandEvent::Terminated(payload) => {
                    let success = payload.code == Some(0);
                    let error = if success {
                        None
                    } else {
                        Some(match payload.code {
                            Some(1) => "diarizer: bad arguments".into(),
                            Some(2) => "diarizer: model preparation failed (network or disk)".into(),
                            Some(3) => "diarizer: audio processing failed".into(),
                            Some(4) => "diarizer: failed to write output JSON".into(),
                            other   => format!("diarizer exited with code {other:?}"),
                        })
                    };
                    let _ = app_for.emit(
                        "diarize-done",
                        DoneEvent {
                            job_id: job_for.clone(),
                            success,
                            code: payload.code,
                            path: if success { Some(output_path.clone()) } else { None },
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
                        let cut = stderr_tail.len() - 2048;
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

