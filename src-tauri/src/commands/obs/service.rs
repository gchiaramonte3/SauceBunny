//! One shared helper process; independent, generation-scoped programs. Consumer
//! backpressure never reaches the helper. Capacity remains held until a slot's
//! teardown acknowledgement, or until a failed helper has been killed/reaped.
use std::{collections::HashMap, io, path::{Path, PathBuf}, process::{ExitStatus, Stdio}, sync::{Arc, Mutex, OnceLock}, time::Duration};
use serde::Deserialize;
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, process::{Child, ChildStdin, ChildStdout, ChildStderr}, sync::{mpsc, watch}, time::{Instant, interval}};
use super::{ObsSelection, framing::Framer, service_wire::{Record, Wire, MAX_GENERATION}};
use super::{raw_control, raw_service};
use super::super::ndi::{Program, WorkerPermit, NdiTelemetry, NdiPhase};
use crate::AppError;

pub(super) struct Request { pub selection: ObsSelection, pub program: Arc<Program>, pub permit: Option<WorkerPermit> }
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CloseReason { Draining, UnconfirmedReap }
impl CloseReason {
    fn message(self) -> &'static str {
        match self {
            Self::Draining => "Application capture is still closing. Retry the preview in a moment.",
            Self::UnconfirmedReap => "Application capture cleanup could not be confirmed. Restart Sauce Bunny before starting another application capture.",
        }
    }
}
struct Client {
    root: PathBuf, sender: mpsc::Sender<Request>, closing: Option<CloseReason>,
    raw_sender: mpsc::Sender<raw_service::Request>,
    // Local completion only: no source metadata or media is carried here.
    pending: HashMap<String, watch::Sender<bool>>,
}
impl Client {
    fn close(&mut self, reason: CloseReason) {
        if self.closing != Some(CloseReason::UnconfirmedReap) { self.closing = Some(reason); }
    }
    fn admission_error(&self, root: &Path) -> Option<AppError> {
        (self.closing.is_some() || self.root != root)
            .then(||AppError::invalid(self.closing.unwrap_or(CloseReason::Draining).message()))
    }
    fn completed(&mut self, id: &str) {
        if !self.pending.contains_key(id) { return; }
        if self.pending.len() == 1 {
            // The last slot also owns the shared process lifetime. Do not
            // report stop complete until finish() has reaped that process.
            self.close(CloseReason::Draining);
        } else if let Some(done) = self.pending.remove(id) { done.send_replace(true); }
    }
    fn finish(self) {
        for done in self.pending.into_values() { done.send_replace(true); }
    }
}
fn client() -> &'static Mutex<Option<Client>> {
    static CLIENT: OnceLock<Mutex<Option<Client>>> = OnceLock::new();
    CLIENT.get_or_init(||Mutex::new(None))
}
/// Check before reserving native capacity, which may remain held by quarantine.
/// enqueue rechecks under the same lock after registration to cover races.
pub(super) fn check_start(root: &Path) -> Result<(), AppError> {
    let current = client().lock().map_err(|_|AppError::internal("Application capture state unavailable"))?;
    match current.as_ref().and_then(|client|client.admission_error(root)) {
        Some(error) => Err(error),
        None => Ok(()),
    }
}
pub(super) fn enqueue(root: PathBuf, request: Request) -> Result<(), AppError> {
    if request.program.is_stopped() { return Ok(()); }
    if !request.selection.valid() {
        request.program.stop();
        return Err(AppError::invalid("Select a visible application window and a valid viewer crop"));
    }
    let mut current = client().lock().map_err(|_|AppError::internal("Application capture state unavailable"))?;
    if let Some(error) = current.as_ref().and_then(|client|client.admission_error(&root)) {
        request.program.stop();
        return Err(error);
    }
    if current.is_none() {
        let (sender, receiver) = mpsc::channel(2);
        let (raw_sender, raw_receiver) = mpsc::channel(2);
        *current = Some(Client { root:root.clone(), sender, raw_sender, closing:None, pending:HashMap::new() });
        tauri::async_runtime::spawn(run(root, receiver, raw_receiver));
    }
    let Some(active) = current.as_mut() else { return Err(AppError::internal("Application capture state unavailable")); };
    let id = request.program.id.clone();
    if active.pending.contains_key(&id) { return Err(AppError::invalid("Application capture is already starting")); }
    active.pending.insert(id.clone(), watch::channel(false).0);
    if let Err(error) = active.sender.try_send(request) {
        error.into_inner().program.stop();
        if let Some(done) = active.pending.remove(&id) { done.send_replace(true); }
        return Err(AppError::invalid("Application capture is busy; retry the preview"));
    }
    Ok(())
}

