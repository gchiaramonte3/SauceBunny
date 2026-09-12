//! Atomic close-on-exec raw-media descriptors, without modifying other spawn paths.
// SPDX-License-Identifier: MIT
use std::{io, os::fd::OwnedFd};

#[cfg(target_os = "macos")]
pub(super) fn pipe() -> io::Result<(OwnedFd, OwnedFd)> { darwin::pipe() }

#[cfg(not(target_os = "macos"))]
pub(super) fn pipe() -> io::Result<(OwnedFd, OwnedFd)> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "OBS raw output requires macOS"))
}

#[cfg(target_os = "macos")]
mod darwin {
    use super::*;
    use std::{ffi::{CStr, CString}, mem, os::fd::{AsRawFd, FromRawFd, RawFd}};

    fn invalid() -> io::Error { io::Error::new(io::ErrorKind::InvalidData, "Invalid private raw FIFO") }
    fn check(result: libc::c_int) -> io::Result<()> {
        if result == -1 { Err(io::Error::last_os_error()) } else { Ok(()) }
    }
    fn open_at(parent: RawFd, name: &CStr, flags: libc::c_int) -> io::Result<OwnedFd> {
        // Darwin has no pipe2. Unlike pipe()+fcntl(), O_CLOEXEC is installed
        // before open publishes the fd, including during concurrent execs:
        // https://github.com/apple-oss-distributions/xnu/blob/main/bsd/vfs/vfs_syscalls.c (open1).
        let fd = unsafe { libc::openat(parent, name.as_ptr(), flags | libc::O_CLOEXEC | libc::O_NOFOLLOW) };
        if fd < 0 { return Err(io::Error::last_os_error()); }
        // openat returned a fresh descriptor, adopted before any fallible work.
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }
    fn stat(fd: RawFd) -> io::Result<libc::stat> {
        let mut value = unsafe { mem::zeroed() };
        check(unsafe { libc::fstat(fd, &mut value) })?;
        Ok(value)
    }
    fn owned_mode(value: &libc::stat, kind: libc::mode_t, mode: libc::mode_t) -> bool {
        value.st_uid == unsafe { libc::geteuid() } && value.st_mode & libc::S_IFMT == kind &&
            value.st_mode & 0o777 == mode
    }
    fn same(first: &libc::stat, second: &libc::stat) -> bool {
        first.st_dev == second.st_dev && first.st_ino == second.st_ino
    }
    fn parent() -> io::Result<OwnedFd> {
        // Use Darwin's per-user local temporary directory, not an arbitrary TMPDIR.
        let mut bytes = [0u8; libc::PATH_MAX as usize];
        let length = unsafe { libc::confstr(libc::_CS_DARWIN_USER_TEMP_DIR, bytes.as_mut_ptr().cast(), bytes.len()) };
        if length == 0 || length > bytes.len() { return Err(invalid()); }
        let name = CStr::from_bytes_with_nul(&bytes[..length]).map_err(|_| invalid())?;
        let fd = open_at(libc::AT_FDCWD, name, libc::O_RDONLY | libc::O_DIRECTORY)?;
        if !owned_mode(&stat(fd.as_raw_fd())?, libc::S_IFDIR, 0o700) { return Err(invalid()); }
        Ok(fd)
    }

