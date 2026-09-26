//! Cancellable, bounded subprocess ownership for the AAF pipeline.
use super::model::AafProgress;
use crate::{commands::JobRegistry, AppError};
use std::{collections::HashSet, sync::Mutex, time::Duration};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_shell::{process::CommandEvent, ShellExt};

static ACTIVE_JOBS: Mutex<Option<HashSet<String>>> = Mutex::new(None);
static RESOLVING_DOCUMENTS: Mutex<Option<HashSet<String>>> = Mutex::new(None);

pub struct ResolutionGuard(String);
impl ResolutionGuard {
    pub fn begin(document: &str) -> Result<Self, AppError> {
        let mut documents = RESOLVING_DOCUMENTS.lock().map_err(|_| AppError::internal("Media resolution lock unavailable"))?;
        if !documents.get_or_insert_with(HashSet::new).insert(document.into()) {
            return Err(AppError::invalid("This document's media is already being checked. Stop that check before relinking."));
        }
        Ok(Self(document.into()))
    }
}
impl Drop for ResolutionGuard {
    fn drop(&mut self) {
        if let Ok(mut documents) = RESOLVING_DOCUMENTS.lock() {
            if let Some(documents) = documents.as_mut() { documents.remove(&self.0); }
        }
    }
}

pub struct JobGuard { app: AppHandle, id: String }
impl JobGuard {
    pub fn begin(app: &AppHandle, id: &str) -> Result<Self, AppError> {
        if id.is_empty() || id.len() > 96 || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
            return Err(AppError::invalid("Invalid AAF job ID"));
        }
        let mut jobs = ACTIVE_JOBS.lock().map_err(|_| AppError::internal("AAF job lock unavailable"))?;
        if !jobs.get_or_insert_with(HashSet::new).insert(id.to_owned()) {
            return Err(AppError::invalid("This AAF job is already running"));
        }
        drop(jobs);
        let guard = Self { app: app.clone(), id: id.to_owned() };
        check_cancelled(app, id)?;
        Ok(guard)
    }
}
impl Drop for JobGuard {
    fn drop(&mut self) {
        self.app.state::<JobRegistry>().finish_job(&self.id);
        if let Ok(mut jobs) = ACTIVE_JOBS.lock() {
            if let Some(jobs) = jobs.as_mut() { jobs.remove(&self.id); }
        }
    }
}

pub fn check_cancelled(app: &AppHandle, job: &str) -> Result<(), AppError> {
    if app.state::<JobRegistry>().is_cancelled(job) { Err(AppError::Cancelled) } else { Ok(()) }
}

/// Await work that cannot be cancelled itself (blocking reads on a network
/// volume), polling Stop so a stalled mount cannot hold the job until the SMB
/// timeout. Abandoned reads finish or fail on their own threads; nothing waits.
pub async fn until_cancelled<T>(app: &AppHandle, job: &str, work: impl std::future::Future<Output = T>) -> Result<T, AppError> {
    tokio::pin!(work);
    let mut poll = tokio::time::interval(Duration::from_millis(250));
    loop {
        tokio::select! {
            output = &mut work => return Ok(output),
            _ = poll.tick() => check_cancelled(app, job)?,
        }
    }
}

pub fn progress(app: &AppHandle, job: &str, track: Option<&str>, phase: &str, completed: i64, total: i64) {
    if app.state::<JobRegistry>().is_cancelled(job) { return; }
    let _ = app.emit("aaf-progress", AafProgress {
        job_id: job.to_owned(), track_id: track.map(str::to_owned), phase: phase.to_owned(),
        completed_frames: completed, total_frames: total,
    });
}

pub struct ProcessResult { pub code: Option<i32>, pub stdout: String, pub stderr: String }
impl ProcessResult {
    pub fn require_success(&self, name: &str) -> Result<(), AppError> {
        if self.code == Some(0) { Ok(()) } else {
            Err(AppError::SidecarFailed { name: name.to_owned(), exit_code: self.code,
                tail: crate::commands::truncate_utf8_bytes(self.stderr.trim(), 2_000).to_owned() })
        }
    }
}

pub async fn run(app: &AppHandle, job: &str, stage: &str, name: &str, args: Vec<String>) -> Result<ProcessResult, AppError> {
    run_with_timeout(app, job, stage, name, args, Duration::from_secs(15 * 60)).await
}

pub async fn run_with_timeout(app: &AppHandle, job: &str, stage: &str, name: &str, args: Vec<String>, timeout: Duration) -> Result<ProcessResult, AppError> {
    let started = std::time::Instant::now();
    super::diagnostics::log(app, job, "info", stage, &format!("Starting {name}"));
    let result = run_inner(app, job, stage, name, args, timeout).await;
    let (level, message) = match &result {
        Ok(output) if output.code == Some(0) => ("ok", format!("{name} completed")),
        Ok(output) if stage == "asr" => ("err", format!("{name} exit {:?}; recognizer output omitted from diagnostics", output.code)),
        Ok(output) => ("err", format!("{name} exit {:?}: {}", output.code, output.stderr.trim())),
        Err(AppError::Cancelled) => ("warn", format!("{name} stopped")),
        Err(error) => ("err", format!("{name}: {error}")),
    };
    super::diagnostics::log(app, job, level, stage, &format!("{message} · {} ms", started.elapsed().as_millis()));
    result
}

