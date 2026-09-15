//! Explicit NDI-only process ownership. Never stops a Program or the shared
//! capture helper to recover a stalled sender. No renderer command is registered.
use std::{collections::HashMap, os::fd::OwnedFd, path::{Path, PathBuf}, process::{ExitStatus, Stdio}, sync::{Arc, Mutex, OnceLock, atomic::{AtomicBool, Ordering}}, time::Duration};
use serde::Deserialize;
use tokio::{io::AsyncReadExt, process::{Child, ChildStdout, Command}, sync::watch, time::{Instant, interval, MissedTickBehavior}};
use super::{raw_service::{RawFeed, RawGenerations, RawStatus}, service};
use crate::AppError;

const TICK: Duration = Duration::from_millis(20);
const RESERVE_WAIT: Duration = Duration::from_secs(3);
const SDK_WAIT: Duration = Duration::from_secs(5);
const MEDIA_WAIT: Duration = Duration::from_secs(3);
const STOP_GRACE: Duration = Duration::from_secs(3);
const REAP_WAIT: Duration = Duration::from_secs(2);
const DRAIN_WAIT: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct CleanupProof {
    pub child_reaped: bool,
    pub raw_stopped: bool,
    pub pipe_eof: bool,
}
impl CleanupProof {
    pub fn complete(self) -> bool { self.child_reaped && self.raw_stopped && self.pipe_eof }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BroadcastFailure { Startup, StartupTimeout, SourceStopped, Protocol, SenderFailed, SdkUnavailable, InputFailed, ReadTimeout, SinkFailed, DrainTimeout, ShutdownTimeout, CleanupUnconfirmed }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BroadcastStatus {
    Starting, Live, Stopping, Stopped,
    Failed { reason: BroadcastFailure, cleanup: CleanupProof },
}

pub struct BroadcastHandle {
    feed: Arc<RawFeed>,
    cancelled: Arc<AtomicBool>,
    status: watch::Receiver<BroadcastStatus>,
    #[cfg(test)] pid: Arc<std::sync::atomic::AtomicU32>,
}
impl BroadcastHandle {
    pub fn status(&self) -> watch::Receiver<BroadcastStatus> { self.status.clone() }
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        self.feed.cancel();
    }
    pub async fn stop(&self) -> Result<(), AppError> {
        self.cancel();
        let mut status = self.status();
        let ended = tokio::time::timeout(Duration::from_secs(12), status.wait_for(|state|
            matches!(state, BroadcastStatus::Stopped | BroadcastStatus::Failed { .. }))).await;
        match ended {
            Ok(Ok(state)) if matches!(*state, BroadcastStatus::Stopped) => Ok(()),
            _ => Err(AppError::invalid("NDI sender did not stop cleanly; check its current status")),
        }
    }
    #[cfg(test)]
    pub(super) fn child_pid(&self) -> Option<u32> {
        match self.pid.load(Ordering::Acquire) { 0 => None, value => Some(value) }
    }
}
impl Drop for BroadcastHandle { fn drop(&mut self) { self.cancel(); } }

