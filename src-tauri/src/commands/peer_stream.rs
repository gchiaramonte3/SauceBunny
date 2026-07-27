//! Tier B phase 3b: the async→blocking bridge between the loopback proxy's
//! plain-thread workers and the tokio session world (_design/p2p-media-plan.md).
//!
//! The proxy's tiny_http workers are std threads with NO tokio context, so
//! they cannot open an iroh substream themselves — and `Handle::block_on` in
//! a worker deadlocks. Instead the proxy sends a `MediaStreamRequest` through
//! a global hook the session installs while it is live; a session task opens
//! the substream and pumps its bytes into a BOUNDED tokio mpsc; the worker
//! drains it through a `std::io::Read` adapter using `blocking_recv`.
//!
//! The bound IS the flow control (risk R7): MSE stops reading past its
//! buffer-ahead cap → the worker stops draining → the channel fills → the
//! session task's `send().await` parks → it stops reading QUIC → QUIC flow
//! control backpressures the presenter → its ffmpeg stalls on the pipe
//! write. End-to-end, with no unbounded buffer anywhere.

use std::sync::{Mutex, OnceLock};

/// ~4 MB in flight (64 × 64 KB): enough to ride out scheduling jitter,
/// small enough that pause backpressure reaches the presenter in well under
/// a second at streaming bitrates.
pub const BRIDGE_CHANNEL_CHUNKS: usize = 64;

/// One proxy-worker ask: "give me the fMP4 byte stream for this offered
/// file, from `start` seconds". Answered by the session's service task.
pub struct MediaStreamRequest {
    pub blake3: String,
    pub start: f64,
    /// Quality rung height (1080/720/540/360), or `None` for source
    /// passthrough. Chosen by the guest because starvation is only observable
    /// where the video plays; see `src/lib/stream-rung.ts`.
    pub rung: Option<u32>,
    /// Sync sender back into the blocking world. The worker waits on the
    /// paired receiver with a timeout, so a dead session can't park it.
    pub resp: std::sync::mpsc::SyncSender<std::io::Result<MediaStreamHandle>>,
}

/// The opened stream: timeline metadata from the presenter's header line
/// plus the bounded byte channel the pump task fills.
#[derive(Debug)]
pub struct MediaStreamHandle {
    /// "absolute" | "rebased" — becomes the X-Timeline response header.
    pub timeline: String,
    /// Present when timeline is absolute — becomes X-Stream-Epoch.
    pub epoch: Option<f64>,
    /// The rung the presenter ACTUALLY encoded, which is not necessarily the
    /// one we asked for: a host on an older build ignores the field entirely
    /// and serves passthrough. Without echoing it back, a guest would believe
    /// it had downshifted while the same megabits kept arriving, and would
    /// then downshift again for the same reason. Becomes X-Rung.
    pub rung: Option<u32>,
    /// True when this session's QUIC path is currently a relay rather than a
    /// direct link (R6). Becomes X-Relay, which caps the guest's ladder at its
    /// lowest rung and shows a "relayed" badge — the user's media is crossing
    /// third-party infrastructure and they should be told.
    pub relayed: bool,
    pub rx: tokio::sync::mpsc::Receiver<Vec<u8>>,
}

/// The session installs its request sender here while live (peer role only);
/// cleared on teardown. The proxy treats an empty slot as "no session".
fn hook() -> &'static Mutex<Option<tokio::sync::mpsc::UnboundedSender<MediaStreamRequest>>> {
    static H: OnceLock<Mutex<Option<tokio::sync::mpsc::UnboundedSender<MediaStreamRequest>>>> =
        OnceLock::new();
    H.get_or_init(|| Mutex::new(None))
}

pub fn install_media_hook(tx: tokio::sync::mpsc::UnboundedSender<MediaStreamRequest>) {
    if let Ok(mut h) = hook().lock() {
        *h = Some(tx);
    }
}

pub fn clear_media_hook() {
    if let Ok(mut h) = hook().lock() {
        *h = None;
    }
}

/// Blocking-side entry (called from a proxy worker thread): ask the live
/// session for a media stream and wait bounded for the answer.
pub fn request_media_stream(
    blake3: String,
    start: f64,
    rung: Option<u32>,
) -> std::io::Result<MediaStreamHandle> {
    let tx = hook()
        .lock()
        .ok()
        .and_then(|h| h.clone())
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::NotConnected, "no live session"))?;
    let (resp_tx, resp_rx) = std::sync::mpsc::sync_channel(1);
    tx.send(MediaStreamRequest { blake3, start, rung, resp: resp_tx })
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::NotConnected, "session closing"))?;
    // Generous: covers the presenter's epoch probe + ffmpeg warm-up.
    resp_rx
        .recv_timeout(std::time::Duration::from_secs(20))
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "stream open timed out"))?
}

