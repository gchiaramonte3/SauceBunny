//! Offline video intelligence, isolated from playback and existing transcription.
pub mod model;
mod audio;
use crate::{commands::{JobRegistry, LlmServer}, AppError};
use model::*;
use std::{collections::HashSet, path::PathBuf, sync::{atomic::{AtomicBool, Ordering}, Mutex}, time::Duration};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

#[derive(Default)]
pub struct VideoIntelligenceState {
    active: Mutex<Option<String>>,
    heavy: AtomicBool,
    foreground_windows: Mutex<HashSet<String>>,
}

struct JobGuard { app: AppHandle, id: String, reserved: bool }
impl JobGuard {
    fn begin(app: &AppHandle, id: &str, request: &VideoRequest) -> Result<Self, AppError> {
        if id.is_empty() || id.len() > 96 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
            return Err(AppError::invalid("Invalid video job ID"));
        }
        let state = app.state::<VideoIntelligenceState>();
        let mut active = state.active.lock().map_err(|_| AppError::internal("Video job lock unavailable"))?;
        let reserved = !request.read_only();
        if reserved {
            if active.is_some() { return Err(AppError::invalid("Video Intelligence is already working. Stop it first.")); }
            *active = Some(id.into());
            state.heavy.store(request.heavy(), Ordering::Release);
        }
        drop(active);
        let guard = Self { app: app.clone(), id: id.into(), reserved };
        check_cancelled(app, id)?;
        Ok(guard)
    }
}
impl Drop for JobGuard {
    fn drop(&mut self) {
        self.app.state::<JobRegistry>().finish_job(&self.id);
        if self.reserved {
            if let Ok(mut active) = self.app.state::<VideoIntelligenceState>().active.lock() { *active = None; }
        }
    }
}

fn check_cancelled(app: &AppHandle, id: &str) -> Result<(), AppError> {
    if app.state::<JobRegistry>().is_cancelled(id) { Err(AppError::Cancelled) } else { Ok(()) }
}

fn check_hardware(request: &VideoRequest) -> Result<(), AppError> {
    // The system sound classifier does not load an MLX model or need its memory budget.
    if !request.heavy() || request.native_audio() { return Ok(()); }
    if !cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        return Err(AppError::invalid("Video Intelligence requires an Apple Silicon Mac"));
    }
    #[cfg(target_os = "macos")]
    {
        let mut bytes: u64 = 0;
        let mut size = std::mem::size_of::<u64>();
        // Read-only kernel property; the output is an exactly sized u64.
        let result = unsafe { libc::sysctlbyname(c"hw.memsize".as_ptr(), (&mut bytes as *mut u64).cast(), &mut size, std::ptr::null_mut(), 0) };
        let minimum = if request.reasoning() { 24 } else { 16 };
        if result != 0 || bytes < minimum * 1024 * 1024 * 1024 {
            return Err(AppError::invalid(format!("This video model needs a Mac with at least {minimum} GB of memory")));
        }
    }
    Ok(())
}

/// Foreground AI takes priority before its cold model allocation begins.
/// Only this module's owned worker can be cancelled by this helper.
pub(crate) fn yield_video_background(app: &AppHandle) {
    let Some(state) = app.try_state::<VideoIntelligenceState>() else { return };
    if !state.heavy.load(Ordering::Acquire) { return; }
    let job = state.active.lock().ok().and_then(|active| active.clone());
    if let Some(job) = job {
        let registry = app.state::<JobRegistry>();
        registry.mark_cancelled(&job);
        for child in registry.take_job(&job) { let _ = child.kill(); }
    }
}

fn runtime(app: &AppHandle) -> Result<PathBuf, AppError> {
    let path = app.path().resource_dir().map_err(|e| AppError::internal(e.to_string()))?.join("video-runtime/saucebunny-video/saucebunny-video");
    #[cfg(debug_assertions)]
    let path = if path.is_file() { path } else {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("video-runtime/saucebunny-video/saucebunny-video")
    };
    if !path.is_file() { return Err(AppError::sidecar_missing("saucebunny-video")); }
    Ok(path)
}

fn audio_runtime(app: &AppHandle) -> Result<PathBuf, AppError> {
    let path = app.path().resource_dir().map_err(|e| AppError::internal(e.to_string()))?
        .join("audio-runtime/saucebunny-audio-analysis");
    #[cfg(debug_assertions)]
    let path = if path.is_file() { path } else {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../swift-sidecar/.build/debug/saucebunny-audio-analysis")
    };
    if !path.is_file() { return Err(AppError::sidecar_missing("saucebunny-audio-analysis")); }
    Ok(path)
}

fn foreground_busy(app: &AppHandle, own_key: &str) -> bool {
    let playback = app.state::<VideoIntelligenceState>().foreground_windows.lock().map(|mut windows| {
        // A closed detached player cannot leave the background worker blocked.
        windows.retain(|label| app.get_webview_window(label).is_some());
        !windows.is_empty()
    }).unwrap_or(true);
    playback
        || app.state::<JobRegistry>().active_ids().iter().any(|key| key != own_key && !key.ends_with("::video-read"))
        || app.state::<LlmServer>().has_process()
}

/// Playback has priority. The worker checkpoints each segment and can resume
/// after being yielded; this never pauses or stops the active media player.
#[tauri::command]
pub fn video_set_foreground_busy(app: AppHandle, window: tauri::WebviewWindow, busy: bool) -> Result<(), AppError> {
    let state = app.state::<VideoIntelligenceState>();
    let mut windows = state.foreground_windows.lock().map_err(|_| AppError::internal("Playback priority lock unavailable"))?;
    if busy { windows.insert(window.label().into()); } else { windows.remove(window.label()); }
    Ok(())
}

