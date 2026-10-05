//! Preview capture through macOS's own sharing picker (docs/PROGRAM-CAPTURE.md).
//!
//! One long-lived helper, `Sauce Bunny Capture.app` (swift-sidecar's
//! saucebunny-program-capture), shows the picker and streams what was picked.
//! The filter the picker returns is valid only inside the process that showed
//! it, so the helper keeps each pick under a token minted here and stays alive
//! while it holds any: choosing again is needed only after it restarts.
//!
//! Choosing is separate from starting. The person's time in the picker never
//! counts against the first-media watchdog, and `start` never shows UI. The
//! records on the helper's stdout are the OBS service's (service_wire.rs) plus
//! kind 4, a choice result; media lands in the same `Program` ring, so the
//! Preview monitor, the room and the coordinator are unchanged.
use std::{collections::HashMap, path::PathBuf, process::Stdio, sync::{Arc, Mutex, OnceLock}, time::Duration};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tokio::{io::{AsyncReadExt, AsyncWriteExt}, process::ChildStdin, sync::{mpsc, oneshot, watch}, time::{interval, Instant}};
use super::{framing::Framer, service_wire::{Wire, MAX_GENERATION}, ObsCrop, ObsSelection, ObsStarted};
use super::super::ndi::{self, NdiPhase, NdiTelemetry, Program, WorkerPermit};
use crate::AppError;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum ProgramCaptureKind { Screen, Window, Region }
impl ProgramCaptureKind {
    fn name(self) -> &'static str { match self { Self::Screen => "screen", Self::Window => "window", Self::Region => "region" } }
}

/// What the Preview captures: a pick the helper holds under `choice`.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ProgramCaptureSelection {
    pub choice: String,
    pub kind: ProgramCaptureKind,
    /// Shown in the dialog and the room: the display's name, or "App · Window title".
    pub label: String,
    pub audio: bool,
    /// Region only: the part of the picked display, each edge a fraction of it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub region: Option<ObsCrop>,
}
impl ProgramCaptureSelection {
    pub(super) fn valid(&self) -> bool {
        valid_token(&self.choice) && !self.label.is_empty() && self.label.chars().count() <= 160 && !self.label.chars().any(char::is_control)
            && match (&self.kind, &self.region) { (ProgramCaptureKind::Region, Some(region)) => region.valid(), (ProgramCaptureKind::Region, None) => false, (_, region) => region.is_none() }
    }
}
fn valid_token(value: &str) -> bool { value.len() == 32 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) }

#[derive(Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ProgramCapturePreflight {
    pub available: bool,
    pub error: Option<String>,
    /// The kinds this build can capture; the dialog shows only these tabs.
    pub kinds: Vec<ProgramCaptureKind>,
    /// System and application audio need macOS 14.2 (a Core Audio process tap).
    pub system_audio: bool,
}

#[derive(Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ProgramCaptureChoice { pub choice: String, pub kind: ProgramCaptureKind, pub label: String, pub width: u32, pub height: u32 }

#[derive(Serialize, ts_rs::TS)]
#[serde(tag = "outcome", rename_all = "lowercase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum ProgramCaptureChooseResult { Chosen { choice: ProgramCaptureChoice }, Cancelled }

/// The kinds that ship in this build (Window and Region arrive in later phases).
const KINDS: [ProgramCaptureKind; 1] = [ProgramCaptureKind::Screen];

fn helper_candidate(executable: &std::path::Path, developer: bool, override_path: Option<PathBuf>) -> Option<PathBuf> {
    let parent = executable.parent()?;
    if parent.file_name()? == "MacOS" && parent.parent()?.file_name()? == "Contents" {
        // A packaged app runs only the helper it ships; nothing can be substituted.
        return Some(parent.parent()?.join("Helpers/Sauce Bunny Capture.app/Contents/MacOS/saucebunny-program-capture"));
    }
    developer.then(|| override_path.unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("helpers/Sauce Bunny Capture.app/Contents/MacOS/saucebunny-program-capture")))
}

