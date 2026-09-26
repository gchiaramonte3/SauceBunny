//! Local, bounded diagnostics, available even when import never creates a document.
//! No media samples, transcript text, network requests, or automatic uploads.
use super::{model::AafDocument, store};
use crate::AppError;
use serde::{Deserialize, Serialize};
use std::{collections::{BTreeSet, VecDeque}, future::Future, io::Write, path::{Path, PathBuf}, sync::Mutex, time::{Instant, SystemTime, UNIX_EPOCH}};
use tauri::{AppHandle, Emitter, Manager};

const MAX_ROWS: usize = 1500;
const MAX_FILE_BYTES: u64 = 1024 * 1024;
static JOURNAL: Mutex<Option<Journal>> = Mutex::new(None);
static NEXT_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

pub fn new_id() -> String {
    format!("{}-{}-{}", std::process::id(), SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_nanos()),
        NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
}

#[derive(Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AafDiagnosticEvent {
    pub id: String,
    #[ts(type = "number")]
    pub timestamp_ms: u64,
    pub job_id: String,
    pub level: String,
    pub stage: String,
    pub message: String,
    /// Only operation boundaries change activity. Subprocess stages do not.
    pub active: Option<bool>,
}

#[derive(Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AafDiagnostics {
    pub events: Vec<AafDiagnosticEvent>,
    pub active_jobs: Vec<String>,
    pub persistence_error: Option<String>,
    pub context: String,
}

struct Journal {
    path: PathBuf,
    rows: VecDeque<AafDiagnosticEvent>,
    active: BTreeSet<String>,
    error: Option<String>,
}

/// AAF locators can contain URL credentials. Keep paths useful for relinking,
/// but remove URL userinfo, query strings, fragments and terminal controls.
fn clean(value: &str) -> String {
    let bounded: String = value.chars().filter(|c| !c.is_control() || *c == '\n' || *c == '\t').take(4000).collect();
    bounded.split_inclusive(char::is_whitespace).map(|word| {
        let Some(scheme) = word.find("://") else { return word.to_owned(); };
        let authority_start = scheme + 3;
        let end = word[authority_start..].find('/').map_or(word.len(), |n| n + authority_start);
        let mut safe = word.to_owned();
        if let Some(at) = word[authority_start..end].rfind('@') {
            safe.replace_range(authority_start..authority_start + at + 1, "[redacted]@");
        }
        if let Some(index) = safe.find(['?', '#']) { safe.truncate(index); safe.push_str("[redacted]"); }
        safe
    }).collect()
}

impl Journal {
    fn open(path: PathBuf) -> Self {
        let mut journal = Self { path, rows: VecDeque::new(), active: BTreeSet::new(), error: None };
        for path in [journal.path.with_extension("previous.jsonl"), journal.path.clone()] {
            // Never read an unexpectedly large or non-regular diagnostic file.
            match std::fs::metadata(&path) {
                Ok(meta) if meta.is_file() && meta.len() <= MAX_FILE_BYTES + 32_768 => {
                    match std::fs::read_to_string(path) {
                        Ok(text) => for line in text.lines() {
                            if let Ok(row) = serde_json::from_str::<AafDiagnosticEvent>(line) { journal.push(row); }
                        },
                        Err(error) => journal.error = Some(error.to_string()),
                    }
                }
                Ok(_) => journal.error = Some("Saved diagnostic log exceeded its safety bound; it was not loaded.".into()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
                Err(error) => journal.error = Some(error.to_string()),
            }
        }
        journal
    }

    fn push(&mut self, row: AafDiagnosticEvent) {
        self.rows.push_back(row);
        while self.rows.len() > MAX_ROWS { self.rows.pop_front(); }
    }

    fn append(&mut self, row: AafDiagnosticEvent) {
        match row.active {
            Some(true) => { self.active.insert(row.job_id.clone()); },
            Some(false) => { self.active.remove(&row.job_id); },
            None => {},
        }
        let saved = self.persist(&row);
        if let Err(error) = saved { self.error = Some(error.to_string()); }
        self.push(row);
    }

    fn persist(&self, row: &AafDiagnosticEvent) -> Result<(), AppError> {
        if let Some(parent) = self.path.parent() { std::fs::create_dir_all(parent)?; }
        let mut bytes = serde_json::to_vec(row)?;
        bytes.push(b'\n');
        if std::fs::metadata(&self.path).is_ok_and(|m| m.len() + bytes.len() as u64 > MAX_FILE_BYTES) {
            // Two rolling logs, each at most 1 MiB. This is diagnostic retention,
            // not a source-media limit. Only our own previous log is replaced.
            std::fs::rename(&self.path, self.path.with_extension("previous.jsonl"))?;
        }
        std::fs::OpenOptions::new().create(true).append(true).open(&self.path)?.write_all(&bytes)?;
        Ok(())
    }
}

fn path(app: &AppHandle) -> Result<PathBuf, AppError> {
    Ok(app.path().app_log_dir().map_err(|e| AppError::internal(e.to_string()))?.join("multitrack.jsonl"))
}

fn with_journal<T>(app: &AppHandle, action: impl FnOnce(&mut Journal) -> T) -> Result<T, AppError> {
    let mut guard = JOURNAL.lock().map_err(|_| AppError::internal("Diagnostic log lock unavailable"))?;
    let path = path(app)?;
    Ok(action(guard.get_or_insert_with(|| Journal::open(path))))
}

fn record(app: &AppHandle, job: &str, level: &str, stage: &str, message: &str, active: Option<bool>) {
    let row = AafDiagnosticEvent {
        id: new_id(),
        timestamp_ms: SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64),
        job_id: clean(job), level: level.into(), stage: clean(stage), message: clean(message), active,
    };
    // Reporting must never turn a playable recording into a failed operation.
    let _ = with_journal(app, |journal| journal.append(row.clone()));
    let _ = app.emit("aaf-diagnostic", row);
}