struct RegistryEntry { cancelled: Arc<AtomicBool>, status: watch::Receiver<BroadcastStatus> }
#[derive(Default)]
struct Registry { closing: bool, entries: HashMap<String, RegistryEntry> }
impl Registry {
    fn reserve(&mut self, id: &str) -> Result<(Arc<AtomicBool>, watch::Sender<BroadcastStatus>), AppError> {
        if self.closing { return Err(AppError::invalid("NDI senders are shutting down")); }
        if self.entries.contains_key(id) { return Err(AppError::invalid("This NDI sender is still running or closing")); }
        let cancelled = Arc::new(AtomicBool::new(false));
        let (state, status) = watch::channel(BroadcastStatus::Starting);
        // Publish the watcher with admission, before raw preparation or spawn.
        // Shutdown cannot miss a sender between those synchronous operations.
        self.entries.insert(id.to_owned(), RegistryEntry { cancelled: cancelled.clone(), status });
        Ok((cancelled, state))
    }
    fn cancel_all(&self) {
        for entry in self.entries.values() { entry.cancelled.store(true, Ordering::Release); }
    }
    fn begin_shutdown(&mut self) -> Vec<watch::Receiver<BroadcastStatus>> {
        self.closing = true;
        self.cancel_all();
        self.entries.values().map(|entry|entry.status.clone()).collect()
    }
    // Preserve the existing permit tests' narrow cancellation-token view.
    #[cfg(test)]
    fn get(&self, id: &str) -> Option<&Arc<AtomicBool>> { self.entries.get(id).map(|entry|&entry.cancelled) }
    #[cfg(test)]
    fn contains_key(&self, id: &str) -> bool { self.entries.contains_key(id) }
}
fn senders() -> &'static Arc<Mutex<Registry>> {
    static SENDERS: OnceLock<Arc<Mutex<Registry>>> = OnceLock::new();
    SENDERS.get_or_init(|| Arc::new(Mutex::new(Registry::default())))
}
struct Permit {
    id: String, cancelled: Arc<AtomicBool>, state: watch::Sender<BroadcastStatus>,
    registry: Arc<Mutex<Registry>>, supervised: bool, quarantined: bool,
}
impl Permit {
    fn acquire(id: &str) -> Result<Self, AppError> {
        Self::acquire_in(senders().clone(), id)
    }
    fn acquire_in(registry: Arc<Mutex<Registry>>, id: &str) -> Result<Self, AppError> {
        let (cancelled, state) = registry.lock().map_err(|_| AppError::internal("NDI sender state unavailable"))?.reserve(id)?;
        Ok(Self { id: id.to_owned(), cancelled, state, registry, supervised: false, quarantined: false })
    }
}
impl Drop for Permit {
    fn drop(&mut self) {
        if !self.supervised && !self.quarantined {
            // No RawFeed or child was handed to the supervisor. Every local
            // preparation error has already dropped its untransferred fds.
            self.state.send_replace(BroadcastStatus::Failed { reason: BroadcastFailure::Startup,
                cleanup: CleanupProof { child_reaped: true, raw_stopped: true, pipe_eof: true } });
        }
        // Lost process identity cannot be repaired by dropping a task. Keep
        // this bounded per-program admission entry until the app exits.
        if self.quarantined || (self.supervised && !child_reap_proven(*self.state.borrow())) {
            self.state.send_replace(BroadcastStatus::Failed { reason: BroadcastFailure::CleanupUnconfirmed,
                cleanup: CleanupProof::default() });
            return;
        }
        if let Ok(mut registry) = self.registry.lock() { registry.entries.remove(&self.id); }
    }
}
pub(super) fn cancel_all() {
    if let Ok(senders) = senders().lock() { senders.cancel_all(); }
}
#[cfg(feature = "obs-audio-acceptance")]
pub(super) fn acceptance_idle() -> bool {
    senders().lock().is_ok_and(|registry| registry.entries.is_empty() && !registry.closing)
}

/// Atomically close admission, latch cancellation, and include every admitted
/// startup in the snapshot. No wait or child operation runs under this lock.
pub(super) fn begin_shutdown() -> Vec<watch::Receiver<BroadcastStatus>> {
    match senders().lock() {
        Ok(mut registry) => registry.begin_shutdown(),
        Err(poisoned) => {
            let mut snapshot = poisoned.into_inner().begin_shutdown();
            // Still cancel known entries and close admission, but poisoned
            // registry state cannot be treated as proof of a clean shutdown.
            let (_, failed) = watch::channel(BroadcastStatus::Failed {
                reason: BroadcastFailure::CleanupUnconfirmed, cleanup: CleanupProof::default() });
            snapshot.push(failed);
            snapshot
        },
    }
}

fn child_reap_proven(status: BroadcastStatus) -> bool {
    matches!(status, BroadcastStatus::Stopped | BroadcastStatus::Failed { cleanup: CleanupProof { child_reaped: true, .. }, .. })
}
fn cleanup_proven(status: BroadcastStatus) -> bool {
    match status {
        BroadcastStatus::Stopped => true,
        BroadcastStatus::Failed { cleanup, .. } => cleanup.complete(),
        _ => false,
    }
}

/// Wait concurrently under one deadline. A failed broadcast can still have
/// proven cleanup; an arbitrary terminal/closed watcher is not such proof.
pub(super) async fn await_shutdown(snapshot: Vec<watch::Receiver<BroadcastStatus>>, deadline: Duration) -> bool {
    let waits = snapshot.into_iter().map(|mut status|async move {
        loop {
            if cleanup_proven(*status.borrow()) { return true; }
            if status.changed().await.is_err() { return cleanup_proven(*status.borrow()); }
        }
    });
    match tokio::time::timeout(deadline, futures_util::future::join_all(waits)).await {
        Ok(results) => results.into_iter().all(|complete|complete),
        Err(_) => false,
    }
}