async fn run_inner(app: &AppHandle, job: &str, stage: &str, name: &str, args: Vec<String>, timeout_duration: Duration) -> Result<ProcessResult, AppError> {
    check_cancelled(app, job)?;
    // The frozen reader extracts its private runtime here. A cancelled bootloader
    // cannot leave an unbounded _MEI directory in the system temp folder.
    let temporary = super::audio::WorkDir::new(app, job)?;
    let command = app.shell().sidecar(name).map_err(|_| AppError::sidecar_missing(name))?;
    let (mut rx, child) = command.args(args).env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .env("TMPDIR", temporary.0.to_string_lossy().as_ref())
        .spawn().map_err(|e| AppError::internal(format!("Cannot start {name}: {e}")))?;
    let registry = app.state::<JobRegistry>();
    let key = JobRegistry::stage_key(job, stage);
    registry.insert(key.clone(), child);
    // A Stop between the pre-spawn check and insert must kill the newly owned child.
    if registry.is_cancelled(job) {
        if let Some(child) = registry.take(&key) { let _ = child.kill(); }
        return Err(AppError::Cancelled);
    }
    let timeout = tokio::time::sleep(timeout_duration);
    tokio::pin!(timeout);
    let mut result = ProcessResult { code: None, stdout: String::new(), stderr: String::new() };
    loop {
        let event = tokio::select! {
            event = rx.recv() => event,
            _ = &mut timeout => {
                if let Some(child) = registry.take(&key) { let _ = child.kill(); }
                return Err(AppError::internal(format!("{name} exceeded its {}-minute stage limit", timeout_duration.as_secs() / 60)));
            }
        };
        match event {
            Some(CommandEvent::Stdout(bytes)) => {
                // The same ceiling a saved document has. At 16 MiB a heavily cut
                // multi-mic sequence (about 35,000 audio clips) could never be
                // imported, far below what validate_manifest itself accepts.
                if (result.stdout.len() + bytes.len()) as u64 > super::store::MAX_DOCUMENT_BYTES {
                    if let Some(child) = registry.take(&key) { let _ = child.kill(); }
                    return Err(AppError::invalid("AAF worker output exceeded its safety limit"));
                }
                result.stdout.push_str(&String::from_utf8_lossy(&bytes));
                result.stdout.push('\n');
            }
            Some(CommandEvent::Stderr(bytes)) => {
                if stage == "inspect-mxf" {
                    for line in String::from_utf8_lossy(&bytes).lines() {
                        if let Some(json) = line.strip_prefix("AAF_MXF_EVENT ") {
                            // One row per file: start rows doubled the count and
                            // pushed an import's opening out of the bounded log.
                            if let Some(event) = serde_json::from_str::<MxfEvent>(json).ok().filter(|e| e.phase == "finish") {
                                let detail = format!("{} audio mappings · {} ms{}", event.tracks.unwrap_or(0), event.elapsed_ms.unwrap_or(0), event.error.as_ref().map(|e| format!(" · {e}")).unwrap_or_default());
                                super::diagnostics::log(app, job, if event.error.is_some() { "warn" } else { "info" }, "mxf-file", &format!("{} · {detail}", event.path));
                            }
                        }
                    }
                }
                result.stderr.push_str(&String::from_utf8_lossy(&bytes));
                result.stderr.push('\n');
                if result.stderr.len() > 65_536 {
                    let mut start = result.stderr.len() - 32_768;
                    while !result.stderr.is_char_boundary(start) { start += 1; }
                    result.stderr.drain(..start);
                }
            }
            Some(CommandEvent::Terminated(payload)) => {
                registry.take(&key);
                check_cancelled(app, job)?;
                result.code = payload.code;
                if payload.signal.is_some() {
                    return Err(AppError::SidecarFailed { name: name.into(), exit_code: payload.code,
                        tail: "Worker terminated before producing a complete result".into() });
                }
                return Ok(result);
            }
            Some(CommandEvent::Error(error)) => {
                if let Some(child) = registry.take(&key) { let _ = child.kill(); }
                check_cancelled(app, job)?;
                return Err(AppError::internal(format!("{name}: {error}")));
            }
            None => {
                if let Some(child) = registry.take(&key) { let _ = child.kill(); }
                check_cancelled(app, job)?;
                return Err(AppError::internal(format!("{name} closed without an exit status")));
            }
            _ => {}
        }
    }
}

#[derive(serde::Deserialize)]
struct MxfEvent { path: String, phase: String, elapsed_ms: Option<u64>, tracks: Option<usize>, error: Option<String> }
