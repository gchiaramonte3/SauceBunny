//! Independent raw-output supervision. Waiting for descriptor transfer or a
//! native acknowledgement never blocks encoded Preview stdout or stops a Program.
use std::{os::fd::{AsFd, OwnedFd}, sync::{Arc, atomic::{AtomicBool, Ordering}}, time::Duration};
use tokio::{sync::{mpsc, watch}, time::{Instant, interval, timeout, MissedTickBehavior}};
use super::raw_control::{self, Control, Op, Reason, Wire, MAX_GENERATION};
use super::super::ndi::Program;
use crate::AppError;

const SEND_DEADLINE: Duration = Duration::from_millis(100);
const ACK_DEADLINE: Duration = Duration::from_secs(2);
const RESERVATION_DEADLINE: Duration = Duration::from_secs(10);
const TICK: Duration = Duration::from_millis(20);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RawStatus {
    Starting,
    Live,
    Stopping,
    Stopped { reason: Reason },
    Failed { reason: Reason, stop_confirmed: bool },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RawGenerations {
    pub capture: u64,
    pub broadcast: u64,
}

/// A native consumer must drain reader to EOF before releasing sender buffers.
/// A confirmed terminal means local reservation closure or helper teardown,
/// never an empty OS media pipe. Dropping this owner cancels even after its
/// reader has moved into a separate consumer process.
pub struct RawFeed {
    reader: Option<OwnedFd>,
    status: watch::Receiver<RawStatus>,
    generations: watch::Receiver<Option<RawGenerations>>,
    cancel: Arc<AtomicBool>,
    armed: Arc<AtomicBool>,
}
impl RawFeed {
    pub fn take_reader(&mut self) -> Option<OwnedFd> { self.reader.take() }
    pub fn status(&self) -> watch::Receiver<RawStatus> { self.status.clone() }
    pub fn generations(&self) -> watch::Receiver<Option<RawGenerations>> { self.generations.clone() }
    /// Authorize this reservation only, after its consumer is ready. The tuple
    /// is immutable even after termination; stale handles cannot arm a retry.
    pub fn arm(&self, expected: RawGenerations) -> bool {
        if self.cancel.load(Ordering::Acquire) || *self.generations.borrow() != Some(expected) ||
            matches!(*self.status.borrow(), RawStatus::Stopped { .. } | RawStatus::Failed { .. }) { return false; }
        self.armed.store(true, Ordering::Release);
        true
    }
    pub fn cancel(&self) { self.cancel.store(true, Ordering::Release); }
}
impl Drop for RawFeed {
    fn drop(&mut self) { self.cancel(); }
}

pub(super) struct Request {
    id: String,
    writer: Option<OwnedFd>,
    status: watch::Sender<RawStatus>,
    generations: watch::Sender<Option<RawGenerations>>,
    cancel: Arc<AtomicBool>,
    armed: Arc<AtomicBool>,
    resolved: bool,
}
impl Request {
    fn cancelled(&self) -> bool { self.cancel.load(Ordering::Acquire) }
    fn resolve(&mut self, status: RawStatus) {
        self.writer.take();
        self.resolved = true;
        self.status.send_replace(status);
    }
    fn fail(&mut self, reason: Reason, confirmed: bool) {
        self.resolve(RawStatus::Failed { reason, stop_confirmed: confirmed });
    }
}
impl Drop for Request {
    fn drop(&mut self) {
        // Also covers a closed queue, failed helper spawn, or cancelled actor.
        // Dropping local state never invents a native shutdown acknowledgement.
        if !self.resolved {
            self.status.send_replace(RawStatus::Failed { reason: Reason::Unavailable, stop_confirmed: false });
        }
    }
}

/// No await separates creation of the cancellation handle from enqueueing.
/// The supervisor's channel has capacity two; full/closed queues fail promptly.
pub(super) fn begin(id: &str, sender: &mpsc::Sender<Request>) -> Result<RawFeed, AppError> {
    enqueue(id, sender, true)
}

/// Reserve actor-owned generations without transferring the writer. The owner
/// retains this feed through consumer startup, then calls arm with that tuple.
pub(super) fn prepare(id: &str, sender: &mpsc::Sender<Request>) -> Result<RawFeed, AppError> {
    enqueue(id, sender, false)
}

fn enqueue(id: &str, sender: &mpsc::Sender<Request>, auto_arm: bool) -> Result<RawFeed, AppError> {
    if !super::super::ndi::valid_program_id(id) {
        return Err(AppError::invalid("Select a running application preview"));
    }
    let (reader, writer) = raw_control::pipe()?;
    let (status, observation) = watch::channel(RawStatus::Starting);
    let (generations, assigned) = watch::channel(None);
    let cancel = Arc::new(AtomicBool::new(false));
    let armed = Arc::new(AtomicBool::new(auto_arm));
    let feed = RawFeed { reader: Some(reader), status: observation, generations: assigned,
        cancel: cancel.clone(), armed: armed.clone() };
    let request = Request { id: id.to_owned(), writer: Some(writer), status, generations, cancel, armed, resolved: false };
    sender.try_send(request).map_err(|_| AppError::invalid("Application raw output is unavailable or busy"))?;
    Ok(feed)
}

#[derive(Clone)]
pub(super) struct CaptureSlot {
    pub slot: u8,
    pub generation: u64,
    pub program: Arc<Program>,
}

enum Phase {
    Reserved(Instant),
    Starting(Instant),
    Live,
    Stopping(Instant),
    Unconfirmed,
}
struct Attempt {
    request: Request,
    capture: CaptureSlot,
    broadcast: u64,
    phase: Phase,
}
impl Attempt {
    fn matches(&self, record: Wire) -> bool {
        self.capture.slot == record.slot && self.capture.generation == record.capture && self.broadcast == record.broadcast
    }
    fn source_present(&self, captures: &[CaptureSlot]) -> bool {
        !self.capture.program.is_stopped() && captures.iter().any(|capture|
            capture.slot == self.capture.slot && capture.generation == self.capture.generation &&
            Arc::ptr_eq(&capture.program, &self.capture.program))
    }
    fn unconfirmed(&mut self) {
        self.phase = Phase::Unconfirmed;
        self.request.status.send_replace(RawStatus::Failed { reason: Reason::Unavailable, stop_confirmed: false });
    }
}

fn valid_captures(captures: &[CaptureSlot]) -> bool {
    captures.len() <= 2 && captures.iter().enumerate().all(|(index, capture)|
        capture.slot <= 1 && (1..=MAX_GENERATION).contains(&capture.generation) &&
        captures[..index].iter().all(|other| other.slot != capture.slot && other.program.id != capture.program.id))
}

fn latest_captures(captures: &mut watch::Receiver<Vec<CaptureSlot>>) -> Option<Vec<CaptureSlot>> {
    let current = captures.borrow_and_update().clone();
    (captures.has_changed().is_ok() && valid_captures(&current)).then_some(current)
}

fn close_requests(receiver: &mut mpsc::Receiver<Request>) {
    receiver.close();
    while let Ok(mut request) = receiver.try_recv() { request.fail(Reason::Unavailable, false); }
}

fn admit(mut request: Request, captures: &[CaptureSlot],
    attempts: &mut [Option<Attempt>; 2], generations: &mut [u64; 2]) {
    if request.cancelled() {
        // No Start was submitted: closing this sole writer proves local stop.
        request.resolve(RawStatus::Stopped { reason: Reason::Cancelled });
        return;
    }
    let Some(capture) = captures.iter().find(|capture| capture.program.id == request.id) else {
        request.fail(Reason::Stale, false); return;
    };
    if capture.program.is_stopped() || !capture.program.encoded_ready() {
        request.fail(Reason::Unavailable, false); return;
    }
    let slot = capture.slot as usize;
    if attempts[slot].is_some() {
        request.fail(Reason::Busy, false); return;
    }
    if generations[slot] == MAX_GENERATION {
        request.fail(Reason::Unavailable, false); return;
    }
    if request.writer.is_none() { request.fail(Reason::InvalidDescriptor, false); return; }
    // Once exposed to a consumer, this tuple is burned even if never armed.
    generations[slot] += 1;
    let broadcast = generations[slot];
    request.generations.send_replace(Some(RawGenerations { capture: capture.generation, broadcast }));
    attempts[slot] = Some(Attempt { request, capture: capture.clone(), broadcast, phase: Phase::Reserved(Instant::now()) });
}

fn acknowledge(record: Wire, captures: &mut watch::Receiver<Vec<CaptureSlot>>, attempts: &mut [Option<Attempt>; 2], closing: bool) {
    let slot = record.slot as usize;
    let Some(attempt) = attempts[slot].as_mut().filter(|attempt| attempt.matches(record)) else { return; };
    // The helper has never received this tuple. Even a matching unsolicited
    // terminal record cannot release or promote an unarmed reservation.
    if matches!(attempt.phase, Phase::Reserved(_)) { return; }
    match record.op {
        Op::Started if !closing && matches!(attempt.phase, Phase::Starting(_)) && !attempt.request.cancelled() &&
            latest_captures(captures).is_some_and(|current|attempt.source_present(&current)) => {
            attempt.phase = Phase::Live;
            attempt.request.status.send_replace(RawStatus::Live);
        }
        Op::Stopped => {
            attempt.request.resolve(RawStatus::Stopped { reason: record.reason });
            attempts[slot] = None;
        }
        Op::Failed | Op::Rejected => {
            attempt.request.fail(record.reason, true);
            attempts[slot] = None;
        }
        _ => {},
    }
}

fn observe(record: Wire, hello: &mut bool, captures: &mut watch::Receiver<Vec<CaptureSlot>>,
    attempts: &mut [Option<Attempt>; 2], closing: bool) -> bool {
    if record.op == Op::Hello && !*hello { *hello = true; true }
    else if record.op != Op::Hello && *hello { acknowledge(record, captures, attempts, closing); true }
    else { false }
}

async fn tick_attempts(control: &Control, captures: &mut watch::Receiver<Vec<CaptureSlot>>,
    attempts: &mut [Option<Attempt>; 2], mut closing: bool) -> bool {
    for entry in attempts.iter_mut() {
        let Some(attempt) = entry.as_mut() else { continue; };
        // Re-read immediately before Start, not only when select happens to
        // choose the capture-update branch. No await separates this check and
        // attempting the atomic descriptor transfer.
        let current = latest_captures(captures);
        closing |= current.is_none();
        let present = current.as_ref().is_some_and(|current|attempt.source_present(current));
        if let Phase::Reserved(at) = attempt.phase {
            if closing || attempt.request.cancelled() || !present || at.elapsed() >= RESERVATION_DEADLINE {
                // No Start was submitted. Closing this sole writer proves the
                // branch is stopped locally; no native acknowledgement exists.
                if attempt.request.cancelled() {
                    attempt.request.resolve(RawStatus::Stopped { reason: Reason::Cancelled });
                } else if closing {
                    attempt.request.resolve(RawStatus::Stopped { reason: Reason::Unavailable });
                } else if !present {
                    attempt.request.resolve(RawStatus::Stopped { reason: Reason::SourceStopped });
                } else { attempt.request.fail(Reason::Unavailable, true); }
                *entry = None;
                continue;
            }
            if !attempt.request.armed.load(Ordering::Acquire) { continue; }
            if !attempt.capture.program.encoded_ready() {
                attempt.request.fail(Reason::Unavailable, true);
                *entry = None;
                continue;
            }
            let Some(writer) = attempt.request.writer.as_ref() else {
                attempt.request.fail(Reason::InvalidDescriptor, true);
                *entry = None;
                continue;
            };
            let sent = timeout(SEND_DEADLINE, control.send_start(attempt.capture.slot,
                attempt.capture.generation, attempt.broadcast, writer.as_fd())).await;
            // On success SCM_RIGHTS owns a reference; on an unready timeout it
            // owns none. Never retain this parent's writer beyond the send.
            attempt.request.writer.take();
            if !matches!(sent, Ok(Ok(()))) {
                attempt.request.fail(Reason::Unavailable, false);
                *entry = None;
                continue;
            }
            attempt.phase = Phase::Starting(Instant::now());
        }
        if matches!(attempt.phase, Phase::Stopping(at) if at.elapsed() >= ACK_DEADLINE) {
            // Keep the slot reserved until its exact terminal response arrives.
            // A timeout alone cannot prove that the helper released its writer.
            attempt.unconfirmed();
        }
        if !matches!(attempt.phase, Phase::Starting(_) | Phase::Live) { continue; }
        // Cancellation/source replacement may race a successful awaited send.
        // It is now a transferred attempt and must use the normal Stop/ACK path.
        let current = latest_captures(captures);
        closing |= current.is_none();
        let present = current.as_ref().is_some_and(|current|attempt.source_present(current));
        let start_expired = matches!(attempt.phase, Phase::Starting(at) if at.elapsed() >= ACK_DEADLINE);
        if closing || attempt.request.cancelled() || !present || start_expired {
            attempt.phase = Phase::Stopping(Instant::now());
            attempt.request.status.send_replace(RawStatus::Stopping);
            let stopped = timeout(SEND_DEADLINE, control.send_stop(attempt.capture.slot, attempt.capture.generation, attempt.broadcast)).await;
            if !matches!(stopped, Ok(Ok(()))) { attempt.unconfirmed(); }
        }
    }
    closing
}

/// Run in its own task. The capture supervisor owns the watch sender and drops
/// it on helper exit. An invalid/missing raw channel affects this actor only.
pub(super) async fn run(control: Control, mut receiver: mpsc::Receiver<Request>, mut captures: watch::Receiver<Vec<CaptureSlot>>) {
    let current = latest_captures(&mut captures);
    let mut attempts: [Option<Attempt>; 2] = [None, None];
    let mut generations = [0; 2];
    let mut hello = false;
    let mut control_open = true;
    let began = Instant::now();
    let mut closing = if current.is_some() { None } else { Some(Instant::now()) };
    let mut clock = interval(TICK);
    clock.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        // Bound status bursts so stale acknowledgements cannot monopolize the
        // actor, while consuming an already queued Hello before new requests.
        for _ in 0..4 {
            if !control_open { break; }
            match control.try_receive() {
                Ok(Some(record)) if observe(record, &mut hello, &mut captures, &mut attempts, closing.is_some()) => {},
                Ok(None) => break,
                _ => { control_open = false; closing.get_or_insert_with(Instant::now); },
            }
        }
        if closing.is_some() {
            close_requests(&mut receiver);
            if attempts.iter().all(Option::is_none) || closing.is_some_and(|at| at.elapsed() >= ACK_DEADLINE) { break; }
        }
        tokio::select! {
            result = captures.changed(), if closing.is_none() => {
                if result.is_err() || latest_captures(&mut captures).is_none() { closing = Some(Instant::now()); }
            }
            request = receiver.recv(), if hello && closing.is_none() => {
                match request {
                    Some(mut request) => {
                        // A published replacement and this request can both
                        // be ready in the unbiased select. Admission must use
                        // the latest snapshot, never whichever branch won.
                        if let Some(current) = latest_captures(&mut captures) {
                            admit(request, &current, &mut attempts, &mut generations);
                        } else {
                            request.fail(Reason::Unavailable, false);
                            closing = Some(Instant::now());
                        }
                    }
                    None => closing = Some(Instant::now()),
                }
            }
            result = control.receive(), if control_open => {
                match result {
                    Ok(record) if observe(record, &mut hello, &mut captures, &mut attempts, closing.is_some()) => {},
                    _ => { control_open = false; closing.get_or_insert_with(Instant::now); },
                }
            }
            _ = clock.tick() => {
                if !hello && began.elapsed() >= ACK_DEADLINE { closing.get_or_insert_with(Instant::now); }
            }
        }
        if tick_attempts(&control, &mut captures, &mut attempts, closing.is_some()).await {
            closing.get_or_insert_with(Instant::now);
        }
    }
    close_requests(&mut receiver);
    for mut attempt in attempts.into_iter().flatten() { attempt.request.fail(Reason::Unavailable, false); }
}

