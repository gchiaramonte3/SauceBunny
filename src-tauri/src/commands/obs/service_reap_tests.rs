//! Real, generated child processes only. No capture runtime, media, or projects.
use super::*;

fn fake_child(script: &str, piped: bool) -> Child {
    let mut command = tokio::process::Command::new("/bin/sh");
    command.arg("-c").arg(script).kill_on_drop(true).stdin(Stdio::null());
    if piped { command.stdout(Stdio::piped()).stderr(Stdio::piped()); }
    else { command.stdout(Stdio::null()).stderr(Stdio::null()); }
    command.spawn().unwrap()
}

fn pipes(child: &mut Child) -> Option<(ChildStdout, ChildStderr)> {
    Some((child.stdout.take()?, child.stderr.take()?))
}

fn assert_reaped(pid: u32) {
    let mut status = 0;
    assert_eq!(unsafe { libc::waitpid(pid as i32, &mut status, libc::WNOHANG) }, -1);
    assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ECHILD));
}

// Only used after injected failure has deliberately forgotten Tokio's handle.
// This test still owns the real, unreaped child; production cannot assume that.
fn clean_injected_child(pid: u32) {
    let mut status = 0;
    let waited = unsafe { libc::waitpid(pid as i32, &mut status, libc::WNOHANG) };
    if waited == 0 {
        assert_eq!(unsafe { libc::kill(pid as i32, libc::SIGKILL) }, 0);
        loop {
            let result = unsafe { libc::waitpid(pid as i32, &mut status, 0) };
            if result == pid as i32 { break; }
            assert_eq!(io::Error::last_os_error().kind(), io::ErrorKind::Interrupted);
        }
    } else { assert_eq!(waited, pid as i32); }
}

#[tokio::test]
async fn graceful_reap_drains_both_pipes_and_retries_interrupted_waits() {
    let mut child = fake_child("printf output; printf diagnostics >&2; exit 0", true);
    let pid = child.id().unwrap();
    let pipes = pipes(&mut child);
    let mut faults = ReapFaults { errors: [libc::EINTR, libc::EINTR].into(), ..Default::default() };
    assert!(reap_child(child, pipes, false, &mut faults).await);
    assert_eq!(faults.waits, 3);
    assert_eq!(faults.kills, 0);
    assert_reaped(pid);
}

#[tokio::test]
async fn grace_timeout_forces_only_the_owned_helper_and_confirms_reap() {
    let mut child = fake_child("exec /bin/sleep 30", true);
    let pid = child.id().unwrap();
    let pipes = pipes(&mut child);
    let mut faults = ReapFaults::default();
    assert!(reap_child(child, pipes, false, &mut faults).await);
    assert_eq!(faults.kills, 1);
    assert_eq!(faults.waits, 2);
    assert_reaped(pid);
}

#[tokio::test]
async fn pipe_setup_failure_skips_grace_but_still_requires_a_successful_wait() {
    let child = fake_child("exec /bin/sleep 30", false);
    let pid = child.id().unwrap();
    let mut faults = ReapFaults { errors: [libc::EINTR].into(), ..Default::default() };
    assert!(reap_child(child, None, true, &mut faults).await);
    assert_eq!(faults.kills, 1);
    assert_eq!(faults.waits, 2);
    assert_reaped(pid);
}

#[tokio::test]
async fn nonretryable_wait_errors_never_trigger_another_signal_or_wait() {
    for (force, after_kill) in [(false, false), (false, true), (true, true)] {
        for error in [libc::ECHILD, libc::EINVAL] {
            let mut child = fake_child("exec /bin/sleep 30", true);
            let pid = child.id().unwrap();
            let pipes = pipes(&mut child);
            let mut faults = ReapFaults { errors: [error].into(), after_kill, ..Default::default() };
            let confirmed = reap_child(child, pipes, force, &mut faults).await;
            // Cleanup first, so an assertion failure cannot leave a fixture.
            // Before cleanup, the graceful-error child must still be running:
            // forgetting its handle must suppress kill_on_drop as well.
            let mut status = 0;
            let observed = unsafe { libc::waitpid(pid as i32, &mut status, libc::WNOHANG) };
            if observed == 0 { clean_injected_child(pid); }
            assert!(!confirmed);
            assert_eq!(faults.waits, if after_kill && !force { 2 } else { 1 });
            assert_eq!(faults.kills, usize::from(after_kill));
            if !after_kill { assert_eq!(observed, 0, "lost authority must not signal the helper"); }
            else { assert!(observed == 0 || observed == pid as i32); }
        }
    }
}