fn helper() -> Result<PathBuf, AppError> {
    let executable = std::env::current_exe()?;
    let path = helper_candidate(&executable, cfg!(debug_assertions), std::env::var_os("SAUCE_CAPTURE_DEV_HELPER").map(PathBuf::from))
        .ok_or_else(|| AppError::invalid("This build does not include the screen capture helper"))?;
    let path = path.canonicalize().map_err(|_| AppError::invalid("The screen capture helper is missing from this build"))?;
    if !path.is_file() { return Err(AppError::invalid("The screen capture helper is missing from this build")); }
    Ok(path)
}

enum Op {
    Choose { job: String, kind: ProgramCaptureKind, reply: oneshot::Sender<Result<ProgramCaptureChooseResult, AppError>> },
    Cancel { job: String },
    Start { selection: ProgramCaptureSelection, program: Arc<Program>, permit: WorkerPermit },
}

struct Service { sender: mpsc::Sender<Op>, session: u64 }
#[derive(Default)]
struct State {
    service: Option<Service>,
    next_session: u64,
    /// Picks the running helper holds: token → (its session, kind).
    choices: HashMap<String, (u64, ProgramCaptureKind)>,
    /// Programs whose native teardown has not been acknowledged yet.
    pending: HashMap<String, watch::Sender<bool>>,
}
fn state() -> &'static Mutex<State> {
    static STATE: OnceLock<Mutex<State>> = OnceLock::new();
    STATE.get_or_init(|| Mutex::new(State::default()))
}
fn locked() -> Result<std::sync::MutexGuard<'static, State>, AppError> {
    state().lock().map_err(|_| AppError::internal("Screen capture state unavailable"))
}

/// The running helper's channel, starting it if it is not running.
fn service() -> Result<(mpsc::Sender<Op>, u64), AppError> {
    let mut current = locked()?;
    if let Some(service) = current.service.as_ref().filter(|service| !service.sender.is_closed()) {
        return Ok((service.sender.clone(), service.session));
    }
    let path = helper()?;
    current.next_session += 1;
    let session = current.next_session;
    let (sender, receiver) = mpsc::channel(8);
    current.service = Some(Service { sender: sender.clone(), session });
    tauri::async_runtime::spawn(run(path, receiver, session));
    Ok((sender, session))
}

fn token() -> Result<String, AppError> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|_| AppError::internal("Cannot create a capture token"))?;
    Ok(hex::encode(bytes))
}

#[tauri::command]
pub async fn program_capture_preflight() -> Result<ProgramCapturePreflight, AppError> {
    let available = helper();
    Ok(ProgramCapturePreflight {
        available: available.is_ok(),
        error: available.err().map(|error| error.to_string()),
        kinds: KINDS.to_vec(),
        system_audio: macos_at_least(14, 2),
    })
}

fn macos_at_least(major: u64, minor: u64) -> bool {
    let Ok(output) = std::process::Command::new("/usr/bin/sw_vers").arg("-productVersion").output() else { return false };
    let text = String::from_utf8_lossy(&output.stdout);
    let mut parts = text.trim().split('.').map(|part| part.parse::<u64>().unwrap_or(0));
    let (have_major, have_minor) = (parts.next().unwrap_or(0), parts.next().unwrap_or(0));
    (have_major, have_minor) >= (major, minor)
}

/// Shows macOS's sharing picker. Resolves when the person picks or cancels;
/// `job_id` (minted by the renderer) is how Cancel finds this request.
#[tauri::command]
pub async fn program_capture_choose(job_id: String, kind: ProgramCaptureKind) -> Result<ProgramCaptureChooseResult, AppError> {
    if !KINDS.contains(&kind) { return Err(AppError::invalid("This kind of capture is not available yet")); }
    let (sender, _) = service()?;
    let (reply, answer) = oneshot::channel();
    sender.send(Op::Choose { job: job_id, kind, reply }).await.map_err(|_| AppError::invalid("The screen capture helper stopped. Try again."))?;
    answer.await.map_err(|_| AppError::invalid("The screen capture helper stopped. Try again."))?
}

#[tauri::command]
pub async fn program_capture_cancel_choose(job_id: String) -> Result<(), AppError> {
    let sender = locked()?.service.as_ref().map(|service| service.sender.clone());
    if let Some(sender) = sender { let _ = sender.send(Op::Cancel { job: job_id }).await; }
    Ok(())
}

