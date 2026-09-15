//! Own children from spawn through reap, including the metadata-only startup
//! interval. Attempt identity, not a PID, decides which share Stop owns.
use std::{io, path::PathBuf, process::{Child, ChildStderr, ChildStdout, Command, ExitStatus}, sync::{Arc, Mutex}};

#[derive(Clone, Default)]
pub(super) struct Registry { current: Arc<Mutex<Option<Arc<Attempt>>>> }
struct Attempt { id: String, state: Mutex<State> }
#[derive(Default)]
struct State { claimed: bool, cancelled: bool, children: Vec<(Role, Child)>, fifo: Option<PathBuf> }
#[derive(Clone, Copy)]
pub(super) enum Role { Capture, Encoder }
pub(super) struct Pipes { pub stdout: Option<ChildStdout>, pub stderr: Option<ChildStderr> }
#[derive(Default)]
pub(super) struct Finished {
    pub was_current: bool,
    pub capture_exit: Option<ExitStatus>,
    pub encoder_exit: Option<ExitStatus>,
    #[cfg(test)] pub reaped: usize,
}
pub(super) struct Lease { registry: Registry, attempt: Arc<Attempt>, finished: bool }

fn cancelled() -> io::Error { io::Error::new(io::ErrorKind::Interrupted, "Screen sharing was cancelled") }
fn lock_failed() -> io::Error { io::Error::other("Screen-sharing ownership is unavailable") }
fn remove_fifo(path: PathBuf) {
    let _ = std::fs::remove_file(&path);
    // This is the exact private directory created for this FIFO, never a
    // recursive removal or a caller-supplied path.
    if let Some(parent) = path.parent() { let _ = std::fs::remove_dir(parent); }
}
impl State {
    fn shutdown(&mut self) -> Finished {
        self.cancelled = true;
        let mut result = Finished::default();
        for (role, mut child) in self.children.drain(..) {
            let exit = child.try_wait().ok().flatten();
            match role { Role::Capture => result.capture_exit = exit, Role::Encoder => result.encoder_exit = exit }
            // Child retains its reaped status. Never signal a naked PID after
            // try_wait: the OS could already have reused that process number.
            if exit.is_none() { let _ = child.kill(); }
            let waited = child.wait();
            #[cfg(test)] { if waited.is_ok() { result.reaped += 1; } }
            #[cfg(not(test))] { let _ = waited; }
        }
        if let Some(fifo) = self.fifo.take() { remove_fifo(fifo); }
        result
    }
}
impl Drop for State { fn drop(&mut self) { self.shutdown(); } }
impl Registry {
    /// Reserve before returning a stream URL. Stop also invalidates a fetch
    /// that has not reached the HTTP server yet; reservation starts no child.
    pub fn reserve(&self, id: String) -> io::Result<()> {
        let mut current = self.current.lock().map_err(|_| lock_failed())?;
        if let Some(old) = current.take() {
            old.state.lock().map_err(|_| lock_failed())?.shutdown();
        }
        *current = Some(Arc::new(Attempt { id, state: Mutex::new(State::default()) }));
        Ok(())
    }
    pub fn claim(&self, id: &str) -> io::Result<Lease> {
        let current = self.current.lock().map_err(|_| lock_failed())?;
        let attempt = current.as_ref().filter(|attempt| attempt.id == id).ok_or_else(cancelled)?;
        let mut state = attempt.state.lock().map_err(|_| lock_failed())?;
        if state.cancelled || state.claimed { return Err(cancelled()); }
        state.claimed = true;
        Ok(Lease { registry: self.clone(), attempt: attempt.clone(), finished: false })
    }
    pub fn stop(&self) -> Finished {
        if let Ok(mut current) = self.current.lock() {
            if let Some(attempt) = current.take() {
                if let Ok(mut state) = attempt.state.lock() { return state.shutdown(); }
            }
        }
        Finished::default()
    }
}
impl Lease {
    pub fn is_active(&self) -> bool {
        self.attempt.state.lock().map(|state| !state.cancelled).unwrap_or(false)
    }
    pub fn own_fifo(&self, path: PathBuf) -> io::Result<()> {
        let mut state = self.attempt.state.lock().map_err(|_| lock_failed())?;
        if state.cancelled { remove_fifo(path); return Err(cancelled()); }
        state.fifo = Some(path);
        Ok(())
    }
    /// Spawn and register are one operation relative to Stop/replacement.
    /// The handler owns only pipes; this state exclusively owns Child handles.
    pub fn spawn(&self, command: &mut Command, role: Role) -> io::Result<Pipes> {
        let mut state = self.attempt.state.lock().map_err(|_| lock_failed())?;
        if state.cancelled { return Err(cancelled()); }
        let mut child = command.spawn()?;
        let pipes = Pipes { stdout: child.stdout.take(), stderr: child.stderr.take() };
        state.children.push((role, child));
        Ok(pipes)
    }
    pub fn finish(&mut self) -> Finished {
        if self.finished { return Finished::default(); }
        self.finished = true;
        // Keep one lock order everywhere: registry, then attempt. A stale
        // handler may reap itself but can never clear the replacement entry.
        let Ok(mut current) = self.registry.current.lock() else { return Finished::default() };
        let was_current = current.as_ref().is_some_and(|item| Arc::ptr_eq(item, &self.attempt));
        let mut result = self.attempt.state.lock().map(|mut state| state.shutdown()).unwrap_or_default();
        result.was_current = was_current;
        if was_current { *current = None; }
        result
    }
}
impl Drop for Lease { fn drop(&mut self) { self.finish(); } }