/// `std::io::Read` over the bounded byte channel. Lives on a plain thread
/// (tiny_http worker) — `blocking_recv` would panic inside a runtime, and
/// that is exactly the misuse the design forbids (`Handle::block_on` class).
pub struct ChannelReader {
    rx: tokio::sync::mpsc::Receiver<Vec<u8>>,
    buf: Vec<u8>,
    pos: usize,
}

impl ChannelReader {
    pub fn new(rx: tokio::sync::mpsc::Receiver<Vec<u8>>) -> Self {
        Self { rx, buf: Vec::new(), pos: 0 }
    }
}

impl std::io::Read for ChannelReader {
    fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
        if self.pos >= self.buf.len() {
            match self.rx.blocking_recv() {
                Some(chunk) => {
                    self.buf = chunk;
                    self.pos = 0;
                }
                // Channel closed = pump finished (EOF) or died (the stream
                // ends either way; MSE handles a truncated tail as a stall).
                None => return Ok(0),
            }
        }
        let n = (self.buf.len() - self.pos).min(out.len());
        out[..n].copy_from_slice(&self.buf[self.pos..self.pos + n]);
        self.pos += n;
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn channel_reader_reassembles_chunks_across_read_boundaries() {
        let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(BRIDGE_CHANNEL_CHUNKS);
        tx.try_send(vec![1, 2, 3]).unwrap();
        tx.try_send(vec![4]).unwrap();
        tx.try_send(vec![5, 6]).unwrap();
        drop(tx);
        let mut r = ChannelReader::new(rx);
        // Small out-buffer forces splits WITHIN a chunk.
        let mut out = [0u8; 2];
        let mut got: Vec<u8> = Vec::new();
        loop {
            let n = r.read(&mut out).unwrap();
            if n == 0 { break; }
            got.extend_from_slice(&out[..n]);
        }
        assert_eq!(got, vec![1, 2, 3, 4, 5, 6]);
    }

    #[test]
    fn channel_reader_signals_eof_when_the_pump_closes() {
        let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(4);
        drop(tx);
        let mut r = ChannelReader::new(rx);
        assert_eq!(r.read(&mut [0u8; 8]).unwrap(), 0);
        // EOF is sticky.
        assert_eq!(r.read(&mut [0u8; 8]).unwrap(), 0);
    }

    #[tokio::test]
    async fn the_bound_backpressures_the_async_sender() {
        // The pump must PARK once the reader stops draining — this is the
        // 3b property the whole tier leans on (pause → presenter stalls).
        let (tx, rx) = tokio::sync::mpsc::channel::<Vec<u8>>(2);
        tx.send(vec![0u8; 8]).await.unwrap();
        tx.send(vec![0u8; 8]).await.unwrap();
        // Channel full: a third send must NOT complete while nothing drains.
        let pending = tx.send(vec![0u8; 8]);
        tokio::select! {
            _ = pending => panic!("send completed past the bound with no reader draining"),
            _ = tokio::time::sleep(std::time::Duration::from_millis(50)) => {}
        }
        // Drain one chunk on a blocking thread; now the send goes through.
        let mut r = ChannelReader::new(rx);
        let handle = tokio::task::spawn_blocking(move || {
            let mut out = [0u8; 8];
            let n = r.read(&mut out).unwrap();
            (r, n)
        });
        let (rx_back, n) = handle.await.unwrap();
        assert_eq!(n, 8);
        tokio::time::timeout(std::time::Duration::from_secs(1), tx.send(vec![1]))
            .await
            .expect("send should unpark once a slot frees")
            .unwrap();
        drop(rx_back);
    }

    #[test]
    fn request_without_a_session_fails_closed_not_hanging() {
        clear_media_hook();
        let err = request_media_stream("aa".repeat(32), 0.0, None).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::NotConnected);
        // Asking for a rung must fail the same way. A guest that downshifts
        // into a dead session should get NotConnected, not a hang.
        let err = request_media_stream("aa".repeat(32), 0.0, Some(540)).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::NotConnected);
    }
}
