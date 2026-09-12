//! Private descriptor transport for an explicitly enabled OBS raw output.
//! This socket pair never binds a path or network address. Media goes through
//! one unlinked FIFO per broadcast; the existing encoded stdout is separate.
use std::{
    io,
    mem::{self, size_of},
    os::fd::{AsRawFd, BorrowedFd, OwnedFd, RawFd},
    os::unix::net::UnixDatagram as StdDatagram,
};
use tokio::{io::Interest, net::UnixDatagram, process::Command};
#[path = "raw_pipe.rs"]
mod raw_pipe;

const SIZE: usize = 32;
// Darwin installs every passed descriptor before truncating ancillary output.
// Cover XNU's UIPC_MAX_CMSG_FD (512), including its header, so rejection never
// loses the descriptor numbers needed for close. See bsd/kern/uipc_usrreq.c:
// https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/uipc_usrreq.c
const MAX_ANCILLARY_RIGHTS: usize = 512;
const ANCILLARY_BYTES: usize = 4096;
pub(super) const MAX_GENERATION: u64 = 9_007_199_254_740_991;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub(super) enum Op {
    Hello = 1,
    Start = 2,
    Stop = 3,
    Started = 4,
    Stopped = 5,
    Failed = 6,
    Rejected = 7,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u16)]
pub enum Reason {
    None = 0,
    Unavailable = 1,
    Stale = 2,
    Busy = 3,
    InvalidDescriptor = 4,
    AttachFailed = 5,
    WriterFailed = 6,
    SourceStopped = 7,
    Cancelled = 8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Wire {
    pub op: Op,
    pub slot: u8,
    pub reason: Reason,
    pub capture: u64,
    pub broadcast: u64,
}

fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "Invalid OBS raw control record")
}

impl Wire {
    pub(super) fn validate(self) -> io::Result<()> {
        if self.op == Op::Hello {
            return if self.slot == 0 && self.reason == Reason::None && self.capture == 0 && self.broadcast == 0 {
                Ok(())
            } else {
                Err(invalid())
            };
        }
        if self.slot > 1 || !(1..=MAX_GENERATION).contains(&self.capture) || !(1..=MAX_GENERATION).contains(&self.broadcast) {
            return Err(invalid());
        }
        match self.op {
            Op::Start | Op::Stop | Op::Started if self.reason != Reason::None => Err(invalid()),
            Op::Failed | Op::Rejected if self.reason == Reason::None => Err(invalid()),
            _ => Ok(()),
        }
    }

    pub(super) fn encode(self) -> io::Result<[u8; SIZE]> {
        self.validate()?;
        let mut bytes = [0; SIZE];
        bytes[..4].copy_from_slice(b"SBC1");
        bytes[4] = self.op as u8;
        bytes[5] = self.slot;
        bytes[6..8].copy_from_slice(&(self.reason as u16).to_be_bytes());
        bytes[8..16].copy_from_slice(&self.capture.to_be_bytes());
        bytes[16..24].copy_from_slice(&self.broadcast.to_be_bytes());
        Ok(bytes)
    }

    pub(super) fn decode(bytes: &[u8]) -> io::Result<Self> {
        if bytes.len() != SIZE || &bytes[..4] != b"SBC1" || bytes[24..].iter().any(|byte| *byte != 0) {
            return Err(invalid());
        }
        let op = match bytes[4] {
            1 => Op::Hello,
            2 => Op::Start,
            3 => Op::Stop,
            4 => Op::Started,
            5 => Op::Stopped,
            6 => Op::Failed,
            7 => Op::Rejected,
            _ => return Err(invalid()),
        };
        let reason = match u16::from_be_bytes([bytes[6], bytes[7]]) {
            0 => Reason::None,
            1 => Reason::Unavailable,
            2 => Reason::Stale,
            3 => Reason::Busy,
            4 => Reason::InvalidDescriptor,
            5 => Reason::AttachFailed,
            6 => Reason::WriterFailed,
            7 => Reason::SourceStopped,
            8 => Reason::Cancelled,
            _ => return Err(invalid()),
        };
        let record = Self {
            op,
            slot: bytes[5],
            reason,
            capture: u64::from_be_bytes(bytes[8..16].try_into().map_err(|_| invalid())?),
            broadcast: u64::from_be_bytes(bytes[16..24].try_into().map_err(|_| invalid())?),
        };
        record.validate()?;
        Ok(record)
    }
}

pub(super) struct Control {
    socket: UnixDatagram,
}

