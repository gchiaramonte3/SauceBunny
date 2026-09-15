//! Opt-in packaged audio observation. Never starts/stops the OBS producer.
//! The Swift child is a bounded positive-control reference for our own window.
use std::{ffi::CString, fs::{File, OpenOptions}, io::Read, os::unix::{fs::{DirBuilderExt, OpenOptionsExt}, ffi::OsStrExt},
    path::PathBuf, process::Stdio, sync::{Arc, atomic::{AtomicBool, Ordering}}, time::{Duration, Instant}};
use tokio::{io::{AsyncRead, AsyncReadExt, AsyncWriteExt, unix::AsyncFd}, process::{Child, Command}, sync::mpsc};
use super::super::ndi::{Program, ProgramReader};

const FRAME_BYTES: usize = 8;
const SAMPLE_RATE: usize = 48_000;
const SAMPLE_BYTES: usize = 6 * SAMPLE_RATE * FRAME_BYTES;
const SKIP_BYTES: usize = SAMPLE_RATE * FRAME_BYTES;
const MAX_ENCODED_BYTES: usize = 24 * 1024 * 1024;
const MAX_RECORDS: usize = 1200;
const MAX_REFERENCE_DIAGNOSTICS: usize = 8192;
const MAX_REFERENCE_LINE: usize = 512;
pub(super) const DEADLINE: Duration = Duration::from_secs(12);