#[tauri::command]
pub async fn program_capture_start(app: AppHandle, selection: ProgramCaptureSelection) -> Result<ObsStarted, AppError> {
    if !selection.valid() { return Err(AppError::invalid("Choose a screen, window or region first")); }
    let (sender, session) = service()?;
    match locked()?.choices.get(&selection.choice) {
        Some((held, kind)) if *held == session && *kind == selection.kind => {}
        _ => return Err(AppError::invalid("Choose again. macOS does not let apps keep a screen choice after Sauce Bunny or its capture helper restarts.")),
    }
    let generation = ndi::producer_generation()?;
    let room = super::super::session::ndi_room_generation(&app).await;
    let picked = ObsSelection::Picked(selection.clone());
    let (program, result, permit) = ndi::register_obs(selection.label.clone(), &picked, app, room, generation)?;
    let id = program.id.clone();
    locked()?.pending.insert(id.clone(), watch::channel(false).0);
    if sender.try_send(Op::Start { selection, program: program.clone(), permit }).is_err() {
        program.stop();
        completed(&id);
        return Err(AppError::invalid("Screen capture is busy. Try the preview again."));
    }
    Ok(ObsStarted { program: result, selection: picked })
}

/// Waits for the helper to acknowledge a program's teardown (Stop, Quit).
pub(super) async fn wait_stopped(id: &str) -> Result<(), AppError> {
    let mut done = match locked()?.pending.get(id) { Some(done) => done.subscribe(), None => return Ok(()) };
    let finished = matches!(tokio::time::timeout(Duration::from_secs(10), done.wait_for(|complete| *complete)).await, Ok(Ok(_)));
    if finished { Ok(()) } else { Err(AppError::invalid("Screen capture is still closing. Retry in a moment.")) }
}

fn completed(id: &str) {
    if let Ok(mut current) = state().lock() {
        if let Some(done) = current.pending.remove(id) { done.send_replace(true); }
    }
}

/// The helper's status codes, in the app's own words. A helper string never reaches the UI.
fn status_error(code: &str) -> &'static str {
    match code {
        "source_stopped" => "Capture stopped because the shared screen or window went away",
        "start_choice_unknown" => "Choose again. The capture helper no longer holds that choice",
        "start_invalid_region" => "The capture area is too small or outside the screen. Choose it again",
        "start_audio_unavailable" => "System audio needs macOS 14.2 or later. Turn off Include system audio",
        "start_audio_tap_failed" => "System audio could not be recorded. Allow Sauce Bunny under System Settings, Privacy and Security, Screen and System Audio Recording, then try again",
        "start_source_initialization_failed" => "macOS did not start the capture. Choose the screen again",
        "start_output_preparation_failed" | "start_output_failed" => "The capture encoder could not start",
        _ => "The capture could not start",
    }
}

