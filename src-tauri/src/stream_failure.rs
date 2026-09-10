//! Bounded, credential-free diagnostics for the existing media transport.
use std::{collections::VecDeque, io::Read, process::{Child, ChildStdout}, sync::{Arc, Mutex, OnceLock}};

#[derive(Debug, Clone, serde::Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct StreamFailure { pub request_id: String, pub kind: String, pub message: String }

static FAILURES: OnceLock<Mutex<VecDeque<StreamFailure>>> = OnceLock::new();

#[tauri::command]
pub fn get_stream_failure(request_id: String) -> Option<StreamFailure> {
    FAILURES.get_or_init(Default::default).lock().ok()?.iter().find(|f| f.request_id == request_id).cloned()
}

pub fn request_id(url: &str) -> Option<String> {
    let id = url.split_once('?')?.1.split('&').find_map(|p| p.strip_prefix("request="))?;
    (!id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')).then(|| id.to_owned())
}

fn sanitize(raw: &str) -> String {
    raw.lines().map(|line| {
        let lower = line.to_ascii_lowercase();
        if lower.contains("cookie") || lower.contains("authorization") { return "[credentials redacted]".into(); }
        line.split_whitespace().map(|word| {
            if word.contains("://") || word.contains("/Users/") || word.contains("/private/") { "[source]" } else { word }
        }).collect::<Vec<_>>().join(" ")
    }).collect::<Vec<_>>().join(" · ").chars().take(1200).collect()
}

fn remember(id: &Option<String>, raw: &str, expired: bool, cancelled: bool) {
    let Some(id) = id else { return };
    let lower = raw.to_ascii_lowercase();
    let kind = if cancelled { "cancelled" }
        else if lower.contains("429") { "rate_limited" }
        else if expired && (lower.contains("403") || lower.contains("410")) { "expired_url" }
        else if lower.contains("403") || lower.contains("401") { "upstream_rejection" }
        else if lower.contains("timed out") || lower.contains("timeout") { "upstream_timeout" }
        else if lower.contains("invalid data") || lower.contains("decod") { "decode" }
        else { "local_proxy" };
    let failure = StreamFailure { request_id: id.clone(), kind: kind.into(), message: sanitize(raw) };
    eprintln!("[media-proxy] request={} kind={} {}", failure.request_id, failure.kind, failure.message);
    if let Ok(mut failures) = FAILURES.get_or_init(Default::default).lock() {
        if failures.len() >= 64 { failures.pop_front(); }
        failures.push_back(failure);
    }
}

/// Drains stderr while stdout is backpressured; retains at most 8 KiB, not an
/// unbounded ffmpeg log. Completion is recorded BEFORE HTTP EOF reaches JS.
pub struct RemuxReader {
    child: Child,
    stdout: ChildStdout,
    tail: Arc<Mutex<VecDeque<u8>>>,
    drain: Option<std::thread::JoinHandle<()>>,
    id: Option<String>,
    expires_at: Option<u64>,
    finished: bool,
}
impl RemuxReader {
    pub fn new(mut child: Child, stdout: ChildStdout, id: Option<String>, expires_at: Option<u64>) -> Self {
        let tail = Arc::new(Mutex::new(VecDeque::new()));
        let copy = tail.clone();
        let drain = child.stderr.take().map(|mut stderr| std::thread::spawn(move || {
            let mut chunk = [0u8; 2048];
            while let Ok(n) = stderr.read(&mut chunk) {
                if n == 0 { break; }
                if let Ok(mut bytes) = copy.lock() {
                    bytes.extend(&chunk[..n]);
                    while bytes.len() > 8192 { bytes.pop_front(); }
                }
            }
        }));
        Self { child, stdout, tail, drain, id, expires_at, finished: false }
    }
    fn finish(&mut self, cancelled: bool) {
        if self.finished { return; }
        self.finished = true;
        if cancelled { let _ = self.child.kill(); }
        // EOF on stdout must not wait forever for a broken remux process.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while self.child.try_wait().ok().flatten().is_none() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        if self.child.try_wait().ok().flatten().is_none() { let _ = self.child.kill(); }
        let result = self.child.wait();
        if let Some(thread) = self.drain.take() { let _ = thread.join(); }
        if cancelled || !result.is_ok_and(|s| s.success()) {
            let raw = self.tail.lock().ok().map(|b| String::from_utf8_lossy(&b.iter().copied().collect::<Vec<_>>()).into_owned()).unwrap_or_default();
            let expired = self.expires_at.is_some_and(|expiry| std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).is_ok_and(|d| d.as_secs() >= expiry));
            remember(&self.id, if raw.is_empty() { "FFmpeg stream terminated" } else { &raw }, expired, cancelled);
        }
    }
}
impl Read for RemuxReader {
    fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
        let n = self.stdout.read(buffer)?;
        if n == 0 { self.finish(false); }
        Ok(n)
    }
}
impl Drop for RemuxReader { fn drop(&mut self) { self.finish(true); } }

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn diagnostics_do_not_leak_sources() {
        let raw = "HTTP error 403 Forbidden\nError opening https://cdn.test/video?token=secret\nCookie: SID=secret\n/Users/editor/private.mp4";
        let s = sanitize(raw);
        assert!(s.contains("403")); assert!(!s.contains("secret")); assert!(!s.contains("editor"));
        assert!(sanitize(&"x".repeat(20_000)).len() <= 1200);
    }
    #[test] fn request_identifiers_are_bounded() {
        assert_eq!(request_id("/fmp4?request=src-2-4&start=5"), Some("src-2-4".into()));
        assert!(request_id("/fmp4?request=http://secret").is_none());
    }
    #[test] fn classifies_real_exit_before_eof_without_exposing_credentials() {
        let id = format!("fixture-{}", uuid::Uuid::new_v4());
        let mut child = std::process::Command::new("/bin/sh")
            .args(["-c", "printf 'HTTP error 403 Forbidden https://cdn.test/video?token=secret\\n' >&2; exit 1"])
            .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().unwrap();
        let stdout = child.stdout.take().unwrap();
        let mut reader = RemuxReader::new(child, stdout, Some(id.clone()), Some(1));
        let mut output = Vec::new();
        reader.read_to_end(&mut output).unwrap();
        let failure = get_stream_failure(id).unwrap();
        assert_eq!(failure.kind, "expired_url");
        assert!(failure.message.contains("403"));
        assert!(!failure.message.contains("secret"));
    }
    #[test] fn intentional_cancellation_is_not_a_cdn_failure() {
        let id = format!("fixture-{}", uuid::Uuid::new_v4());
        let mut child = std::process::Command::new("/bin/sleep").arg("5")
            .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().unwrap();
        let stdout = child.stdout.take().unwrap();
        drop(RemuxReader::new(child, stdout, Some(id.clone()), None));
        assert_eq!(get_stream_failure(id).unwrap().kind, "cancelled");
    }
}