#[cfg(test)]
mod tests {
    use super::*;
    use std::{process::Stdio, time::{Duration, Instant}};
    fn sleeper(lease: &Lease, role: Role) {
        lease.spawn(Command::new("/bin/sleep").arg("30").stdout(Stdio::piped()).stderr(Stdio::piped()), role).unwrap();
    }
    #[test]
    fn stop_during_delayed_metadata_reaps_capture_and_rejects_encoder() {
        let registry = Registry::default(); registry.reserve("delayed".into()).unwrap();
        let mut lease = registry.claim("delayed").unwrap();
        let mut pipes = lease.spawn(Command::new("/bin/sleep").arg("30").stderr(Stdio::piped()), Role::Capture).unwrap();
        let drain = super::super::share_diagnostics::drain(pipes.stderr.take().unwrap(), super::super::share_diagnostics::ChildKind::Capture, None);
        assert!(drain.metadata.recv_timeout(Duration::from_millis(20)).is_err());
        let started = Instant::now(); assert_eq!(registry.stop().reaped, 1);
        assert_eq!(drain.metadata.recv_timeout(Duration::from_secs(1)).unwrap(), None);
        assert!(started.elapsed() < Duration::from_secs(1));
        assert!(!lease.is_active());
        assert!(lease.attempt.state.lock().unwrap().children.is_empty());
        assert!(lease.spawn(Command::new("/bin/sleep").arg("30"), Role::Encoder).is_err());
        assert!(!lease.finish().was_current);
        assert!(registry.claim("delayed").is_err());
    }
    #[test]
    fn replacement_rejects_late_metadata_and_old_cleanup_cannot_stop_new_child() {
        let registry = Registry::default(); registry.reserve("old".into()).unwrap();
        let mut old = registry.claim("old").unwrap(); sleeper(&old, Role::Capture);
        registry.reserve("new".into()).unwrap();
        let mut new = registry.claim("new").unwrap(); sleeper(&new, Role::Capture);
        // A queued old metadata result arriving now cannot spawn an encoder.
        assert!(old.spawn(Command::new("/bin/sleep").arg("30"), Role::Encoder).is_err());
        assert!(!old.finish().was_current);
        assert!(new.is_active());
        assert!(new.attempt.state.lock().unwrap().children[0].1.try_wait().unwrap().is_none());
        let ended = new.finish(); assert!(ended.was_current); assert_eq!(ended.reaped, 1);
    }
    #[test]
    fn stop_before_fetch_and_duplicate_fetch_never_spawn() {
        let registry = Registry::default(); registry.reserve("stopped".into()).unwrap(); registry.stop();
        assert!(registry.claim("stopped").is_err());
        registry.reserve("current".into()).unwrap(); let lease = registry.claim("current").unwrap();
        assert!(registry.claim("current").is_err()); assert!(registry.claim("stopped").is_err());
        drop(lease);
        assert!(registry.claim("current").is_err());
    }
    #[test]
    fn cleanup_reaps_both_children_and_is_idempotent() {
        let registry = Registry::default(); registry.reserve("both".into()).unwrap();
        let mut lease = registry.claim("both").unwrap(); sleeper(&lease, Role::Capture); sleeper(&lease, Role::Encoder);
        assert_eq!(lease.finish().reaped, 2); assert_eq!(lease.finish().reaped, 0); registry.stop();
    }
}