pub(super) fn begin_raw_output(id: &str) -> Result<raw_service::RawFeed, AppError> {
    raw_output(id, false)
}
pub(super) fn prepare_raw_output(id: &str) -> Result<raw_service::RawFeed, AppError> {
    raw_output(id, true)
}
fn raw_output(id: &str, prepared: bool) -> Result<raw_service::RawFeed, AppError> {
    let current = client().lock().map_err(|_|AppError::internal("Application capture state unavailable"))?;
    let active = current.as_ref().filter(|client|client.closing.is_none() && client.pending.contains_key(id))
        .ok_or_else(||AppError::invalid("The selected application capture is not running"))?;
    if prepared { raw_service::prepare(id, &active.raw_sender) }
    else { raw_service::begin(id, &active.raw_sender) }
}

/// Called after registry stop, with no session lock held. Merely removing a
/// program from the registry does not release its native encoder capacity.
pub(super) async fn wait_stopped(id: &str) -> Result<(), AppError> {
    let mut done = {
        let current = client().lock().map_err(|_|AppError::internal("Application capture state unavailable"))?;
        let Some(client) = current.as_ref() else { return Ok(()); };
        let Some(done) = client.pending.get(id) else { return Ok(()); };
        if client.closing == Some(CloseReason::UnconfirmedReap) {
            return Err(AppError::invalid(CloseReason::UnconfirmedReap.message()));
        }
        done.subscribe()
    };
    let result = match tokio::time::timeout(Duration::from_secs(10), done.wait_for(|complete|*complete)).await {
        Ok(Ok(_)) => Ok(()),
        _ => {
            // Quarantine may have happened after this waiter subscribed. Keep
            // the existing timeout, but report the current source-scoped reason.
            let current = client().lock().map_err(|_|AppError::internal("Application capture state unavailable"))?;
            let reason = current.as_ref().filter(|client|client.pending.contains_key(id))
                .and_then(|client|client.closing).unwrap_or(CloseReason::Draining);
            Err(AppError::invalid(reason.message()))
        },
    };
    result
}
fn completed(id: &str) {
    if let Ok(mut current) = client().lock() {
        if let Some(client) = current.as_mut() { client.completed(id); }
    }
}

struct Active {
    request: Request, generation: u64, framing: Framer,
    progressed: Instant, ready: bool, frames: u64, fragments: u64, closing: Option<Instant>,
}
impl Active {
    fn new(request: Request, generation: u64) -> Self {
        Self { request, generation, framing:Framer::default(), progressed:Instant::now(),
            ready:false, frames:0, fragments:0, closing:None }
    }
    fn fail(&self, message: &str) { if !self.request.program.is_stopped() { self.request.program.fail(message); } }
    fn record(&mut self, record: Record<'_>) -> bool {
        if self.generation != record.generation { return false; }
        if record.kind == 3 {
            self.fail(if self.framing.finish().is_err() { "Application capture ended inside a media fragment" }
                else { "Application capture ended unexpectedly" });
            return true;
        }
        if self.closing.is_some() || self.request.program.is_stopped() { return false; }
        if record.kind == 1 {
            let result = self.framing.push(record.payload, |kind, data| {
                if kind == 2 { self.ready = true; self.progressed = Instant::now(); self.fragments = self.fragments.saturating_add(1); }
                self.request.program.publish(kind, data);
            });
            if result.is_err() { self.fail("Application capture returned invalid or oversized media"); }
        } else {
            #[derive(Deserialize)] #[serde(deny_unknown_fields)]
            struct Status { width:u32, height:u32, frames:u64, error:String }
            let Ok(status) = serde_json::from_slice::<Status>(record.payload) else {
                self.fail("Application capture returned invalid status"); return false;
            };
            if !status.error.is_empty() {
                self.fail(if status.error == "source_stopped" {
                    "Capture stopped because its window, size, visibility or permission changed"
                } else { "The selected application window could not start capture" });
                return false;
            }
            if !(2..=1920).contains(&status.width) || !(2..=1080).contains(&status.height) ||
                status.width % 2 != 0 || status.height % 2 != 0 {
                self.fail("Application capture returned invalid dimensions"); return false;
            }
            self.frames = self.frames.max(status.frames);
            let state = NdiTelemetry { source_id:self.request.program.id.clone(), phase:NdiPhase::Live,
                input_width:status.width, input_height:status.height, output_fps:30.0,
                received_frames:status.frames, ..NdiTelemetry::default() };
            if let Ok(bytes) = serde_json::to_vec(&state) { self.request.program.publish(3, &bytes); }
        }
        false
    }
}

