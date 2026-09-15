//! Room-share child diagnostics. Keep stderr OPEN after the metadata line:
//! ScreenCaptureKit starts only afterwards and may still report a failure.
//! Raw vendor messages are never retained or returned to the renderer.
use std::{io::Read, sync::mpsc};

const MAX_LINE: usize = 512;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) enum ChildKind { Capture, Encoder }

#[derive(Clone, Copy, Debug, PartialEq)]
enum Failure {
    Permission, Desktop, Discovery, Source, Start, Stopped,
    InvalidDimensions, EncoderUnavailable, EncoderInput, Encoder,
}
impl Failure {
    fn description(self) -> (&'static str, &'static str) {
        match self {
            Self::Permission => ("share_permission_denied", "The screen-sharing helper cannot use Screen Recording access."),
            Self::Desktop => ("share_desktop_unavailable", "The screen-sharing helper could not initialize the active desktop session."),
            Self::Discovery => ("share_discovery_failed", "The screen-sharing helper could not read the selected desktop source."),
            Self::Source => ("share_source_unavailable", "The selected screen or window is no longer available for sharing."),
            Self::Start => ("share_capture_start_failed", "ScreenCaptureKit refused to start the selected screen share."),
            Self::Stopped => ("share_capture_stopped", "ScreenCaptureKit stopped the selected screen share."),
            Self::InvalidDimensions => ("share_encoder_dimensions", "The screen-sharing encoder rejected the picture dimensions."),
            Self::EncoderUnavailable => ("share_encoder_unavailable", "The screen-sharing H.264 encoder is unavailable in this app build."),
            Self::EncoderInput => ("share_encoder_input", "The screen-sharing encoder could not read complete picture frames."),
            Self::Encoder => ("share_encoder_failed", "The screen-sharing encoder failed before it could deliver the picture."),
        }
    }
}

fn classify(kind: ChildKind, line: &[u8]) -> Option<Failure> {
    match kind {
        ChildKind::Capture => {
            if line == b"error: Screen Recording access is not granted. Enable it in System Settings to preview this window." { Some(Failure::Permission) }
            else if line == b"error: Capture helper could not initialize the active macOS desktop session." { Some(Failure::Desktop) }
            else if line.starts_with(b"error: shareable content unavailable (screen recording permission?):") { Some(Failure::Discovery) }
            else if (line.starts_with(b"error: window ") && line.ends_with(b" not found (closed?)")) ||
                (line.starts_with(b"error: display ") && line.ends_with(b" not found")) { Some(Failure::Source) }
            else if line.starts_with(b"error: start capture:") { Some(Failure::Start) }
            else if line.starts_with(b"error: stream stopped:") { Some(Failure::Stopped) }
            else { None }
        }
        ChildKind::Encoder => {
            let text = String::from_utf8_lossy(line).to_ascii_lowercase();
            if text.contains("not divisible by 2") || text.contains("invalid picture size") || text.contains("picture size") && text.contains("invalid") {
                Some(Failure::InvalidDimensions)
            } else if text.contains("unknown encoder") || text.contains("encoder not found") { Some(Failure::EncoderUnavailable) }
            else if text.contains("invalid buffer size") || text.contains("packet corrupt") { Some(Failure::EncoderInput) }
            else if text.contains("error") || text.contains("failed") || text.contains("invalid") { Some(Failure::Encoder) }
            else { None }
        }
    }
}

#[derive(Default)]
struct Lines { bytes: Vec<u8>, oversized: bool }
impl Lines {
    fn push(&mut self, byte: u8) -> Option<Vec<u8>> {
        if byte == b'\n' {
            let line = if self.oversized { None } else { Some(std::mem::take(&mut self.bytes)) };
            self.bytes.clear(); self.oversized = false;
            return line;
        }
        if !self.oversized {
            if self.bytes.len() == MAX_LINE { self.bytes.clear(); self.oversized = true; }
            else { self.bytes.push(byte); }
        }
        None
    }
}

pub(super) struct Drain {
    pub metadata: mpsc::Receiver<Option<(u32, u32)>>,
    done: mpsc::Receiver<()>,
}
impl Drain {
    /// Children have already been killed/reaped by the owner. Do not let a
    /// broken descendant retaining stderr hang a cancelled share forever.
    pub fn finish(&self) { let _ = self.done.recv_timeout(std::time::Duration::from_millis(100)); }
}