impl Control {
    /// Must be called inside a Tokio runtime. No descriptor is inheritable
    /// until prepare_child installs its child-only pre-exec operation.
    pub(super) fn pair() -> io::Result<(Self, OwnedFd)> {
        let (owner, child) = StdDatagram::pair()?;
        owner.set_nonblocking(true)?;
        cloexec(owner.as_raw_fd())?;
        cloexec(child.as_raw_fd())?;
        #[cfg(target_os = "macos")]
        for socket in [&owner, &child] {
            let enabled: libc::c_int = 1;
            // Datagram sends should report a closed peer, never signal the app.
            if unsafe { libc::setsockopt(socket.as_raw_fd(), libc::SOL_SOCKET, libc::SO_NOSIGPIPE,
                (&enabled as *const libc::c_int).cast(), size_of::<libc::c_int>() as _) } == -1 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok((Self { socket: UnixDatagram::from_std(owner)? }, child.into()))
    }

    /// Call after env_clear(). The Command owns child through spawn; the parent
    /// MUST drop(command) immediately after spawn to close its duplicate peer.
    /// On failed/cancelled spawn, dropping Command also closes that descriptor.
    pub(super) fn prepare_child(command: &mut Command, child: OwnedFd) -> io::Result<()> {
        cloexec(child.as_raw_fd())?;
        command.env("SAUCE_OBS_RAW_CONTROL_FD", child.as_raw_fd().to_string());
        // Only fcntl runs between fork and exec: no allocation, locking, or
        // environment changes there. Capturing OwnedFd keeps its number valid.
        unsafe {
            command.pre_exec(move || {
                let fd = child.as_raw_fd();
                let flags = libc::fcntl(fd, libc::F_GETFD);
                if flags == -1 || libc::fcntl(fd, libc::F_SETFD, flags & !libc::FD_CLOEXEC) == -1 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        Ok(())
    }

    /// The caller owns the timeout and keeps writer until completion. A single
    /// successful sendmsg transfers exactly one reference, atomically with the
    /// Start record. Cancelling an unready send transfers none.
    pub(super) async fn send_start(&self, slot: u8, capture: u64, broadcast: u64, writer: BorrowedFd<'_>) -> io::Result<()> {
        writable_pipe(writer.as_raw_fd())?;
        let bytes = Wire { op: Op::Start, slot, reason: Reason::None, capture, broadcast }.encode()?;
        self.send(&bytes, &[writer.as_raw_fd()]).await
    }

    pub(super) async fn send_stop(&self, slot: u8, capture: u64, broadcast: u64) -> io::Result<()> {
        let bytes = Wire { op: Op::Stop, slot, reason: Reason::None, capture, broadcast }.encode()?;
        self.send(&bytes, &[]).await
    }

    async fn send(&self, bytes: &[u8], rights: &[RawFd]) -> io::Result<()> {
        loop {
            let result = self.socket.async_io(Interest::WRITABLE, ||
                send_datagram(self.socket.as_raw_fd(), bytes, rights)).await;
            match result {
                // Darwin reports a full peer datagram queue as ENOBUFS while
                // the socket may still appear writable. Yield on a timer, not
                // readiness, so retries neither busy-spin nor retain rights
                // after the caller's deadline cancels this future.
                Err(error) if error.raw_os_error() == Some(libc::ENOBUFS) =>
                    tokio::time::sleep(std::time::Duration::from_millis(5)).await,
                result => return result,
            }
        }
    }

    /// Cancellation-safe: no receive syscall occurs while awaiting readiness.
    /// Status datagrams never carry descriptors; any received rights are closed
    /// before malformed/status validation returns, including truncated packets.
    pub(super) async fn receive(&self) -> io::Result<Wire> {
        self.socket.async_io(Interest::READABLE, || receive_status(self.socket.as_raw_fd())).await
    }

    /// Direct nonblocking receive for bounded supervisor ticks. A subsequent
    /// async receive still rechecks the syscall and clears stale readiness.
    pub(super) fn try_receive(&self) -> io::Result<Option<Wire>> {
        match receive_status(self.socket.as_raw_fd()) {
            Ok(record) => Ok(Some(record)),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => Ok(None),
            Err(error) => Err(error),
        }
    }
}

fn cloexec(fd: RawFd) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
    if flags == -1 || unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
fn nonblocking(fd: RawFd) -> io::Result<()> {
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags == -1 || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// One unlinked raw-media FIFO. Both ends are atomically CLOEXEC and nonblocking;
/// temporary filesystem metadata is removed before return; media stays in kernel memory.
pub(super) fn pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    raw_pipe::pipe()
}

fn writable_pipe(fd: RawFd) -> io::Result<()> {
    let mut stat: libc::stat = unsafe { mem::zeroed() };
    if unsafe { libc::fstat(fd, &mut stat) } == -1 {
        return Err(io::Error::last_os_error());
    }
    let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
    if flags == -1 {
        return Err(io::Error::last_os_error());
    }
    if stat.st_mode & libc::S_IFMT != libc::S_IFIFO || flags & libc::O_ACCMODE != libc::O_WRONLY {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "OBS raw output needs a write pipe"));
    }
    Ok(())
}

fn send_datagram(socket: RawFd, bytes: &[u8], rights: &[RawFd]) -> io::Result<()> {
    // Production Start supplies one right. Extra capacity exists only to test
    // rejection of hostile ancillary records without allocating unbounded data.
    if rights.len() > MAX_ANCILLARY_RIGHTS {
        return Err(invalid());
    }
    let mut ancillary = [0usize; ANCILLARY_BYTES / size_of::<usize>()];
    let mut iov = libc::iovec { iov_base: bytes.as_ptr().cast_mut().cast(), iov_len: bytes.len() };
    let mut message: libc::msghdr = unsafe { mem::zeroed() };
    message.msg_iov = &mut iov;
    message.msg_iovlen = 1;
    if !rights.is_empty() {
        let payload = mem::size_of_val(rights);
        message.msg_control = ancillary.as_mut_ptr().cast();
        message.msg_controllen = unsafe { libc::CMSG_SPACE(payload as _) as _ };
        // CMSG_SPACE above fits the fixed aligned buffer for the bounded list.
        unsafe {
            let header = libc::CMSG_FIRSTHDR(&message);
            (*header).cmsg_level = libc::SOL_SOCKET;
            (*header).cmsg_type = libc::SCM_RIGHTS;
            (*header).cmsg_len = libc::CMSG_LEN(payload as _) as _;
            std::ptr::copy_nonoverlapping(rights.as_ptr().cast::<u8>(), libc::CMSG_DATA(header), payload);
        }
    }
    #[cfg(target_os = "linux")]
    let flags = libc::MSG_NOSIGNAL;
    #[cfg(not(target_os = "linux"))]
    let flags = 0;
    let written = unsafe { libc::sendmsg(socket, &message, flags) };
    if written == -1 {
        return Err(io::Error::last_os_error());
    }
    if written as usize != bytes.len() {
        return Err(io::Error::new(io::ErrorKind::WriteZero, "Incomplete OBS raw control datagram"));
    }
    Ok(())
}

fn receive_status(socket: RawFd) -> io::Result<Wire> {
    let mut bytes = [0u8; SIZE];
    let mut ancillary = [0usize; ANCILLARY_BYTES / size_of::<usize>()];
    let mut iov = libc::iovec { iov_base: bytes.as_mut_ptr().cast(), iov_len: bytes.len() };
    let mut message: libc::msghdr = unsafe { mem::zeroed() };
    message.msg_iov = &mut iov;
    message.msg_iovlen = 1;
    message.msg_control = ancillary.as_mut_ptr().cast();
    message.msg_controllen = mem::size_of_val(&ancillary) as _;
    let received = unsafe { libc::recvmsg(socket, &mut message, 0) };
    if received == -1 {
        return Err(io::Error::last_os_error());
    }
    // Receive capacity covers Darwin's accepted rights bound. Close every
    // disclosed right before rejecting invalid bytes, direction, or flags.
    close_received_rights(&ancillary, message.msg_controllen as usize);
    if received as usize != SIZE || message.msg_flags & (libc::MSG_TRUNC | libc::MSG_CTRUNC) != 0 || message.msg_controllen != 0 {
        return Err(invalid());
    }
    let record = Wire::decode(&bytes)?;
    if matches!(record.op, Op::Start | Op::Stop) {
        return Err(invalid());
    }
    Ok(record)
}

fn close_received_rights(storage: &[usize], reported: usize) {
    let length = reported.min(mem::size_of_val(storage));
    let base = storage.as_ptr().cast::<u8>();
    let header_size = unsafe { libc::CMSG_LEN(0) as usize };
    let mut offset = 0usize;
    while offset + size_of::<libc::cmsghdr>() <= length {
        // Even malformed ancillary lengths cannot take reads outside the fixed
        // receiver buffer. Normal kernel control headers satisfy these bounds.
        let header = unsafe { std::ptr::read_unaligned(base.add(offset).cast::<libc::cmsghdr>()) };
        let declared = header.cmsg_len as usize;
        if declared < header_size {
            break;
        }
        let end = offset.saturating_add(declared).min(length);
        if header.cmsg_level == libc::SOL_SOCKET && header.cmsg_type == libc::SCM_RIGHTS {
            let mut at = offset + header_size;
            while at + size_of::<RawFd>() <= end {
                let fd = unsafe { std::ptr::read_unaligned(base.add(at).cast::<RawFd>()) };
                if fd >= 0 {
                    // Never retry close: a concurrent allocation may reuse fd.
                    unsafe { libc::close(fd); }
                }
                at += size_of::<RawFd>();
            }
        }
        let step = unsafe { libc::CMSG_SPACE((declared - header_size) as _) as usize };
        if step == 0 || step > length - offset {
            break;
        }
        offset += step;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{os::fd::{AsFd, FromRawFd}, time::Duration};

    fn status(op: Op, reason: Reason) -> Wire {
        Wire { op, slot: 1, reason, capture: 0x0001020304050607, broadcast: MAX_GENERATION }
    }

    fn read_byte(fd: &OwnedFd) -> io::Result<usize> {
        let mut byte = 0u8;
        let count = unsafe { libc::read(fd.as_raw_fd(), (&mut byte as *mut u8).cast(), 1) };
        if count < 0 { Err(io::Error::last_os_error()) } else { Ok(count as usize) }
    }

    #[test]
    fn wire_round_trips_exact_layout_and_all_reasons() {
        let wire = status(Op::Started, Reason::None);
        let bytes = wire.encode().unwrap();
        assert_eq!(&bytes[..8], b"SBC1\x04\x01\x00\x00");
        assert_eq!(&bytes[8..16], &[0, 1, 2, 3, 4, 5, 6, 7]);
        assert_eq!(&bytes[16..24], &[0, 31, 255, 255, 255, 255, 255, 255]);
        assert_eq!(&bytes[24..], &[0; 8]);
        assert_eq!(Wire::decode(&bytes).unwrap(), wire);
        for reason in [Reason::Unavailable, Reason::Stale, Reason::Busy, Reason::InvalidDescriptor,
            Reason::AttachFailed, Reason::WriterFailed, Reason::SourceStopped, Reason::Cancelled] {
            for op in [Op::Failed, Op::Rejected, Op::Stopped] {
                let wire = status(op, reason);
                assert_eq!(Wire::decode(&wire.encode().unwrap()).unwrap(), wire);
            }
        }
        let hello = Wire { op: Op::Hello, slot: 0, reason: Reason::None, capture: 0, broadcast: 0 };
        assert_eq!(Wire::decode(&hello.encode().unwrap()).unwrap(), hello);
        for op in [Op::Start, Op::Stop, Op::Stopped] {
            let wire = status(op, Reason::None);
            assert_eq!(Wire::decode(&wire.encode().unwrap()).unwrap(), wire);
        }
    }

    #[test]
    fn hostile_headers_and_invalid_typed_records_fail() {
        let valid = status(Op::Started, Reason::None).encode().unwrap();
        for length in 0..SIZE {
            assert!(Wire::decode(&valid[..length]).is_err());
        }
        assert!(Wire::decode(&[valid.as_slice(), &[0]].concat()).is_err());
        for offset in [0, 1, 2, 3, 4, 5, 6, 7, 24, 25, 26, 27, 28, 29, 30, 31] {
            let mut bad = valid;
            bad[offset] = 255;
            assert!(Wire::decode(&bad).is_err(), "offset {offset}");
        }
        for start in [8, 16] {
            let mut bad = valid;
            bad[start..start + 8].fill(0);
            assert!(Wire::decode(&bad).is_err());
            bad[start..start + 8].copy_from_slice(&(MAX_GENERATION + 1).to_be_bytes());
            assert!(Wire::decode(&bad).is_err());
        }
        for op in [Op::Start, Op::Stop, Op::Started] {
            assert!(status(op, Reason::Cancelled).encode().is_err());
        }
        for op in [Op::Failed, Op::Rejected] {
            assert!(status(op, Reason::None).encode().is_err());
        }
        assert!(status(Op::Hello, Reason::None).encode().is_err());
    }

    #[tokio::test]
    async fn statuses_are_atomic_and_pending_receive_is_cancellable() {
        let (control, child) = Control::pair().unwrap();
        assert!(control.try_receive().unwrap().is_none());
        assert!(tokio::time::timeout(Duration::from_millis(10), control.receive()).await.is_err());
        let expected = status(Op::Started, Reason::None);
        send_datagram(child.as_raw_fd(), &expected.encode().unwrap(), &[]).unwrap();
        assert_eq!(tokio::time::timeout(Duration::from_secs(1), control.receive()).await.unwrap().unwrap(), expected);
        assert!(control.try_receive().unwrap().is_none());
        send_datagram(child.as_raw_fd(), &status(Op::Stop, Reason::None).encode().unwrap(), &[]).unwrap();
        assert_eq!(control.try_receive().unwrap_err().kind(), io::ErrorKind::InvalidData);
        let oversized = [expected.encode().unwrap().as_slice(), &[9]].concat();
        send_datagram(child.as_raw_fd(), &oversized, &[]).unwrap();
        assert_eq!(control.try_receive().unwrap_err().kind(), io::ErrorKind::InvalidData);
        send_datagram(child.as_raw_fd(), &expected.encode().unwrap(), &[]).unwrap();
        assert_eq!(control.try_receive().unwrap(), Some(expected));
    }

    #[tokio::test]
    async fn start_transfers_one_write_pipe_and_stop_transfers_none() {
        let (control, child) = Control::pair().unwrap();
        let (reader, writer) = pipe().unwrap();
        let expected = status(Op::Start, Reason::None);
        control.send_start(expected.slot, expected.capture, expected.broadcast, writer.as_fd()).await.unwrap();
        let mut bytes = [0u8; SIZE];
        let mut ancillary = [0usize; 32];
        let mut iov = libc::iovec { iov_base: bytes.as_mut_ptr().cast(), iov_len: SIZE };
        let mut message: libc::msghdr = unsafe { mem::zeroed() };
        message.msg_iov = &mut iov;
        message.msg_iovlen = 1;
        message.msg_control = ancillary.as_mut_ptr().cast();
        message.msg_controllen = mem::size_of_val(&ancillary) as _;
        assert_eq!(unsafe { libc::recvmsg(child.as_raw_fd(), &mut message, 0) }, SIZE as isize);
        let header = unsafe { libc::CMSG_FIRSTHDR(&message) };
        assert!(!header.is_null());
        assert_eq!(unsafe { (*header).cmsg_level }, libc::SOL_SOCKET);
        assert_eq!(unsafe { (*header).cmsg_type }, libc::SCM_RIGHTS);
        assert_eq!(unsafe { (*header).cmsg_len } as usize, unsafe { libc::CMSG_LEN(size_of::<RawFd>() as _) as usize });
        assert!(unsafe { libc::CMSG_NXTHDR(&message, header) }.is_null());
        let received = unsafe { OwnedFd::from_raw_fd(std::ptr::read_unaligned(libc::CMSG_DATA(header).cast::<RawFd>())) };
        assert_eq!(Wire::decode(&bytes).unwrap(), expected);
        drop(writer);
        assert_eq!(read_byte(&reader).unwrap_err().kind(), io::ErrorKind::WouldBlock);
        let data = b"x";
        assert_eq!(unsafe { libc::write(received.as_raw_fd(), data.as_ptr().cast(), 1) }, 1);
        assert_eq!(read_byte(&reader).unwrap(), 1);
        drop(received);
        assert_eq!(read_byte(&reader).unwrap(), 0);
        control.send_stop(expected.slot, expected.capture, expected.broadcast).await.unwrap();
        message.msg_controllen = mem::size_of_val(&ancillary) as _;
        assert_eq!(unsafe { libc::recvmsg(child.as_raw_fd(), &mut message, 0) }, SIZE as isize);
        assert_eq!(message.msg_controllen, 0);
        assert_eq!(Wire::decode(&bytes).unwrap().op, Op::Stop);
    }

    #[tokio::test]
    async fn rejected_descriptors_close_with_truncated_payload_or_many_rights() {
        let (control, child) = Control::pair().unwrap();
        for (count, extra_byte) in [(1, false), (1, true), (32, false), (253, false)] {
            let (reader, writer) = pipe().unwrap();
            let mut bytes = status(Op::Started, Reason::None).encode().unwrap().to_vec();
            if extra_byte { bytes.push(1); }
            send_datagram(child.as_raw_fd(), &bytes, &vec![writer.as_raw_fd(); count]).unwrap();
            drop(writer);
            // The queued SCM_RIGHTS references keep the writer alive first.
            assert_eq!(read_byte(&reader).unwrap_err().kind(), io::ErrorKind::WouldBlock);
            assert_eq!(control.try_receive().unwrap_err().kind(), io::ErrorKind::InvalidData);
            // EOF proves all rights were received and closed. A 16-fd receive
            // buffer leaks undisclosed Darwin rights and fails this assertion.
            assert_eq!(read_byte(&reader).unwrap(), 0);
        }
    }

    #[tokio::test]
    async fn start_rejects_read_ends_and_sockets_without_transferring() {
        let (control, child) = Control::pair().unwrap();
        let (reader, _writer) = pipe().unwrap();
        for fd in [reader.as_fd(), child.as_fd()] {
            assert_eq!(control.send_start(0, 1, 1, fd).await.unwrap_err().kind(), io::ErrorKind::InvalidInput);
        }
        nonblocking(child.as_raw_fd()).unwrap();
        let mut byte = 0u8;
        assert_eq!(unsafe { libc::recv(child.as_raw_fd(), (&mut byte as *mut u8).cast(), 1, 0) }, -1);
        assert_eq!(io::Error::last_os_error().kind(), io::ErrorKind::WouldBlock);
    }

    #[tokio::test]
    async fn cancelled_unready_start_keeps_no_pipe_reference() {
        let (control, child) = Control::pair().unwrap();
        let bytes = status(Op::Stop, Reason::None).encode().unwrap();
        let mut queued = 0;
        loop {
            match send_datagram(control.socket.as_raw_fd(), &bytes, &[]) {
                Ok(()) => queued += 1,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock || error.raw_os_error() == Some(libc::ENOBUFS) => break,
                Err(error) => panic!("queue fill failed: {error}"),
            }
            assert!(queued < 100_000, "queue must be bounded");
        }
        assert!(queued > 0);
        let (reader, writer) = pipe().unwrap();
        assert!(tokio::time::timeout(Duration::from_millis(10), control.send_start(0, 1, 1, writer.as_fd())).await.is_err());
        drop(writer);
        // No reference was enqueued by the cancelled Start.
        assert_eq!(read_byte(&reader).unwrap(), 0);
        nonblocking(child.as_raw_fd()).unwrap();
        let mut received = [0u8; SIZE];
        for _ in 0..queued {
            assert_eq!(unsafe { libc::recv(child.as_raw_fd(), received.as_mut_ptr().cast(), SIZE, 0) }, SIZE as isize);
        }
        // Cancellation must not poison later sends once pressure is relieved.
        tokio::time::timeout(Duration::from_millis(100), control.send_stop(0, 1, 2)).await.unwrap().unwrap();
        assert_eq!(unsafe { libc::recv(child.as_raw_fd(), received.as_mut_ptr().cast(), SIZE, 0) }, SIZE as isize);
        assert_eq!(Wire::decode(&received).unwrap().broadcast, 2);
        drop(child);
    }

    #[tokio::test]
    async fn command_retains_only_its_peer_until_dropped_and_pipe_flags_are_safe() {
        let (control, child) = Control::pair().unwrap();
        let raw = child.as_raw_fd();
        let mut command = Command::new("/usr/bin/true");
        command.env_clear();
        Control::prepare_child(&mut command, child).unwrap();
        assert_ne!(unsafe { libc::fcntl(raw, libc::F_GETFD) } & libc::FD_CLOEXEC, 0);
        let configured = command.as_std().get_envs().find(|(key, _)| *key == "SAUCE_OBS_RAW_CONTROL_FD").unwrap().1.unwrap();
        assert_eq!(configured, raw.to_string().as_str());
        drop(command); // no process is launched by this test
        // Inspect the retained socket's peer, not the released fd number,
        // which another concurrently running test could immediately reuse.
        assert!(send_datagram(control.socket.as_raw_fd(), &status(Op::Stop, Reason::None).encode().unwrap(), &[]).is_err());
        assert!(unsafe { libc::fcntl(control.socket.as_raw_fd(), libc::F_GETFD) } >= 0);
        let (reader, writer) = pipe().unwrap();
        for fd in [&reader, &writer] {
            assert_ne!(unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC, 0);
            assert_ne!(unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFL) } & libc::O_NONBLOCK, 0);
        }
    }
}