pub(super) struct SenderRuntime {
    pub executable: PathBuf,
    pub sdk: PathBuf,
    #[cfg(test)] pub fake_mode: Option<String>,
}
fn sender_candidate(executable: &Path, developer: bool, explicit: Option<PathBuf>) -> Option<PathBuf> {
    let macos = executable.parent()?;
    if macos.file_name()? == "MacOS" && macos.parent()?.file_name()? == "Contents" {
        return Some(macos.parent()?.join("Helpers/NDISender.bundle/Contents/MacOS/saucebunny-ndi-sender"));
    }
    developer.then_some(explicit).flatten()
}
impl SenderRuntime {
    fn resolve() -> Result<Self, AppError> {
        let current = std::env::current_exe()?;
        let candidate = sender_candidate(&current, cfg!(debug_assertions), std::env::var_os("SAUCE_NDI_SENDER_DEV_BINARY").map(PathBuf::from))
            .ok_or_else(|| AppError::invalid("This build does not include the NDI sender"))?;
        let executable = candidate.canonicalize().map_err(|_| AppError::invalid("The separate NDI sender is missing"))?;
        if !executable.is_file() { return Err(AppError::invalid("The separate NDI sender is invalid")); }
        if let Some(contents) = current.parent().and_then(Path::parent).filter(|path| path.file_name().is_some_and(|name| name == "Contents")) {
            if !executable.starts_with(contents.canonicalize()?) { return Err(AppError::invalid("The NDI sender escapes its application bundle")); }
        }
        #[cfg(sauce_ndi)] let sdk = super::super::ndi::runtime_path();
        #[cfg(not(sauce_ndi))] let sdk: Option<PathBuf> = None;
        let sdk = sdk.ok_or_else(|| AppError::invalid("The NDI runtime is unavailable"))?.canonicalize()?;
        Ok(Self { executable, sdk, #[cfg(test)] fake_mode: None })
    }
}

pub(super) fn begin(id: &str) -> Result<BroadcastHandle, AppError> {
    if !super::super::ndi::valid_program_id(id) { return Err(AppError::invalid("Select a running application preview")); }
    let runtime = SenderRuntime::resolve()?;
    let permit = Permit::acquire(id)?;
    let feed = service::prepare_raw_output(id)?;
    launch_inner(feed, runtime, Some(permit))
}
#[cfg(test)]
pub(super) fn launch(feed: RawFeed, runtime: SenderRuntime) -> Result<BroadcastHandle, AppError> { launch_inner(feed, runtime, None) }

fn launch_inner(mut feed: RawFeed, runtime: SenderRuntime, mut permit: Option<Permit>) -> Result<BroadcastHandle, AppError> {
    let cancelled = permit.as_ref().map(|permit| permit.cancelled.clone()).unwrap_or_else(|| Arc::new(AtomicBool::new(false)));
    let (state, status) = permit.as_ref().map(|permit|(permit.state.clone(), permit.state.subscribe()))
        .unwrap_or_else(||watch::channel(BroadcastStatus::Starting));
    if let Some(permit) = permit.as_mut() { permit.supervised = true; }
    let valid_paths = runtime.executable.is_absolute() && runtime.sdk.is_absolute();
    let reader = match feed.take_reader() {
        Some(reader) if valid_paths => reader,
        reader => {
            let error = if valid_paths { AppError::invalid("Raw output already has a consumer") }
                else { AppError::invalid("The NDI sender requires fixed absolute runtime paths") };
            // A raw reservation already exists. Even a synchronous launch error
            // must resolve its actual stop/EOF barriers before releasing admission.
            feed.cancel();
            tauri::async_runtime::spawn(close_unlaunched(Arc::new(feed), reader, state, permit));
            return Err(error);
        },
    };
    let feed = Arc::new(feed);
    #[cfg(test)] let pid = Arc::new(std::sync::atomic::AtomicU32::new(0));
    let handle = BroadcastHandle { feed: feed.clone(), cancelled: cancelled.clone(), status, #[cfg(test)] pid: pid.clone() };
    // This task, not the UI handle, owns the child and permit until real reap.
    tauri::async_runtime::spawn(run(feed, reader, runtime, cancelled, state, permit, #[cfg(test)] pid));
    Ok(handle)
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum ChildFailure { Usage, InvalidInput, SdkUnavailable, TruncatedInput, ReadTimeout, ReadFailed, SinkFailed, DrainTimeout }
impl ChildFailure {
    fn failure(self) -> BroadcastFailure {
        match self {
            Self::Usage => BroadcastFailure::Protocol,
            Self::InvalidInput | Self::TruncatedInput | Self::ReadFailed => BroadcastFailure::InputFailed,
            Self::SdkUnavailable => BroadcastFailure::SdkUnavailable,
            Self::ReadTimeout => BroadcastFailure::ReadTimeout,
            Self::SinkFailed => BroadcastFailure::SinkFailed,
            Self::DrainTimeout => BroadcastFailure::DrainTimeout,
        }
    }
}
#[derive(Deserialize)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
enum ChildEvent { Ready {}, Live {}, Stopping {}, Failed { reason: ChildFailure } }
#[derive(Default)]
struct StatusReader { pending: Vec<u8>, total: usize, records: usize, ready: bool, live: bool, stopping: bool, failed: Option<BroadcastFailure> }
impl StatusReader {
    fn push(&mut self, bytes: &[u8]) -> Result<(), BroadcastFailure> {
        self.total += bytes.len();
        if self.total > 4096 { return Err(BroadcastFailure::Protocol); }
        for &byte in bytes {
            if byte != b'\n' {
                if self.pending.len() >= 256 { return Err(BroadcastFailure::Protocol); }
                self.pending.push(byte); continue;
            }
            self.records += 1;
            if self.records > 8 { return Err(BroadcastFailure::Protocol); }
            let event: ChildEvent = serde_json::from_slice(&self.pending).map_err(|_| BroadcastFailure::Protocol)?;
            self.pending.clear();
            match event {
                ChildEvent::Ready {} if !self.ready && !self.stopping && self.failed.is_none() => self.ready = true,
                ChildEvent::Live {} if self.ready && !self.live && !self.stopping && self.failed.is_none() => self.live = true,
                ChildEvent::Stopping {} if !self.stopping => self.stopping = true,
                ChildEvent::Failed { reason } => { self.failed.get_or_insert(reason.failure()); },
                _ => return Err(BroadcastFailure::Protocol),
            }
        }
        Ok(())
    }
}

fn raw_confirmed(state: RawStatus) -> bool {
    matches!(state, RawStatus::Stopped { .. } | RawStatus::Failed { stop_confirmed: true, .. })
}
fn raw_ended(state: RawStatus) -> bool { matches!(state, RawStatus::Stopped { .. } | RawStatus::Failed { .. }) }

async fn reservation(feed: &RawFeed, cancelled: &AtomicBool) -> Result<Option<RawGenerations>, BroadcastFailure> {
    let mut generations = feed.generations();
    let mut raw = feed.status();
    let started = Instant::now();
    let mut tick = interval(TICK);
    loop {
        if cancelled.load(Ordering::Acquire) { return Ok(None); }
        if raw_ended(*raw.borrow()) { return Err(BroadcastFailure::SourceStopped); }
        if let Some(generation) = *generations.borrow() { return Ok(Some(generation)); }
        if started.elapsed() >= RESERVE_WAIT { return Err(BroadcastFailure::StartupTimeout); }
        tokio::select! {
            result = raw.changed() => if result.is_err() { return Err(BroadcastFailure::SourceStopped); },
            result = generations.changed() => if result.is_err() { return Err(BroadcastFailure::Startup); },
            _ = tick.tick() => {},
        }
    }
}
fn spawn(runtime: &SenderRuntime, input: OwnedFd, expected: RawGenerations) -> std::io::Result<Child> {
    let mut command = Command::new(&runtime.executable);
    command.env_clear().env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin").kill_on_drop(true)
        .arg("--broadcast").arg("--runtime").arg(&runtime.sdk)
        .arg("--capture").arg(expected.capture.to_string()).arg("--attempt").arg(expected.broadcast.to_string())
        .stdin(Stdio::from(std::fs::File::from(input))).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(test)] if let Some(mode) = &runtime.fake_mode { command.env("SAUCE_NDI_FAKE_MODE", mode); }
    command.spawn() // command drops here, including its copy of the inherited fd
}

async fn active(child: &mut Child, output: &mut ChildStdout, expected: RawGenerations, feed: &RawFeed, cancelled: &AtomicBool,
                state: &watch::Sender<BroadcastStatus>) -> (Option<BroadcastFailure>, Option<std::io::Result<ExitStatus>>) {
    let mut raw = feed.status();
    let mut parser = StatusReader::default();
    let mut buffer = [0; 256];
    let mut armed = false;
    let mut live = false;
    let mut deadline = Instant::now() + SDK_WAIT;
    let mut tick = interval(TICK); tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
    loop {
        if cancelled.load(Ordering::Acquire) { return (None, None); }
        if raw_ended(*raw.borrow()) { return (Some(BroadcastFailure::SourceStopped), None); }
        if let Some(reason) = parser.failed { return (Some(reason), None); }
        if parser.stopping { return (Some(BroadcastFailure::SenderFailed), None); }
        if parser.ready && !armed {
            if !feed.arm(expected) { return (Some(BroadcastFailure::SourceStopped), None); }
            armed = true; deadline = Instant::now() + MEDIA_WAIT;
        }
        if !live && parser.live && matches!(*raw.borrow(), RawStatus::Live) && !cancelled.load(Ordering::Acquire) {
            live = true; state.send_replace(BroadcastStatus::Live);
        }
        if !live && Instant::now() >= deadline { return (Some(BroadcastFailure::StartupTimeout), None); }
        tokio::select! {
            result = wait_owned(child) => return (Some(BroadcastFailure::SenderFailed), Some(result)),
            result = output.read(&mut buffer) => match result {
                Ok(0) => return (Some(BroadcastFailure::SenderFailed), None),
                Ok(count) => {
                    if let Err(reason) = parser.push(&buffer[..count]) { return (Some(reason), None); }
                    if parser.live && !armed { return (Some(BroadcastFailure::Protocol), None); }
                },
                Err(_) => return (Some(BroadcastFailure::Protocol), None),
            },
            result = raw.changed() => if result.is_err() { return (Some(BroadcastFailure::SourceStopped), None); },
            _ = tick.tick() => {},
        }
    }
}

fn terminate(child: &Child) {
    if let Some(pid) = child.id() {
        // Only this task waits/reaps its Child, so the PID cannot be recycled
        // between this observation and the signal. Never signal a process group.
        unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM); }
    }
}

fn wait_lost_ownership(error: &std::io::Error) -> bool {
    // EINTR is retryable; every other unexpected wait error is conservative
    // loss of authority. In particular ECHILD can mean an external reaper has
    // consumed this child and its numeric PID can already belong to another.
    error.kind() != std::io::ErrorKind::Interrupted
}

async fn wait_owned(child: &mut Child) -> std::io::Result<ExitStatus> {
    loop {
        match child.wait().await {
            Err(error) if !wait_lost_ownership(&error) => continue,
            result => return result,
        }
    }
}

async fn quarantine(child: Child, permit: &mut Option<Permit>, reason: &mut Option<BroadcastFailure>,
                    state: &watch::Sender<BroadcastStatus>) -> bool {
    if let Some(permit) = permit { permit.quarantined = true; }
    // Tokio's kill_on_drop guard (and orphan reaper) still retain the old PID
    // after a wait error. Forget only this now-unsafe handle BEFORE any await;
    // even task/runtime cancellation must never signal or reap that PID again.
    // This rare path intentionally retains bounded bookkeeping and admission.
    std::mem::forget(child);
    reason.get_or_insert(BroadcastFailure::CleanupUnconfirmed);
    state.send_replace(BroadcastStatus::Failed { reason: BroadcastFailure::CleanupUnconfirmed, cleanup: CleanupProof::default() });
    // Another numeric wait is not new identity proof. Without a kernel-owned
    // identity handle there is no safe recovery, and we must not claim reap or
    // drain the standby reader while the original sender might still exist.
    std::future::pending().await
}

async fn reap(mut child: Child, exited: Option<std::io::Result<ExitStatus>>, reason: &mut Option<BroadcastFailure>,
              state: &watch::Sender<BroadcastStatus>, permit: &mut Option<Permit>) -> bool {
    if let Some(result) = exited {
        match result {
            Ok(exit) => { if !exit.success() { reason.get_or_insert(BroadcastFailure::SenderFailed); } return true; },
            Err(_) => return quarantine(child, permit, reason, state).await,
        }
    }
    terminate(&child);
    match tokio::time::timeout(STOP_GRACE, wait_owned(&mut child)).await {
        Ok(Ok(exit)) => { if !exit.success() { reason.get_or_insert(BroadcastFailure::SenderFailed); } return true; },
        Ok(Err(_)) => return quarantine(child, permit, reason, state).await,
        Err(_) => { reason.get_or_insert(BroadcastFailure::ShutdownTimeout); },
    }
    let _ = child.start_kill();
    match tokio::time::timeout(REAP_WAIT, wait_owned(&mut child)).await {
        Ok(Ok(_)) => true,
        Ok(Err(_)) => quarantine(child, permit, reason, state).await,
        Err(_) => {
            // A timeout is not reap. Keep Child + permit owned by this task;
            // expose failure now, but do not admit a replacement process yet.
            state.send_replace(BroadcastStatus::Failed { reason: BroadcastFailure::ShutdownTimeout, cleanup: CleanupProof::default() });
            loop {
                match tokio::time::timeout(REAP_WAIT, wait_owned(&mut child)).await {
                    Ok(Ok(_)) => return true,
                    Ok(Err(_)) => return quarantine(child, permit, reason, state).await,
                    Err(_) => { let _ = child.start_kill(); },
                }
            }
        },
    }
}

async fn drain(reader: OwnedFd) -> bool {
    // Called ONLY after child reap (or when no child was spawned). Otherwise
    // this duplicate would steal bytes from the sender's framed media stream.
    use std::{io::Read, os::fd::AsRawFd};
    let mut input = std::fs::File::from(reader);
    let flags = unsafe { libc::fcntl(input.as_raw_fd(), libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(input.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 { return false; }
    let deadline = Instant::now() + DRAIN_WAIT;
    let mut bytes = [0; 65536];
    loop {
        if Instant::now() >= deadline { return false; }
        match input.read(&mut bytes) {
            Ok(0) => return true,
            Ok(_) => tokio::task::yield_now().await,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {},
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => tokio::time::sleep(TICK).await,
            Err(_) => return false,
        }
    }
}
async fn raw_stopped(feed: &RawFeed) -> bool {
    let mut raw = feed.status();
    if raw_confirmed(*raw.borrow()) { return true; }
    let confirmed = match tokio::time::timeout(Duration::from_secs(3), raw.wait_for(|value| raw_confirmed(*value))).await {
        Ok(Ok(value)) => raw_confirmed(*value),
        _ => false,
    };
    confirmed
}

async fn close_unlaunched(feed: Arc<RawFeed>, reader: Option<OwnedFd>, state: watch::Sender<BroadcastStatus>,
                         _permit: Option<Permit>) {
    state.send_replace(BroadcastStatus::Stopping);
    let eof = async { match reader { Some(reader) => drain(reader).await, None => false } };
    let (raw_stopped, pipe_eof) = tokio::join!(raw_stopped(&feed), eof);
    state.send_replace(BroadcastStatus::Failed { reason: BroadcastFailure::Startup,
        cleanup: CleanupProof { child_reaped: true, raw_stopped, pipe_eof } });
}

async fn discard_status(output: Option<ChildStdout>) {
    let Some(mut output) = output else { return; };
    let mut buffer = [0; 256];
    let mut total = 0;
    while let Ok(count) = output.read(&mut buffer).await {
        if count == 0 { break; }
        total += count;
        if total > 4096 { break; }
    }
}

async fn run(feed: Arc<RawFeed>, reader: OwnedFd, runtime: SenderRuntime, cancelled: Arc<AtomicBool>,
             state: watch::Sender<BroadcastStatus>, mut permit: Option<Permit>,
             #[cfg(test)] pid: Arc<std::sync::atomic::AtomicU32>) {
    let mut child = None;
    let mut output = None;
    let mut exited = None;
    let mut reason = None;
    match reservation(&feed, &cancelled).await {
        Ok(Some(expected)) if !cancelled.load(Ordering::Acquire) => {
            match reader.try_clone().and_then(|input| spawn(&runtime, input, expected)) {
                Ok(mut process) => {
                    #[cfg(test)] pid.store(process.id().unwrap_or(0), Ordering::Release);
                    output = process.stdout.take();
                    if let Some(output) = output.as_mut() {
                        (reason, exited) = active(&mut process, output, expected, &feed, &cancelled, &state).await;
                    } else { reason = Some(BroadcastFailure::Protocol); }
                    child = Some(process);
                },
                Err(_) => reason = Some(BroadcastFailure::Startup),
            }
        },
        Ok(_) => {},
        Err(failure) => reason = Some(failure),
    }
    // Latched once: queued Ready/Live messages can never reopen this attempt.
    feed.cancel();
    state.send_replace(BroadcastStatus::Stopping);
    let child_reaped = match child {
        Some(child) => {
            let (reaped, _) = tokio::join!(reap(child, exited, &mut reason, &state, &mut permit),
                tokio::time::timeout(STOP_GRACE + REAP_WAIT, discard_status(output)));
            reaped
        },
        None => true, // No child was created; this barrier is not applicable.
    };
    let (raw_stopped, pipe_eof) = if child_reaped {
        tokio::join!(raw_stopped(&feed), drain(reader))
    } else { (false, false) };
    let cleanup = CleanupProof { child_reaped, raw_stopped, pipe_eof };
    if !cleanup.complete() { reason.get_or_insert(BroadcastFailure::CleanupUnconfirmed); }
    state.send_replace(match reason {
        Some(reason) => BroadcastStatus::Failed { reason, cleanup },
        None => BroadcastStatus::Stopped,
    });
}

#[cfg(test)]
mod ownership_tests {
    use super::*;

    #[test]
    fn only_interrupted_wait_retains_pid_authority() {
        assert!(!wait_lost_ownership(&std::io::Error::from_raw_os_error(libc::EINTR)));
        assert!(wait_lost_ownership(&std::io::Error::from_raw_os_error(libc::ECHILD)));
        assert!(wait_lost_ownership(&std::io::Error::from_raw_os_error(libc::EINVAL)));
        assert!(wait_lost_ownership(&std::io::Error::other("generated wait failure")));
    }

    #[test]
    fn quarantined_admission_survives_permit_drop() {
        let registry = Arc::new(Mutex::new(Registry::default()));
        let mut permit = Permit::acquire_in(registry.clone(), "quarantined").unwrap();
        permit.quarantined = true;
        drop(permit); // Models task/runtime cancellation while quarantined.
        assert!(Permit::acquire_in(registry.clone(), "quarantined").is_err());
        let snapshot = registry.lock().unwrap().begin_shutdown();
        assert_eq!(snapshot.len(), 1);
        assert!(!cleanup_proven(*snapshot[0].borrow()));
    }

    #[test]
    fn shutdown_atomically_closes_admission_and_snapshots_unlaunched_starts() {
        let registry = Arc::new(Mutex::new(Registry::default()));
        let first = Permit::acquire_in(registry.clone(), "first").unwrap();
        let other = Permit::acquire_in(registry.clone(), "other").unwrap();
        let snapshot = registry.lock().unwrap().begin_shutdown();
        assert_eq!(snapshot.len(), 2);
        assert!(first.cancelled.load(Ordering::Acquire));
        assert!(other.cancelled.load(Ordering::Acquire));
        assert!(snapshot.iter().all(|status| *status.borrow() == BroadcastStatus::Starting));
        assert!(Permit::acquire_in(registry.clone(), "later").is_err());
        assert_eq!(registry.lock().unwrap().begin_shutdown().len(), 2);
        drop(first); drop(other);
        assert!(snapshot.iter().all(|status| cleanup_proven(*status.borrow())));
        assert!(registry.lock().unwrap().entries.is_empty());
        assert!(Permit::acquire_in(registry, "still-closed").is_err());
    }

    #[tokio::test]
    async fn unlaunched_failure_publishes_complete_local_cleanup_before_status_closes() {
        let registry = Arc::new(Mutex::new(Registry::default()));
        let permit = Permit::acquire_in(registry.clone(), "no-raw-or-child").unwrap();
        let snapshot = registry.lock().unwrap().begin_shutdown();
        drop(permit);
        assert!(await_shutdown(snapshot, Duration::from_millis(20)).await);
        assert!(registry.lock().unwrap().entries.is_empty());
    }

    #[tokio::test]
    async fn invalid_launch_paths_and_missing_reader_preserve_reservation_cleanup() {
        use super::super::raw_service::{self, tests::Fixture};
        for (invalid_paths, missing_reader) in [(true, false), (false, true), (true, true)] {
            let fixture = Fixture::new();
            let mut feed = raw_service::prepare(&fixture.program.id, &fixture.requests).unwrap();
            let mut generations = feed.generations();
            fixture.peer.hello().await;
            tokio::time::timeout(Duration::from_secs(1), generations.wait_for(Option::is_some)).await.unwrap().unwrap();
            let held_reader = if missing_reader { feed.take_reader() } else { None };
            let registry = Arc::new(Mutex::new(Registry::default()));
            let permit = Permit::acquire_in(registry.clone(), "invalid-launch").unwrap();
            let status = permit.state.subscribe();
            let runtime = SenderRuntime {
                executable: PathBuf::from(if invalid_paths { "relative-sender" } else { "/unused-generated-sender" }),
                sdk: PathBuf::from("/unused-generated-runtime"), fake_mode: None,
            };
            assert!(launch_inner(feed, runtime, Some(permit)).is_err());
            assert!(Permit::acquire_in(registry.clone(), "invalid-launch").is_err(),
                "synchronous validation failure must retain admission until raw cleanup");
            let complete = await_shutdown(vec![status.clone()], Duration::from_secs(3)).await;
            assert_eq!(complete, !missing_reader);
            assert_eq!(*status.borrow(), BroadcastStatus::Failed { reason: BroadcastFailure::Startup,
                cleanup: CleanupProof { child_reaped: true, raw_stopped: true, pipe_eof: !missing_reader } });
            fixture.peer.no_message().await; // Neither Start nor Stop for this unarmed reservation.
            assert!(registry.lock().unwrap().entries.is_empty());
            assert!(!fixture.program.is_stopped()); assert!(fixture.program.encoded_ready());
            drop(held_reader);
            fixture.close().await;
        }
    }

    #[tokio::test]
    async fn cancelled_supervisor_without_reap_proof_remains_quarantined() {
        let registry = Arc::new(Mutex::new(Registry::default()));
        let mut permit = Permit::acquire_in(registry.clone(), "supervised").unwrap();
        permit.supervised = true;
        let snapshot = registry.lock().unwrap().begin_shutdown();
        drop(permit); // A task cancellation must not invent its child's reap.
        assert!(!await_shutdown(snapshot, Duration::from_millis(20)).await);
        assert_eq!(registry.lock().unwrap().entries.len(), 1);
    }

    #[tokio::test]
    async fn shutdown_waits_for_all_peers_under_one_deadline() {
        let mut registry = Registry::default();
        let (_, first) = registry.reserve("first").unwrap();
        let (_, other) = registry.reserve("other").unwrap();
        let snapshot = registry.begin_shutdown();
        let completion = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            first.send_replace(BroadcastStatus::Stopped);
            tokio::time::sleep(Duration::from_millis(20)).await;
            other.send_replace(BroadcastStatus::Failed { reason: BroadcastFailure::SenderFailed,
                cleanup: CleanupProof { child_reaped: true, raw_stopped: true, pipe_eof: true } });
        });
        let began = Instant::now();
        assert!(await_shutdown(snapshot, Duration::from_secs(1)).await);
        assert!(began.elapsed() >= Duration::from_millis(35));
        completion.await.unwrap();
        assert!(await_shutdown(Vec::new(), Duration::ZERO).await);
    }

    #[tokio::test]
    async fn incomplete_peer_does_not_skip_other_peers_cleanup_wait() {
        let mut registry = Registry::default();
        let (_, failed) = registry.reserve("unknown").unwrap();
        let (_, healthy) = registry.reserve("healthy").unwrap();
        let snapshot = registry.begin_shutdown();
        failed.send_replace(BroadcastStatus::Failed { reason: BroadcastFailure::CleanupUnconfirmed,
            cleanup: CleanupProof { child_reaped: true, raw_stopped: false, pipe_eof: true } });
        drop(failed);
        let completion = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(40)).await;
            healthy.send_replace(BroadcastStatus::Stopped);
        });
        let began = Instant::now();
        assert!(!await_shutdown(snapshot, Duration::from_secs(1)).await);
        assert!(began.elapsed() >= Duration::from_millis(35));
        completion.await.unwrap();
    }

    #[tokio::test]
    async fn shutdown_timeout_is_not_multiplied_by_snapshot_count() {
        let mut registry = Registry::default();
        let states: Vec<_> = (0..6).map(|index| registry.reserve(&format!("held-{index}")).unwrap().1).collect();
        let snapshot = registry.begin_shutdown();
        let began = Instant::now();
        assert!(!await_shutdown(snapshot, Duration::from_millis(40)).await);
        assert!(began.elapsed() < Duration::from_millis(200));
        assert!(registry.closing);
        assert!(registry.reserve("no-reopen-after-timeout").is_err());
        drop(states);
    }

    #[tokio::test]
    async fn closed_status_is_not_cleanup_without_a_complete_terminal_proof() {
        for status in [BroadcastStatus::Starting, BroadcastStatus::Stopping,
            BroadcastStatus::Failed { reason: BroadcastFailure::CleanupUnconfirmed, cleanup: CleanupProof::default() }] {
            let (sender, receiver) = watch::channel(status);
            drop(sender);
            assert!(!await_shutdown(vec![receiver], Duration::from_secs(1)).await);
        }
        let (sender, receiver) = watch::channel(BroadcastStatus::Stopped);
        drop(sender);
        assert!(await_shutdown(vec![receiver], Duration::from_secs(1)).await);
    }

    #[test]
    fn empty_struct_events_reject_unknown_fields() {
        for state in ["ready", "live", "stopping"] {
            let valid = format!(r#"{{"state":"{state}"}}"#);
            let extra = format!(r#"{{"state":"{state}","extra":true}}"#);
            assert!(serde_json::from_str::<ChildEvent>(&valid).is_ok());
            assert!(serde_json::from_str::<ChildEvent>(&extra).is_err());
        }
    }
}

#[cfg(test)]
#[path = "broadcast_tests.rs"]
mod tests;