pub(super) fn drain<R: Read + Send + 'static>(mut reader: R, kind: ChildKind, request: Option<String>) -> Drain {
    let (meta_tx, metadata) = mpsc::channel();
    let (done_tx, done) = mpsc::channel();
    std::thread::spawn(move || {
        let mut meta_tx = Some(meta_tx);
        let mut lines = Lines::default();
        let mut failure_seen = false;
        let mut consume = |raw: Vec<u8>| {
            let line = raw.strip_suffix(b"\r").unwrap_or(&raw);
            if kind == ChildKind::Capture && meta_tx.is_some() {
                if let Some(json) = line.strip_prefix(b"meta:") {
                    #[derive(serde::Deserialize)] struct Size { width: u32, height: u32 }
                    if let Ok(size) = serde_json::from_slice::<Size>(json) {
                        if size.width > 0 && size.height > 0 {
                            if let Some(tx) = meta_tx.take() { let _ = tx.send(Some((size.width, size.height))); }
                        }
                    }
                }
            }
            if !failure_seen {
                if let Some(failure) = classify(kind, line) {
                    failure_seen = true;
                    let (kind, message) = failure.description();
                    crate::stream_failure::remember_fixed(&request, kind, message);
                }
            }
        };
        let mut chunk = [0; 1024];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
                Ok(count) => for byte in &chunk[..count] { if let Some(line) = lines.push(*byte) { consume(line); } },
            }
        }
        if let Some(line) = lines.push(b'\n') { consume(line); }
        if let Some(tx) = meta_tx.take() { let _ = tx.send(None); }
        let _ = done_tx.send(());
    });
    Drain { metadata, done }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    #[test]
    fn preserves_capture_failure_after_metadata_without_exposing_vendor_text() {
        let id = format!("share-test-{}", uuid::Uuid::new_v4());
        let pipe = Cursor::new(b"meta:{\"height\":798,\"width\":892}\nerror: start capture: /Users/private/window-title auth-secret\n".to_vec());
        let observed = drain(pipe, ChildKind::Capture, Some(id.clone()));
        assert_eq!(observed.metadata.recv().unwrap(), Some((892, 798)));
        observed.finish();
        let failure = crate::stream_failure::get_stream_failure(id).unwrap();
        assert_eq!(failure.kind, "share_capture_start_failed");
        assert!(!failure.message.contains("private")); assert!(!failure.message.contains("secret"));
    }
    #[test]
    fn oversized_and_unknown_lines_never_become_messages_and_do_not_stop_draining() {
        let mut input = vec![b'x'; 20_000];
        input.extend_from_slice(b"\nmeta:{\"width\":1280,\"height\":720}\nprivate unrelated vendor text\nerror: stream stopped: secret\n");
        let id = format!("share-test-{}", uuid::Uuid::new_v4());
        let observed = drain(Cursor::new(input), ChildKind::Capture, Some(id.clone()));
        assert_eq!(observed.metadata.recv().unwrap(), Some((1280, 720))); observed.finish();
        assert_eq!(crate::stream_failure::get_stream_failure(id).unwrap().kind, "share_capture_stopped");
    }
    #[test]
    fn exact_encoder_causes_map_to_fixed_messages() {
        assert_eq!(classify(ChildKind::Encoder, b"[libx264 @ private] height not divisible by 2 (892x799)"), Some(Failure::InvalidDimensions));
        assert_eq!(classify(ChildKind::Encoder, b"Unknown encoder 'libx264'"), Some(Failure::EncoderUnavailable));
        assert_eq!(classify(ChildKind::Encoder, b"Invalid buffer size, packet size 9 < expected frame_size 12"), Some(Failure::EncoderInput));
        assert_eq!(classify(ChildKind::Capture, b"error: display 31 not found"), Some(Failure::Source));
    }
    #[test]
    fn metadata_delivery_keeps_the_real_stderr_pipe_open_for_start_capture() {
        use std::io::Write;
        let (reader, mut writer) = std::os::unix::net::UnixStream::pair().unwrap();
        let id = format!("share-pipe-{}", uuid::Uuid::new_v4());
        let observed = drain(reader, ChildKind::Capture, Some(id.clone()));
        writer.write_all(b"meta:{\"width\":892,\"height\":798}\n").unwrap();
        assert_eq!(observed.metadata.recv().unwrap(), Some((892, 798)));
        // The old metadata reader closed here, making this later native
        // diagnostic an EPIPE/SIGPIPE instead of an actionable failure.
        writer.write_all(b"error: start capture: native private detail\n").unwrap();
        drop(writer); observed.finish();
        assert_eq!(crate::stream_failure::get_stream_failure(id).unwrap().kind, "share_capture_start_failed");
    }
    #[test]
    fn interrupted_read_does_not_close_the_native_diagnostic_pipe() {
        struct InterruptedOnce { input: Cursor<Vec<u8>>, interrupted: bool }
        impl Read for InterruptedOnce {
            fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
                if !self.interrupted {
                    self.interrupted = true;
                    return Err(std::io::Error::from(std::io::ErrorKind::Interrupted));
                }
                self.input.read(bytes)
            }
        }
        let id = format!("share-interrupted-{}", uuid::Uuid::new_v4());
        let pipe = InterruptedOnce { interrupted: false,
            input: Cursor::new(b"meta:{\"width\":892,\"height\":798}\nerror: start capture: private detail\n".to_vec()) };
        let observed = drain(pipe, ChildKind::Capture, Some(id.clone()));
        assert_eq!(observed.metadata.recv().unwrap(), Some((892, 798))); observed.finish();
        assert_eq!(crate::stream_failure::get_stream_failure(id).unwrap().kind, "share_capture_start_failed");
    }
}