/// Keep only a fixed classification, never vendor text, source IDs or paths.
/// The helper already emits these stable prefixes before exiting. Unknown
/// stderr remains untrusted and is discarded, including oversized lines.
#[derive(Default, Debug)]
struct ReferenceDiagnostics {
    failure: Option<&'static str>,
    metadata: bool,
    exceeded: bool,
    bytes: usize,
    line: Vec<u8>,
    discard_line: bool,
}
impl ReferenceDiagnostics {
    fn complete_line(&mut self) {
        if !self.discard_line {
            let line = self.line.strip_suffix(b"\r").unwrap_or(&self.line);
            let failure = if line == b"error: Screen Recording access is not granted. Enable it in System Settings to preview this window." {
                Some("reference_permission_denied")
            } else if line.starts_with(b"error: shareable content unavailable (screen recording permission?):") {
                Some("reference_discovery_failed")
            } else if line.starts_with(b"error: window ") && line.ends_with(b" not found (closed?)") {
                Some("reference_window_missing")
            } else if line == b"error: Reference window is not owned by the original spawning process." ||
                line == b"error: Reference window owner changed before capture started." {
                Some("reference_owner_mismatch")
            } else if line == b"error: Capture helper could not initialize the active macOS desktop session." {
                Some("reference_desktop_unavailable")
            } else if line.starts_with(b"error: start capture:") {
                Some("reference_capture_start_failed")
            } else if line.starts_with(b"error: stream stopped:") {
                Some("reference_stream_stopped")
            } else { None };
            if self.failure.is_none() { self.failure = failure; }
            if line.starts_with(b"meta:") { self.metadata = true; }
        }
        self.line.clear(); self.discard_line = false;
    }
    fn accept(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.bytes += 1;
            if self.bytes > MAX_REFERENCE_DIAGNOSTICS { self.exceeded = true; break; }
            if *byte == b'\n' { self.complete_line(); }
            else if !self.discard_line {
                if self.line.len() >= MAX_REFERENCE_LINE { self.line.clear(); self.discard_line = true; }
                else { self.line.push(*byte); }
            }
        }
    }
    fn finish(&mut self) {
        if !self.exceeded { self.complete_line(); }
        self.line.clear();
    }
}
async fn reference_diagnostics<R: AsyncRead + Unpin>(mut reader: R) -> ReferenceDiagnostics {
    let mut diagnostics = ReferenceDiagnostics::default();
    let mut bytes = [0; 512];
    loop {
        match reader.read(&mut bytes).await {
            Ok(0) => break,
            Ok(count) => {
                diagnostics.accept(&bytes[..count]);
                if diagnostics.exceeded { break; }
            }
            Err(_) => {
                if diagnostics.failure.is_none() { diagnostics.failure = Some("reference_diagnostics_unavailable"); }
                break;
            }
        }
    }
    diagnostics.finish();
    diagnostics
}
#[derive(Debug)]
enum ReferenceStop { Cancelled, Timeout, Exited(Option<i32>), WaitFailed, Read(&'static str) }
fn reference_failure(stop: &ReferenceStop, diagnostics: &ReferenceDiagnostics) -> &'static str {
    if matches!(stop, ReferenceStop::Cancelled) { return "cancelled"; }
    if let Some(failure) = diagnostics.failure { return failure; }
    if diagnostics.exceeded { return "reference_diagnostic_limit"; }
    match stop {
        ReferenceStop::Cancelled => "cancelled",
        ReferenceStop::Timeout if diagnostics.metadata => "reference_audio_timeout_after_metadata",
        ReferenceStop::Timeout => "reference_startup_timeout",
        ReferenceStop::Exited(Some(2)) => "reference_invalid_arguments",
        ReferenceStop::Exited(Some(3)) => "reference_source_unavailable",
        ReferenceStop::Exited(Some(4)) => "reference_discovery_or_permission_failed",
        ReferenceStop::Exited(Some(5)) => "reference_capture_failed",
        ReferenceStop::Exited(Some(_)) => "reference_exited_before_audio_complete",
        ReferenceStop::Exited(None) => "reference_crashed",
        ReferenceStop::WaitFailed => "reference_wait_failed",
        ReferenceStop::Read(error) => error,
    }
}

pub(super) fn packaged_tool(names: &[&str]) -> Result<PathBuf, &'static str> {
    let executable = std::env::current_exe().map_err(|_| "package_unavailable")?;
    let directory = executable.parent().filter(|p| p.file_name().is_some_and(|n| n == "MacOS") &&
        p.parent().and_then(|p|p.file_name()).is_some_and(|n| n == "Contents")).ok_or("packaged_app_required")?;
    let directory = directory.canonicalize().map_err(|_| "package_unavailable")?;
    for name in names {
        if let Ok(file) = directory.join(name).canonicalize() {
            if file.parent() == Some(directory.as_path()) && file.is_file() { return Ok(file); }
        }
    }
    Err("packaged_tool_unavailable")
}
fn child_command(path: PathBuf) -> Command {
    let mut command = Command::new(path);
    command.env_clear().env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).kill_on_drop(true);
    command
}
async fn cancelled(flag: &AtomicBool) {
    while !flag.load(Ordering::Acquire) { tokio::time::sleep(Duration::from_millis(20)).await; }
}
async fn cleanup(child: &mut Child) -> Result<(), &'static str> {
    let _ = child.start_kill();
    tokio::time::timeout(Duration::from_secs(2), child.wait()).await
        .map_err(|_| "cleanup_unconfirmed")?.map_err(|_| "cleanup_unconfirmed")?;
    Ok(())
}
async fn samples<R: AsyncRead + Unpin>(reader: &mut R, cancel: &AtomicBool, missing: &'static str) -> Result<Vec<u8>, &'static str> {
    let mut bytes = vec![0u8; SAMPLE_BYTES];
    tokio::select! {
        biased;
        _ = cancelled(cancel) => Err("cancelled"),
        result = tokio::time::timeout(DEADLINE, reader.read_exact(&mut bytes)) => {
            result.map_err(|_| "audio_timeout")?.map_err(|_|missing)?;
            Ok(bytes.split_off(SKIP_BYTES))
        }
    }
}

/// The production reader yields the exact same framed stream as /program/v1.
/// Capacity two bounds backpressure independently of the producer's ring.
fn read_program(program: Arc<Program>, stop: Arc<AtomicBool>, sender: mpsc::Sender<Vec<u8>>) -> Result<(), &'static str> {
    let mut reader = ProgramReader::acceptance(program, stop.clone(), Instant::now() + DEADLINE);
    let mut bytes = 0usize;
    let mut records = 0usize;
    let mut initialized = false;
    while !stop.load(Ordering::Acquire) {
        let mut header = [0u8; 5];
        reader.read_exact(&mut header).map_err(|_| "program_ended")?;
        let length = u32::from_be_bytes([header[1], header[2], header[3], header[4]]) as usize;
        if length == 0 || length > 2 * 1024 * 1024 || !matches!(header[0], 1..=3) ||
            (header[0] == 3 && length > 16384) { return Err("invalid_program_record"); }
        records += 1;
        bytes += length;
        if bytes > MAX_ENCODED_BYTES || records > MAX_RECORDS { return Err("program_observation_limit"); }
        let mut payload = vec![0; length];
        reader.read_exact(&mut payload).map_err(|_| "program_ended")?;
        if header[0] == 3 { continue; }
        if header[0] == 1 {
            if initialized { return Err("program_reinitialized"); }
            initialized = true;
        } else if !initialized { return Err("program_not_initialized"); }
        if stop.load(Ordering::Acquire) { break; }
        sender.blocking_send(payload).map_err(|_| "observer_ended")?;
    }
    Ok(())
}