pub fn log(app: &AppHandle, job: &str, level: &str, stage: &str, message: &str) {
    record(app, job, level, stage, message, None);
}

pub async fn operation<T>(app: &AppHandle, job: &str, stage: &str, description: &str,
    work: impl Future<Output = Result<T, AppError>>) -> Result<T, AppError> {
    record(app, job, "info", stage, description, Some(true));
    let started = Instant::now();
    let result = work.await;
    let (level, outcome) = match &result {
        Ok(_) => ("ok", "Completed".into()),
        Err(AppError::Cancelled) => ("warn", "Stopped; committed transcripts are retained".into()),
        Err(AppError::SidecarFailed { name, exit_code, .. }) if stage == "transcribe" =>
            ("err", format!("{name} exit {exit_code:?}; recognizer output omitted from diagnostics")),
        Err(error) => ("err", error.to_string()),
    };
    record(app, job, level, stage, &format!("{outcome} · {} ms", started.elapsed().as_millis()), Some(false));
    result
}

pub fn describe_path(path: &Path) -> String {
    match std::fs::metadata(path) {
        Ok(meta) => format!("{} · {} bytes · regular file: {}", path.display(), meta.len(), meta.is_file()),
        Err(error) => format!("{} · metadata failed: {error}", path.display()),
    }
}

fn document_context(document: &AafDocument) -> serde_json::Value {
    serde_json::json!({ "id": document.id, "schema_version": document.schema_version,
        "source_path": document.source_path, "source_size": document.source_size,
        "source_modified_ms": document.source_modified_ms, "manifest": document.manifest,
        // Transcript CONTENT and editable person/cast labels are not diagnostics.
        "committed_transcript_count": document.transcripts.len() })
}

fn sanitize_context(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(text) => *text = clean(text),
        serde_json::Value::Array(values) => values.iter_mut().for_each(sanitize_context),
        serde_json::Value::Object(values) => values.values_mut().for_each(sanitize_context),
        _ => {},
    }
}

#[tauri::command]
pub async fn aaf_diagnostics(app: AppHandle, document_id: Option<String>) -> Result<AafDiagnostics, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let document = document_id.map(|id| match store::root(&app).and_then(|root| store::load(&root, &id)) {
            Ok(doc) => document_context(&doc),
            Err(error) => serde_json::json!({ "id": id, "read_error": error.to_string() }),
        });
        // Metadata already saved by the importer; no server scan or media probe
        // while exporting. Offline/disconnected mounts cannot block the report.
        let mut context = serde_json::json!({
            "app_version": app.package_info().version.to_string(), "bundle_version": app.config().bundle.macos.bundle_version,
            "build_id": crate::commands::system::BACKEND_BUILD_ID,
            "os": std::env::consts::OS, "architecture": std::env::consts::ARCH,
            "log_path": path(&app)?.to_string_lossy(), "document": document,
        });
        sanitize_context(&mut context);
        let context = serde_json::to_string_pretty(&context)?;
        with_journal(&app, |journal| AafDiagnostics { events: journal.rows.iter().cloned().collect(),
            active_jobs: journal.active.iter().cloned().collect(), persistence_error: journal.error.clone(), context })
    }).await.map_err(|e| AppError::internal(e.to_string()))?
}

#[tauri::command]
pub async fn aaf_clear_diagnostics(app: AppHandle) -> Result<(), AppError> {
    with_journal(&app, |journal| -> Result<(), AppError> {
        for path in [&journal.path, &journal.path.with_extension("previous.jsonl")] {
            match std::fs::remove_file(path) {
                Ok(()) => {}, Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}, Err(error) => return Err(error.into()),
            }
        }
        journal.rows.clear(); journal.error = None;
        Ok(())
    })?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn removes_url_credentials_and_controls_without_hiding_media_paths() {
        assert_eq!(clean("file://person:password@Server/Media/test.mxf?secret=x"), "file://[redacted]@Server/Media/test.mxf[redacted]");
        assert_eq!(clean("/Volumes/Media/Show #2/a.mxf\0"), "/Volumes/Media/Show #2/a.mxf");
    }
    #[test]
    fn journal_reopens_failed_imports_rotates_and_does_not_restore_running_jobs() {
        let dir = std::env::temp_dir().join(format!("aaf-log-{}", uuid::Uuid::new_v4()));
        let path = dir.join("multitrack.jsonl");
        let mut journal = Journal::open(path.clone());
        for i in 0..1600 {
            journal.append(AafDiagnosticEvent { id: i.to_string(), timestamp_ms: i, job_id: "test".into(), level: "err".into(), stage: "import".into(), message: "x".repeat(3900), active: Some(true) });
        }
        assert_eq!(journal.rows.len(), MAX_ROWS);
        assert!(journal.error.is_none());
        for p in [&path, &path.with_extension("previous.jsonl")] { assert!(std::fs::metadata(p).unwrap().len() <= MAX_FILE_BYTES); }
        let reopened = Journal::open(path);
        assert_eq!(reopened.rows.back().unwrap().id, "1599");
        assert!(reopened.active.is_empty());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
