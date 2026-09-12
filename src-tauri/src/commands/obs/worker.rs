//! One owned helper, continuously drained independently of media consumers.
//! The existing Program ring is the only media queue. stderr is bounded and
//! only known health records/errors cross into app telemetry (no raw logs).
use std::{process::Stdio, sync::Arc, time::Duration};
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, process::Command, time::{Instant, interval}};
use super::{framing::Framer, super::ndi::{Program, NdiPhase, NdiTelemetry}};

const STARTUP: Duration = Duration::from_secs(12);
const STALL: Duration = Duration::from_secs(4);
// The pinned output emits independent three-frame fragments. OBS reports
// accepted output frames once per second. Limit queued encoder/muxer lag too:
// a trickle of complete fragments must not defeat the no-progress timeout.
const MAX_QUEUED_FRAMES: u64 = 90;

#[derive(Default)]
struct Diagnostics { line: Vec<u8>, discard: bool, failure: Option<&'static str>, frames: u64 }
impl Diagnostics {
    fn output_lagged(&self, fragments: u64) -> bool {
        self.frames.saturating_sub(fragments.saturating_mul(3)) > MAX_QUEUED_FRAMES
    }
    fn push(&mut self, input: &[u8], program: &Program) {
        for byte in input {
            if *byte == b'\n' {
                if !self.discard { self.accept(program); }
                self.line.clear(); self.discard = false;
            } else if self.line.len() < 4096 && !self.discard { self.line.push(*byte); }
            else { self.line.clear(); self.discard = true; }
        }
    }
    fn accept(&mut self, program: &Program) {
        self.failure = match self.line.as_slice() {
            b"selected_window_unavailable" | b"selected_window_no_frame" => Some("The selected application window is no longer available"),
            b"selected_capture_stopped" => Some("The selected application's capture stream stopped; restart the preview"),
            b"selected_crop_invalid" => Some("The selected viewer crop is no longer valid"),
            b"screen_capture_permission_required" => Some("Screen recording permission is required for the selected application"),
            _ => self.failure,
        };
        let Ok(value) = serde_json::from_slice::<serde_json::Value>(&self.line) else { return; };
        if self.failure.is_none() && value["event"] == "media-proof" && value["sourceValid"] == false {
            self.failure = Some("Capture stopped because its window, size, visibility or permission changed");
        }
        if self.failure.is_some() || value["event"] != "program-state" { return; }
        let (Some(width), Some(height), Some(frames)) = (value["width"].as_u64(), value["height"].as_u64(), value["frames"].as_u64()) else { return; };
        if !(2..=1920).contains(&width) || !(2..=1080).contains(&height) || value["fps"] != 30 { return; }
        self.frames = self.frames.max(frames);
        let state = NdiTelemetry { source_id: program.id.clone(), phase: NdiPhase::Live,
            input_width: width as u32, input_height: height as u32, output_fps: 30.0,
            received_frames: frames, ..NdiTelemetry::default() };
        if let Ok(data) = serde_json::to_vec(&state) { program.publish(3, &data); }
    }
}

pub(super) async fn run(mut command: Command, program: Arc<Program>) {
    if program.is_stopped() { return; }
    command.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => { program.fail("The embedded OBS capture helper could not start"); return; }
    };
    let (Some(mut input), Some(mut output), Some(mut errors)) = (child.stdin.take(), child.stdout.take(), child.stderr.take()) else {
        let _ = child.kill().await; let _ = child.wait().await;
        program.fail("The embedded OBS capture pipes could not open"); return;
    };
    let mut media_bytes = [0u8; 16384]; let mut error_bytes = [0u8; 4096];
    let mut framing = Framer::default(); let mut diagnostics = Diagnostics::default();
    let mut heartbeat = interval(Duration::from_millis(250));
    let mut progressed = Instant::now(); let mut ready = false; let mut errors_open = true;
    let mut fragments = 0u64;
    let failure = loop {
        tokio::select! {
            _ = heartbeat.tick() => {
                if program.is_stopped() { break None; }
                if diagnostics.output_lagged(fragments) { break Some("Application capture encoder fell behind; restart the preview"); }
                if progressed.elapsed() > if ready { STALL } else { STARTUP } {
                    break Some(if ready { "Application capture stopped delivering complete media" } else { "Application capture did not start in time" });
                }
                // One byte per tick; the helper drains this continuously. Bound
                // even this write so a broken helper cannot pin the supervisor.
                if !matches!(tokio::time::timeout(Duration::from_millis(100), input.write_all(b"P")).await, Ok(Ok(()))) {
                    break Some("Application capture control channel closed");
                }
            }
            bytes = output.read(&mut media_bytes) => {
                match bytes {
                    Ok(0) => break Some(if framing.finish().is_err() { "Application capture ended inside a media fragment" } else { "Application capture ended unexpectedly" }),
                    Ok(count) => {
                        let result = framing.push(&media_bytes[..count], |kind, data| {
                            if kind == 2 { ready = true; progressed = Instant::now(); fragments = fragments.saturating_add(1); }
                            program.publish(kind, data);
                        });
                        if result.is_err() { break Some("Application capture returned invalid or oversized media"); }
                    }
                    Err(_) => break Some("Application capture media pipe failed"),
                }
            }
            bytes = errors.read(&mut error_bytes), if errors_open => {
                match bytes { Ok(0) | Err(_) => errors_open = false, Ok(count) => diagnostics.push(&error_bytes[..count], &program) }
                if diagnostics.failure.is_some() { break diagnostics.failure; }
            }
        }
    };
    // An explicit native source failure is already authoritative. Revoke
    // readiness now, before draining an encoder that may still have old frames.
    if !program.is_stopped() {
        if let Some(message) = diagnostics.failure { program.fail(message); }
    }
    // Cancel only this owned process. Keep draining until it exits so graceful
    // shutdown can flush without filling the pipe. Always kill/reap on timeout.
    let _ = tokio::time::timeout(Duration::from_millis(100), input.write_all(b"S")).await;
    drop(input);
    let drain = async {
        let mut sink = tokio::io::sink();
        let remaining_errors = async {
            while let Ok(count) = errors.read(&mut error_bytes).await {
                if count == 0 { break; }
                diagnostics.push(&error_bytes[..count], &program);
            }
        };
        tokio::join!(tokio::io::copy(&mut output, &mut sink), remaining_errors, child.wait())
    };
    if tokio::time::timeout(Duration::from_secs(4), drain).await.is_err() {
        let _ = child.kill().await; let _ = child.wait().await;
    }
    if !program.is_stopped() {
        if let Some(message) = diagnostics.failure.or(failure) { program.fail(message); }
        else { program.stop(); }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn diagnostic_lines_are_bounded_and_do_not_expose_raw_paths() {
        let program = Program::new("test".into(), "test".into(), None);
        let mut diagnostics = Diagnostics::default();
        diagnostics.push(&vec![b'x'; 100_000], &program);
        assert!(diagnostics.line.is_empty() && diagnostics.discard);
        diagnostics.push(b"\nprivate path and URL\nselected_window_no_frame\n", &program);
        assert_eq!(diagnostics.failure, Some("The selected application window is no longer available"));
    }
    #[test]
    fn native_capture_failure_survives_generic_shutdown_and_ignores_late_live_records() {
        let program = Program::new("test".into(), "test".into(), None);
        let mut diagnostics = Diagnostics::default();
        diagnostics.push(b"selected_capture_", &program);
        assert!(diagnostics.failure.is_none());
        diagnostics.push(b"stopped\n{\"event\":\"media-proof\",\"sourceValid\":false}\n\
            {\"event\":\"program-state\",\"width\":1280,\"height\":720,\"fps\":30,\"frames\":100}\n", &program);
        assert_eq!(diagnostics.failure, Some("The selected application's capture stream stopped; restart the preview"));
        assert_eq!(diagnostics.frames, 0, "a failed capture cannot become live again");
    }
    #[tokio::test]
    async fn source_failure_revokes_readiness_before_uncooperative_encoder_exits() {
        let program = Program::new("test".into(), "test".into(), None);
        program.publish(1, b"initialization"); program.publish(2, b"fragment");
        assert!(program.encoded_ready());
        let mut command = Command::new("/bin/sh");
        // exec retains one owned PID, without a shell child to leak at timeout.
        command.args(["-c", "printf 'selected_capture_stopped\\n' >&2; exec /bin/sleep 30"]);
        let worker = tokio::spawn(run(command, program.clone()));
        let observed = tokio::time::timeout(Duration::from_secs(2), async {
            while !program.is_stopped() { tokio::time::sleep(Duration::from_millis(10)).await; }
        }).await;
        let stopped_before_exit = !worker.is_finished();
        // Always join/clean up before assertions, including a failed deadline.
        tokio::time::timeout(Duration::from_secs(6), worker).await.unwrap().unwrap();
        assert!(observed.is_ok() && stopped_before_exit);
        assert!(!program.encoded_ready());
    }
    #[test]
    fn trickling_fragments_cannot_hide_encoder_queue_growth() {
        let mut diagnostics = Diagnostics { frames:300, ..Diagnostics::default() };
        assert!(!diagnostics.output_lagged(100));
        assert!(!diagnostics.output_lagged(70));
        assert!(diagnostics.output_lagged(69));
        diagnostics.frames = u64::MAX;
        assert!(diagnostics.output_lagged(10));
        assert!(!diagnostics.output_lagged(u64::MAX));
    }
    #[tokio::test]
    async fn explicit_stop_kills_and_reaps_uncooperative_worker() {
        let program = Program::new("test".into(), "test".into(), None);
        let mut command = Command::new("/bin/sleep"); // no children; ignores stdin and S
        command.arg("30");
        let result = tokio::spawn(run(command, program.clone()));
        tokio::time::sleep(Duration::from_millis(100)).await;
        program.stop();
        tokio::time::timeout(Duration::from_secs(6), result).await.unwrap().unwrap();
        assert!(program.is_stopped());
    }
    #[tokio::test]
    async fn invalid_media_fails_closed_without_raw_diagnostics() {
        let program = Program::new("test".into(), "test".into(), None);
        let mut command = Command::new("/usr/bin/printf"); command.arg("not an mp4 stream");
        run(command, program.clone()).await;
        assert!(program.is_stopped() && !program.encoded_ready());
    }
    #[tokio::test]
    #[ignore = "requires private libobs bundle and generated test fixture; no user capture"]
    async fn native_obs_stream_uses_bounded_program_ring_and_stops() {
        let root = std::path::PathBuf::from(std::env::var_os("SAUCE_OBS_TEST_RUNTIME").expect("private OBS runtime"));
        let fixture = std::env::var_os("SAUCE_OBS_TEST_FIXTURE").expect("generated 440/660 Hz fixture");
        let seconds = std::env::var("SAUCE_OBS_TEST_SECONDS").ok().map(|value|value.parse::<u64>().unwrap()).unwrap_or(12);
        assert!((12..=120).contains(&seconds));
        let program = Program::new("obs-generated-fixture".into(), "Generated fixture".into(), None);
        let mut command = super::super::command(&root, "media-worker"); command.arg(&root).arg(fixture);
        let worker = tokio::spawn(run(command, program.clone()));
        // Deliberately attach no reader. The worker must keep draining and the
        // ring must evict complete fragments without growing with stream length.
        tokio::time::sleep(Duration::from_secs(seconds)).await;
        let ready = program.encoded_ready(); let metrics = program.retained_media_metrics();
        // A late Preview reader still receives the init plus a complete current
        // fragment; it does not backpressure the capture owner.
        let reader_program = program.clone();
        let reader = tokio::task::spawn_blocking(move || {
            use std::io::Read;
            let mut reader = super::super::super::ndi::ProgramReader::new(reader_program);
            let mut kinds = Vec::new();
            while !kinds.contains(&2) && kinds.len() < 8 {
                let mut header = [0;5]; reader.read_exact(&mut header)?;
                let size = u32::from_be_bytes(header[1..].try_into().unwrap()) as usize;
                assert!(size <= super::super::framing::LIMIT);
                let mut bytes = vec![0;size]; reader.read_exact(&mut bytes)?;
                if header[0] == 1 { assert_eq!(&bytes[4..8], b"ftyp"); }
                if header[0] == 2 { assert_eq!(&bytes[4..8], b"moof"); }
                kinds.push(header[0]);
            }
            Ok::<_, std::io::Error>(kinds)
        });
        let read = tokio::time::timeout(Duration::from_secs(2), reader).await;
        program.stop();
        tokio::time::timeout(Duration::from_secs(5), worker).await.unwrap().unwrap();
        assert!(ready, "native stream never reached bounded Program readiness");
        assert_eq!(metrics.0, 8); assert!(metrics.1 <= 8 * super::super::framing::LIMIT);
        assert!(metrics.2 > (seconds - 3) * 8, "continuous worker stopped or fell behind");
        let kinds = read.unwrap().unwrap().unwrap(); assert!(kinds.contains(&1) && kinds.contains(&2));
        eprintln!("OBS bounded ring: {} retained fragments / {} bytes, {} fragments produced; late reader and stop passed", metrics.0, metrics.1, metrics.2);
    }
}