pub(super) async fn capture_audio(program: Arc<Program>, cancel: Arc<AtomicBool>) -> Result<Vec<u8>, &'static str> {
    if cancel.load(Ordering::Acquire) { return Err("cancelled"); }
    let mut command = child_command(packaged_tool(&["ffmpeg", "ffmpeg-aarch64-apple-darwin"])?);
    command.args(["-hide_banner", "-loglevel", "error", "-nostdin", "-probesize", "65536", "-analyzeduration", "0",
        "-protocol_whitelist", "pipe", "-i", "pipe:0", "-map", "0:a:0", "-vn", "-ac", "2", "-ar", "48000", "-f", "f32le", "pipe:1"])
        .stdin(Stdio::piped()).stdout(Stdio::piped());
    let mut child = command.spawn().map_err(|_| "decoder_start_failed")?;
    let Some(mut input) = child.stdin.take() else { cleanup(&mut child).await?; return Err("decoder_pipe_failed"); };
    let Some(mut output) = child.stdout.take() else { cleanup(&mut child).await?; return Err("decoder_pipe_failed"); };
    let (sender, mut receiver) = mpsc::channel::<Vec<u8>>(2);
    let reader_stop = Arc::new(AtomicBool::new(false));
    let thread_stop = reader_stop.clone();
    let reader = tokio::task::spawn_blocking(move || read_program(program, thread_stop, sender));
    let writer = tokio::spawn(async move {
        while let Some(bytes) = receiver.recv().await { input.write_all(&bytes).await?; }
        input.shutdown().await
    });
    let result = samples(&mut output, &cancel, "capture_audio_missing").await;
    reader_stop.store(true, Ordering::Release);
    writer.abort();
    let _ = writer.await;
    drop(output);
    let cleaned = cleanup(&mut child).await;
    let reader_cleaned = tokio::time::timeout(Duration::from_secs(1), reader).await.is_ok();
    cleaned?;
    if !reader_cleaned { return Err("cleanup_unconfirmed"); }
    result
}

