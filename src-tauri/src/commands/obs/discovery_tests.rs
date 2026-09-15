use super::*;
use serde_json::{json, Value};
use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf};

// These tests share the production process-admission bound. Isolate unrelated
// fixtures; overload/cancellation concurrency is exercised inside its own test.
async fn isolate() -> tokio::sync::MutexGuard<'static, ()> {
    static GUARD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    GUARD.lock().await
}

// Disposable metadata-only executables. No OBS library, screen permission,
// running-app enumeration or user capture is used by these tests.
struct Probe { root: PathBuf, binary: PathBuf }
impl Probe {
    fn new(bytes: &[u8], status: i32) -> Self {
        let root = std::env::temp_dir().join(format!("sauce-obs-discovery-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        fs::create_dir(root.join("MacOS")).unwrap();
        let binary = root.join("MacOS/saucebunny-obs-window-probe");
        fs::write(binary.with_extension("response"), bytes).unwrap();
        let probe = Self {root, binary};
        probe.script(&format!("/bin/cat \"$0.response\"\nexit {status}\n"));
        probe
    }
    fn json(value: Value, status: i32) -> Self { Self::new(&serde_json::to_vec(&value).unwrap(), status) }
    fn script(&self, body: &str) {
        fs::write(&self.binary, format!("#!/bin/sh\n{body}")).unwrap();
        fs::set_permissions(&self.binary, fs::Permissions::from_mode(0o700)).unwrap();
    }
    fn assert_reaped(&self) {
        let pid: i32 = fs::read_to_string(self.binary.with_extension("pid")).unwrap().trim().parse().unwrap();
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "discovery helper was not reaped");
        assert_eq!(std::io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
    }
}

fn display(id: u32, uuid: &str) -> Value {
    json!({"displayId":id,"displayUuid":uuid,"label":"Screen 1",
        "geometry":{"x":-1920,"y":0,"width":1920,"height":1080,"pixelWidth":3840,"pixelHeight":2160}})
}
fn display_list(displays: Vec<Value>) -> Value { json!({"displays":displays,"error":"","capturedUserContent":false}) }
#[tokio::test]
async fn displays_are_metadata_only_exact_unique_identities_with_bounded_geometry() {
    let _isolation = isolate().await;
    let first=display(1,"12345678-1234-1234-1234-123456789ABC");
    let second=display(2,"12345678-1234-1234-1234-123456789ABD");
    let probe=Probe::json(display_list(vec![first.clone(),first.clone(),second.clone()]),0);
    probe.script("[ \"$#\" = 1 ] && [ \"$1\" = --displays ] || exit 9\nexec /bin/cat \"$0.response\"\n");
    let found=displays(&probe.root).await.unwrap();
    assert_eq!(found.len(),2); assert_eq!(found[0].geometry.x,-1920.0);
    for (key,value) in [("displayId",json!(0)),("displayUuid",json!("invalid")),("label",json!(""))] {
        let mut invalid=first.clone(); invalid[key]=value;
        assert!(displays(&Probe::json(display_list(vec![invalid]),0).root).await.is_err());
    }
    for (key,value) in [("x",json!(1000001)),("width",json!(0)),("pixelHeight",json!(16385)),("height",json!(20.5))] {
        let mut invalid=first.clone(); invalid["geometry"][key]=value;
        assert!(displays(&Probe::json(display_list(vec![invalid]),0).root).await.is_err());
    }
    let mut same_id=second.clone(); same_id["displayId"]=json!(1);
    let mut same_uuid=second; same_uuid["displayUuid"]=first["displayUuid"].clone();
    for conflict in [same_id,same_uuid] {
        assert!(displays(&Probe::json(display_list(vec![first.clone(),conflict]),0).root).await.unwrap_err().to_string().contains("Conflicting"));
    }
    assert!(displays(&Probe::json(display_list(vec![first;33]),0).root).await.is_err());
    let mut captured=display_list(vec![]); captured["capturedUserContent"]=json!(true);
    assert!(displays(&Probe::json(captured,0).root).await.is_err());
}
impl Drop for Probe { fn drop(&mut self) { fs::remove_dir_all(&self.root).unwrap(); } }

fn app(pid: i32, name: &str) -> Value { json!({"pid":pid,"app":"com.example.editor","name":name}) }
fn apps(values: Vec<Value>) -> Value { json!({"applications":values,"error":"","capturedUserContent":false}) }
fn window(id: u32, pid: i32) -> Value {
    json!({"id":id,"pid":pid,"app":"com.example.editor","title":"Same title","width":1920,"height":1080})
}
fn window_list(values: Vec<Value>) -> Value {
    json!({"windows":values,"error":"","capturedUserContent":false,
        "visibleWindowCount":5,"matchingWindowCount":2,"matchingApplicationCount":2,
        "diagnosticBundle":"com.example.editor","diagnosticWindowCount":2})
}
fn choice(id: u32, pid: i32, app: &str, name: &str) -> Value {
    let mut value = window(id, pid);
    value["app"] = json!(app); value["applicationName"] = json!(name); value
}

#[tokio::test]
async fn all_windows_is_one_explicit_query_with_exact_cross_application_choices_and_self_exclusion() {
    let _isolation = isolate().await;
    let first = choice(1,10,"com.example.alpha","Editor");
    let second = choice(2,20,"com.example.beta","Editor");
    let own = choice(3,30,"com.saucebunny.test","Sauce Bunny");
    let probe = Probe::json(window_list(vec![first.clone(),second,first,own]),0);
    probe.script("[ \"$#\" = 1 ] && [ \"$1\" = --all-windows ] || exit 9\nexec /bin/cat \"$0.response\"\n");
    let result = all_windows(&probe.root,30).await.unwrap();
    assert_eq!(result.len(),2);
    assert_eq!((result[0].window.id,result[0].window.pid,result[1].window.id,result[1].window.pid),(1,10,2,20));
    assert_eq!(result[0].application_name,result[1].application_name);
    assert_ne!(result[0].window.app,result[1].window.app);
    let wire = serde_json::to_value(&result[0]).unwrap();
    assert_eq!(wire["applicationName"],"Editor"); assert_eq!(wire["id"],1);
    assert!(wire.get("window").is_none());
}

#[tokio::test]
async fn all_windows_rejects_invalid_fields_conflicts_and_untrusted_capture_claims() {
    let _isolation = isolate().await;
    for (field,value) in [("app",json!("--all")),("pid",json!(0)),("id",json!(0)),
        ("width",json!(1)),("height",json!(16385)),("title",json!("Secret\0")),
        ("applicationName",json!("")),("applicationName",json!("Editor\0")),("applicationName",json!("é".repeat(2049)))] {
        let mut invalid = choice(1,10,"com.example.alpha","Editor"); invalid[field] = value;
        let probe = Probe::json(window_list(vec![invalid]),0);
        assert!(all_windows(&probe.root,30).await.unwrap_err().to_string().contains("Invalid application window list"),"{field}");
    }
    for second in [choice(1,20,"com.example.beta","Other"), choice(2,10,"com.example.beta","Other"),
        choice(2,10,"com.example.alpha","Changed name")] {
        let probe = Probe::json(window_list(vec![choice(1,10,"com.example.alpha","Editor"),second]),0);
        assert!(all_windows(&probe.root,30).await.unwrap_err().to_string().contains("Conflicting"));
    }
    let mut response = window_list(vec![]); response["capturedUserContent"] = json!(true);
    assert!(all_windows(&Probe::json(response,0).root,30).await.is_err());
    assert!(all_windows(&Probe::json(window_list(vec![]),7).root,30).await.is_err());
    assert!(all_windows(&Probe::json(window_list(vec![]),0).root,30).await.unwrap().is_empty());
}

#[tokio::test]
async fn all_windows_limits_apply_before_duplicate_collapse_and_do_not_return_a_partial_list() {
    let _isolation = isolate().await;
    let values = vec![choice(1,10,"a.b","A");MAX_ENTRIES+1];
    assert!(all_windows(&Probe::json(window_list(values),0).root,30).await.unwrap_err().to_string().contains("safety limit"));
    let mut response = window_list(vec![]); response["error"] = json!("window_list_too_large");
    assert!(all_windows(&Probe::json(response,4).root,30).await.unwrap_err().to_string().contains("safety limit"));
}

#[tokio::test]
async fn applications_preserve_process_identity_and_only_return_local_app_metadata() {
    let _isolation = isolate().await;
    let mut first = app(10, "Éditeur 🎬");
    first["path"] = json!("/private/not-for-the-renderer");
    first["title"] = json!("private window title");
    let probe = Probe::json(apps(vec![first, app(11, "Éditeur 🎬"), app(10, "Éditeur 🎬")]), 0);
    let result = applications(&probe.root).await.unwrap();
    assert_eq!(result.len(), 2);
    assert_eq!((result[0].pid,result[1].pid), (10,11));
    assert_eq!(result[0].name, "Éditeur 🎬");
    let wire = serde_json::to_string(&result).unwrap();
    assert!(!wire.contains("path") && !wire.contains("title"));
}

#[tokio::test]
async fn zero_running_apps_is_success_and_only_the_applications_mode_is_requested() {
    let _isolation = isolate().await;
    let probe = Probe::json(apps(vec![]), 0);
    probe.script("[ \"$#\" = 1 ] && [ \"$1\" = --applications ] && [ \"$PATH\" = /usr/bin:/bin:/usr/sbin:/sbin ] && [ -z \"$HOME\" ] || exit 9\nexec /bin/cat \"$0.response\"\n");
    assert!(applications(&probe.root).await.unwrap().is_empty());
}

#[tokio::test]
async fn application_fields_and_utf8_byte_bounds_are_validated() {
    let _isolation = isolate().await;
    for (field,value) in [("pid",json!(0)),("pid",json!(-1)),("app",json!("--all")),
        ("app",json!("/Applications/Editor.app")),("app",json!("com.editor\n")),
        ("name",json!("")),("name",json!("Editor\0")),("name",json!("é".repeat(2049)))] {
        let mut invalid = app(10,"Editor"); invalid[field] = value;
        let probe = Probe::json(apps(vec![invalid]),0);
        assert!(applications(&probe.root).await.unwrap_err().to_string().contains("Invalid application list"), "{field}");
    }
    let probe = Probe::json(apps(vec![app(10,&"é".repeat(2048))]),0);
    assert!(applications(&probe.root).await.is_ok());
    let probe = Probe::json(apps(vec![app(10,"   ")]),0);
    assert_eq!(applications(&probe.root).await.unwrap()[0].name,"   ");
}

#[tokio::test]
async fn conflicting_process_snapshots_are_rejected_not_merged_by_name() {
    let _isolation = isolate().await;
    for (field,value) in [("app",json!("com.other.editor")),("name",json!("Changed name"))] {
        let mut conflicting = app(10,"Editor"); conflicting[field] = value;
        let probe = Probe::json(apps(vec![app(10,"Editor"),conflicting]),0);
        assert!(applications(&probe.root).await.unwrap_err().to_string().contains("Conflicting application identities"));
    }
}

#[tokio::test]
async fn application_count_is_bounded_before_duplicate_collapse() {
    let _isolation = isolate().await;
    let mut value = app(1,"a"); value["app"] = json!("a.b");
    let bytes = serde_json::to_vec(&apps(vec![value; MAX_ENTRIES+1])).unwrap();
    assert!(bytes.len() < MAX_BYTES as usize);
    let probe = Probe::new(&bytes,0);
    assert!(applications(&probe.root).await.unwrap_err().to_string().contains("safety limit"));
}

#[tokio::test]
async fn windows_keep_exact_ids_same_titles_and_existing_diagnostic_schema() {
    let _isolation = isolate().await;
    let probe = Probe::json(window_list(vec![window(1,10),window(2,11),window(1,10)]),0);
    let result = windows(&probe.root,"com.example.editor").await.unwrap();
    assert_eq!(result.len(),2);
    assert_eq!((result[0].id,result[0].pid,result[1].id,result[1].pid),(1,10,2,11));
    assert_eq!(result[0].title,result[1].title);
}

#[tokio::test]
async fn windows_reject_other_apps_invalid_geometry_and_conflicting_ids() {
    let _isolation = isolate().await;
    for (field,value) in [("app",json!("com.other.editor")),("pid",json!(0)),("id",json!(0)),
        ("width",json!(1)),("width",json!(16385)),("height",json!(0)),
        ("title",json!("a".repeat(4097)))] {
        let mut invalid = window(1,10); invalid[field] = value;
        let probe = Probe::json(window_list(vec![invalid]),0);
        assert!(windows(&probe.root,"com.example.editor").await.unwrap_err().to_string().contains("Invalid application window list"));
    }
    let probe = Probe::json(window_list(vec![window(1,10),window(1,11)]),0);
    assert!(windows(&probe.root,"com.example.editor").await.unwrap_err().to_string().contains("Conflicting application window identities"));
    assert!(windows(Path::new("/nonexistent-discovery-test-root"),"--all").await.unwrap_err().to_string().contains("Choose an application"));
}

#[tokio::test]
async fn malformed_or_capture_claiming_responses_fail_closed() {
    let _isolation = isolate().await;
    for bytes in [b"not JSON".to_vec(),b"\xff".to_vec(),b"{}".to_vec(),
        br#"{"applications":[],"error":""}"#.to_vec(),
        br#"{"applications":[],"error":"","capturedUserContent":true}"#.to_vec(),
        br#"{"applications":null,"error":"","capturedUserContent":false}"#.to_vec()] {
        let probe = Probe::new(&bytes,0);
        assert!(applications(&probe.root).await.is_err());
    }
}

#[tokio::test]
async fn exit_status_cannot_turn_success_json_into_success_and_errors_are_sanitized() {
    let _isolation = isolate().await;
    let probe = Probe::json(apps(vec![]),7);
    assert!(applications(&probe.root).await.unwrap_err().to_string().contains("helper failed"));
    let probe = Probe::json(window_list(vec![]),7);
    assert!(windows(&probe.root,"com.example.editor").await.unwrap_err().to_string().contains("helper failed"));
    let mut denied = window_list(vec![]); denied["error"] = json!("screen_capture_permission_required");
    let probe = Probe::json(denied,4);
    let permission_error = windows(&probe.root,"com.example.editor").await.unwrap_err().to_string();
    assert!(permission_error.contains("not active for this copy of Sauce Bunny"));
    assert!(permission_error.contains("Screen & System Audio Recording"));
    assert!(permission_error.contains("quit and reopen"));
    assert!(permission_error.contains("If already enabled"));
    assert!(!permission_error.contains("No visible windows"));
    let mut oversized = apps(vec![]); oversized["error"] = json!("application_list_too_large");
    let probe = Probe::json(oversized,4);
    assert!(applications(&probe.root).await.unwrap_err().to_string().contains("safety limit"));
    let mut failed = apps(vec![]); failed["error"] = json!("private helper error /Users/example/private");
    let probe = Probe::json(failed,4);
    let error = applications(&probe.root).await.unwrap_err().to_string();
    assert!(error.contains("discovery failed") && !error.contains("/Users/"));
}

#[tokio::test]
async fn stdout_limit_accepts_exact_boundary_and_rejects_one_extra_byte() {
    let _isolation = isolate().await;
    let mut bytes = serde_json::to_vec(&apps(vec![])).unwrap();
    bytes.resize(MAX_BYTES as usize,b' ');
    let probe = Probe::new(&bytes,0);
    assert!(applications(&probe.root).await.is_ok());
    bytes.push(b' ');
    let probe = Probe::new(&bytes,0);
    assert!(applications(&probe.root).await.unwrap_err().to_string().contains("safety limit"));
}

#[tokio::test]
async fn watchdog_kills_and_reaps_helpers_stuck_reading_or_after_stdout_closes() {
    let _isolation = isolate().await;
    let reading = Probe::new(b"",0);
    reading.script("printf '%s' \"$$\" > \"$0.pid\"\nexec /bin/sleep 30\n");
    let waiting = Probe::new(b"",0);
    waiting.script("printf '%s' \"$$\" > \"$0.pid\"\nexec 1>&-\nexec /bin/sleep 30\n");
    let (first,second) = tokio::join!(applications(&reading.root),applications(&waiting.root));
    for result in [first,second] { assert!(result.unwrap_err().to_string().contains("timed out")); }
    reading.assert_reaped(); waiting.assert_reaped();
}

#[tokio::test]
async fn cancelling_an_active_query_kills_and_reaps_its_exact_helper() {
    let _isolation = isolate().await;
    let probe = Probe::new(b"",0);
    probe.script("printf '%s' \"$$\" > \"$0.pid\"\nexec /bin/sleep 30\n");
    let root = probe.root.clone();
    let query = tokio::spawn(async move { applications(&root).await });
    let pid_path = probe.binary.with_extension("pid");
    let started = tokio::time::timeout(Duration::from_secs(2),async {
        loop {
            if let Ok(value) = fs::read_to_string(&pid_path) {
                if let Ok(pid) = value.trim().parse::<i32>() { break pid; }
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await;
    query.abort();
    assert!(query.await.unwrap_err().is_cancelled());
    let pid = started.expect("disposable discovery helper did not start");
    let reaped = tokio::time::timeout(Duration::from_secs(2),async {
        loop {
            if unsafe { libc::kill(pid,0) } == -1 && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.is_ok();
    // Even a cancellation regression must not leave this known fixture alive.
    if !reaped { unsafe { libc::kill(pid,libc::SIGKILL); } }
    assert!(reaped,"cancelled discovery helper was not reaped");
}

#[tokio::test]
async fn discovery_admission_never_spawns_a_third_helper_and_releases_after_cancel_error_and_timeout() {
    let _isolation = isolate().await;
    let first = Probe::new(b"",0);
    let second = Probe::new(b"",0);
    for probe in [&first,&second] {
        probe.script("printf '%s' \"$$\" > \"$0.pid\"\nexec /bin/sleep 30\n");
    }
    let root = first.root.clone();
    let first_query = tokio::spawn(async move { applications(&root).await });
    let root = second.root.clone();
    let second_query = tokio::spawn(async move { applications(&root).await });
    tokio::time::timeout(Duration::from_secs(2),async {
        while !first.binary.with_extension("pid").exists() || !second.binary.with_extension("pid").exists() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("both admitted fixture helpers should start");
    let third = Probe::json(window_list(vec![]),0);
    third.script("printf '%s' \"$$\" > \"$0.pid\"\nexec /bin/cat \"$0.response\"\n");
    let start = tokio::time::Instant::now();
    assert!(all_windows(&third.root,30).await.unwrap_err().to_string().contains("discovery is busy"));
    assert!(start.elapsed() < Duration::from_secs(2));
    assert!(!third.binary.with_extension("pid").exists(),"overload must not spawn another helper");
    first_query.abort(); assert!(first_query.await.unwrap_err().is_cancelled());
    assert!(all_windows(&third.root,30).await.unwrap().is_empty(),"cancel releases one slot");
    assert_eq!(DISCOVERY_SLOTS.available_permits(),1);
    let failed = Probe::json(apps(vec![]),7);
    assert!(applications(&failed.root).await.is_err());
    assert_eq!(DISCOVERY_SLOTS.available_permits(),1,"failure releases its slot");
    assert!(second_query.await.unwrap().unwrap_err().to_string().contains("timed out"));
    assert_eq!(DISCOVERY_SLOTS.available_permits(),2,"timeout releases the remaining slot");
    tokio::time::timeout(Duration::from_secs(2),async {
        let pid: i32 = fs::read_to_string(first.binary.with_extension("pid")).unwrap().trim().parse().unwrap();
        while unsafe { libc::kill(pid,0) } == 0 { tokio::time::sleep(Duration::from_millis(10)).await; }
    }).await.expect("cancelled helper should be reaped");
    first.assert_reaped(); second.assert_reaped();
}