#[tokio::test]
async fn unconfirmed_reap_keeps_stop_pending_and_capture_capacity_reserved() {
    const FLAG: &str = "SAUCE_OBS_REAP_QUARANTINE_FIXTURE";
    const COMPLETE: &str = "shared-helper quarantine assertions completed";
    if std::env::var_os(FLAG).is_none() {
        // Quarantine intentionally lasts until process exit. Isolate the real
        // permit counter and shared Client so other tests are never poisoned.
        // Includes wait_stopped's unchanged ten-second deadline plus harness startup.
        let output = tokio::time::timeout(Duration::from_secs(20),
            tokio::process::Command::new(std::env::current_exe().unwrap())
                .arg("--exact")
                .arg("commands::obs::service::reap_tests::unconfirmed_reap_keeps_stop_pending_and_capture_capacity_reserved")
                .arg("--nocapture").env(FLAG, "1").kill_on_drop(true).output()).await.unwrap().unwrap();
        assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
        assert!(String::from_utf8_lossy(&output.stdout).contains(COMPLETE), "isolated quarantine test did not run");
        return;
    }
    let program = Program::new("a".repeat(32), "Generated fixture".into(), None);
    let selection = super::super::ObsSelection { application: "com.example.fixture".into(), process: 1, window: 2,
        crop: super::super::ObsCrop { x: 0.0, y: 0.0, width: 1.0, height: 1.0 } };
    let (sender, mut receiver) = mpsc::channel(2);
    let (done, observation) = watch::channel(false);
    *client().lock().unwrap() = Some(Client { root: PathBuf::from("/generated-fixture"), sender,
        raw_sender: mpsc::channel(2).0, closing: None, pending: HashMap::from([(program.id.clone(), done)]) });
    let mut slots = [Some(Active::new(Request { selection: selection.clone(), program: program.clone(),
        permit: Some(WorkerPermit::acquire().unwrap()) }, 1)), None];
    let other = WorkerPermit::acquire().unwrap();
    let mut waiting_before_quarantine = Box::pin(wait_stopped(&program.id));
    assert!(tokio::time::timeout(Duration::from_millis(1), &mut waiting_before_quarantine).await.is_err());
    let child = fake_child("exec /bin/sleep 30", false);
    let pid = child.id().unwrap();
    let mut faults = ReapFaults { errors: [libc::ECHILD].into(), ..Default::default() };
    let reaped = reap_child(child, None, false, &mut faults).await;
    clean_injected_child(pid);
    assert!(!reaped);
    retain_unconfirmed(&mut receiver, &mut slots);
    assert!(slots.iter().all(Option::is_none));
    assert!(program.is_stopped() && receiver.is_closed());
    assert_eq!(client().lock().unwrap().as_ref().unwrap().closing, Some(CloseReason::UnconfirmedReap));
    assert!(!*observation.borrow(), "a wait error must not complete stop waiters");
    assert!(WorkerPermit::acquire().is_err(), "uncertain native capacity must remain reserved");
    let restart = CloseReason::UnconfirmedReap.message();
    assert_eq!(check_start(Path::new("/generated-fixture")).unwrap_err().to_string(), restart);
    assert_eq!(wait_stopped(&program.id).await.unwrap_err().to_string(), restart);
    assert_eq!(waiting_before_quarantine.await.unwrap_err().to_string(), restart,
        "a waiter subscribed before quarantine must report its updated reason after the existing timeout");
    assert!(wait_stopped("unrelated-source").await.is_ok());
    let replacement = Program::new("b".repeat(32), "Replacement fixture".into(), None);
    assert_eq!(enqueue(PathBuf::from("/generated-fixture"), Request { selection, program: replacement.clone(), permit: None })
        .unwrap_err().to_string(), restart);
    assert!(replacement.is_stopped());
    drop(other);
    println!("{COMPLETE}");
}
