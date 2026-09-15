use super::*;
use super::super::ObsCrop;

#[path = "raw_native_tests.rs"]
#[cfg(test)]
mod raw_native_tests;

pub(super) fn trace_errors(bytes: &[u8]) {
    // Native gates explicitly select generated fixtures and retain bounded
    // diagnostics locally. Production builds never compile this trace path.
    if std::env::var_os("SAUCE_OBS_TEST_OUTPUT").is_some() {
        eprint!("{}", String::from_utf8_lossy(bytes));
    }
}

fn selection() -> ObsSelection {
    ObsSelection::Window(super::super::ObsWindowSelection { application:"com.saucebunny.capture-test-source".into(), process:1, window:2, audio:None,
        crop:ObsCrop {x:0.0,y:0.0,width:1.0,height:1.0} })
}
fn active() -> Active {
    Active::new(Request {selection:selection(), program:Program::new("unit".into(), "test".into(), None),permit:None}, 4)
}
fn program_error(program: Arc<Program>) -> Option<String> {
    use std::io::Read;
    let mut reader = super::super::super::ndi::ProgramReader::new(program);
    let mut header = [0u8;5];
    reader.read_exact(&mut header).unwrap();
    assert_eq!(header[0], 3);
    let length = u32::from_be_bytes(header[1..].try_into().unwrap()) as usize;
    assert!(length <= 8192);
    let mut payload = vec![0u8;length]; reader.read_exact(&mut payload).unwrap();
    serde_json::from_slice::<NdiTelemetry>(&payload).unwrap().error
}
#[test]
fn startup_diagnostics_only_publish_allowlisted_messages_and_keep_first_failure() {
    let native = include_str!("../../../../obs-sidecar/capture-start-failure.hpp");
    let codes: Vec<&str> = native.lines().filter_map(|line| {
        let (_, tail) = line.split_once("return \"start_")?;
        let end = tail.find('"')?;
        Some(&tail[..end])
    }).collect();
    assert_eq!(codes.len(), 29, "Every native startup enum must stay covered by this wire test");
    for suffix in codes {
        let code = format!("start_{suffix}");
        let message = capture_status_error(&code);
        if code != "start_failed" {
            assert_ne!(message, capture_status_error("unknown"), "Unmapped native reason: {code}");
        }
        let mut active = active();
        let payload = serde_json::to_vec(&serde_json::json!({
            "width":0,"height":0,"frames":0,"error":code,"action":"none",
        })).unwrap();
        assert!(!active.record(Record {kind:2,slot:0,generation:3,payload:&payload}));
        assert!(!active.request.program.is_stopped(), "A stale reason cannot affect this source");
        assert!(!active.record(Record {kind:2,slot:0,generation:4,payload:&payload}));
        assert!(active.request.program.is_stopped());
        assert_eq!(program_error(active.request.program.clone()).as_deref(), Some(message));
        assert!(active.record(Record {kind:3,slot:0,generation:4,payload:b""}));
        assert_eq!(program_error(active.request.program.clone()).as_deref(), Some(message), "Terminal acknowledgment must not replace the startup cause");
        assert_eq!(active.frames, 0);
    }
}
#[test]
fn startup_diagnostics_never_echo_unknown_helper_text() {
    for private in ["/private/project.mov", "window title secret", "start_unknown\nPID=123", "start_screen_permission_required /private/token"] {
        let mut active = active();
        let payload = serde_json::to_vec(&serde_json::json!({"width":0,"height":0,"frames":0,"error":private})).unwrap();
        active.record(Record {kind:2,slot:0,generation:4,payload:&payload});
        assert_eq!(program_error(active.request.program.clone()).as_deref(), Some("The selected screen or window could not start capture"));
    }
}
#[test]
fn display_wire_has_no_window_fallback_and_requires_explicit_audio_policy() {
    let mut selected: ObsSelection = serde_json::from_value(serde_json::json!({"kind":"display",
        "displayUuid":"12345678-1234-1234-1234-123456789ABC","displayId":42,
        "geometry":{"x":-1920,"y":0,"width":1920,"height":1080,"pixelWidth":3840,"pixelHeight":2160},
        "crop":{"x":0.25,"y":0.25,"width":0.5,"height":0.5},"audio":false})).unwrap();
    let command=start_message(&selected,1,123);
    assert_eq!(command["kind"],"display"); assert_eq!(command["audio"],false);
    assert_eq!(command["crop"],serde_json::json!([0.25,0.25,0.5,0.5]));
    assert_eq!(command["geometry"]["x"],-1920.0);
    assert_eq!(command.as_object().unwrap().len(),9);
    for key in ["window","application","process"] { assert!(command.get(key).is_none()); }
    assert!(command.get("audioPolicy").is_none());
    let ObsSelection::Display(display) = &mut selected else { panic!("display fixture"); };
    display.audio = true;
    let with_audio = start_message(&selected,1,124);
    assert_eq!(with_audio["audio"],true);
    assert_eq!(with_audio["audioPolicy"],1);
    assert_eq!(with_audio["generation"],124);
    assert_eq!(with_audio.as_object().unwrap().len(),10);
    for key in ["window","application","process","parentPid","parentBundle","excludedApplications"] {
        assert!(with_audio.get(key).is_none(),"{key} must not be renderer-controlled");
    }
}
#[test]
fn native_stop_retires_only_matching_generation_as_off_before_teardown_ack() {
    let mut active=active();
    let stop=br#"{"width":640,"height":360,"frames":12,"error":"","action":"stop"}"#;
    assert!(!active.record(Record{kind:2,slot:0,generation:3,payload:stop}));
    assert!(!active.request.program.is_stopped());
    active.request.program.publish(1,b"init"); active.request.program.publish(2,b"fragment");
    assert!(active.request.program.encoded_ready());
    assert!(!active.record(Record{kind:2,slot:0,generation:4,payload:stop}),"intent is not a teardown acknowledgment");
    assert!(active.request.program.is_stopped());
    assert!(!active.request.program.encoded_ready());
    assert_eq!(active.request.program.phase(),NdiPhase::Off);
    assert!(!active.record(Record{kind:2,slot:0,generation:4,payload:br#"{"width":640,"height":360,"frames":20,"error":""}"#}));
    assert_eq!(active.request.program.phase(),NdiPhase::Off);
    assert!(active.record(Record{kind:3,slot:0,generation:4,payload:b""}));
    assert_eq!(active.request.program.phase(),NdiPhase::Off);
}
#[test]
fn audio_choice_is_optional_strict_and_resolved_on_the_service_wire() {
    let legacy = serde_json::json!({"application":"com.example.fixture","process":1,"window":2,
        "crop":{"x":0.0,"y":0.0,"width":1.0,"height":1.0}});
    let omitted: ObsSelection = serde_json::from_value(legacy.clone()).unwrap();
    assert!(matches!(omitted, ObsSelection::Window(value) if value.audio.is_none()));
    for value in [None, Some(serde_json::Value::Null), Some(serde_json::json!(true)), Some(serde_json::json!(false))] {
        let mut json = legacy.clone();
        if let Some(value) = value { json["audio"] = value; }
        let selected: ObsSelection = serde_json::from_value(json).unwrap();
        let ObsSelection::Window(value)=&selected else { panic!("window fixture"); };
        let serialized = serde_json::to_value(&selected).unwrap();
        assert_eq!(serialized.get("audio"), value.audio.map(serde_json::Value::Bool).as_ref());
        let command = start_message(&selected, 1, 123);
        assert_eq!(command["audio"], value.audio.unwrap_or(true));
        assert_eq!(command["slot"], 1);
        assert_eq!(command["generation"], 123);
        assert_eq!(command["application"], "com.example.fixture");
        assert_eq!(command["process"], 1);
        assert_eq!(command["window"], 2);
        assert_eq!(command["crop"], serde_json::json!([0.0,0.0,1.0,1.0]));
        assert_eq!(command.as_object().unwrap().len(), 8);
    }
    for value in [serde_json::json!(0), serde_json::json!(1), serde_json::json!("false"), serde_json::json!([])] {
        let mut json = legacy.clone(); json["audio"] = value;
        assert!(serde_json::from_value::<ObsSelection>(json).is_err());
    }
}
#[test]
fn late_media_status_and_stop_cannot_affect_a_reused_slot() {
    let mut active = active();
    for kind in 1..=3 {
        assert!(!active.record(Record {kind,slot:0,generation:3,payload:b"invalid stale data"}));
    }
    assert!(!active.request.program.is_stopped());
    assert_eq!(active.frames, 0);
    assert!(!active.ready);
}
#[test]
fn failure_immediately_revokes_media_and_late_live_cannot_restore_it() {
    let mut active = active();
    active.request.program.publish(1,b"init"); active.request.program.publish(2,b"fragment");
    assert!(active.request.program.encoded_ready());
    active.record(Record {kind:2,slot:0,generation:4,payload:br#"{"width":640,"height":360,"frames":120,"error":"source_stopped"}"#});
    assert!(!active.request.program.encoded_ready());
    active.record(Record {kind:2,slot:0,generation:4,payload:br#"{"width":640,"height":360,"frames":160,"error":""}"#});
    assert_eq!(active.frames,0);
    assert!(active.record(Record {kind:3,slot:0,generation:4,payload:b""}));
}
#[test]
fn unknown_status_and_oversized_media_fail_closed() {
    for (kind,payload) in [(2,b"raw private path".as_slice()), (1,b"not mp4 data at all".as_slice())] {
        let mut active = active();
        active.record(Record {kind,slot:0,generation:4,payload});
        assert!(active.request.program.is_stopped());
    }
}

#[test]
fn completion_releases_one_slot_but_last_waiter_requires_process_reap() {
    let (sender, _receiver) = mpsc::channel(2);
    let (first, first_waiter) = watch::channel(false);
    let (last, last_waiter) = watch::channel(false);
    let mut client = Client {root:PathBuf::new(), sender, raw_sender:mpsc::channel(2).0, closing:None,
        pending:HashMap::from([("first".into(),first),("last".into(),last)])};
    client.completed("unknown");
    assert!(client.closing.is_none() && !*first_waiter.borrow() && !*last_waiter.borrow());
    client.completed("first");
    assert!(*first_waiter.borrow());
    assert!(!client.pending.contains_key("first") && client.closing.is_none() && !*last_waiter.borrow());
    client.completed("first"); // A duplicate acknowledgement cannot close the survivor.
    assert!(client.closing.is_none());
    client.completed("last");
    assert_eq!(client.closing, Some(CloseReason::Draining));
    assert!(!*last_waiter.borrow());
    // A stop command arriving after slot acknowledgement must still wait.
    let late_waiter = client.pending["last"].subscribe();
    assert!(!*late_waiter.borrow());
    client.finish();
    assert!(*last_waiter.borrow() && *late_waiter.borrow());
}

#[test]
fn closing_reasons_preserve_retry_copy_and_never_downgrade_quarantine() {
    let (sender, _receiver) = mpsc::channel(2);
    let mut client = Client { root:PathBuf::from("/fixture"), sender, raw_sender:mpsc::channel(2).0,
        closing:None, pending:HashMap::new() };
    let retry = "Application capture is still closing. Retry the preview in a moment.";
    let restart = "Application capture cleanup could not be confirmed. Restart Sauce Bunny before starting another application capture.";
    assert!(client.admission_error(Path::new("/fixture")).is_none());
    assert_eq!(client.admission_error(Path::new("/different-runtime")).unwrap().to_string(), retry);
    client.close(CloseReason::Draining);
    assert_eq!(client.admission_error(Path::new("/fixture")).unwrap().to_string(), retry);
    client.close(CloseReason::UnconfirmedReap);
    client.close(CloseReason::Draining);
    assert_eq!(client.closing, Some(CloseReason::UnconfirmedReap));
    assert_eq!(client.admission_error(Path::new("/fixture")).unwrap().to_string(), restart);
    assert_eq!(client.admission_error(Path::new("/different-runtime")).unwrap().to_string(), restart);
}

#[tokio::test]
async fn stopping_an_untracked_program_does_not_wait_on_other_captures() {
    wait_stopped("not-an-obs-capture").await.unwrap();
}

#[tokio::test]
async fn cancellation_reaps_a_stuck_shared_helper_before_allowing_restart() {
    use std::os::unix::fs::PermissionsExt;
    let root = std::env::temp_dir().join(format!("sauce-obs-stuck-{}",uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir(root.join("MacOS")).unwrap();
    let binary = root.join("MacOS/saucebunny-obs-capture-service");
    // One PID, no grandchildren. It never reads control or acknowledges stop.
    std::fs::write(&binary,b"#!/bin/sh\nexec /bin/sleep 30\n").unwrap();
    std::fs::set_permissions(&binary,std::fs::Permissions::from_mode(0o700)).unwrap();
    let program = Program::new("stuck-test".into(),"test".into(),None);
    let result = enqueue(root.clone(),Request {selection:selection(),program:program.clone(),permit:None});
    assert!(result.is_ok());
    tokio::time::sleep(Duration::from_millis(100)).await;
    program.stop();
    let mut stop = Box::pin(wait_stopped(&program.id));
    let premature = tokio::time::timeout(Duration::from_millis(100), &mut stop).await.is_ok();
    // Closing capacity is retained while the shared helper is being reaped.
    let observed_closing = until(||client().lock().unwrap().as_ref().is_some_and(|c|c.closing.is_some()),6).await;
    let replacement = Program::new("replacement-test".into(),"test".into(),None);
    let refused = enqueue(root.clone(),Request {selection:selection(),program:replacement.clone(),permit:None}).is_err();
    replacement.stop(); // Cleanup also covers a regression that wrongly accepted it.
    let completed = stop.await.is_ok();
    let reaped = until(||client().lock().unwrap().is_none(),10).await;
    std::fs::remove_file(binary).unwrap(); std::fs::remove_dir(root.join("MacOS")).unwrap(); std::fs::remove_dir(root).unwrap();
    assert!(!premature && observed_closing && refused && replacement.is_stopped() && completed && reaped);
}

async fn until(mut condition: impl FnMut() -> bool, seconds: u64) -> bool {
    tokio::time::timeout(Duration::from_secs(seconds), async {
        while !condition() { tokio::time::sleep(Duration::from_millis(20)).await; }
    }).await.is_ok()
}
struct StopOnDrop(Vec<Arc<Program>>);
impl Drop for StopOnDrop { fn drop(&mut self) { for program in &self.0 { program.stop(); } } }
#[derive(Default)]
struct Recording { bytes: usize, error: Option<String> }
fn record(program: Arc<Program>, path: PathBuf) -> tokio::task::JoinHandle<std::io::Result<Recording>> {
    tokio::task::spawn_blocking(move || {
        use std::io::{Read,Write};
        let mut output = std::fs::OpenOptions::new().write(true).create_new(true).open(&path)?;
        let mut statuses = std::fs::OpenOptions::new().write(true).create_new(true).open(path.with_extension("status.jsonl"))?;
        let mut reader = super::super::super::ndi::ProgramReader::new(program);
        let mut observed = Recording::default();
        loop {
            let mut header = [0u8;5];
            match reader.read_exact(&mut header) {
                Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => break,
                result => result?,
            }
            let length = u32::from_be_bytes(header[1..].try_into().unwrap()) as usize;
            assert!(length <= super::super::framing::LIMIT);
            let mut data = vec![0u8;length]; reader.read_exact(&mut data)?;
            if header[0] == 1 || header[0] == 2 {
                observed.bytes += data.len(); assert!(observed.bytes <= 24 * 1024 * 1024);
                output.write_all(&data)?;
            } else if header[0] == 3 {
                let status: NdiTelemetry = serde_json::from_slice(&data)?;
                statuses.write_all(&data)?; statuses.write_all(b"\n")?;
                if status.error.is_some() { observed.error = status.error; }
            }
        }
        Ok(observed)
    })
}
#[tokio::test]
#[ignore = "signed shared OBS runtime and two visible generated-window fixtures; no user capture"]
async fn native_shared_service_survives_slot_stop_and_replacement() {
    let root = PathBuf::from(std::env::var_os("SAUCE_OBS_TEST_RUNTIME").expect("private runtime"));
    let output = PathBuf::from(std::env::var_os("SAUCE_OBS_TEST_OUTPUT").expect("test output directory"));
    let selected: Vec<ObsSelection> = serde_json::from_str(&std::env::var("SAUCE_OBS_TEST_SELECTIONS").unwrap()).unwrap();
    assert_eq!(selected.len(),2);
    for selection in &selected {
        assert!(selection.valid() && matches!(&selection, ObsSelection::Window(value) if value.application.starts_with("com.saucebunny.capture-test-")));
    }
    let programs: Vec<_> = (0..3).map(|i|Program::new(format!("generated-{i}"), "Generated fixture".into(), None)).collect();
    let _guard = StopOnDrop(programs.clone());
    let mut recordings = Vec::new();
    recordings.push(record(programs[0].clone(), output.join("0.mp4")));
    enqueue(root.clone(), Request { selection:selected[0].clone(), program:programs[0].clone(),permit:Some(WorkerPermit::acquire().unwrap()) }).unwrap();
    assert!(until(||programs[0].encoded_ready(),10).await,"first capture never ready");
    tokio::time::sleep(Duration::from_secs(1)).await;
    recordings.push(record(programs[1].clone(), output.join("1.mp4")));
    enqueue(root.clone(), Request { selection:selected[1].clone(), program:programs[1].clone(),permit:Some(WorkerPermit::acquire().unwrap()) }).unwrap();
    assert!(until(||programs[1].encoded_ready(),8).await,"second capture never ready");
    tokio::time::sleep(Duration::from_secs(4)).await;
    let before = programs[1].retained_media_metrics();
    assert!(WorkerPermit::acquire().is_err(), "two native captures must exhaust capacity");
    programs[0].stop();
    // Use the same completion boundary as the renderer stop command, not a
    // test-only Arc-count poll. A replacement must obtain real capacity now.
    wait_stopped(&programs[0].id).await.unwrap();
    let mut replacement = selected[0].clone();
    let ObsSelection::Window(value)=&mut replacement else { panic!("window fixture"); };
    value.crop = ObsCrop{x:0.25,y:0.25,width:0.5,height:0.5};
    recordings.push(record(programs[2].clone(), output.join("2.mp4")));
    enqueue(root, Request { selection:replacement, program:programs[2].clone(),permit:Some(WorkerPermit::acquire().unwrap()) }).unwrap();
    assert!(until(||programs[2].encoded_ready(),8).await,"replacement capture never ready");
    // Retain five complete interior seconds for the existing tone oracle,
    // excluding encoder startup and the final partial second.
    tokio::time::sleep(Duration::from_secs(7)).await;
    let after = programs[1].retained_media_metrics();
    let survived = programs[1].encoded_ready();
    for program in &programs { program.stop(); }
    for program in &programs { wait_stopped(&program.id).await.unwrap(); }
    assert!(until(||client().lock().unwrap().is_none(),6).await,"shared helper did not reap");
    for recording in recordings {
        let recording = recording.await.unwrap().unwrap();
        assert!(recording.bytes > 100_000);
        assert!(recording.error.is_none(), "unexpected capture error: {:?}", recording.error);
    }
    assert!(survived,"stopping another slot interrupted shared capture");
    assert_eq!(after.0,8);
    assert!(after.1 <= 8 * super::super::framing::LIMIT);
    assert!(after.2 > before.2 + 40,"surviving media did not advance through slot replacement");
    eprintln!("OBS shared service: {} fragments after first stop/replacement; all programs stopped and helper reaped",after.2-before.2);
}

#[tokio::test]
#[ignore = "signed shared OBS runtime and two owned generated applications; moves/resizes/hides/closes/quits only the fixture"]
async fn native_shared_service_contains_source_loss() {
    use std::io::Write;
    let root = PathBuf::from(std::env::var_os("SAUCE_OBS_TEST_RUNTIME").expect("private runtime"));
    let output = PathBuf::from(std::env::var_os("SAUCE_OBS_TEST_OUTPUT").expect("fixture directory"));
    let selected: Vec<ObsSelection> = serde_json::from_str(&std::env::var("SAUCE_OBS_TEST_SELECTIONS").unwrap()).unwrap();
    let action = std::env::var("SAUCE_OBS_TEST_ACTION").unwrap();
    assert!(matches!(action.as_str(), "M" | "R" | "H" | "C" | "Q"));
    assert_eq!(selected.len(), 2);
    for selection in &selected {
        assert!(selection.valid() && matches!(&selection, ObsSelection::Window(value) if value.application.starts_with("com.saucebunny.capture-test-")));
    }
    let mut control = std::fs::OpenOptions::new().write(true).open(output.join("selected.stdin")).unwrap();
    let programs: Vec<_> = (0..3).map(|i|Program::new(format!("lifecycle-{i}"), "Generated fixture".into(), None)).collect();
    let _guard = StopOnDrop(programs.clone());
    let mut recordings = Vec::new();
    for index in 0..2 {
        recordings.push(record(programs[index].clone(), output.join(format!("{index}.mp4"))));
        enqueue(root.clone(), Request {selection:selected[index].clone(), program:programs[index].clone(), permit:Some(WorkerPermit::acquire().unwrap())}).unwrap();
        assert!(until(||programs[index].encoded_ready() || programs[index].is_stopped(), 10).await &&
            programs[index].encoded_ready(), "capture {index} never ready; inspect its status.jsonl");
    }
    // Both recordings must contain five interior seconds of independently
    // decoded audio before changing the selected source.
    tokio::time::sleep(Duration::from_secs(6)).await;
    let before = programs[1].retained_media_metrics().2;
    let began = Instant::now();
    control.write_all(action.as_bytes()).unwrap();
    if action == "M" {
        assert!(until(||std::fs::read_to_string(output.join("selected.stdout")).unwrap().contains("\"moved\""), 2).await);
    } else {
        assert!(until(||programs[0].is_stopped(), 4).await, "lost source did not stop");
        assert!(!programs[0].encoded_ready(), "stale source remains playable");
        wait_stopped(&programs[0].id).await.unwrap();
    }
    let transition_ms = began.elapsed().as_millis();
    let stopped_at = programs[0].retained_media_metrics().2;
    if action == "R" {
        // Explicit restart after a size change uses a new program. The failed
        // program must remain failed; there is no automatic source substitution.
        recordings.push(record(programs[2].clone(), output.join("2.mp4")));
        enqueue(root, Request {selection:selected[0].clone(), program:programs[2].clone(), permit:Some(WorkerPermit::acquire().unwrap())}).unwrap();
        assert!(until(||programs[2].encoded_ready(), 8).await, "resized source could not restart explicitly");
    }
    tokio::time::sleep(Duration::from_secs(7)).await;
    assert!(programs[1].encoded_ready(), "source loss interrupted the other capture");
    let after = programs[1].retained_media_metrics();
    assert!(after.2 > before + 40, "surviving media did not advance after source transition");
    assert_eq!(after.0, 8);
    assert!(after.1 <= 8 * super::super::framing::LIMIT);
    if action == "M" {
        assert!(programs[0].encoded_ready(), "moving the exact source interrupted capture");
        assert!(programs[0].retained_media_metrics().2 > stopped_at + 40);
    } else {
        assert!(!programs[0].encoded_ready());
        assert_eq!(programs[0].retained_media_metrics().2, stopped_at, "failed source published more media");
    }
    for program in &programs { program.stop(); }
    for program in &programs { wait_stopped(&program.id).await.unwrap(); }
    assert!(until(||client().lock().unwrap().is_none(), 6).await, "helper did not reap");
    for (index, recording) in recordings.into_iter().enumerate() {
        let recording = recording.await.unwrap().unwrap();
        assert!(recording.bytes > 100_000);
        if index == 0 && action != "M" {
            assert_eq!(recording.error.as_deref(), Some("Capture stopped because its window, size, visibility or permission changed"));
        } else { assert!(recording.error.is_none(), "unrelated capture failed: {:?}", recording.error); }
    }
    eprintln!("OBS source transition {action}: {transition_ms} ms; {} surviving fragments; all programs stopped and helper reaped", after.2-before);
}
