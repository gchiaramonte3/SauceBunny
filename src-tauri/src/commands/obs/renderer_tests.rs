use super::*;
use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};

#[derive(Clone)]
struct FakeOwner { state: Arc<Mutex<BroadcastStatus>>, cancels: Arc<AtomicUsize> }
impl FakeOwner {
    fn new() -> Self { Self { state: Arc::new(Mutex::new(BroadcastStatus::Starting)), cancels: Arc::new(AtomicUsize::new(0)) } }
    fn set(&self, state: BroadcastStatus) { *self.state.lock().unwrap() = state; }
    fn count(&self) -> usize { self.cancels.load(Ordering::Acquire) }
}
impl Owner for FakeOwner {
    fn current(&self) -> BroadcastStatus { *self.state.lock().unwrap() }
    fn cancel(&self) { self.cancels.fetch_add(1, Ordering::AcqRel); }
}
fn complete() -> super::super::CleanupProof { super::super::CleanupProof { child_reaped: true, raw_stopped: true, pipe_eof: true } }

#[test]
fn reads_and_duplicate_starts_never_create_or_cancel_another_sender() {
    let mut registry = Registry::<FakeOwner>::default();
    assert_eq!(registry.status("source").phase, ObsBroadcastPhase::Off);
    assert!(registry.entries.is_empty());
    let owner = FakeOwner::new();
    assert_eq!(registry.start("source", 1, ||Ok(owner.clone())).unwrap().phase, ObsBroadcastPhase::Starting);
    for _ in 0..3 {
        assert_eq!(registry.start("source", 1, ||panic!("duplicate start")).unwrap().attempt, 1);
        registry.status("source");
    }
    owner.set(BroadcastStatus::Live);
    assert_eq!(registry.status("source").phase, ObsBroadcastPhase::Live);
    assert_eq!(owner.count(), 0, "polling/closing a settings surface does not own cancellation");
}
#[test]
fn cancellation_before_start_blocks_late_creation_and_new_intent_can_start() {
    let mut registry = Registry::<FakeOwner>::default();
    assert_eq!(registry.stop("source", 2).unwrap().phase, ObsBroadcastPhase::Stopped);
    assert_eq!(registry.start("source", 2, ||panic!("cancelled start")).unwrap().phase, ObsBroadcastPhase::Stopped);
    assert!(registry.start("source", 1, ||panic!("stale start")).is_err());
    assert_eq!(registry.start("source", 3, ||Ok(FakeOwner::new())).unwrap().phase, ObsBroadcastPhase::Starting);
}
#[test]
fn exact_stop_latches_before_status_and_old_stop_cannot_cancel_replacement() {
    let mut registry = Registry::<FakeOwner>::default();
    let first = FakeOwner::new();
    registry.start("source", 1, ||Ok(first.clone())).unwrap();
    assert_eq!(registry.stop("source", 1).unwrap().phase, ObsBroadcastPhase::Stopping);
    first.set(BroadcastStatus::Live);
    assert_eq!(registry.status("source").phase, ObsBroadcastPhase::Stopping, "late Live cannot reopen cancellation");
    assert!(registry.start("source", 2, ||panic!("still closing")).is_err());
    first.set(BroadcastStatus::Stopped);
    let next = FakeOwner::new();
    registry.start("source", 2, ||Ok(next.clone())).unwrap();
    assert_eq!(registry.stop("source", 1).unwrap().attempt, 2);
    assert_eq!(next.count(), 0);
    assert_eq!(first.count(), 1);
}
#[test]
fn future_stop_does_not_cancel_current_owner_but_prevents_that_late_start() {
    let mut registry = Registry::<FakeOwner>::default(); let owner = FakeOwner::new();
    registry.start("source", 1, ||Ok(owner.clone())).unwrap();
    registry.stop("source", 3).unwrap(); assert_eq!(owner.count(), 0);
    owner.set(BroadcastStatus::Stopped);
    assert!(registry.start("source", 3, ||panic!("cancelled future start")).is_err());
    assert!(registry.start("source", 2, ||panic!("older than cancellation watermark")).is_err());
    assert!(registry.start("source", 4, ||Ok(FakeOwner::new())).is_ok());
}
#[test]
fn source_loss_and_unconfirmed_cleanup_are_errors_not_successful_stops() {
    let mut registry = Registry::<FakeOwner>::default(); let owner = FakeOwner::new();
    registry.start("source", 1, ||Ok(owner.clone())).unwrap();
    owner.set(BroadcastStatus::Failed { reason: BroadcastFailure::SourceStopped, cleanup: complete() });
    let ended = registry.status("source");
    assert_eq!(ended.phase, ObsBroadcastPhase::Error);
    assert_eq!(ended.cleanup_confirmed, Some(true));
    assert!(ended.error.unwrap().contains("application preview stopped"));
    let unsafe_owner = FakeOwner::new();
    registry.start("source", 2, ||Ok(unsafe_owner.clone())).unwrap();
    unsafe_owner.set(BroadcastStatus::Failed { reason: BroadcastFailure::ShutdownTimeout, cleanup: super::super::CleanupProof::default() });
    registry.prune(|_|false);
    assert!(registry.entries.contains_key("source"));
    let uncertain = registry.status("source");
    assert!(uncertain.error.unwrap().contains("could not be confirmed"));
    assert_eq!(uncertain.cleanup_confirmed, Some(false));
    assert!(registry.start("source", 3, ||panic!("unreaped child")).is_err());
}
#[test]
fn admission_is_bounded_and_completed_unavailable_sources_are_pruned() {
    let mut registry = Registry::<FakeOwner>::default();
    registry.stop("one", 1).unwrap(); registry.stop("two", 1).unwrap();
    assert!(registry.start("three", 1, ||panic!("over capacity")).is_err());
    registry.prune(|id|id == "two");
    assert!(registry.start("three", 1, ||Ok(FakeOwner::new())).is_ok());
    assert_eq!(registry.entries.len(), 2);
}
#[test]
fn startup_errors_are_sanitized_and_duplicate_failed_intent_never_retries() {
    let mut registry = Registry::<FakeOwner>::default();
    let result = registry.start("source", 1, ||Err(AppError::invalid("/private/secret/runtime secret-token"))).unwrap();
    assert_eq!(result.phase, ObsBroadcastPhase::Error);
    assert_eq!(result.cleanup_confirmed, None, "startup failure can still have asynchronous cleanup in flight");
    let json = serde_json::to_value(&result).unwrap();
    assert_eq!(json.as_object().unwrap().len(), 4);
    assert!(json.get("cleanupConfirmed").is_none(), "absence means unknown, never completed cleanup");
    assert_eq!(json["sourceId"], "source"); assert_eq!(json["attempt"], 1);
    assert!(!json.to_string().contains("secret")); assert!(!json.to_string().contains("/private"));
    assert_eq!(registry.start("source", 1, ||panic!("failed duplicate")).unwrap(), result);
}
#[test]
fn renderer_tokens_are_bounded_integers_and_never_raw_generations() {
    let id = "0123456789abcdef0123456789abcdef";
    assert!(validate(id, None).is_ok()); assert!(validate(id, Some(1)).is_ok());
    for attempt in [0, super::super::raw_control::MAX_GENERATION + 1, u64::MAX] { assert!(validate(id, Some(attempt)).is_err()); }
    for invalid in ["", "../source", "same title", "0123456789abcdef"] { assert!(validate(invalid, Some(1)).is_err()); }
    assert_eq!(Registry::<FakeOwner>::default().status(id).phase, ObsBroadcastPhase::Off);
}

