use super::*;

pub(super) struct TempQueue { directory: PathBuf, path: PathBuf }
impl TempQueue {
    pub(super) fn new() -> Self {
        let directory = std::env::temp_dir().join(format!("sauce-premiere-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        Self { path: directory.join("notes.json"), directory }
    }
    pub(super) fn bridge(&self) -> Bridge { Bridge::open(self.path.clone()).unwrap() }
}
impl Drop for TempQueue {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_dir(&self.directory);
    }
}

pub(super) fn binding() -> PremiereBinding {
    PremiereBinding { binding_id: "binding-1".into(), project_id: "project-1".into(), sequence_id: "sequence-1".into(),
        project_name: "Editorial".into(), sequence_name: "Cut 1".into(), timebase_ticks: "10584000000".into(),
        display_format: "24Timecode".into(), zero_point_ticks: "914457600000000".into() }
}

pub(super) fn request() -> PremiereMarkerRequest {
    PremiereMarkerRequest { review_key: "ndi:source-1".into(), version_id: "version-1".into(), comment_id: "comment-1".into(),
        session_id: Some("session-1".into()), author: "Alex".into(), body: "Hold this shot longer.".into(),
        anchor: PremiereAnchor { binding: binding(), captured_at: 10, source_id: "source-1".into(),
            stream_id: Some("receiver-generation-1".into()),
            frame_id: Some("displayed-1".into()), media_seconds: Some(1.0), sequence_ticks: None,
            verification: "unverified".into(), reason: Some("NDI frame timing has not been verified".into()) } }
}

pub(super) fn ready(bridge: &mut Bridge) {
    bridge.binding = Some(binding()); bridge.connected = true; bridge.sync_enabled = true;
}

#[test]
fn enqueue_is_durable_without_pairing_and_safe_to_repeat_after_restart() {
    let temp = TempQueue::new(); let mut bridge = temp.bridge();
    let note = bridge.enqueue(request()).unwrap();
    assert_eq!(note.status, PremiereMarkerState::NeedsConfirmation);
    assert!(!bridge.snapshot().automatic_placement);
    let mut reopened = temp.bridge();
    assert_eq!(reopened.enqueue(request()).unwrap(), note);
    assert_eq!(reopened.ledger.notes.len(), 1);
    assert_eq!(std::fs::read_dir(&temp.directory).unwrap().count(), 1);
}

#[test]
fn queued_anchor_and_text_cannot_be_retargeted_by_a_duplicate() {
    let temp = TempQueue::new(); let mut bridge = temp.bridge(); let note = bridge.enqueue(request()).unwrap();
    let mut retarget = request(); retarget.anchor.binding.sequence_id = "different".into();
    assert!(bridge.enqueue(retarget).is_err());
    let mut edited = request(); edited.body = "Changed later".into(); assert!(bridge.enqueue(edited).is_err());
    assert_eq!(bridge.ledger.notes, vec![note]);
}

#[test]
fn different_review_and_version_get_distinct_identities() {
    let temp = TempQueue::new(); let mut bridge = temp.bridge();
    let a = bridge.enqueue(request()).unwrap();
    let mut b = request(); b.version_id = "version-2".into(); let b = bridge.enqueue(b).unwrap();
    let mut c = request(); c.review_key = "another-review".into(); let c = bridge.enqueue(c).unwrap();
    assert_ne!(a.id, b.id); assert_ne!(a.id, c.id); assert_ne!(b.id, c.id);
}

#[test]
fn infallible_identity_encoding_preserves_existing_queue_keys() {
    for source in ["ndi:source-1", "Sequence \"B\"\n東京"] {
        let mut note = request(); note.review_key = source.into();
        let original = serde_json::to_vec(&(&note.review_key, &note.version_id, &note.comment_id)).unwrap();
        assert_eq!(note.identity(), blake3::hash(&original).to_hex().to_string());
    }
}

#[test]
fn forged_verified_anchor_never_dispatches_automatically() {
    let temp = TempQueue::new(); let mut bridge = temp.bridge(); ready(&mut bridge);
    let mut r = request(); r.anchor.verification = "verified".into(); r.anchor.sequence_ticks = Some("999999999999999999999".into());
    let note = bridge.enqueue(r).unwrap();
    assert_eq!(note.status, PremiereMarkerState::NeedsConfirmation); assert_eq!(note.sequence_ticks, None);
    assert!(!bridge.snapshot().automatic_placement);
}

#[test]
fn confirmation_requires_enabled_sync_and_exact_captured_binding() {
    let temp = TempQueue::new(); let mut bridge = temp.bridge(); let note = bridge.enqueue(request()).unwrap();
    assert!(bridge.confirm(&note.id, &binding(), "10584000000", false).is_err());
    ready(&mut bridge);
    for mutate in [0, 1, 2, 3] {
        let mut wrong = binding();
        match mutate { 0 => wrong.binding_id = "after-save-as".into(), 1 => wrong.sequence_id = "other-sequence".into(),
            2 => wrong.project_id = "other-project".into(), _ => wrong.timebase_ticks = "8467200000".into() }
        bridge.binding = Some(wrong.clone()); assert!(bridge.confirm(&note.id, &wrong, "10584000000", false).is_err());
    }
    ready(&mut bridge);
    let dispatched = bridge.confirm(&note.id, &binding(), "10584000000", false).unwrap();
    assert_eq!(dispatched.status, PremiereMarkerState::Dispatching);
    let reopened = temp.bridge(); assert_eq!(reopened.ledger.notes[0].status, PremiereMarkerState::Uncertain);
    assert_eq!(reopened.ledger.notes[0].sequence_ticks.as_deref(), Some("10584000000"));
}

#[test]
fn acknowledged_marker_stays_applied_and_duplicate_ack_is_idempotent() {
    let temp = TempQueue::new(); let mut bridge = temp.bridge(); let note = bridge.enqueue(request()).unwrap(); ready(&mut bridge);
    bridge.confirm(&note.id, &binding(), "10584000000", false).unwrap();
    bridge.acknowledge(&note.id, &binding(), "marker-guid").unwrap();
    bridge.acknowledge(&note.id, &binding(), "marker-guid").unwrap();
    assert!(bridge.acknowledge(&note.id, &binding(), "different-marker").is_err());
    assert!(bridge.confirm(&note.id, &binding(), "10584000000", true).is_err());
    let mut reopened = temp.bridge(); let same = reopened.enqueue(request()).unwrap();
    assert_eq!(same.status, PremiereMarkerState::Added); assert_eq!(same.marker_guid.as_deref(), Some("marker-guid"));
    assert_eq!(reopened.ledger.notes.len(), 1);
}

#[test]
fn missing_ack_cannot_trigger_implicit_retry() {
    let temp = TempQueue::new(); let mut bridge = temp.bridge(); let note = bridge.enqueue(request()).unwrap(); ready(&mut bridge);
    bridge.confirm(&note.id, &binding(), "10584000000", false).unwrap(); bridge.disconnected().unwrap();
    assert!(!bridge.sync_enabled); assert_eq!(bridge.ledger.notes[0].status, PremiereMarkerState::Uncertain);
    ready(&mut bridge); assert!(bridge.confirm(&note.id, &binding(), "21168000000", false).is_err());
    assert_eq!(bridge.confirm(&note.id, &binding(), "21168000000", true).unwrap().status, PremiereMarkerState::Dispatching);
}

#[test]
fn invalid_and_oversized_input_never_replaces_saved_queue() {
    let temp = TempQueue::new(); let mut bridge = temp.bridge(); bridge.enqueue(request()).unwrap();
    let saved = std::fs::read(&temp.path).unwrap();
    let mut invalid = request(); invalid.comment_id = "another".into(); invalid.body = "a".repeat(16 * 1024 + 1);
    assert!(bridge.enqueue(invalid).is_err());
    let mut invalid = request(); invalid.anchor.media_seconds = Some(f64::NAN); assert!(bridge.enqueue(invalid).is_err());
    let mut invalid = request(); invalid.anchor.binding.timebase_ticks = "0".into(); assert!(bridge.enqueue(invalid).is_err());
    assert_eq!(std::fs::read(&temp.path).unwrap(), saved);
}

#[test]
fn corrupt_queue_is_preserved_not_silently_reset() {
    let temp = TempQueue::new(); std::fs::write(&temp.path, b"{incomplete").unwrap();
    assert!(Bridge::open(temp.path.clone()).is_err()); assert_eq!(std::fs::read(&temp.path).unwrap(), b"{incomplete");
}

#[test]
fn failed_disk_write_never_becomes_an_in_memory_success() {
    let temp = TempQueue::new(); let mut bridge = temp.bridge();
    bridge.path = temp.path.join("impossible.json"); std::fs::write(&temp.path, b"not a directory").unwrap();
    assert!(bridge.enqueue(request()).is_err()); assert!(bridge.ledger.notes.is_empty());
    assert_eq!(bridge.ledger_revision, 0);
}

#[test]
fn ledger_revision_changes_only_after_durable_mutation() {
    let temp = TempQueue::new(); let mut bridge = temp.bridge();
    assert_eq!(bridge.snapshot().ledger_revision, 0);
    let note = bridge.enqueue(request()).unwrap(); assert_eq!(bridge.snapshot().ledger_revision, 1);
    bridge.enqueue(request()).unwrap(); assert_eq!(bridge.snapshot().ledger_revision, 1);
    ready(&mut bridge); bridge.confirm(&note.id, &binding(), "10584000000", false).unwrap();
    assert_eq!(bridge.snapshot().ledger_revision, 2);
    bridge.acknowledge(&note.id, &binding(), "native-guid").unwrap();
    assert_eq!(bridge.snapshot().ledger_revision, 3);
    bridge.acknowledge(&note.id, &binding(), "native-guid").unwrap();
    assert_eq!(bridge.snapshot().ledger_revision, 3);
    assert_eq!(temp.bridge().snapshot().ledger_revision, 0);
}

#[test]
fn tick_strings_retain_precision_and_reject_non_numeric_values() {
    for value in ["0", "10584000000", "999999999999999999999999"] { assert!(ticks(value, false)); }
    for value in ["", "-1", "1.2", "1e4", " 10", "+10", "9999999999999999999999999"] { assert!(!ticks(value, false)); }
    assert!(ticks("-10584000000", true)); assert!(!ticks("--1", true));
}

#[test]
fn bindings_omit_local_filesystem_paths() {
    let json = serde_json::to_value(binding()).unwrap(); assert!(json.get("path").is_none());
    let mut forged = json; forged["projectPath"] = serde_json::json!("/Users/editor/project.prproj");
    assert!(serde_json::from_value::<PremiereBinding>(forged).is_err());
}