struct Active {
    program: Arc<Program>, _permit: WorkerPermit, generation: u64, framer: Framer,
    progressed: Instant, ready: bool, frames: u64, fragments: u64, closing: Option<Instant>,
}
impl Active {
    fn fail(&self, message: &str) { if !self.program.is_stopped() { self.program.fail(message); } }
    /// One stdout record for this slot. True when the slot has ended.
    fn record(&mut self, kind: u8, payload: &[u8]) -> bool {
        if kind == 3 {
            if self.closing.is_none() && !self.program.is_stopped() {
                self.fail(if self.framer.finish().is_err() { "Screen capture ended inside a media fragment" } else { "Screen capture ended unexpectedly" });
            }
            return true;
        }
        if self.closing.is_some() || self.program.is_stopped() { return false; }
        if kind == 1 {
            let (program, ready, progressed, fragments) = (&self.program, &mut self.ready, &mut self.progressed, &mut self.fragments);
            if self.framer.push(payload, |part, data| {
                if part == 2 { *ready = true; *progressed = Instant::now(); *fragments = fragments.saturating_add(1); }
                program.publish(part, data);
            }).is_err() { self.fail("Screen capture returned invalid or oversized media"); }
            return false;
        }
        #[derive(Default, Deserialize)] #[serde(rename_all = "lowercase")]
        enum Action { #[default] None, Stop }
        #[derive(Deserialize)] #[serde(deny_unknown_fields)]
        struct Status { width: u32, height: u32, frames: u64, error: String, #[serde(default)] action: Action }
        let Ok(status) = serde_json::from_slice::<Status>(payload) else { self.fail("Screen capture returned invalid status"); return false; };
        if matches!(status.action, Action::Stop) { self.program.capture_stopped(); return false; }
        if !status.error.is_empty() { self.fail(status_error(&status.error)); return false; }
        if !(2..=1920).contains(&status.width) || !(2..=1080).contains(&status.height) || status.width % 2 != 0 || status.height % 2 != 0 {
            self.fail("Screen capture returned invalid dimensions"); return false;
        }
        self.frames = self.frames.max(status.frames);
        let state = NdiTelemetry { source_id: self.program.id.clone(), phase: NdiPhase::Live, input_width: status.width, input_height: status.height,
            output_fps: 30.0, received_frames: status.frames, ..NdiTelemetry::default() };
        if let Ok(bytes) = serde_json::to_vec(&state) { self.program.publish(3, &bytes); }
        false
    }
}

async fn send(input: &mut ChildStdin, value: serde_json::Value) -> bool {
    let Ok(mut bytes) = serde_json::to_vec(&value) else { return false };
    bytes.push(b'\n');
    matches!(tokio::time::timeout(Duration::from_millis(250), input.write_all(&bytes)).await, Ok(Ok(())))
}

struct Choosing { job: String, token: String, kind: ProgramCaptureKind, reply: oneshot::Sender<Result<ProgramCaptureChooseResult, AppError>> }

/// A kind-4 record, checked against the request it answers. A pick is remembered for this session only.
fn chosen(session: u64, token: &str, kind: ProgramCaptureKind, payload: &[u8]) -> Result<ProgramCaptureChooseResult, AppError> {
    #[derive(Deserialize)]
    struct Reply { choice: String, outcome: String, #[serde(default)] label: String, #[serde(default)] width: u32, #[serde(default)] height: u32 }
    let reply: Reply = serde_json::from_slice(payload).map_err(|_| AppError::invalid("The screen capture helper answered in a way this build does not understand"))?;
    if reply.choice != token { return Err(AppError::invalid("The screen capture helper answered a different request")); }
    match reply.outcome.as_str() {
        "cancelled" => Ok(ProgramCaptureChooseResult::Cancelled),
        "chosen" => {
            let label: String = reply.label.chars().filter(|c| !c.is_control()).take(160).collect();
            let label = if label.trim().is_empty() { "Screen".to_string() } else { label };
            if let Ok(mut current) = state().lock() { current.choices.insert(token.to_string(), (session, kind)); }
            Ok(ProgramCaptureChooseResult::Chosen { choice: ProgramCaptureChoice { choice: token.to_string(), kind, label, width: reply.width, height: reply.height } })
        }
        _ => Err(AppError::invalid("macOS could not show its screen picker. Try again.")),
    }
}

async fn run(path: PathBuf, mut ops: mpsc::Receiver<Op>, session: u64) {
    let mut command = tokio::process::Command::new(&path);
    command.arg("--service").env_clear().env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
    let spawned = command.spawn();
    let mut slots: [Option<Active>; 2] = [None, None];
    let mut choosing: HashMap<u64, Choosing> = HashMap::new();
    let failure = 'service: {
        let Ok(mut child) = spawned else { break 'service (None, "The screen capture helper could not start") };
        let (Some(mut input), Some(mut output), Some(mut errors)) = (child.stdin.take(), child.stdout.take(), child.stderr.take()) else {
            break 'service (Some(child), "The screen capture helper's pipes could not open");
        };
        let (mut wire, mut media, mut noise) = (Wire::default(), [0u8; 16384], [0u8; 4096]);
        let (mut generation, mut request, mut errors_open) = (0u64, 0u64, true);
        let mut heartbeat = interval(Duration::from_millis(250));
        let reason = loop {
            tokio::select! {
                op = ops.recv() => match op {
                    None => break "Screen capture closed",
                    Some(Op::Choose { job, kind, reply }) => {
                        let Ok(token) = token() else { let _ = reply.send(Err(AppError::internal("Cannot create a capture token"))); continue };
                        request += 1;
                        let message = serde_json::json!({"op": "choose", "request": request, "choice": token, "kind": kind.name()});
                        choosing.insert(request, Choosing { job, token, kind, reply });
                        if !send(&mut input, message).await { break "The screen capture helper stopped answering"; }
                    }
                    Some(Op::Cancel { job }) => {
                        let found = choosing.iter().find(|(_, choice)| choice.job == job).map(|(request, _)| *request);
                        if let Some(request) = found { if !send(&mut input, serde_json::json!({"op": "cancel", "request": request})).await { break "The screen capture helper stopped answering"; } }
                    }
                    Some(Op::Start { selection, program, permit }) => {
                        if program.is_stopped() { completed(&program.id); continue; }
                        let Some(slot) = slots.iter().position(Option::is_none) else {
                            program.fail("Screen capture is still closing. Retry the preview in a moment.");
                            completed(&program.id); continue;
                        };
                        generation += 1;
                        if generation > MAX_GENERATION { program.fail("Screen capture generation exhausted"); completed(&program.id); break "Screen capture generation exhausted"; }
                        let region = selection.region.as_ref().map(|r| serde_json::json!([r.x, r.y, r.width, r.height]));
                        let message = serde_json::json!({"op": "start", "slot": slot, "generation": generation, "choice": selection.choice,
                            "audio": selection.audio, "region": region});
                        slots[slot] = Some(Active { program, _permit: permit, generation, framer: Framer::default(), progressed: Instant::now(),
                            ready: false, frames: 0, fragments: 0, closing: None });
                        if !send(&mut input, message).await { break "The screen capture helper stopped answering"; }
                    }
                },
                _ = heartbeat.tick() => {
                    let mut stalled = false;
                    for (slot, active) in slots.iter_mut().enumerate() {
                        let Some(active) = active else { continue };
                        if active.frames.saturating_sub(active.fragments.saturating_mul(3)) > 90 { active.fail("Screen capture fell behind. Restart the preview"); }
                        if active.closing.is_none() && active.progressed.elapsed() > Duration::from_secs(if active.ready { 4 } else { 12 }) {
                            active.fail("Screen capture stopped delivering pictures");
                        }
                        if active.program.is_stopped() && active.closing.is_none() {
                            active.closing = Some(Instant::now());
                            if !send(&mut input, serde_json::json!({"op": "stop", "slot": slot, "generation": active.generation})).await { stalled = true; }
                        }
                        if active.closing.is_some_and(|at| at.elapsed() > Duration::from_secs(4)) { stalled = true; }
                    }
                    if stalled { break "Screen capture did not stop safely"; }
                    if !matches!(tokio::time::timeout(Duration::from_millis(100), input.write_all(b"P\n")).await, Ok(Ok(()))) {
                        break "The screen capture helper stopped answering";
                    }
                }
                read = output.read(&mut media) => {
                    let count = match read { Ok(0) | Err(_) => break "The screen capture helper stopped", Ok(count) => count };
                    let mut ended = Vec::new();
                    let pushed = wire.push(&media[..count], |record| {
                        if record.kind == 4 {
                            if let Some(choice) = choosing.remove(&record.generation) {
                                let _ = choice.reply.send(chosen(session, &choice.token, choice.kind, record.payload));
                            }
                            return;
                        }
                        if let Some(active) = slots.get_mut(record.slot).and_then(Option::as_mut).filter(|active| active.generation == record.generation) {
                            if active.record(record.kind, record.payload) { ended.push(record.slot); }
                        }
                    });
                    for slot in ended { if let Some(active) = slots[slot].take() { completed(&active.program.id); } }
                    if pushed.is_err() { break "The screen capture helper returned invalid records"; }
                }
                read = errors.read(&mut noise), if errors_open => {
                    // Helper diagnostics stay private and bounded; only typed stdout records change state.
                    if !matches!(read, Ok(1..)) { errors_open = false; }
                }
            }
        };
        let _ = tokio::time::timeout(Duration::from_millis(100), input.write_all(b"Q\n")).await;
        drop(input);
        (Some(child), reason)
    };
    let (child, reason) = failure;
    for active in slots.iter_mut().filter_map(Option::take) { active.fail(reason); completed(&active.program.id); }
    for (_, choice) in choosing.drain() { let _ = choice.reply.send(Err(AppError::invalid("The screen capture helper stopped. Try again."))); }
    if let Some(mut child) = child {
        if tokio::time::timeout(Duration::from_secs(3), child.wait()).await.is_err() { let _ = child.kill().await; }
    }
    // Picks lived only in that helper. Close this session so the next request starts afresh.
    if let Ok(mut current) = state().lock() {
        current.choices.retain(|_, (held, _)| *held != session);
        if current.service.as_ref().is_some_and(|service| service.session == session) { current.service = None; }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn selection(kind: ProgramCaptureKind, region: Option<ObsCrop>) -> ProgramCaptureSelection {
        ProgramCaptureSelection { choice: "0123456789abcdef0123456789abcdef".into(), kind, label: "Studio Display".into(), audio: true, region }
    }

    #[test]
    fn a_selection_needs_a_minted_token_a_label_and_a_region_only_for_region() {
        assert!(selection(ProgramCaptureKind::Screen, None).valid());
        let crop = ObsCrop { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
        assert!(selection(ProgramCaptureKind::Region, Some(crop.clone())).valid());
        assert!(!selection(ProgramCaptureKind::Region, None).valid());
        assert!(!selection(ProgramCaptureKind::Screen, Some(crop)).valid());
        assert!(!ProgramCaptureSelection { choice: "ABC".into(), ..selection(ProgramCaptureKind::Screen, None) }.valid());
        assert!(!ProgramCaptureSelection { label: "".into(), ..selection(ProgramCaptureKind::Screen, None) }.valid());
        assert!(!ProgramCaptureSelection { label: "Display\u{7}".into(), ..selection(ProgramCaptureKind::Screen, None) }.valid());
    }

    #[test]
    fn a_packaged_app_only_runs_its_own_helper() {
        let packaged = PathBuf::from("/Applications/Sauce Bunny.app/Contents/MacOS/sauce-bunny");
        assert_eq!(helper_candidate(&packaged, true, Some(PathBuf::from("/tmp/evil"))),
            Some(PathBuf::from("/Applications/Sauce Bunny.app/Contents/Helpers/Sauce Bunny Capture.app/Contents/MacOS/saucebunny-program-capture")));
        let dev = PathBuf::from("/repo/src-tauri/target/debug/sauce-bunny");
        assert_eq!(helper_candidate(&dev, true, Some(PathBuf::from("/tmp/helper"))), Some(PathBuf::from("/tmp/helper")));
        assert_eq!(helper_candidate(&dev, false, Some(PathBuf::from("/tmp/helper"))), None);
    }

    #[test]
    fn a_pick_is_remembered_only_for_its_session_and_a_cancel_is_not_an_error() {
        let token = "fedcba9876543210fedcba9876543210";
        let answer = chosen(41, token, ProgramCaptureKind::Screen, br#"{"choice":"fedcba9876543210fedcba9876543210","outcome":"chosen","kind":"screen","label":"Studio\u0007 Display","width":1920,"height":1080}"#).unwrap();
        let ProgramCaptureChooseResult::Chosen { choice } = answer else { panic!("not chosen") };
        assert_eq!((choice.label.as_str(), choice.width), ("Studio Display", 1920));
        assert_eq!(state().lock().unwrap().choices.get(token), Some(&(41, ProgramCaptureKind::Screen)));
        assert!(matches!(chosen(41, token, ProgramCaptureKind::Screen, br#"{"choice":"fedcba9876543210fedcba9876543210","outcome":"cancelled"}"#), Ok(ProgramCaptureChooseResult::Cancelled)));
        assert!(chosen(41, token, ProgramCaptureKind::Screen, br#"{"choice":"00000000000000000000000000000000","outcome":"chosen"}"#).is_err(), "an answer for a different token was accepted");
    }
}