#[tauri::command]
pub async fn video_intelligence_run(app: AppHandle, job_id: String, request: VideoRequest) -> Result<VideoResponse, AppError> {
    request.validate()?;
    check_hardware(&request)?;
    let _guard = JobGuard::begin(&app, &job_id, &request)?;
    let key = JobRegistry::stage_key(&job_id, if request.read_only() { "video-read" } else { "video" });
    if request.heavy() && foreground_busy(&app, &key) {
        return Err(AppError::invalid(format!("Pause playback and finish transcription first. If a local text model is loaded, unload it in Video Intelligence settings.{}", request.saved_work_note())));
    }
    let root = app.path().app_data_dir().map_err(|e| AppError::internal(e.to_string()))?.join("video-intelligence");
    std::fs::create_dir_all(&root)?;
    let executable = if request.native_audio() { audio_runtime(&app)? } else { runtime(&app)? };
    let mut payload = serde_json::to_vec(&request)?;
    if payload.len() > 256 * 1024 { return Err(AppError::invalid("Video request is too large")); }
    payload.push(b'\n');
    check_cancelled(&app, &job_id)?;
    let args = if request.native_audio() { Vec::new() } else { vec!["--root".to_string(), root.to_string_lossy().into_owned()] };
    let (mut events, child) = app.shell().command(executable).args(args)
        .env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("HF_HUB_OFFLINE", "1").env("TRANSFORMERS_OFFLINE", "1").env("HF_HUB_DISABLE_TELEMETRY", "1")
        .spawn().map_err(|e| AppError::internal(format!("Cannot start Video Intelligence: {e}")))?;
    let registry = app.state::<JobRegistry>();
    registry.insert(key.clone(), child);
    check_cancelled(&app, &job_id)?;
    if !registry.write_stdin(&key, &payload) { return Err(AppError::internal("Cannot send request to the video worker")); }
    let mut result = None;
    let mut audio = audio::Collector::new(&request);
    let mut error = None;
    let mut stderr = String::new();
    let mut output_bytes: usize = 0;
    let mut heartbeat = tokio::time::interval(Duration::from_millis(200));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let timeout = tokio::time::sleep(Duration::from_secs(24 * 3600));
    tokio::pin!(timeout);
    loop {
        let event = tokio::select! {
            _ = &mut timeout => return Err(AppError::invalid(format!("Video job exceeded its 24-hour limit.{}", request.saved_work_note()))),
            _ = heartbeat.tick() => {
                check_cancelled(&app, &job_id)?;
                if request.heavy() && foreground_busy(&app, &key) {
                    return Err(AppError::invalid(format!("Video analysis yielded to playback or another task. Try again when ready.{}", request.saved_work_note())));
                }
                continue;
            },
            event = events.recv() => event,
        };
        match event {
            Some(CommandEvent::Stdout(bytes)) => {
                output_bytes += bytes.len();
                if output_bytes > 64 * 1024 * 1024 || bytes.len() > 8 * 1024 * 1024 {
                    return Err(AppError::invalid("Video worker output exceeded its safety limit"));
                }
                let packet: serde_json::Value = serde_json::from_slice(&bytes)
                    .map_err(|_| AppError::invalid("The video worker returned an invalid response"))?;
                if let Some(collector) = audio.as_mut() {
                    if !matches!(packet.get("type").and_then(|value| value.as_str()), Some("error" | "progress")) {
                        let (completed, total) = collector.push(packet)?;
                        let _ = app.emit("video-intelligence-progress", VideoProgress { job_id: job_id.clone(),
                            phase: "analyzing-audio".into(), completed, total });
                        continue;
                    }
                }
                match packet.get("type").and_then(|value| value.as_str()) {
                    Some("progress") => {
                        let phase = packet["phase"].as_str().unwrap_or("working");
                        if phase.len() > 64 { return Err(AppError::invalid("Invalid video progress")); }
                        let _ = app.emit("video-intelligence-progress", VideoProgress { job_id: job_id.clone(),
                            phase: phase.into(), completed: packet["completed"].as_u64().unwrap_or(0), total: packet["total"].as_u64().unwrap_or(0) });
                    },
                    Some("result") if result.is_none() => result = Some(serde_json::from_value::<VideoResponse>(packet)?),
                    Some("error") => error = Some(packet["message"].as_str().unwrap_or("Video analysis failed").to_owned()),
                    _ => return Err(AppError::invalid("Unknown video worker response")),
                }
            },
            Some(CommandEvent::Stderr(bytes)) => {
                stderr.push_str(&String::from_utf8_lossy(&bytes));
                if stderr.len() > 16384 { stderr = super::truncate_utf8_bytes(&stderr, 8192).into(); }
            },
            Some(CommandEvent::Terminated(status)) => {
                registry.take(&key);
                check_cancelled(&app, &job_id)?;
                if let Some(error) = error { return Err(AppError::invalid(error)); }
                if status.code != Some(0) || status.signal.is_some() {
                    log::warn!("Video worker failed: {}", super::truncate_utf8_bytes(&stderr, 2000));
                    return Err(AppError::invalid(format!("The local video worker stopped unexpectedly.{}", request.saved_work_note())));
                }
                if let Some(collector) = audio { return collector.finish(); }
                return result.ok_or_else(|| AppError::invalid("The video worker returned no result"));
            },
            Some(CommandEvent::Error(_)) | None => return Err(AppError::invalid(format!("The video worker disconnected.{}", request.saved_work_note()))),
            _ => {},
        }
    }
}