#[test]
fn cleanup_observation_requires_every_barrier_without_changing_failure_or_ownership() {
    for mask in 0..8 {
        let mut registry = Registry::<FakeOwner>::default();
        assert_eq!(registry.status("source").cleanup_confirmed, Some(true));
        let owner = FakeOwner::new();
        assert_eq!(registry.start("source", 1, ||Ok(owner.clone())).unwrap().cleanup_confirmed, Some(false));
        owner.set(BroadcastStatus::Live);
        assert_eq!(registry.status("source").cleanup_confirmed, Some(false));
        registry.stop("source", 1).unwrap();
        assert_eq!(registry.status("source").cleanup_confirmed, Some(false));
        let cleanup = super::super::CleanupProof { child_reaped: mask & 1 != 0, raw_stopped: mask & 2 != 0, pipe_eof: mask & 4 != 0 };
        owner.set(BroadcastStatus::Failed { reason: BroadcastFailure::SourceStopped, cleanup });
        let failed = registry.status("source");
        assert_eq!(failed.phase, ObsBroadcastPhase::Error);
        assert_eq!(failed.cleanup_confirmed, Some(mask == 7));
        assert_eq!(serde_json::to_value(&failed).unwrap()["cleanupConfirmed"], mask == 7);
        assert_eq!(owner.count(), 1, "observing cleanup must not issue additional cancellation");
    }
    let mut registry = Registry::<FakeOwner>::default();
    assert_eq!(registry.stop("source", 1).unwrap().cleanup_confirmed, Some(true));
}

#[test]
fn pruning_unavailable_sources_preserves_every_incomplete_cleanup_mask() {
    for mask in 0..8 {
        let mut registry = Registry::<FakeOwner>::default();
        let owner = FakeOwner::new();
        registry.start("retired", 1, ||Ok(owner.clone())).unwrap();
        let cleanup = super::super::CleanupProof {
            child_reaped: mask & 1 != 0,
            raw_stopped: mask & 2 != 0,
            pipe_eof: mask & 4 != 0,
        };
        owner.set(BroadcastStatus::Failed { reason: BroadcastFailure::SourceStopped, cleanup });
        // Polling another source prunes entries whose capture is no longer
        // available. Reaping the child alone cannot turn partial proof into Off.
        registry.prune(|_|false);
        assert_eq!(registry.entries.contains_key("retired"), mask != 7, "cleanup mask {mask}");
        let status = registry.status("retired");
        assert_eq!(status.cleanup_confirmed, Some(mask == 7), "cleanup mask {mask}");
        assert_eq!(status.phase, if mask == 7 { ObsBroadcastPhase::Off } else { ObsBroadcastPhase::Error });
        assert_eq!(owner.count(), 0, "pruning must not issue cancellation");
    }
}

#[test]
fn pruning_does_not_turn_unknown_startup_cleanup_into_a_confirmed_stop() {
    let mut registry = Registry::<FakeOwner>::default();
    let failed = registry.start("retired", 1, ||Err(AppError::invalid("startup failed"))).unwrap();
    for _ in 0..3 {
        registry.prune(|_|false);
        assert_eq!(registry.status("retired"), failed);
    }
    assert_eq!(failed.cleanup_confirmed, None);
    assert_eq!(registry.start("retired", 1, ||panic!("failed duplicate")).unwrap(), failed);
}