    struct Temporary {
        parent: OwnedFd,
        name: CString,
        directory: OwnedFd,
        fifo: Option<libc::stat>,
        directory_present: bool,
    }
    impl Temporary {
        fn new(parent: OwnedFd) -> io::Result<Self> {
            let mut random = [0u8; 16];
            getrandom::getrandom(&mut random).map_err(|error| io::Error::other(error.to_string()))?;
            let name = CString::new(format!("sauce-raw-{}", hex::encode(random))).map_err(|_| invalid())?;
            // mkdirat is exclusive; never adopt a preexisting random-name entry.
            check(unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o700) })?;
            let directory = open_at(parent.as_raw_fd(), &name, libc::O_RDONLY | libc::O_DIRECTORY);
            let directory = match directory {
                Ok(fd) => fd,
                Err(error) => {
                    // No FIFO exists yet. Only remove our empty directory, never a tree.
                    unsafe { libc::unlinkat(parent.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR); }
                    return Err(error);
                }
            };
            let result = Self { parent, name, directory, fifo: None, directory_present: true };
            if !owned_mode(&stat(result.directory.as_raw_fd())?, libc::S_IFDIR, 0o700) { return Err(invalid()); }
            Ok(result)
        }
        fn create(&mut self) -> io::Result<()> {
            check(unsafe { libc::mkfifoat(self.directory.as_raw_fd(), c"media".as_ptr(), 0o600) })?;
            // Record cleanup ownership immediately, even if the following stat fails.
            self.fifo = Some(unsafe { mem::zeroed() });
            let mut description = unsafe { mem::zeroed() };
            check(unsafe { libc::fstatat(self.directory.as_raw_fd(), c"media".as_ptr(), &mut description, libc::AT_SYMLINK_NOFOLLOW) })?;
            if !owned_mode(&description, libc::S_IFIFO, 0o600) || description.st_nlink != 1 { return Err(invalid()); }
            self.fifo = Some(description);
            Ok(())
        }
        fn endpoint(&self, access: libc::c_int) -> io::Result<OwnedFd> {
            let expected = self.fifo.as_ref().ok_or_else(invalid)?;
            let fd = open_at(self.directory.as_raw_fd(), c"media", access | libc::O_NONBLOCK)?;
            let description = stat(fd.as_raw_fd())?;
            let flags = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFL) };
            let fd_flags = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFD) };
            if !same(expected, &description) || !owned_mode(&description, libc::S_IFIFO, 0o600) ||
                description.st_nlink != 1 || flags < 0 || fd_flags < 0 ||
                flags & libc::O_ACCMODE != access || flags & libc::O_NONBLOCK == 0 || fd_flags & libc::FD_CLOEXEC == 0 {
                return Err(invalid());
            }
            Ok(fd)
        }
        fn cleanup(&mut self) -> io::Result<()> {
            if self.fifo.is_some() {
                if let Err(error) = check(unsafe { libc::unlinkat(self.directory.as_raw_fd(), c"media".as_ptr(), 0) }) {
                    // The FIFO may already be unlinked after an interrupted/error
                    // path. Its absence must not strand our still-owned directory.
                    if error.raw_os_error() != Some(libc::ENOENT) { return Err(error); }
                }
                self.fifo = None;
            }
            if self.directory_present {
                let mut entry = unsafe { mem::zeroed() };
                check(unsafe { libc::fstatat(self.parent.as_raw_fd(), self.name.as_ptr(), &mut entry, libc::AT_SYMLINK_NOFOLLOW) })?;
                if !same(&entry, &stat(self.directory.as_raw_fd())?) { return Err(invalid()); }
                check(unsafe { libc::unlinkat(self.parent.as_raw_fd(), self.name.as_ptr(), libc::AT_REMOVEDIR) })?;
                self.directory_present = false;
            }
            Ok(())
        }
    }
    impl Drop for Temporary {
        fn drop(&mut self) { let _ = self.cleanup(); }
    }
    pub(super) fn pipe() -> io::Result<(OwnedFd, OwnedFd)> {
        let mut temporary = Temporary::new(parent()?)?;
        temporary.create()?;
        // Separate endpoints are essential: an O_RDWR keeper would prevent true EOF.
        let reader = temporary.endpoint(libc::O_RDONLY)?;
        let writer = temporary.endpoint(libc::O_WRONLY)?;
        // F_SETNOSIGPIPE=73 in Darwin's SDK; libc 0.2.186 does not export it.
        check(unsafe { libc::fcntl(writer.as_raw_fd(), 73, 1) })?;
        temporary.cleanup()?; // Never expose a still-named FIFO to the actor.
        if stat(reader.as_raw_fd())?.st_nlink != 0 || stat(writer.as_raw_fd())?.st_nlink != 0 { return Err(invalid()); }
        Ok((reader, writer))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::{io::{Read, Write}, os::unix::process::CommandExt, process::{Child, Command, Stdio}, time::{Duration, Instant}};

        const PROBE: &str = "SAUCE_OBS_RAW_PIPE_PROBE";
        const CHILD: &str = "commands::obs::raw_control::raw_pipe::darwin::tests::inheritance_child";
        struct Reap(Child);
        impl Drop for Reap {
            fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
        }
        fn child(mode: &str, pre_exec: bool, input: Stdio) -> Command {
            let mut command = Command::new(std::env::current_exe().unwrap());
            command.arg("--exact").arg(CHILD).arg("--nocapture").env(PROBE, mode)
                .stdin(input).stdout(Stdio::piped()).stderr(Stdio::piped());
            if pre_exec { unsafe { command.pre_exec(|| Ok(())); } }
            command
        }
        fn run(mut command: Command) {
            let mut child = Reap(command.spawn().unwrap());
            let deadline = Instant::now() + Duration::from_secs(10);
            let status = loop {
                if let Some(status) = child.0.try_wait().unwrap() { break status; }
                assert!(Instant::now() < deadline, "raw FIFO child timed out");
                std::thread::sleep(Duration::from_millis(10));
            };
            let mut errors = String::new();
            child.0.stderr.take().unwrap().read_to_string(&mut errors).unwrap();
            assert!(status.success(), "raw FIFO child failed: {errors}");
            let mut output = String::new();
            child.0.stdout.take().unwrap().read_to_string(&mut output).unwrap();
            assert!(output.contains("raw-pipe-probe-ok"), "child probe must actually run");
        }
        fn no_inheritance(fds: &[RawFd], pre_exec: bool) {
            let expected = fds.iter().map(|fd| {
                let value = stat(*fd).unwrap();
                format!("{fd}:{}:{}", value.st_dev, value.st_ino)
            }).collect::<Vec<_>>().join(",");
            run(child(&expected, pre_exec, Stdio::null()));
        }
        fn absent(temporary: &Temporary) {
            let mut value = unsafe { mem::zeroed() };
            assert_eq!(unsafe { libc::fstatat(temporary.parent.as_raw_fd(), temporary.name.as_ptr(), &mut value, libc::AT_SYMLINK_NOFOLLOW) }, -1);
            assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ENOENT));
        }
        fn read_one(fd: &OwnedFd) -> io::Result<usize> {
            let mut byte = 0u8;
            let result = unsafe { libc::read(fd.as_raw_fd(), (&mut byte as *mut u8).cast(), 1) };
            if result < 0 { Err(io::Error::last_os_error()) } else { Ok(result as usize) }
        }
        fn actual_eof(fd: &OwnedFd) {
            // Even CLOEXEC descriptors briefly exist between another thread's
            // fork and exec. Wait for actual zero, never infer EOF from EAGAIN.
            let started = Instant::now();
            let deadline = started + Duration::from_secs(2);
            loop {
                match read_one(fd) {
                    Ok(0) => {
                        if started.elapsed() > Duration::from_millis(100) {
                            eprintln!("raw FIFO actual EOF waited {} ms", started.elapsed().as_millis());
                        }
                        return;
                    }
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                        assert!(Instant::now() < deadline, "a writer still holds the FIFO");
                        std::thread::sleep(Duration::from_millis(5));
                    }
                    result => panic!("unexpected EOF result: {result:?}"),
                }
            }
        }

        #[test]
        fn inheritance_child() {
            let Ok(mode) = std::env::var(PROBE) else { return; };
            if mode == "stdin" {
                let mut bytes = Vec::new();
                std::io::stdin().read_to_end(&mut bytes).unwrap();
                assert_eq!(bytes, b"FIFO stays in kernel memory");
                println!("raw-pipe-probe-ok");
                return;
            }
            let (present, entries) = match mode.strip_prefix("present;") {
                Some(entries) => (true, entries),
                None => (false, mode.as_str()),
            };
            for entry in entries.split(',') {
                let values = entry.split(':').collect::<Vec<_>>();
                let fd = values[0].parse::<RawFd>().unwrap();
                let device = values[1].parse::<libc::dev_t>().unwrap();
                let inode = values[2].parse::<libc::ino_t>().unwrap();
                let inherited = stat(fd).is_ok_and(|value| value.st_dev == device && value.st_ino == inode);
                assert_eq!(inherited, present, "unexpected ambient descriptor {fd} inheritance");
            }
            println!("raw-pipe-probe-ok");
        }

        #[test]
        fn negative_control_legacy_pipe_writer_inherits_in_both_spawn_paths() {
            // Deterministically pause the old algorithm before its fcntl calls.
            // These are generated test-only descriptors, owned until both children reap.
            let mut fds = [-1; 2];
            check(unsafe { libc::pipe(fds.as_mut_ptr()) }).unwrap();
            let _reader = unsafe { OwnedFd::from_raw_fd(fds[0]) };
            let writer = unsafe { OwnedFd::from_raw_fd(fds[1]) };
            assert_eq!(unsafe { libc::fcntl(writer.as_raw_fd(), libc::F_GETFD) } & libc::FD_CLOEXEC, 0);
            let value = stat(writer.as_raw_fd()).unwrap();
            let expected = format!("present;{}:{}:{}", writer.as_raw_fd(), value.st_dev, value.st_ino);
            for pre_exec in [false, true] { run(child(&expected, pre_exec, Stdio::null())); }
        }

        #[test]
        fn atomic_cloexec_at_every_open_survives_both_spawn_paths() {
            for pre_exec in [false, true] {
                let parent = parent().unwrap();
                no_inheritance(&[parent.as_raw_fd()], pre_exec);
                let mut temporary = Temporary::new(parent).unwrap();
                let mut fds = vec![temporary.parent.as_raw_fd(), temporary.directory.as_raw_fd()];
                no_inheritance(&fds, pre_exec);
                temporary.create().unwrap();
                let reader = temporary.endpoint(libc::O_RDONLY).unwrap();
                fds.push(reader.as_raw_fd());
                no_inheritance(&fds, pre_exec); // Paused before a writer even exists.
                let writer = temporary.endpoint(libc::O_WRONLY).unwrap();
                fds.push(writer.as_raw_fd());
                no_inheritance(&fds, pre_exec); // Paused immediately after writer open.
                temporary.cleanup().unwrap();
                absent(&temporary);
            }
        }

        #[test]
        fn unlinked_fifo_transfers_bytes_and_only_last_writer_close_yields_eof() {
            let (reader, writer) = pipe().unwrap();
            let first = stat(reader.as_raw_fd()).unwrap();
            let second = stat(writer.as_raw_fd()).unwrap();
            assert!(same(&first, &second));
            assert_eq!(first.st_nlink, 0);
            assert_eq!(second.st_nlink, 0);
            assert_eq!(unsafe { libc::fcntl(writer.as_raw_fd(), 74) }, 1); // F_GETNOSIGPIPE
            let mut copy = std::fs::File::from(writer.try_clone().unwrap());
            drop(writer);
            assert_eq!(read_one(&reader).unwrap_err().kind(), io::ErrorKind::WouldBlock);
            copy.write_all(b"x").unwrap();
            assert_eq!(read_one(&reader).unwrap(), 1);
            drop(copy);
            actual_eof(&reader);
        }

        #[test]
        fn intentional_stdin_transfer_remains_usable_in_both_spawn_paths() {
            for pre_exec in [false, true] {
                let (reader, writer) = pipe().unwrap();
                let mut writer = std::fs::File::from(writer);
                writer.write_all(b"FIFO stays in kernel memory").unwrap();
                drop(writer);
                run(child("stdin", pre_exec, Stdio::from(std::fs::File::from(reader))));
            }
        }

        #[test]
        fn errors_and_early_returns_remove_only_owned_temporary_entries() {
            for stage in 0..4 {
                let mut temporary = Temporary::new(parent().unwrap()).unwrap();
                let parent = temporary.parent.try_clone().unwrap();
                let name = temporary.name.clone();
                let mut endpoints = Vec::new();
                if stage > 0 { temporary.create().unwrap(); }
                if stage == 1 {
                    assert_eq!(temporary.endpoint(libc::O_WRONLY).unwrap_err().raw_os_error(), Some(libc::ENXIO));
                }
                if stage > 1 { endpoints.push(temporary.endpoint(libc::O_RDONLY).unwrap()); }
                if stage > 2 { endpoints.push(temporary.endpoint(libc::O_WRONLY).unwrap()); }
                if stage > 0 { assert!(temporary.create().is_err(), "exclusive FIFO creation must fail"); }
                drop(temporary); // Simulate each fallible stage returning early.
                let mut value = unsafe { mem::zeroed() };
                assert_eq!(unsafe { libc::fstatat(parent.as_raw_fd(), name.as_ptr(), &mut value, libc::AT_SYMLINK_NOFOLLOW) }, -1);
                assert_eq!(io::Error::last_os_error().raw_os_error(), Some(libc::ENOENT));
                for fd in endpoints { assert_eq!(stat(fd.as_raw_fd()).unwrap().st_nlink, 0); }
            }
        }

        #[test]
        fn already_unlinked_fifo_still_cleans_up_its_owned_directory() {
            let mut temporary = Temporary::new(parent().unwrap()).unwrap();
            temporary.create().unwrap();
            let reader = temporary.endpoint(libc::O_RDONLY).unwrap();
            check(unsafe { libc::unlinkat(temporary.directory.as_raw_fd(), c"media".as_ptr(), 0) }).unwrap();
            assert_eq!(temporary.endpoint(libc::O_WRONLY).unwrap_err().raw_os_error(), Some(libc::ENOENT));
            temporary.cleanup().unwrap();
            absent(&temporary);
            assert!(temporary.fifo.is_none());
            assert!(!temporary.directory_present);
            assert_eq!(stat(reader.as_raw_fd()).unwrap().st_nlink, 0);
            temporary.cleanup().unwrap(); // Explicit cleanup and subsequent Drop remain idempotent.
        }

        #[test]
        fn symlinks_and_replaced_fifo_identities_are_rejected_without_following() {
            for symlink in [false, true] {
                let mut temporary = Temporary::new(parent().unwrap()).unwrap();
                temporary.create().unwrap();
                let reader = temporary.endpoint(libc::O_RDONLY).unwrap(); // Keep old inode allocated.
                check(unsafe { libc::unlinkat(temporary.directory.as_raw_fd(), c"media".as_ptr(), 0) }).unwrap();
                if symlink {
                    check(unsafe { libc::symlinkat(c"missing-target".as_ptr(), temporary.directory.as_raw_fd(), c"media".as_ptr()) }).unwrap();
                } else {
                    check(unsafe { libc::mkfifoat(temporary.directory.as_raw_fd(), c"media".as_ptr(), 0o600) }).unwrap();
                }
                assert!(temporary.endpoint(libc::O_RDONLY).is_err());
                temporary.cleanup().unwrap();
                absent(&temporary);
                assert_eq!(stat(reader.as_raw_fd()).unwrap().st_nlink, 0);
            }
        }
    }
}