struct ReferencePipe { directory: PathBuf, path: PathBuf, file: Option<File> }
impl ReferencePipe {
    fn new(attempt: &str) -> Result<Self, &'static str> {
        // Caller supplies a validated UUID, never a path. create_dir refuses
        // collisions/symlinks; only these two newly created entries are removed.
        let directory = std::env::temp_dir().join(format!("saucebunny-audio-acceptance-{attempt}"));
        std::fs::DirBuilder::new().mode(0o700).create(&directory).map_err(|_| "reference_pipe_failed")?;
        let path = directory.join("audio.fifo");
        let mut pipe = Self { directory, path, file: None };
        let name = CString::new(pipe.path.as_os_str().as_bytes()).map_err(|_| "reference_pipe_failed")?;
        // This private FIFO is opened nonblocking at both ends. An absent or
        // stalled capture cannot hang worker cleanup in open/read.
        if unsafe { libc::mkfifo(name.as_ptr(), 0o600) } != 0 { return Err("reference_pipe_failed"); }
        pipe.file = Some(OpenOptions::new().read(true).write(true).custom_flags(libc::O_NONBLOCK)
            .open(&pipe.path).map_err(|_| "reference_pipe_failed")?);
        Ok(pipe)
    }
}
impl Drop for ReferencePipe {
    fn drop(&mut self) {
        self.file.take();
        let _ = std::fs::remove_file(&self.path);
        let _ = std::fs::remove_dir(&self.directory);
    }
}
async fn read_fifo(file: &AsyncFd<File>) -> Result<Vec<u8>, &'static str> {
    let mut bytes = vec![0; SAMPLE_BYTES];
    let mut offset = 0;
    while offset < bytes.len() {
        let mut ready = file.readable().await.map_err(|_| "reference_audio_missing")?;
        match ready.try_io(|inner| inner.get_ref().read(&mut bytes[offset..])) {
            Ok(Ok(0)) => return Err("reference_audio_missing"),
            Ok(Ok(count)) => offset += count,
            Ok(Err(_)) => return Err("reference_audio_missing"),
            Err(_) => continue,
        }
    }
    Ok(bytes.split_off(SKIP_BYTES))
}
pub(super) async fn reference_audio(window: u32, attempt: &str, cancel: Arc<AtomicBool>) -> Result<Vec<u8>, &'static str> {
    if cancel.load(Ordering::Acquire) { return Err("cancelled"); }
    let mut pipe = ReferencePipe::new(attempt)?;
    let file = AsyncFd::new(pipe.file.take().ok_or("reference_pipe_failed")?).map_err(|_| "reference_pipe_failed")?;
    let mut command = child_command(packaged_tool(&["saucebunny-capture", "saucebunny-capture-aarch64-apple-darwin"])?);
    command.args(["stream", "--kind", "window", "--id", &window.to_string(), "--fps", "1", "--max-width", "32",
        "--include-own-audio", "--duration-ms", "12000", "--require-parent-window", "--audio-fifo"]).arg(&pipe.path)
        .stderr(Stdio::piped());
    // The selected window is natively owned by this very packaged main process.
    // Video goes to /dev/null; no desktop pixels, PCM or media file is retained.
    let mut child = command.spawn().map_err(|_| "reference_start_failed")?;
    let Some(stderr) = child.stderr.take() else { cleanup(&mut child).await?; return Err("reference_diagnostics_unavailable"); };
    let mut diagnostics = tokio::spawn(reference_diagnostics(stderr));
    let result = tokio::select! {
        biased;
        _ = cancelled(&cancel) => Err(ReferenceStop::Cancelled),
        result = read_fifo(&file) => result.map_err(ReferenceStop::Read),
        status = child.wait() => Err(match status {
            Ok(status) => ReferenceStop::Exited(status.code()),
            Err(_) => ReferenceStop::WaitFailed,
        }),
        _ = tokio::time::sleep(DEADLINE) => Err(ReferenceStop::Timeout),
    };
    drop(file);
    let cleaned = cleanup(&mut child).await;
    let parsed = match tokio::time::timeout(Duration::from_secs(1), &mut diagnostics).await {
        Ok(Ok(parsed)) => Some(parsed),
        Ok(Err(_)) => None,
        Err(_) => { diagnostics.abort(); let _ = diagnostics.await; None }
    };
    cleaned?;
    let diagnostics = parsed.ok_or("reference_diagnostics_unavailable")?;
    match result {
        Ok(samples) if diagnostics.failure.is_none() && !diagnostics.exceeded => Ok(samples),
        Ok(_) => Err(reference_failure(&ReferenceStop::Read("reference_audio_failed"), &diagnostics)),
        Err(stop) => Err(reference_failure(&stop, &diagnostics)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn reference_stderr_preserves_only_fixed_failure_classes() {
        for (message, expected) in [
            ("error: Screen Recording access is not granted. Enable it in System Settings to preview this window.", "reference_permission_denied"),
            ("error: shareable content unavailable (screen recording permission?): private vendor detail", "reference_discovery_failed"),
            ("error: window 123456 not found (closed?)", "reference_window_missing"),
            ("error: Reference window is not owned by the original spawning process.", "reference_owner_mismatch"),
            ("error: Reference window owner changed before capture started.", "reference_owner_mismatch"),
            ("error: Capture helper could not initialize the active macOS desktop session.", "reference_desktop_unavailable"),
            ("error: start capture: private vendor detail /Users/example", "reference_capture_start_failed"),
            ("error: stream stopped: private vendor detail", "reference_stream_stopped"),
        ] {
            let parsed = reference_diagnostics(message.as_bytes()).await;
            assert_eq!(parsed.failure, Some(expected));
            assert!(parsed.line.is_empty());
            // A startup error wins over an exit status or the FIFO's timeout.
            assert_eq!(reference_failure(&ReferenceStop::Exited(Some(4)), &parsed), expected);
            assert_eq!(reference_failure(&ReferenceStop::Timeout, &parsed), expected);
            assert_eq!(reference_failure(&ReferenceStop::Cancelled, &parsed), "cancelled");
        }
    }
    #[test]
    fn reference_parser_accepts_split_lines_but_not_oversized_or_untrusted_text() {
        let mut parsed = ReferenceDiagnostics::default();
        for byte in b"meta:{\"width\":32,\"height\":18}\nerror: start capture: vendor detail\r\n" { parsed.accept(&[*byte]); }
        parsed.finish();
        assert!(parsed.metadata);
        assert_eq!(parsed.failure, Some("reference_capture_start_failed"));
        let mut oversized = ReferenceDiagnostics::default();
        oversized.accept(b"error: start capture:");
        oversized.accept(&vec![b'x'; MAX_REFERENCE_LINE]);
        oversized.accept(b"\nReference window is not owned by the original spawning process.\n");
        oversized.finish();
        assert_eq!(oversized.failure, None);
        assert!(oversized.line.is_empty());
        assert_eq!(reference_failure(&ReferenceStop::Exited(None), &oversized), "reference_crashed");
    }
    #[tokio::test]
    async fn reference_diagnostics_and_exit_mapping_are_bounded_and_truthful() {
        let large = vec![b'x'; MAX_REFERENCE_DIAGNOSTICS + 1];
        let parsed = reference_diagnostics(large.as_slice()).await;
        assert!(parsed.exceeded); assert!(parsed.line.is_empty());
        assert!(parsed.bytes <= MAX_REFERENCE_DIAGNOSTICS + 1);
        assert_eq!(reference_failure(&ReferenceStop::Timeout, &parsed), "reference_diagnostic_limit");
        let mut plain = ReferenceDiagnostics::default();
        assert_eq!(reference_failure(&ReferenceStop::Timeout, &plain), "reference_startup_timeout");
        plain.metadata = true;
        assert_eq!(reference_failure(&ReferenceStop::Timeout, &plain), "reference_audio_timeout_after_metadata");
        assert_eq!(reference_failure(&ReferenceStop::Exited(Some(0)), &plain), "reference_exited_before_audio_complete");
        assert_eq!(reference_failure(&ReferenceStop::Exited(Some(2)), &plain), "reference_invalid_arguments");
        assert_eq!(reference_failure(&ReferenceStop::Exited(Some(3)), &plain), "reference_source_unavailable");
        assert_eq!(reference_failure(&ReferenceStop::Exited(Some(4)), &plain), "reference_discovery_or_permission_failed");
        assert_eq!(reference_failure(&ReferenceStop::Exited(Some(5)), &plain), "reference_capture_failed");
        assert_eq!(reference_failure(&ReferenceStop::Exited(None), &plain), "reference_crashed");
    }
    #[tokio::test]
    async fn cancellation_interrupts_an_empty_observer_without_media_or_children() {
        let (mut reader, _writer) = tokio::io::duplex(8);
        let flag = AtomicBool::new(true);
        assert_eq!(samples(&mut reader, &flag, "missing").await.unwrap_err(), "cancelled");
    }
    #[tokio::test]
    async fn an_early_eof_is_not_a_silent_pass() {
        let mut reader = &b""[..];
        assert_eq!(samples(&mut reader, &AtomicBool::new(false), "missing").await.unwrap_err(), "missing");
    }
    #[tokio::test]
    async fn audio_off_is_complete_silent_pcm_not_missing_audio() {
        let bytes = vec![0; SAMPLE_BYTES];
        let observed = samples(&mut bytes.as_slice(), &AtomicBool::new(false), "missing").await.unwrap();
        assert_eq!(observed.len(), SAMPLE_BYTES - SKIP_BYTES);
        assert!(observed.iter().all(|byte| *byte == 0));
    }
    #[tokio::test]
    async fn cancellation_wakes_an_already_waiting_observer() {
        let (mut reader, _writer) = tokio::io::duplex(8);
        let flag = Arc::new(AtomicBool::new(false));
        let signal = flag.clone();
        let canceller = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            signal.store(true, Ordering::Release);
        });
        let observed = tokio::time::timeout(Duration::from_secs(1), samples(&mut reader, &flag, "missing")).await.unwrap();
        assert_eq!(observed.unwrap_err(), "cancelled");
        canceller.await.unwrap();
    }
    #[test]
    fn reference_pipe_is_new_private_and_removed_without_touching_other_paths() {
        use std::os::unix::fs::{FileTypeExt, PermissionsExt};
        let attempt = uuid::Uuid::new_v4().to_string();
        let pipe = ReferencePipe::new(&attempt).unwrap();
        let directory = pipe.directory.clone(); let path = pipe.path.clone();
        assert_eq!(std::fs::metadata(&directory).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert!(std::fs::metadata(&path).unwrap().file_type().is_fifo());
        assert!(ReferencePipe::new(&attempt).is_err());
        assert!(path.exists());
        drop(pipe);
        assert!(!path.exists()); assert!(!directory.exists());
    }
    #[test]
    fn cargo_supervisor_cannot_substitute_for_a_packaged_main() {
        assert_eq!(packaged_tool(&["ffmpeg"]).unwrap_err(), "packaged_app_required");
    }
}
