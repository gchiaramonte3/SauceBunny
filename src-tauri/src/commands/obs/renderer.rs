//! Renderer intent ownership, separate from raw generations and process lifetime.
//! Opening/closing a settings dialog only reads this registry; only explicit
//! start creates a sender. The native supervisor still owns teardown and reap.
use std::{collections::HashMap, sync::{Mutex, OnceLock}};
use serde::Serialize;
use super::{BroadcastFailure, BroadcastHandle, BroadcastStatus};
use crate::AppError;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum ObsBroadcastPhase { Off, Starting, Live, Stopping, Stopped, Error }

#[derive(Clone, Debug, PartialEq, Eq, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ObsBroadcastStatus {
    pub source_id: String,
    /// Renderer intent counter only; never an OBS raw-output generation.
    #[ts(type = "number")]
    pub attempt: u64,
    pub phase: ObsBroadcastPhase,
    pub error: Option<String>,
    /// Cleanup proof is independent of failure. Omitted when no authoritative
    /// proof is available, including synchronous startup admission failures.
    #[serde(skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub cleanup_confirmed: Option<bool>,
}

trait Owner {
    fn current(&self) -> BroadcastStatus;
    fn cancel(&self);
}
impl Owner for BroadcastHandle {
    fn current(&self) -> BroadcastStatus {
        let status = self.status();
        let value = *status.borrow();
        if status.has_changed().is_err() && matches!(value, BroadcastStatus::Starting | BroadcastStatus::Live | BroadcastStatus::Stopping) {
            BroadcastStatus::Failed { reason: BroadcastFailure::CleanupUnconfirmed, cleanup: super::CleanupProof::default() }
        } else { value }
    }
    fn cancel(&self) { BroadcastHandle::cancel(self); }
}
struct Entry<H> {
    attempt: u64,
    cancelled_through: u64,
    cancelled: bool,
    owner: Option<H>,
    state: BroadcastStatus,
    startup_failed: bool,
}
impl<H: Owner> Entry<H> {
    fn stopped(attempt: u64) -> Self {
        Self { attempt, cancelled_through: attempt, cancelled: true, owner: None,
            state: BroadcastStatus::Stopped, startup_failed: false }
    }
    fn refresh(&mut self) {
        if let Some(owner) = self.owner.as_ref() { self.state = owner.current(); }
        // A quarantined child remains owned. Other failed cleanup is still
        // reported truthfully; the raw actor/native permit controls retry.
        if matches!(self.state, BroadcastStatus::Stopped | BroadcastStatus::Failed {
            cleanup: super::CleanupProof { child_reaped: true, .. }, .. }) { self.owner.take(); }
    }
    fn cleanup_confirmed(&self) -> Option<bool> {
        // begin() can fail after scheduling asynchronous raw-feed cleanup.
        // An absent owner from that path is not proof of cleanup completion.
        (!self.startup_failed).then(||match self.state {
            BroadcastStatus::Stopped => true,
            BroadcastStatus::Failed { cleanup, .. } => cleanup.complete(),
            _ => false,
        })
    }
    fn snapshot(&mut self, id: &str) -> ObsBroadcastStatus {
        self.refresh();
        let cleanup_confirmed = self.cleanup_confirmed();
        let (phase, error) = if self.startup_failed {
            (ObsBroadcastPhase::Error, Some("NDI broadcasting could not start. Check the application preview and included sender."))
        } else {
            match self.state {
                BroadcastStatus::Starting | BroadcastStatus::Live if self.cancelled => (ObsBroadcastPhase::Stopping, None),
                BroadcastStatus::Starting => (ObsBroadcastPhase::Starting, None),
                BroadcastStatus::Live => (ObsBroadcastPhase::Live, None),
                BroadcastStatus::Stopping => (ObsBroadcastPhase::Stopping, None),
                BroadcastStatus::Stopped => (ObsBroadcastPhase::Stopped, None),
                BroadcastStatus::Failed { reason, cleanup } => (ObsBroadcastPhase::Error, Some(if !cleanup.complete() {
                    "NDI broadcasting ended, but cleanup could not be confirmed."
                } else { match reason {
                    BroadcastFailure::SourceStopped => "The application preview stopped. NDI broadcasting ended.",
                    BroadcastFailure::SdkUnavailable => "The included NDI runtime is unavailable.",
                    BroadcastFailure::StartupTimeout | BroadcastFailure::ReadTimeout => "NDI broadcasting stopped because picture or audio did not arrive in time.",
                    BroadcastFailure::ShutdownTimeout => "NDI broadcasting required forced shutdown.",
                    _ => "NDI broadcasting failed. The application preview was not stopped.",
                } })),
            }
        };
        ObsBroadcastStatus { source_id: id.to_owned(), attempt: self.attempt, phase, error: error.map(str::to_owned), cleanup_confirmed }
    }
}
struct Registry<H> { entries: HashMap<String, Entry<H>> }
impl<H: Owner> Default for Registry<H> { fn default() -> Self { Self { entries: HashMap::new() } } }
impl<H: Owner> Registry<H> {
    fn prune(&mut self, available: impl Fn(&str) -> bool) {
        self.entries.retain(|id, entry| {
            entry.refresh();
            // Forgetting an entry makes later reads report a confirmed Off.
            // Ownership release alone does not establish every cleanup barrier.
            entry.owner.is_some() || available(id) || entry.cleanup_confirmed() != Some(true)
        });
    }
    fn status(&mut self, id: &str) -> ObsBroadcastStatus {
        self.entries.get_mut(id).map(|entry|entry.snapshot(id)).unwrap_or_else(||ObsBroadcastStatus {
            source_id: id.to_owned(), attempt: 0, phase: ObsBroadcastPhase::Off, error: None, cleanup_confirmed: Some(true),
        })
    }
    fn capacity(&self, id: &str) -> Result<(), AppError> {
        if !self.entries.contains_key(id) && self.entries.len() >= 2 {
            return Err(AppError::invalid("NDI senders are still running or closing"));
        }
        Ok(())
    }
    fn start(&mut self, id: &str, attempt: u64, begin: impl FnOnce() -> Result<H, AppError>) -> Result<ObsBroadcastStatus, AppError> {
        self.capacity(id)?;
        if let Some(entry) = self.entries.get_mut(id) {
            entry.refresh();
            if attempt == entry.attempt { return Ok(entry.snapshot(id)); }
            if attempt < entry.attempt || attempt <= entry.cancelled_through {
                return Err(AppError::invalid("This NDI broadcast request is no longer current"));
            }
            if entry.owner.is_some() { return Err(AppError::invalid("Stop the current NDI broadcast before starting another")); }
        }
        let cancelled_through = self.entries.get(id).map_or(0, |entry|entry.cancelled_through);
        // No await occurs between admission, native handle creation and storing
        // its owner. A concurrent stop is serialized by this same mutex.
        let owner = begin().ok();
        let mut entry = Entry { attempt, cancelled_through, cancelled: false,
            startup_failed: owner.is_none(), owner, state: BroadcastStatus::Starting };
        let result = entry.snapshot(id);
        self.entries.insert(id.to_owned(), entry);
        Ok(result)
    }
    fn stop(&mut self, id: &str, attempt: u64) -> Result<ObsBroadcastStatus, AppError> {
        self.capacity(id)?;
        let entry = self.entries.entry(id.to_owned()).or_insert_with(||Entry::stopped(attempt));
        entry.refresh();
        entry.cancelled_through = entry.cancelled_through.max(attempt);
        if attempt == entry.attempt {
            entry.cancelled = true;
            if let Some(owner) = entry.owner.as_ref() { owner.cancel(); }
        } else if attempt > entry.attempt && entry.owner.is_none() {
            *entry = Entry::stopped(attempt);
        }
        // Future cancellation is a bounded watermark, not permission to stop
        // an older active owner; stale cancellation never touches a newer one.
        Ok(entry.snapshot(id))
    }
}
fn registry() -> &'static Mutex<Registry<BroadcastHandle>> {
    static VALUE: OnceLock<Mutex<Registry<BroadcastHandle>>> = OnceLock::new();
    VALUE.get_or_init(||Mutex::new(Registry::default()))
}
fn validate(id: &str, attempt: Option<u64>) -> Result<(), AppError> {
    if !super::super::ndi::valid_program_id(id) || attempt.is_some_and(|value| !(1..=super::raw_control::MAX_GENERATION).contains(&value)) {
        return Err(AppError::invalid("Invalid application broadcast request"));
    }
    Ok(())
}
fn available(id: &str) -> bool { super::super::ndi::find_program(id).is_some_and(|program|program.is_application_capture()) }
pub(super) fn status(id: &str) -> Result<ObsBroadcastStatus, AppError> {
    validate(id, None)?;
    let mut registry = registry().lock().map_err(|_|AppError::internal("NDI broadcast controls are unavailable"))?;
    // Preserve the requested source's final result long enough for its owner to
    // observe it, while releasing unrelated completed source entries.
    registry.prune(|source|source == id || available(source));
    Ok(registry.status(id))
}
pub(super) fn start(id: &str, attempt: u64) -> Result<ObsBroadcastStatus, AppError> {
    validate(id, Some(attempt))?;
    if !available(id) { return Err(AppError::invalid("Select a running application preview before broadcasting")); }
    let mut registry = registry().lock().map_err(|_|AppError::internal("NDI broadcast controls are unavailable"))?;
    registry.prune(available);
    registry.start(id, attempt, ||super::begin_broadcast(id))
}
pub(super) fn stop(id: &str, attempt: u64) -> Result<ObsBroadcastStatus, AppError> {
    validate(id, Some(attempt))?;
    let mut registry = registry().lock().map_err(|_|AppError::internal("NDI broadcast controls are unavailable"))?;
    registry.prune(|source|source == id || available(source));
    if !registry.entries.contains_key(id) && !available(id) {
        return Ok(Entry::<BroadcastHandle>::stopped(attempt).snapshot(id));
    }
    registry.stop(id, attempt)
}

#[cfg(test)]
#[path = "renderer_tests.rs"]
mod tests;
