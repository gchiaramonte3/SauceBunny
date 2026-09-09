//! Opt-in, loopback-only UXP companion bridge. This is deliberately separate
//! from the media proxy. Nothing here treats an NDI clock as sequence time.
//! A note is dispatched ONLY after an explicit editor confirmation, with its
//! captured binding, and after the dispatch record reaches durable storage.

use crate::AppError;
use serde::{Deserialize, Serialize};
use std::{path::{Path, PathBuf}, sync::{Arc, Mutex, OnceLock}, time::{Duration, SystemTime, UNIX_EPOCH}};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::watch;

const MAX_FILE_BYTES: usize = 32 * 1024 * 1024;
const MAX_NOTES: usize = 5000;
const PAIR_LIFETIME_MS: u64 = 5 * 60 * 1000;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PremiereBinding {
    pub binding_id: String,
    pub project_id: String,
    pub sequence_id: String,
    pub project_name: String,
    pub sequence_name: String,
    pub timebase_ticks: String,
    pub display_format: String,
    pub zero_point_ticks: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PremiereAnchor {
    pub binding: PremiereBinding,
    #[ts(type = "number")]
    pub captured_at: u64,
    pub source_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub stream_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub frame_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub media_seconds: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub sequence_ticks: Option<String>,
    #[ts(type = "'unverified' | 'verified'")]
    pub verification: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub reason: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PremiereMarkerRequest {
    pub review_key: String,
    pub version_id: String,
    pub comment_id: String,
    pub session_id: Option<String>,
    pub author: String,
    pub body: String,
    pub anchor: PremiereAnchor,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
#[serde(rename_all = "snake_case")]
pub enum PremiereMarkerState { NeedsConfirmation, Dispatching, Uncertain, Added, RemovedInPremiere }

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PremiereMarkerRecord {
    pub id: String,
    pub request: PremiereMarkerRequest,
    pub status: PremiereMarkerState,
    pub sequence_ticks: Option<String>,
    pub marker_guid: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct PremiereBridgeSnapshot {
    #[ts(type = "'off' | 'pairing' | 'connected'")]
    pub phase: String,
    pub binding: Option<PremiereBinding>,
    pub sync_enabled: bool,
    #[ts(type = "false")]
    pub automatic_placement: bool,
    pub pending_count: u32,
    pub other_binding_pending_count: u32,
    #[ts(type = "number")]
    pub ledger_revision: u64,
    pub error: Option<String>,
}

// Never Debug: the token must not accidentally reach logs.
#[derive(Clone, Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct PremierePairing {
    pub url: String,
    pub token: String,
    #[ts(type = "number")]
    pub expires_at: u64,
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Ledger { version: u32, notes: Vec<PremiereMarkerRecord> }

struct Bridge {
    path: PathBuf,
    ledger: Ledger,
    ledger_revision: u64,
    phase: String,
    binding: Option<PremiereBinding>,
    sync_enabled: bool,
    token: String,
    expires_at: u64,
    generation: u64,
    connected: bool,
    stop: Option<watch::Sender<bool>>,
    error: Option<String>,
}

pub struct PremiereBridge { inner: Mutex<Bridge> }
static INSTANCE: OnceLock<Arc<PremiereBridge>> = OnceLock::new();

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64
}

fn lock(bridge: &PremiereBridge) -> Result<std::sync::MutexGuard<'_, Bridge>, AppError> {
    bridge.inner.lock().map_err(|_| AppError::internal("Premiere bridge state unavailable"))
}

fn bounded(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max && !value.contains('\0')
}

fn ticks(value: &str, allow_negative: bool) -> bool {
    let digits = if allow_negative { value.strip_prefix('-').unwrap_or(value) } else { value };
    !digits.is_empty() && digits.len() <= 24 && digits.bytes().all(|c| c.is_ascii_digit())
}

impl PremiereBinding {
    fn validate(&self) -> Result<(), AppError> {
        if ![&self.binding_id, &self.project_id, &self.sequence_id].into_iter().all(|s| bounded(s, 128))
            || !bounded(&self.project_name, 512) || !bounded(&self.sequence_name, 512)
            || !bounded(&self.display_format, 128) || !ticks(&self.timebase_ticks, false)
            || self.timebase_ticks.bytes().all(|c| c == b'0') || !ticks(&self.zero_point_ticks, true) {
            return Err(AppError::invalid("Premiere sequence binding is incomplete or invalid"));
        }
        Ok(())
    }

    fn same_target(&self, other: &Self) -> bool {
        self.binding_id == other.binding_id && self.project_id == other.project_id
            && self.sequence_id == other.sequence_id && self.timebase_ticks == other.timebase_ticks
            && self.display_format == other.display_format && self.zero_point_ticks == other.zero_point_ticks
    }
}

impl PremiereMarkerRequest {
    fn validate(&self) -> Result<(), AppError> {
        self.anchor.binding.validate()?;
        let a = &self.anchor;
        if !bounded(&self.review_key, 4096) || !bounded(&self.version_id, 256)
            || !bounded(&self.comment_id, 256) || !bounded(&self.author, 512)
            || !bounded(&self.body, 16 * 1024) || !bounded(&a.source_id, 1024)
            || self.session_id.as_ref().is_some_and(|s| !bounded(s, 256))
            || a.frame_id.as_ref().is_some_and(|s| !bounded(s, 256))
            || a.stream_id.as_ref().is_some_and(|s| !bounded(s, 256))
            || a.reason.as_ref().is_some_and(|s| !bounded(s, 1024))
            || a.sequence_ticks.as_ref().is_some_and(|s| !ticks(s, false))
            || a.media_seconds.is_some_and(|s| !s.is_finite() || s < 0.0)
            || !matches!(a.verification.as_str(), "unverified" | "verified") {
            return Err(AppError::invalid("Premiere note exceeds a limit or has invalid timing metadata; the saved review note is unchanged"));
        }
        Ok(())
    }

    fn identity(&self) -> String {
        // Structured encoding avoids concatenation ambiguities across reviews.
        let identity = serde_json::Value::Array(vec![
            serde_json::Value::String(self.review_key.clone()),
            serde_json::Value::String(self.version_id.clone()),
            serde_json::Value::String(self.comment_id.clone()),
        ]).to_string();
        blake3::hash(identity.as_bytes()).to_hex().to_string()
    }
}

impl Bridge {
    fn open(path: PathBuf) -> Result<Self, AppError> {
        let mut ledger: Ledger = match std::fs::metadata(&path) {
            Ok(meta) if meta.len() <= MAX_FILE_BYTES as u64 => serde_json::from_slice(&std::fs::read(&path)?)
                .map_err(|_| AppError::invalid("Premiere marker queue could not be read. It was preserved; do not replace it with an empty queue."))?,
            Ok(_) => return Err(AppError::invalid("Premiere marker queue exceeds the safety limit; existing notes were preserved")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ledger { version: 1, notes: vec![] },
            Err(e) => return Err(e.into()),
        };
        if ledger.version != 1 || ledger.notes.len() > MAX_NOTES {
            return Err(AppError::invalid("Unsupported Premiere marker queue; existing notes were preserved"));
        }
        for note in &mut ledger.notes {
            note.request.validate()?;
            if note.id != note.request.identity() { return Err(AppError::invalid("Premiere queue identity mismatch; existing notes were preserved")); }
            if note.status == PremiereMarkerState::Dispatching {
                note.status = PremiereMarkerState::Uncertain;
                note.error = Some("Premiere delivery was interrupted. Reconcile the marker before confirming a retry.".into());
            }
        }
        Ok(Self { path, ledger, ledger_revision: 0, phase: "off".into(), binding: None, sync_enabled: false,
            token: String::new(), expires_at: 0, generation: 0, connected: false, stop: None, error: None })
    }

    fn snapshot(&self) -> PremiereBridgeSnapshot {
        let expired = self.phase == "pairing" && now_ms() >= self.expires_at;
        PremiereBridgeSnapshot { phase: self.phase.clone(), binding: self.binding.clone(), sync_enabled: self.sync_enabled,
            automatic_placement: false, pending_count: self.ledger.notes.iter().filter(|n| !matches!(n.status,
                PremiereMarkerState::Added | PremiereMarkerState::RemovedInPremiere)).count() as u32,
            other_binding_pending_count: self.ledger.notes.iter().filter(|n| !matches!(n.status,
                PremiereMarkerState::Added | PremiereMarkerState::RemovedInPremiere)
                && !self.binding.as_ref().is_some_and(|b| b.same_target(&n.request.anchor.binding))).count() as u32,
            ledger_revision: self.ledger_revision,
            error: self.error.clone().or_else(|| expired.then(|| "Pairing expired. Create a new pairing to reconnect Premiere.".into())) }
    }

    fn commit(&mut self, ledger: Ledger) -> Result<(), AppError> {
        let bytes = serde_json::to_vec(&ledger)?;
        if bytes.len() > MAX_FILE_BYTES || ledger.notes.len() > MAX_NOTES {
            return Err(AppError::invalid("Premiere queue is full. Existing notes remain saved; no queued note was discarded."));
        }
        atomic_write(&self.path, &bytes)?;
        self.ledger = ledger;
        self.ledger_revision = self.ledger_revision.saturating_add(1);
        Ok(())
    }

    fn enqueue(&mut self, request: PremiereMarkerRequest) -> Result<PremiereMarkerRecord, AppError> {
        request.validate()?;
        let id = request.identity();
        if let Some(existing) = self.ledger.notes.iter().find(|n| n.id == id) {
            // Editing/reply sync is out of scope. Never change a captured anchor
            // or redirect a delayed retry to a different binding.
            if existing.request != request {
                return Err(AppError::invalid("This note is already queued with different content or a different captured sequence. Its original marker request is unchanged."));
            }
            return Ok(existing.clone());
        }
        let record = PremiereMarkerRecord { id, request, status: PremiereMarkerState::NeedsConfirmation,
            sequence_ticks: None, marker_guid: None, error: None };
        let mut ledger = self.ledger.clone(); ledger.notes.push(record.clone()); self.commit(ledger)?;
        Ok(record)
    }

    fn confirm(&mut self, note_id: &str, binding: &PremiereBinding, sequence_ticks: &str, retry_confirmed: bool) -> Result<PremiereMarkerRecord, AppError> {
        if !self.sync_enabled || !self.connected { return Err(AppError::invalid("Enable marker sync in the paired Premiere companion first")); }
        if !ticks(sequence_ticks, false) { return Err(AppError::invalid("A valid sequence tick position is required")); }
        let mut ledger = self.ledger.clone();
        let note = ledger.notes.iter_mut().find(|n| n.id == note_id).ok_or_else(|| AppError::invalid("Unknown Premiere note"))?;
        self.require_binding(binding, &note.request.anchor.binding)?;
        match note.status {
            PremiereMarkerState::NeedsConfirmation => {},
            PremiereMarkerState::Uncertain if retry_confirmed => {},
            PremiereMarkerState::Uncertain => return Err(AppError::invalid("Delivery is uncertain. Reconcile existing markers and explicitly confirm a retry first.")),
            _ => return Err(AppError::invalid("This note was dispatched already. It will not be inserted again automatically.")),
        }
        note.status = PremiereMarkerState::Dispatching;
        note.sequence_ticks = Some(sequence_ticks.to_owned()); note.error = None;
        let result = note.clone(); self.commit(ledger)?; Ok(result)
    }

    fn require_binding(&self, binding: &PremiereBinding, captured: &PremiereBinding) -> Result<(), AppError> {
        if !binding.same_target(captured) || !self.binding.as_ref().is_some_and(|b| b.same_target(binding)) {
            return Err(AppError::invalid("The captured project/sequence binding is not active. Rebind that exact project and sequence; this note was not redirected."));
        }
        Ok(())
    }

    fn acknowledge(&mut self, note_id: &str, binding: &PremiereBinding, marker_guid: &str) -> Result<(), AppError> {
        if !bounded(marker_guid, 256) { return Err(AppError::invalid("Premiere must acknowledge a native marker GUID")); }
        let mut ledger = self.ledger.clone();
        let note = ledger.notes.iter_mut().find(|n| n.id == note_id).ok_or_else(|| AppError::invalid("Unknown Premiere note"))?;
        self.require_binding(binding, &note.request.anchor.binding)?;
        if note.status == PremiereMarkerState::Added {
            return if note.marker_guid.as_deref() == Some(marker_guid) { Ok(()) } else { Err(AppError::invalid("Marker identity does not match the saved acknowledgement")) };
        }
        if !matches!(note.status, PremiereMarkerState::Dispatching | PremiereMarkerState::Uncertain) {
            return Err(AppError::invalid("No marker transaction was dispatched for this note"));
        }
        note.status = PremiereMarkerState::Added; note.marker_guid = Some(marker_guid.to_owned()); note.error = None;
        self.commit(ledger)
    }

    fn disconnected(&mut self) -> Result<(), AppError> {
        self.connected = false; self.sync_enabled = false;
        self.phase = if self.stop.is_some() { "pairing" } else { "off" }.into();
        let mut ledger = self.ledger.clone(); let mut changed = false;
        for note in &mut ledger.notes {
            if note.status == PremiereMarkerState::Dispatching {
                note.status = PremiereMarkerState::Uncertain;
                note.error = Some("No durable marker acknowledgement was received. Check Premiere before retrying.".into()); changed = true;
            }
        }
        if changed { self.commit(ledger)?; } Ok(())
    }
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let parent = path.parent().ok_or_else(|| AppError::internal("Missing Premiere queue directory"))?;
    std::fs::create_dir_all(parent)?;
    let mut random = [0u8; 16]; getrandom::getrandom(&mut random).map_err(|_| AppError::internal("Cannot stage Premiere queue"))?;
    let staging = parent.join(format!(".premiere-markers-{}.tmp", hex::encode(random)));
    let write = || -> std::io::Result<()> {
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&staging)?;
        f.write_all(bytes)?; f.sync_all()?; std::fs::rename(&staging, path)?;
        std::fs::File::open(parent)?.sync_all()?; Ok(())
    };
    if let Err(e) = write() { let _ = std::fs::remove_file(staging); return Err(e.into()); }
    Ok(())
}

pub fn instance(app: &AppHandle) -> Result<Arc<PremiereBridge>, AppError> {
    if let Some(bridge) = INSTANCE.get() { return Ok(bridge.clone()); }
    let path = app.path().app_data_dir().map_err(|_| AppError::internal("Application data directory unavailable"))?.join("premiere-markers.json");
    let bridge = Arc::new(PremiereBridge { inner: Mutex::new(Bridge::open(path)?) });
    let _ = INSTANCE.set(bridge);
    INSTANCE.get().cloned().ok_or_else(|| AppError::internal("Cannot initialize Premiere bridge"))
}

fn publish(app: &AppHandle, bridge: &PremiereBridge) {
    if let Ok(state) = lock(bridge) { let _ = app.emit("premiere-bridge-changed", state.snapshot()); }
}

pub fn snapshot(app: &AppHandle) -> Result<PremiereBridgeSnapshot, AppError> {
    let bridge = instance(app)?; let snapshot = lock(&bridge)?.snapshot(); Ok(snapshot)
}
pub fn notes(app: &AppHandle) -> Result<Vec<PremiereMarkerRecord>, AppError> {
    let bridge = instance(app)?; let notes = lock(&bridge)?.ledger.notes.clone(); Ok(notes)
}
pub fn enqueue(app: &AppHandle, request: PremiereMarkerRequest) -> Result<PremiereMarkerRecord, AppError> {
    let bridge = instance(app)?;
    let (result, changed) = {
        let mut state = lock(&bridge)?; let previous = state.ledger_revision;
        let result = state.enqueue(request)?; (result, previous != state.ledger_revision)
    };
    if changed { publish(app, &bridge); } Ok(result)
}

pub fn shutdown() {
    if let Some(bridge) = INSTANCE.get() {
        if let Ok(mut state) = lock(bridge) {
            if let Some(stop) = state.stop.take() { let _ = stop.send(true); }
            state.generation += 1; state.token.clear(); state.binding = None;
            if let Err(e) = state.disconnected() { state.error = Some(e.to_string()); }
        }
    }
}

pub fn stop(app: &AppHandle) -> Result<(), AppError> { shutdown(); let bridge = instance(app)?; publish(app, &bridge); Ok(()) }

mod socket;
pub use socket::start;

#[cfg(test)]
mod tests;