async fn send(input: &mut ChildStdin, value: serde_json::Value) -> bool {
    let Ok(mut bytes) = serde_json::to_vec(&value) else { return false; };
    bytes.push(b'\n');
    matches!(tokio::time::timeout(Duration::from_millis(100), input.write_all(&bytes)).await, Ok(Ok(())))
}
fn closing(receiver: &mut mpsc::Receiver<Request>, only_if_empty: bool) -> bool {
    let Ok(mut current) = client().lock() else { receiver.close(); return true; };
    // Enqueue holds this same lock through try_send. No new request can slip
    // between the empty check and closing. Keep the Client until process reap.
    if only_if_empty && !receiver.is_empty() { return false; }
    if let Some(client) = current.as_mut() { client.close(CloseReason::Draining); }
    receiver.close(); true
}
fn raw_snapshot(slots: &[Option<Active>;2]) -> Vec<raw_service::CaptureSlot> {
    slots.iter().enumerate().filter_map(|(slot, active)|active.as_ref().map(|active|raw_service::CaptureSlot {
        slot:slot as u8, generation:active.generation, program:active.request.program.clone(),
    })).collect()
}

#[cfg(test)]
#[derive(Default)]
struct ReapFaults {
    errors: std::collections::VecDeque<i32>,
    after_kill: bool,
    waits: usize,
    kills: usize,
}

async fn wait_owned(child: &mut Child, #[cfg(test)] faults: &mut ReapFaults) -> io::Result<ExitStatus> {
    loop {
        #[cfg(test)] {
            faults.waits += 1;
            if !faults.after_kill || faults.kills > 0 {
                if let Some(code) = faults.errors.pop_front() {
                    let error = io::Error::from_raw_os_error(code);
                    if error.kind() == io::ErrorKind::Interrupted { continue; }
                    return Err(error);
                }
            }
        }
        match child.wait().await {
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            result => return result,
        }
    }
}