#[cfg(test)]
pub(in crate::commands::obs) mod tests {
    use super::*;
    use std::{io, mem, os::fd::{AsRawFd, FromRawFd, RawFd}, ptr};
    use tokio::{io::Interest, net::UnixDatagram};

    pub(in crate::commands::obs) struct Peer { socket: UnixDatagram }
    impl Peer {
        fn new(fd: OwnedFd) -> Self {
            let socket: std::os::unix::net::UnixDatagram = fd.into();
            socket.set_nonblocking(true).unwrap();
            Self { socket: UnixDatagram::from_std(socket).unwrap() }
        }
        pub(in crate::commands::obs) async fn send(&self, record: Wire) {
            self.socket.send(&record.encode().unwrap()).await.unwrap();
        }
        pub(in crate::commands::obs) async fn hello(&self) {
            self.send(Wire { op: Op::Hello, slot: 0, reason: Reason::None, capture: 0, broadcast: 0 }).await;
        }
        pub(in crate::commands::obs) async fn receive(&self) -> (Wire, Vec<OwnedFd>) {
            self.receive_within(Duration::from_secs(1)).await.expect("raw peer control deadline or invalid datagram")
        }
        // Raw-only actor tests keep their one-second control budget. A sender
        // integration test also waits for exec/SDK readiness before Start, so
        // its caller supplies that phase's budget and status diagnostics.
        pub(in crate::commands::obs) async fn receive_within(&self, deadline: Duration) -> io::Result<(Wire, Vec<OwnedFd>)> {
            timeout(deadline, self.socket.async_io(Interest::READABLE, || {
                let mut bytes = [0u8; 32];
                let mut rights = [0usize; 16];
                let mut iov = libc::iovec { iov_base: bytes.as_mut_ptr().cast(), iov_len: bytes.len() };
                let mut message: libc::msghdr = unsafe { mem::zeroed() };
                message.msg_iov = &mut iov; message.msg_iovlen = 1;
                message.msg_control = rights.as_mut_ptr().cast(); message.msg_controllen = mem::size_of_val(&rights) as _;
                let length = unsafe { libc::recvmsg(self.socket.as_raw_fd(), &mut message, 0) };
                if length < 0 { return Err(io::Error::last_os_error()); }
                let mut descriptors = Vec::new();
                let mut header = unsafe { libc::CMSG_FIRSTHDR(&message) };
                while !header.is_null() {
                    unsafe {
                        assert_eq!((*header).cmsg_level, libc::SOL_SOCKET);
                        assert_eq!((*header).cmsg_type, libc::SCM_RIGHTS);
                        let length = (*header).cmsg_len as usize - libc::CMSG_LEN(0) as usize;
                        let data = libc::CMSG_DATA(header);
                        for offset in (0..length).step_by(mem::size_of::<RawFd>()) {
                            let descriptor = OwnedFd::from_raw_fd(ptr::read_unaligned(data.add(offset).cast::<RawFd>()));
                            // SCM_RIGHTS creates a new descriptor without the
                            // sender's FD_CLOEXEC bit. Mirror the native helper:
                            // another parallel subprocess must not retain this
                            // fake helper's writer after its owner closes it.
                            let flags = libc::fcntl(descriptor.as_raw_fd(), libc::F_GETFD);
                            assert!(flags >= 0);
                            assert_eq!(libc::fcntl(descriptor.as_raw_fd(), libc::F_SETFD, flags | libc::FD_CLOEXEC), 0);
                            descriptors.push(descriptor);
                        }
                        header = libc::CMSG_NXTHDR(&message, header);
                    }
                }
                assert_eq!(length, 32);
                assert_eq!(message.msg_flags & (libc::MSG_TRUNC | libc::MSG_CTRUNC), 0);
                Ok((Wire::decode(&bytes)?, descriptors))
            })).await.map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "raw peer control deadline"))?
        }
        pub(in crate::commands::obs) async fn no_message(&self) {
            let mut bytes = [0; 32];
            assert!(timeout(Duration::from_millis(30), self.socket.recv(&mut bytes)).await.is_err());
        }
    }

    pub(in crate::commands::obs) struct Fixture {
        pub(in crate::commands::obs) peer: Peer,
        pub(in crate::commands::obs) requests: mpsc::Sender<Request>,
        pub(in crate::commands::obs) captures: watch::Sender<Vec<CaptureSlot>>,
        pub(in crate::commands::obs) program: Arc<Program>,
        task: tokio::task::JoinHandle<()>,
    }
    impl Fixture {
        pub(in crate::commands::obs) fn new() -> Self {
            let (control, peer) = Control::pair().unwrap();
            let (requests, receiver) = mpsc::channel(2);
            let program = Program::new("a".repeat(32), "Generated fixture".into(), None);
            program.publish(1, b"init"); program.publish(2, b"media");
            let (captures, state) = watch::channel(vec![CaptureSlot { slot: 0, generation: 10, program: program.clone() }]);
            let task = tokio::spawn(run(control, receiver, state));
            Self { peer: Peer::new(peer), requests, captures, program, task }
        }
        async fn active(&self) -> (RawFeed, Wire, Vec<OwnedFd>) {
            self.peer.hello().await;
            let feed = begin(&self.program.id, &self.requests).unwrap();
            let (record, writers) = self.peer.receive().await;
            assert_eq!(record.op, Op::Start); assert_eq!(writers.len(), 1);
            self.peer.send(Wire { op: Op::Started, ..record }).await;
            wait_for(&feed, RawStatus::Live).await;
            (feed, record, writers)
        }
        pub(in crate::commands::obs) async fn close(self) {
            drop(self.captures); drop(self.requests);
            timeout(Duration::from_secs(3), self.task).await.unwrap().unwrap();
        }
    }

    pub(in crate::commands::obs) async fn wait_for(feed: &RawFeed, expected: RawStatus) {
        let mut status = feed.status();
        timeout(Duration::from_secs(3), status.wait_for(|status| *status == expected)).await.unwrap().unwrap();
    }

    fn pipe_read(reader: &OwnedFd) -> io::Result<usize> {
        let mut byte = 0u8;
        let count = unsafe { libc::read(reader.as_raw_fd(), (&mut byte as *mut u8).cast(), 1) };
        if count < 0 { Err(io::Error::last_os_error()) } else { Ok(count as usize) }
    }

    async fn assigned(feed: &RawFeed) -> RawGenerations {
        let mut generations = feed.generations();
        let value = timeout(Duration::from_secs(1), generations.wait_for(Option::is_some)).await.unwrap().unwrap();
        value.unwrap()
    }

    #[tokio::test]
    async fn fixture_received_writer_is_not_inherited_by_other_test_processes() {
        let fixture = Fixture::new();
        let (feed, started, writers) = fixture.active().await;
        let flags = unsafe { libc::fcntl(writers[0].as_raw_fd(), libc::F_GETFD) };
        assert!(flags >= 0);
        assert_ne!(flags & libc::FD_CLOEXEC, 0, "SCM_RIGHTS does not preserve CLOEXEC; a parallel sender could inherit this fixture writer and prevent EOF");
        feed.cancel();
        assert_eq!(fixture.peer.receive().await.0, Wire { op: Op::Stop, ..started });
        drop(writers);
        fixture.peer.send(Wire { op: Op::Stopped, reason: Reason::Cancelled, ..started }).await;
        wait_for(&feed, RawStatus::Stopped { reason: Reason::Cancelled }).await;
        fixture.close().await;
    }

    #[tokio::test]
    async fn prepared_tuple_is_immutable_and_only_exact_arm_transfers_writer() {
        let fixture = Fixture::new();
        let mut feed = prepare(&fixture.program.id, &fixture.requests).unwrap();
        let reader = feed.take_reader().unwrap();
        let expected = RawGenerations { capture: 10, broadcast: 1 };
        assert!(!feed.arm(expected)); // The actor has not assigned a tuple yet.
        fixture.peer.no_message().await;
        assert!(feed.generations().borrow().is_none());
        fixture.peer.hello().await;
        assert_eq!(assigned(&feed).await, expected);
        assert_eq!(pipe_read(&reader).unwrap_err().kind(), io::ErrorKind::WouldBlock);
        fixture.peer.no_message().await;
        assert!(!feed.arm(RawGenerations { capture: 11, ..expected }));
        assert!(!feed.arm(RawGenerations { broadcast: 2, ..expected }));
        fixture.peer.no_message().await;
        assert!(feed.arm(expected));
        assert!(feed.arm(expected)); // Request-local idempotence, not a new Start.
        let (start, writers) = fixture.peer.receive().await;
        assert_eq!((start.capture, start.broadcast), (expected.capture, expected.broadcast));
        assert_eq!(writers.len(), 1);
        fixture.peer.no_message().await;
        fixture.peer.send(Wire { op: Op::Started, ..start }).await;
        wait_for(&feed, RawStatus::Live).await;
        feed.cancel();
        assert!(!feed.arm(expected));
        assert_eq!(fixture.peer.receive().await.0, Wire { op: Op::Stop, ..start });
        drop(writers);
        fixture.peer.send(Wire { op: Op::Stopped, reason: Reason::Cancelled, ..start }).await;
        wait_for(&feed, RawStatus::Stopped { reason: Reason::Cancelled }).await;
        assert_eq!(*feed.generations().borrow(), Some(expected));
        assert_eq!(pipe_read(&reader).unwrap(), 0);
        fixture.close().await;
    }

    #[tokio::test]
    async fn dropped_reservation_never_sends_stop_and_burns_its_generation() {
        let fixture = Fixture::new();
        fixture.peer.hello().await;
        let mut feed = prepare(&fixture.program.id, &fixture.requests).unwrap();
        let first = assigned(&feed).await;
        let old_arm = feed.armed.clone();
        let reader = feed.take_reader().unwrap();
        let mut status = feed.status();
        drop(feed);
        timeout(Duration::from_secs(1), status.wait_for(|value|
            *value == RawStatus::Stopped { reason: Reason::Cancelled })).await.unwrap().unwrap();
        assert_eq!(pipe_read(&reader).unwrap(), 0);
        fixture.peer.no_message().await;
        let replacement = prepare(&fixture.program.id, &fixture.requests).unwrap();
        let next = assigned(&replacement).await;
        assert_eq!(next.capture, first.capture);
        assert_eq!(next.broadcast, first.broadcast + 1);
        old_arm.store(true, Ordering::Release);
        fixture.peer.no_message().await;
        replacement.cancel();
        wait_for(&replacement, RawStatus::Stopped { reason: Reason::Cancelled }).await;
        fixture.close().await;
    }

    #[tokio::test]
    async fn queued_preparation_cancel_never_assigns_a_tuple_or_transfers_a_writer() {
        let fixture = Fixture::new();
        let mut feed = prepare(&fixture.program.id, &fixture.requests).unwrap();
        let reader = feed.take_reader().unwrap();
        feed.cancel();
        fixture.peer.hello().await;
        wait_for(&feed, RawStatus::Stopped { reason: Reason::Cancelled }).await;
        assert!(feed.generations().borrow().is_none());
        assert_eq!(pipe_read(&reader).unwrap(), 0);
        fixture.peer.no_message().await;
        let next = prepare(&fixture.program.id, &fixture.requests).unwrap();
        assert_eq!(assigned(&next).await.broadcast, 1); // No reservation was made for the cancelled queue entry.
        next.cancel(); wait_for(&next, RawStatus::Stopped { reason: Reason::Cancelled }).await;
        fixture.close().await;
    }

    #[tokio::test]
    async fn reserved_slot_is_busy_and_unsolicited_acknowledgements_cannot_resolve_it() {
        let fixture = Fixture::new();
        fixture.peer.hello().await;
        let feed = prepare(&fixture.program.id, &fixture.requests).unwrap();
        let tuple = assigned(&feed).await;
        let mut busy = prepare(&fixture.program.id, &fixture.requests).unwrap();
        let reader = busy.take_reader().unwrap();
        wait_for(&busy, RawStatus::Failed { reason: Reason::Busy, stop_confirmed: false }).await;
        assert!(busy.generations().borrow().is_none());
        assert!(!busy.arm(tuple));
        assert_eq!(pipe_read(&reader).unwrap(), 0);
        for op in [Op::Started, Op::Stopped, Op::Failed, Op::Rejected] {
            let reason = if op == Op::Started { Reason::None } else { Reason::Unavailable };
            fixture.peer.send(Wire { op, slot: 0, capture: tuple.capture, broadcast: tuple.broadcast, reason }).await;
        }
        fixture.peer.no_message().await;
        assert_eq!(*feed.status().borrow(), RawStatus::Starting);
        assert!(feed.arm(tuple));
        let (start, writers) = fixture.peer.receive().await;
        drop(writers);
        fixture.peer.send(Wire { op: Op::Failed, reason: Reason::AttachFailed, ..start }).await;
        wait_for(&feed, RawStatus::Failed { reason: Reason::AttachFailed, stop_confirmed: true }).await;
        assert!(!feed.arm(tuple));
        fixture.close().await;
    }

    #[tokio::test]
    async fn replacement_published_before_arm_never_receives_old_start() {
        let fixture = Fixture::new();
        fixture.peer.hello().await;
        let mut feed = prepare(&fixture.program.id, &fixture.requests).unwrap();
        let tuple = assigned(&feed).await;
        let reader = feed.take_reader().unwrap();
        let replacement = Program::new("b".repeat(32), "Replacement fixture".into(), None);
        replacement.publish(1, b"init"); replacement.publish(2, b"media");
        fixture.captures.send_replace(vec![CaptureSlot { slot: 0, generation: 11, program: replacement.clone() }]);
        // No yield: both watch change and arm are ready before the actor runs.
        assert!(feed.arm(tuple));
        wait_for(&feed, RawStatus::Stopped { reason: Reason::SourceStopped }).await;
        fixture.peer.no_message().await;
        assert_eq!(pipe_read(&reader).unwrap(), 0);
        let next = prepare(&replacement.id, &fixture.requests).unwrap();
        let assigned = assigned(&next).await;
        assert_eq!(assigned, RawGenerations { capture: 11, broadcast: tuple.broadcast + 1 });
        next.cancel();
        wait_for(&next, RawStatus::Stopped { reason: Reason::Cancelled }).await;
        assert!(!fixture.program.is_stopped()); assert!(fixture.program.encoded_ready());
        assert!(!replacement.is_stopped()); assert!(replacement.encoded_ready());
        fixture.close().await;
    }

    #[tokio::test]
    async fn cancellation_after_transfer_before_started_requires_matching_stop_ack() {
        let fixture = Fixture::new();
        fixture.peer.hello().await;
        let feed = prepare(&fixture.program.id, &fixture.requests).unwrap();
        let tuple = assigned(&feed).await;
        assert!(feed.arm(tuple));
        let (start, writers) = fixture.peer.receive().await;
        feed.cancel();
        fixture.peer.send(Wire { op: Op::Started, ..start }).await;
        let (stop, rights) = fixture.peer.receive().await;
        assert_eq!(stop, Wire { op: Op::Stop, ..start }); assert!(rights.is_empty());
        wait_for(&feed, RawStatus::Stopping).await;
        drop(writers);
        fixture.peer.send(Wire { op: Op::Stopped, broadcast: tuple.broadcast + 1, reason: Reason::Cancelled, ..start }).await;
        fixture.peer.no_message().await;
        assert_eq!(*feed.status().borrow(), RawStatus::Stopping);
        fixture.peer.send(Wire { op: Op::Stopped, reason: Reason::Cancelled, ..start }).await;
        wait_for(&feed, RawStatus::Stopped { reason: Reason::Cancelled }).await;
        fixture.close().await;
    }

    #[tokio::test]
    async fn reserved_source_loss_and_actor_shutdown_close_writer_without_control_messages() {
        for shutdown in [false, true] {
            let fixture = Fixture::new();
            fixture.peer.hello().await;
            let mut feed = prepare(&fixture.program.id, &fixture.requests).unwrap();
            assigned(&feed).await;
            let reader = feed.take_reader().unwrap();
            if shutdown { drop(fixture.captures); } else { fixture.captures.send_replace(Vec::new()); }
            wait_for(&feed, RawStatus::Stopped { reason: if shutdown { Reason::Unavailable } else { Reason::SourceStopped } }).await;
            fixture.peer.no_message().await;
            assert_eq!(pipe_read(&reader).unwrap(), 0);
            assert!(!fixture.program.is_stopped()); assert!(fixture.program.encoded_ready());
            drop(fixture.requests);
            timeout(Duration::from_secs(3), fixture.task).await.unwrap().unwrap();
        }
    }

    #[tokio::test]
    async fn reservation_deadline_is_distinct_from_native_ack_and_closes_locally() {
        let (control, peer) = Control::pair().unwrap();
        let peer = Peer::new(peer);
        let (sender, mut receiver) = mpsc::channel(2);
        let program = Program::new("a".repeat(32), "Generated fixture".into(), None);
        program.publish(1, b"init"); program.publish(2, b"media");
        let current = vec![CaptureSlot { slot: 0, generation: 10, program: program.clone() }];
        let (_updates, mut captures) = watch::channel(current.clone());
        let mut feed = prepare(&program.id, &sender).unwrap();
        let reader = feed.take_reader().unwrap();
        let mut attempts = [None, None]; let mut generations = [0, 0];
        admit(receiver.recv().await.unwrap(), &current, &mut attempts, &mut generations);
        let tuple = assigned(&feed).await;
        attempts[0].as_mut().unwrap().phase = Phase::Reserved(Instant::now() - ACK_DEADLINE - Duration::from_secs(1));
        assert!(!tick_attempts(&control, &mut captures, &mut attempts, false).await);
        assert!(matches!(attempts[0].as_ref().unwrap().phase, Phase::Reserved(_)));
        assert_eq!(pipe_read(&reader).unwrap_err().kind(), io::ErrorKind::WouldBlock);
        attempts[0].as_mut().unwrap().phase = Phase::Reserved(Instant::now() - RESERVATION_DEADLINE);
        assert!(!tick_attempts(&control, &mut captures, &mut attempts, false).await);
        assert!(attempts[0].is_none());
        wait_for(&feed, RawStatus::Failed { reason: Reason::Unavailable, stop_confirmed: true }).await;
        assert!(!feed.arm(tuple)); assert_eq!(pipe_read(&reader).unwrap(), 0);
        peer.no_message().await;
        let replacement = prepare(&program.id, &sender).unwrap();
        admit(receiver.recv().await.unwrap(), &current, &mut attempts, &mut generations);
        assert_eq!(assigned(&replacement).await.broadcast, tuple.broadcast + 1);
        replacement.cancel();
        tick_attempts(&control, &mut captures, &mut attempts, false).await;
    }

    #[tokio::test]
    async fn started_uses_latest_capture_snapshot_even_before_watch_branch_runs() {
        let (sender, mut receiver) = mpsc::channel(2);
        let program = Program::new("a".repeat(32), "Generated fixture".into(), None);
        program.publish(1, b"init"); program.publish(2, b"media");
        let current = vec![CaptureSlot { slot: 0, generation: 10, program: program.clone() }];
        let (updates, mut captures) = watch::channel(current.clone());
        let feed = prepare(&program.id, &sender).unwrap();
        let mut attempts = [None, None]; let mut generations = [0, 0];
        admit(receiver.recv().await.unwrap(), &current, &mut attempts, &mut generations);
        let tuple = assigned(&feed).await;
        attempts[0].as_mut().unwrap().phase = Phase::Starting(Instant::now());
        updates.send_replace(Vec::new());
        acknowledge(Wire { op: Op::Started, slot: 0, capture: tuple.capture, broadcast: tuple.broadcast,
            reason: Reason::None }, &mut captures, &mut attempts, false);
        assert!(matches!(attempts[0].as_ref().unwrap().phase, Phase::Starting(_)));
        assert_eq!(*feed.status().borrow(), RawStatus::Starting);
    }

    #[tokio::test]
    async fn cancellation_while_start_send_is_unready_never_leaks_writer() {
        let (control, peer) = Control::pair().unwrap();
        let peer = Peer::new(peer);
        let mut queued = 0;
        while queued < 128 && matches!(timeout(Duration::from_millis(5), control.send_stop(1, 2, 3)).await, Ok(Ok(()))) {
            queued += 1;
        }
        assert!(queued > 0 && queued < 128, "generated datagram queue must become full");
        let (sender, mut receiver) = mpsc::channel(2);
        let program = Program::new("a".repeat(32), "Generated fixture".into(), None);
        program.publish(1, b"init"); program.publish(2, b"media");
        let current = vec![CaptureSlot { slot: 0, generation: 10, program: program.clone() }];
        let (_updates, mut captures) = watch::channel(current.clone());
        let mut feed = prepare(&program.id, &sender).unwrap();
        let reader = feed.take_reader().unwrap();
        let mut attempts = [None, None]; let mut generations = [0, 0];
        admit(receiver.recv().await.unwrap(), &current, &mut attempts, &mut generations);
        assert!(feed.arm(assigned(&feed).await));
        let cancellation = feed.cancel.clone();
        let cancel_task = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(10)).await;
            cancellation.store(true, Ordering::Release);
        });
        let began = Instant::now();
        tick_attempts(&control, &mut captures, &mut attempts, false).await;
        cancel_task.await.unwrap();
        assert!(began.elapsed() < Duration::from_secs(1));
        assert!(attempts[0].is_none());
        wait_for(&feed, RawStatus::Failed { reason: Reason::Unavailable, stop_confirmed: false }).await;
        assert_eq!(pipe_read(&reader).unwrap(), 0);
        for _ in 0..queued {
            let (record, rights) = peer.receive().await;
            assert_eq!(record.op, Op::Stop); assert_eq!(record.slot, 1); assert!(rights.is_empty());
        }
        peer.no_message().await; // In particular, no delayed Start after cancellation.
        assert!(!program.is_stopped()); assert!(program.encoded_ready());
    }

    #[tokio::test]
    async fn hello_gates_start_and_explicit_cancel_waits_for_matching_terminal() {
        let fixture = Fixture::new();
        let mut feed = begin(&fixture.program.id, &fixture.requests).unwrap();
        fixture.peer.no_message().await;
        fixture.peer.hello().await;
        let (record, writers) = fixture.peer.receive().await;
        assert_eq!(writers.len(), 1);
        fixture.peer.send(Wire { op: Op::Started, ..record }).await;
        wait_for(&feed, RawStatus::Live).await;
        let reader = feed.take_reader().unwrap();
        assert!(feed.take_reader().is_none());
        let byte = b"x";
        assert_eq!(unsafe { libc::write(writers[0].as_raw_fd(), byte.as_ptr().cast(), 1) }, 1);
        feed.cancel();
        let (stop, stop_rights) = fixture.peer.receive().await;
        assert_eq!(stop, Wire { op: Op::Stop, ..record }); assert!(stop_rights.is_empty());
        fixture.peer.send(Wire { op: Op::Stopped, broadcast: record.broadcast + 1, reason: Reason::Cancelled, ..record }).await;
        wait_for(&feed, RawStatus::Stopping).await;
        drop(writers);
        fixture.peer.send(Wire { op: Op::Stopped, reason: Reason::Cancelled, ..record }).await;
        wait_for(&feed, RawStatus::Stopped { reason: Reason::Cancelled }).await;
        // Native terminal status does not consume media already in the pipe.
        assert_eq!(pipe_read(&reader).unwrap(), 1);
        assert_eq!(pipe_read(&reader).unwrap(), 0);
        assert!(!fixture.program.is_stopped()); assert!(fixture.program.encoded_ready());
        fixture.close().await;
    }

    #[tokio::test]
    async fn cancellation_before_hello_never_transfers_a_descriptor() {
        let fixture = Fixture::new();
        let mut feed = begin(&fixture.program.id, &fixture.requests).unwrap();
        let reader = feed.take_reader().unwrap();
        feed.cancel();
        fixture.peer.hello().await;
        wait_for(&feed, RawStatus::Stopped { reason: Reason::Cancelled }).await;
        fixture.peer.no_message().await;
        assert_eq!(pipe_read(&reader).unwrap(), 0);
        fixture.close().await;
    }

    #[tokio::test]
    async fn latest_capture_snapshot_wins_at_request_admission() {
        for generation in 11..19 {
            let fixture = Fixture::new();
            fixture.peer.hello().await;
            fixture.peer.no_message().await;
            let replacement = Program::new("b".repeat(32), "Replacement fixture".into(), None);
            replacement.publish(1, b"init"); replacement.publish(2, b"media");
            fixture.captures.send_replace(vec![CaptureSlot { slot: 0, generation, program: replacement.clone() }]);
            // No yield between publication and queueing: both select branches
            // can be ready while the actor still caches the former program.
            let feed = begin(&replacement.id, &fixture.requests).unwrap();
            let (start, writers) = fixture.peer.receive().await;
            assert_eq!(start.capture, generation);
            drop(writers);
            fixture.peer.send(Wire { op: Op::Failed, reason: Reason::AttachFailed, ..start }).await;
            wait_for(&feed, RawStatus::Failed { reason: Reason::AttachFailed, stop_confirmed: true }).await;
            fixture.close().await;
        }
    }

    #[tokio::test]
    async fn dropped_feed_stops_and_old_cancellation_cannot_stop_replacement() {
        let fixture = Fixture::new();
        let (feed, first, writers) = fixture.active().await;
        let old_cancel = feed.cancel.clone();
        let mut old_status = feed.status();
        drop(feed);
        assert_eq!(fixture.peer.receive().await.0.op, Op::Stop);
        drop(writers);
        fixture.peer.send(Wire { op: Op::Stopped, reason: Reason::Cancelled, ..first }).await;
        // Wait for the terminal to free the actor slot before the replacement.
        timeout(Duration::from_secs(1), old_status.wait_for(|status|
            *status == RawStatus::Stopped { reason: Reason::Cancelled })).await.unwrap().unwrap();
        let replacement = begin(&fixture.program.id, &fixture.requests).unwrap();
        let (next, writers) = fixture.peer.receive().await;
        assert!(next.broadcast > first.broadcast);
        fixture.peer.send(Wire { op: Op::Started, ..next }).await;
        wait_for(&replacement, RawStatus::Live).await;
        old_cancel.store(true, Ordering::Release);
        fixture.peer.send(Wire { op: Op::Stopped, reason: Reason::Cancelled, ..first }).await;
        fixture.peer.no_message().await;
        assert_eq!(*replacement.status().borrow(), RawStatus::Live);
        replacement.cancel(); fixture.peer.receive().await;
        drop(writers);
        fixture.peer.send(Wire { op: Op::Stopped, reason: Reason::Cancelled, ..next }).await;
        wait_for(&replacement, RawStatus::Stopped { reason: Reason::Cancelled }).await;
        fixture.close().await;
    }

    #[tokio::test]
    async fn source_loss_cancels_only_raw_and_busy_requests_close_their_pipe() {
        let fixture = Fixture::new();
        let (feed, record, writers) = fixture.active().await;
        let mut busy = begin(&fixture.program.id, &fixture.requests).unwrap();
        let reader = busy.take_reader().unwrap();
        wait_for(&busy, RawStatus::Failed { reason: Reason::Busy, stop_confirmed: false }).await;
        assert_eq!(pipe_read(&reader).unwrap(), 0);
        fixture.captures.send_replace(Vec::new());
        let (stop, _) = fixture.peer.receive().await;
        assert_eq!(stop, Wire { op: Op::Stop, ..record });
        drop(writers);
        fixture.peer.send(Wire { op: Op::Stopped, reason: Reason::SourceStopped, ..record }).await;
        wait_for(&feed, RawStatus::Stopped { reason: Reason::SourceStopped }).await;
        assert!(!fixture.program.is_stopped());
        fixture.close().await;
    }

    #[tokio::test]
    async fn missing_stop_ack_is_unconfirmed_and_keeps_slot_reserved() {
        let fixture = Fixture::new();
        let (feed, record, writers) = fixture.active().await;
        feed.cancel(); fixture.peer.receive().await;
        wait_for(&feed, RawStatus::Failed { reason: Reason::Unavailable, stop_confirmed: false }).await;
        let busy = begin(&fixture.program.id, &fixture.requests).unwrap();
        wait_for(&busy, RawStatus::Failed { reason: Reason::Busy, stop_confirmed: false }).await;
        drop(writers);
        fixture.peer.send(Wire { op: Op::Stopped, reason: Reason::Cancelled, ..record }).await;
        wait_for(&feed, RawStatus::Stopped { reason: Reason::Cancelled }).await;
        assert!(!fixture.program.is_stopped());
        fixture.close().await;
    }

    #[tokio::test]
    async fn absent_hello_and_dropped_queue_report_failure_without_claiming_stop() {
        let fixture = Fixture::new();
        let mut feed = begin(&fixture.program.id, &fixture.requests).unwrap();
        let reader = feed.take_reader().unwrap();
        tokio::task::yield_now().await;
        wait_for(&feed, RawStatus::Failed { reason: Reason::Unavailable, stop_confirmed: false }).await;
        assert_eq!(pipe_read(&reader).unwrap(), 0);
        fixture.close().await;
        let (sender, receiver) = mpsc::channel(2);
        let mut feed = begin(&"b".repeat(32), &sender).unwrap();
        let reader = feed.take_reader().unwrap();
        drop(receiver);
        wait_for(&feed, RawStatus::Failed { reason: Reason::Unavailable, stop_confirmed: false }).await;
        assert_eq!(pipe_read(&reader).unwrap(), 0);
    }

    #[tokio::test]
    async fn malformed_control_and_shutdown_never_stop_encoded_preview() {
        let fixture = Fixture::new();
        let (feed, _, writers) = fixture.active().await;
        fixture.peer.socket.send(b"bad").await.unwrap();
        assert_eq!(fixture.peer.receive().await.0.op, Op::Stop);
        wait_for(&feed, RawStatus::Failed { reason: Reason::Unavailable, stop_confirmed: false }).await;
        drop(writers);
        assert!(!fixture.program.is_stopped()); assert!(fixture.program.encoded_ready());
        fixture.close().await;
    }
}