/// Normal shutdown keeps the existing four-second drain grace. Pipe setup
/// failure skips grace, but neither path may treat a wait error as a reap.
async fn reap_child(mut child: Child, pipes: Option<(ChildStdout, ChildStderr)>, force: bool,
                    #[cfg(test)] faults: &mut ReapFaults) -> bool {
    if !force {
        let drain = async {
            if let Some((mut output, mut errors)) = pipes {
                let mut sink_a = tokio::io::sink(); let mut sink_b = tokio::io::sink();
                let _ = tokio::join!(tokio::io::copy(&mut output, &mut sink_a), tokio::io::copy(&mut errors, &mut sink_b));
            }
            Ok::<(), io::Error>(())
        };
        // A wait error must escape immediately even if a stale writer keeps
        // stdout open. Only wait_owned can fail this join, not pipe draining.
        let graceful = async {
            tokio::try_join!(wait_owned(&mut child, #[cfg(test)] faults), drain).map(|_|())
        };
        match tokio::time::timeout(Duration::from_secs(4), graceful).await {
            Ok(Ok(())) => return true,
            Ok(Err(_)) => {
                // Same lost-identity policy as the standalone NDI supervisor:
                // do not let Tokio's kill_on_drop/orphan reaper reuse this PID.
                std::mem::forget(child);
                return false;
            },
            Err(_) => {},
        }
    }
    #[cfg(test)] { faults.kills += 1; }
    let _ = child.start_kill();
    match wait_owned(&mut child, #[cfg(test)] faults).await {
        Ok(_) => true,
        Err(_) => { std::mem::forget(child); false },
    }
}

fn retain_unconfirmed(receiver: &mut mpsc::Receiver<Request>, slots: &mut [Option<Active>;2]) {
    closing(receiver, false);
    if let Ok(mut current) = client().lock() {
        if let Some(client) = current.as_mut() { client.close(CloseReason::UnconfirmedReap); }
    }
    for active in slots.iter_mut().filter_map(Option::take) {
        active.fail("Application capture cleanup could not be confirmed");
        // These bounded native capture permits must survive task cancellation.
        // The closed Client remains registered until app exit; no replacement
        // helper can start and no waiter is told that teardown succeeded.
        if let Some(permit) = active.request.permit { std::mem::forget(permit); }
    }
    // Queued captures were never sent to the helper and can release capacity.
    while let Ok(request) = receiver.try_recv() {
        request.program.fail("Application capture cleanup could not be confirmed");
    }
    eprintln!("[obs] Capture helper reap could not be confirmed; restart is required");
}

async fn run(root: PathBuf, mut receiver: mpsc::Receiver<Request>, raw_receiver: mpsc::Receiver<raw_service::Request>) {
    let mut command = super::command(&root, "capture-service");
    #[cfg(test)]
    if std::env::var_os("SAUCE_OBS_TEST_AUDIO_TRACE").is_some() { command.env("SAUCE_OBS_AUDIO_DIAGNOSTICS", "1"); }
    command.arg(&root).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // An optional, anonymous control channel. Failure to provision this branch
    // must not turn an otherwise working local preview into an error.
    let raw_control = raw_control::Control::pair().ok().and_then(|(control, child)| {
        raw_control::Control::prepare_child(&mut command, child).ok().map(|()|control)
    });
    let mut slots: [Option<Active>;2] = [None,None];
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => { finish(&mut receiver, &mut slots, "The embedded OBS capture helper could not start"); return; }
    };
    // prepare_child owns a descriptor in Command's pre_exec closure. Keeping
    // the parent Command alive would keep that peer open after helper exit.
    drop(command);
    let (Some(mut input), Some(mut output), Some(mut errors)) = (child.stdin.take(), child.stdout.take(), child.stderr.take()) else {
        closing(&mut receiver, false);
        if reap_child(child, None, true, #[cfg(test)] &mut ReapFaults::default()).await {
            finish(&mut receiver, &mut slots, "The embedded OBS capture pipes could not open");
        } else { retain_unconfirmed(&mut receiver, &mut slots); }
        return;
    };
    let (raw_captures, raw_capture_updates) = watch::channel(Vec::new());
    let raw_task = raw_control.map(|control|tauri::async_runtime::spawn(raw_service::run(control, raw_receiver, raw_capture_updates)));
    let mut media = [0u8;16384]; let mut error_bytes = [0u8;4096];
    let mut wire = Wire::default(); let mut heartbeat = interval(Duration::from_millis(250));
    let mut generation = 0u64; let mut errors_open = true;
    let failure = loop {
        if slots.iter().all(Option::is_none) && closing(&mut receiver, true) { break "Application capture stopped"; }
        tokio::select! {
            request = receiver.recv() => {
                let Some(request) = request else { break "Application capture owner closed"; };
                if request.program.is_stopped() {
                    let id = request.program.id.clone(); drop(request); completed(&id); continue;
                }
                let Some(slot) = slots.iter().position(Option::is_none) else {
                    request.program.fail("Application capture slots are still closing");
                    let id = request.program.id.clone(); drop(request); completed(&id); continue;
                };
                generation += 1;
                if generation > MAX_GENERATION { request.program.fail("Application capture generation exhausted"); break "Application capture generation exhausted"; }
                let selection = &request.selection;
                let message = serde_json::json!({"op":"start", "slot":slot,"generation":generation,
                    "application":selection.application,"process":selection.process,"window":selection.window,
                    "crop":[selection.crop.x,selection.crop.y,selection.crop.width,selection.crop.height]});
                slots[slot] = Some(Active::new(request, generation));
                raw_captures.send_replace(raw_snapshot(&slots));
                if !send(&mut input, message).await { break "Application capture control channel closed"; }
            }
            _ = heartbeat.tick() => {
                let mut stalled_stop = false;
                for (slot, active) in slots.iter_mut().enumerate() {
                    let Some(active) = active else { continue; };
                    if active.frames.saturating_sub(active.fragments.saturating_mul(3)) > 90 {
                        active.fail("Application capture encoder fell behind; restart the preview");
                    }
                    if active.progressed.elapsed() > Duration::from_secs(if active.ready {4} else {12}) {
                        active.fail("Application capture stopped delivering complete media");
                    }
                    if active.request.program.is_stopped() && active.closing.is_none() {
                        active.closing = Some(Instant::now());
                        if !send(&mut input, serde_json::json!({"op":"stop","slot":slot,"generation":active.generation})).await { stalled_stop = true; }
                    }
                    if active.closing.is_some_and(|at|at.elapsed() > Duration::from_secs(4)) { stalled_stop = true; }
                }
                if stalled_stop { break "Application capture did not stop safely"; }
                if !matches!(tokio::time::timeout(Duration::from_millis(100), input.write_all(b"P\n")).await, Ok(Ok(()))) {
                    break "Application capture control channel closed";
                }
            }
            bytes = output.read(&mut media) => {
                match bytes {
                    Ok(0) | Err(_) => break "Application capture service ended unexpectedly",
                    Ok(count) => {
                        if wire.push(&media[..count], |record| {
                            let slot = record.slot;
                            if let Some(active) = &mut slots[slot] {
                                if active.record(record) {
                                    let id = active.request.program.id.clone();
                                    slots[slot] = None; // Release permit BEFORE notifying stop callers.
                                    raw_captures.send_replace(raw_snapshot(&slots));
                                    completed(&id);
                                }
                            }
                        }).is_err() { break "Application capture returned invalid service records"; }
                    }
                }
            }
            bytes = errors.read(&mut error_bytes), if errors_open => {
                // Vendor diagnostics stay bounded and private. Only the typed
                // stdout status can affect an individual program's state.
                #[cfg(test)]
                if let Ok(count) = &bytes { service_tests::trace_errors(&error_bytes[..*count]); }
                if !matches!(bytes, Ok(1..)) { errors_open = false; }
            }
        }
    };
    closing(&mut receiver, false);
    for active in slots.iter().flatten() { active.fail(failure); }
    let _ = tokio::time::timeout(Duration::from_millis(100), input.write_all(b"Q\n")).await;
    drop(input);
    let reaped = reap_child(child, Some((output, errors)), false, #[cfg(test)] &mut ReapFaults::default()).await;
    if !reaped { retain_unconfirmed(&mut receiver, &mut slots); }
    // Native source teardown closes its raw writers before the existing
    // terminal capture record. The raw actor remains independent until here.
    drop(raw_captures);
    if let Some(mut task) = raw_task {
        if tokio::time::timeout(Duration::from_secs(3), &mut task).await.is_err() {
            task.abort();
            let _ = task.await;
        }
    }
    if reaped { finish(&mut receiver, &mut slots, failure); }
}
fn finish(receiver: &mut mpsc::Receiver<Request>, slots: &mut [Option<Active>;2], failure: &str) {
    closing(receiver, false);
    for active in slots.iter_mut() {
        if let Some(active) = active.take() { active.fail(failure); drop(active.request.permit); }
    }
    while let Ok(request) = receiver.try_recv() { request.program.fail(failure); }
    if let Ok(mut current) = client().lock() {
        if let Some(client) = current.take() { client.finish(); }
    }
}

#[path = "service_tests.rs"]
#[cfg(test)]
mod service_tests;

#[path = "service_reap_tests.rs"]
#[cfg(test)]
mod reap_tests;
