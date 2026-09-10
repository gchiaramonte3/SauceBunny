//! Experimental NDI receiver. Only encoded segments, never raw frames,
//! reach the webview or peer transport. A bounded ring lets slow readers skip
//! whole independent segments, never fragments of compressed frames.
use std::{collections::{HashMap, VecDeque}, io::{self, Read}, path::PathBuf,
    sync::{Arc, Condvar, Mutex, OnceLock, atomic::{AtomicBool, AtomicU64, Ordering}}, time::Duration};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
#[cfg(any(sauce_ndi, test))]
use tauri::Emitter;
use crate::AppError;

#[path = "ndi_timing.rs"]
mod timing;
pub use timing::NdiTimingProbeResult;

#[cfg(any(sauce_ndi, test))]
const MAX_SEGMENT: usize = 2 * 1024 * 1024;
#[cfg(any(sauce_ndi, test))]
// Match the decoder's eight-fragment queue: nominally 800 ms, at most 16 MiB
// plus the init. Ordinary delivery/append jitter must not become missing AAC.
const RETAINED_SEGMENTS: usize = 8;
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export,export_to="../../src/bindings/")]
pub struct NdiStarted { pub id:String, pub name:String, pub url:String }

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
#[serde(rename_all = "lowercase")]
pub enum NdiRuntimeState { Ready, #[default] Missing, Incompatible }

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
#[serde(rename_all = "lowercase")]
pub enum NdiPhase { #[default] Off, Connecting, Live, Stale, Error }

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct NdiSource { pub name: String }

#[derive(Clone, Debug, Serialize, PartialEq, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct NdiDiscoveryResult {
    pub bridge_compiled: bool,
    pub runtime: NdiRuntimeState,
    pub runtime_version: Option<String>,
    pub sources: Vec<NdiSource>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct NdiPreflightResult {
    pub bridge_compiled: bool,
    pub runtime: NdiRuntimeState,
    pub runtime_version: Option<String>,
    #[ts(type = "'bundled' | 'developer' | 'missing'")]
    pub runtime_origin: String,
    pub premiere_installed: bool,
    pub premiere_version: Option<String>,
    pub plugin_installed: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
#[serde(default, rename_all = "camelCase")]
pub struct NdiTelemetry {
    pub source_id: String,
    pub phase: NdiPhase,
    pub error: Option<String>,
    pub input_width: u32,
    pub input_height: u32,
    pub output_fps: f64,
    pub input_fps: Option<f64>,
    pub connection_count: Option<u32>,
    #[ts(type = "number")]
    pub received_frames: u64,
    #[ts(type = "number")]
    pub ndi_dropped_frames: u64,
    #[ts(type = "number")]
    pub encoder_dropped_frames: u64,
    #[ts(type = "number")]
    pub encoder_dropped_audio_samples: u64,
    pub left_peak: f64,
    pub right_peak: f64,
    #[ts(type = "number")]
    pub last_input_age_ms: u64,
    #[ts(type = "number | null")]
    pub encoded_bitrate_kbps: Option<u64>,
}

#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct NdiStatusResult {
    pub program: Option<NdiStarted>,
    pub telemetry: NdiTelemetry,
    pub encoded_ready: bool,
    #[ts(type = "number | null")]
    pub room_generation: Option<u64>,
}

#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct NdiSessionsResult {
    pub programs: Vec<NdiStatusResult>,
    pub room: Option<NdiRoomState>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
#[serde(rename_all = "lowercase")]
pub enum NdiPublicationState { Live, Stopped }

#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct NdiRoomProgram {
    pub id: String,
    pub name: String,
    pub review_key: String,
    pub state: NdiPublicationState,
}

#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct NdiRoomState {
    #[ts(type = "number")]
    pub generation: u64,
    pub presenter_epoch: u32,
    pub presenting: bool,
    pub published_id: Option<String>,
    #[ts(type = "number | null")]
    pub publication_revision: Option<u64>,
    pub source: Option<NdiRoomProgram>,
}

#[cfg(sauce_ndi)]
#[derive(Deserialize)]
struct NativeDiscoveryResult {
    available: bool,
    #[serde(default)]
    version: Option<String>,
    #[serde(default)]
    sources: Vec<NdiSource>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Default)]
struct Buffer {
    init: Option<Arc<[u8]>>,
    segments: VecDeque<(u64, Arc<[u8]>)>,
    // Only the SDK receiver (or its test publisher) allocates segment ids.
    #[cfg(any(sauce_ndi, test))]
    next: u64,
    status: NdiTelemetry,
    telemetry: Option<Arc<[u8]>>,
    status_seq: u64,
}
pub struct Program {
    pub id: String,
    pub name: String,
    stopped: AtomicBool,
    // Zero is standalone preview. Session generations are stored plus one.
    room: AtomicU64,
    publication_revision: AtomicU64,
    buffer: Mutex<Buffer>,
    // Diagnostic-only: never included in ProgramReader's peer media records.
    timing: Mutex<Option<timing::Probe>>,
    changed: Condvar,
    #[cfg(any(sauce_ndi, test))]
    app: Option<AppHandle>,
}
impl Program {
    #[cfg(any(sauce_ndi, test))]
    pub(super) fn new(id: String, name: String, app: Option<AppHandle>) -> Arc<Self> {
        let status = NdiTelemetry { source_id: id.clone(), phase: NdiPhase::Connecting, ..NdiTelemetry::default() };
        Arc::new(Self { id, name, stopped: AtomicBool::new(false), room: AtomicU64::new(0), publication_revision:AtomicU64::new(0), buffer: Mutex::new(Buffer { status, ..Buffer::default() }), timing: Mutex::new(None), changed: Condvar::new(), app })
    }
    #[cfg(any(sauce_ndi, test))]
    pub(super) fn publish(&self, kind: i32, data: &[u8]) {
        if self.stopped.load(Ordering::Relaxed) { return; }
        if kind == 4 {
            if let Ok(mut probe) = self.timing.lock() {
                if let Some(probe) = probe.as_mut() { probe.accept(data, std::time::Instant::now()); }
            }
            return;
        }
        if data.len() > MAX_SEGMENT { self.fail("Encoded NDI segment exceeded the 2 MiB safety limit"); return; }
        if kind == 3 {
            let Ok(mut state) = serde_json::from_slice::<NdiTelemetry>(data) else {
                self.fail("NDI returned invalid telemetry");
                return;
            };
            state.source_id = self.id.clone();
            if let Ok(mut b) = self.buffer.lock() {
                b.status = state.clone(); b.status_seq+=1;
                b.telemetry=serde_json::to_vec(&state).ok().map(Arc::from);
            }
            if let Some(app) = &self.app { let _ = app.emit("ndi:state", &state); }
        } else if matches!(kind, 1 | 2) {
            if let Ok(mut b) = self.buffer.lock() {
                if kind == 1 { b.init = Some(Arc::from(data)); }
                else {
                    let seq = b.next; b.next += 1;
                    b.segments.push_back((seq, Arc::from(data)));
                    while b.segments.len() > RETAINED_SEGMENTS { b.segments.pop_front(); }
                }
            }
        }
        self.changed.notify_all();
    }
    #[cfg(any(sauce_ndi, test))]
    fn fail(&self, message: &str) {
        let state = NdiTelemetry { source_id:self.id.clone(), phase:NdiPhase::Error,
            error:Some(message.to_string()), ..NdiTelemetry::default() };
        if let Ok(mut b) = self.buffer.lock() {
            b.status = state.clone(); b.status_seq+=1;
            b.telemetry=serde_json::to_vec(&state).ok().map(Arc::from);
        }
        if let Some(app) = &self.app { let _ = app.emit("ndi:state", state); }
        self.stop();
    }
    fn stop(&self) {
        self.stopped.store(true, Ordering::Release);
        if let Ok(mut probe) = self.timing.lock() {
            if let Some(probe) = probe.as_mut() { probe.stop(true); }
        }
        self.changed.notify_all();
    }
    #[cfg(any(sauce_ndi, test))]
    fn timing_token(&self) -> u64 {
        if self.stopped.load(Ordering::Acquire) { return 0; }
        self.timing.lock().ok().and_then(|mut probe| probe.as_mut().map(|probe|probe.token(std::time::Instant::now()))).unwrap_or(0)
    }
    pub(crate) fn encoded_ready(&self) -> bool {
        !self.stopped.load(Ordering::Acquire) && self.buffer.lock()
            .map(|b| b.init.is_some() && !b.segments.is_empty()).unwrap_or(false)
    }
    pub(crate) fn bind_room(&self, generation: u64) { self.room.store(generation + 1, Ordering::Release); }
    fn snapshot(&self, base: &str) -> NdiStatusResult {
        let b = self.buffer.lock().unwrap_or_else(|e| e.into_inner());
        NdiStatusResult {
            program: Some(NdiStarted { id:self.id.clone(), name:self.name.clone(), url:format!("{base}/program/v1/{}", self.id) }),
            telemetry: b.status.clone(),
            encoded_ready: !self.stopped.load(Ordering::Acquire) && b.init.is_some() && !b.segments.is_empty(),
            room_generation: self.room.load(Ordering::Acquire).checked_sub(1),
        }
    }
}

/// Native capacity is bounded even if multiple renderer requests race. A
/// cancelled start may not repopulate the registry after a room teardown.
#[derive(Default)]
struct Programs { entries: HashMap<String, Arc<Program>>, generation: u64 }
impl Programs {
    #[cfg(any(sauce_ndi, test))]
    fn insert(&mut self, program: Arc<Program>, generation: u64) -> Result<(), AppError> {
        if self.generation != generation { return Err(AppError::invalid("NDI preview was cancelled")); }
        self.entries.retain(|_, p| !p.stopped.load(Ordering::Acquire));
        if self.entries.len() >= 2 { return Err(AppError::invalid("A shared source and a private preview are already running. Cancel the preview before choosing another source.")); }
        self.entries.insert(program.id.clone(), program);
        Ok(())
    }
    fn stop(&mut self, id: &str) -> Result<(), AppError> {
        if self.entries.get(id).is_some_and(|p|p.publication_revision.load(Ordering::Acquire)!=0) {
            return Err(AppError::invalid("Stop sharing this source before disconnecting it"));
        }
        if let Some(p) = self.entries.remove(id) { p.stop(); }
        Ok(())
    }
    fn stop_room(&mut self, generation: u64) {
        self.generation += 1;
        self.entries.retain(|_, p| {
            if p.room.load(Ordering::Acquire) == generation + 1 { p.stop(); false } else { true }
        });
    }
}
fn programs() -> &'static Mutex<Programs> { static VALUE: OnceLock<Mutex<Programs>> = OnceLock::new(); VALUE.get_or_init(|| Mutex::new(Programs::default())) }

#[cfg(any(sauce_ndi, test))]
struct WorkerPermit;
#[cfg(any(sauce_ndi, test))]
static NATIVE_WORKERS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
#[cfg(any(sauce_ndi, test))]
impl WorkerPermit {
    fn acquire() -> Result<Self, AppError> {
        NATIVE_WORKERS.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n|(n<2).then_some(n+1))
            .map(|_|Self).map_err(|_|AppError::invalid("An NDI receiver is still closing. Retry the preview in a moment. The shared feed is unchanged."))
    }
}
#[cfg(any(sauce_ndi, test))]
impl Drop for WorkerPermit { fn drop(&mut self) { NATIVE_WORKERS.fetch_sub(1,Ordering::SeqCst); } }

/// A receiver existing is NOT permission to fetch it. Each publication has a
/// revocable lease owned by exactly one host room and presenter epoch.
pub(crate) struct ProgramPublication {
    pub program: Arc<Program>,
    pub room_generation: u64,
    pub presenter_epoch: u64,
    pub revision: u64,
    active: AtomicBool,
    revoked: tokio::sync::Notify,
}
impl ProgramPublication {
    pub(crate) fn new(program: Arc<Program>, room_generation: u64, presenter_epoch: u64) -> Arc<Self> {
        static NEXT_REVISION: AtomicU64 = AtomicU64::new(1);
        program.bind_room(room_generation);
        let revision=NEXT_REVISION.fetch_add(1,Ordering::Relaxed);
        program.publication_revision.store(revision,Ordering::Release);
        Arc::new(Self { program, room_generation, presenter_epoch, revision, active:AtomicBool::new(true), revoked:tokio::sync::Notify::new() })
    }
    pub(crate) fn active(&self) -> bool { self.active.load(Ordering::Acquire) }
    pub(crate) fn revoke(&self) {
        self.active.store(false, Ordering::Release);
        let _=self.program.publication_revision.compare_exchange(self.revision,0,Ordering::AcqRel,Ordering::Acquire);
        self.program.changed.notify_all();
        self.revoked.notify_waiters();
    }
    pub(crate) async fn cancelled(&self) {
        // Register before checking to avoid losing a concurrent revoke.
        let notified = self.revoked.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        if self.active() { notified.await; }
    }
}
fn runtime_choice() -> &'static Mutex<Option<PathBuf>> { static VALUE: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new(); VALUE.get_or_init(|| Mutex::new(None)) }
#[cfg(sauce_ndi)]
fn runtime_path() -> Option<PathBuf> {
    let explicit = runtime_choice().lock().ok().and_then(|v| v.clone());
    runtime_candidates(bundled_runtime(),cfg!(debug_assertions),explicit, std::env::var_os("NDI_RUNTIME_DIR_V6"),
        cfg!(debug_assertions).then_some(option_env!("SAUCE_NDI_DEV_RUNTIME")).flatten())
        .into_iter().find(|p| p.is_file())
}
fn bundled_runtime() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let macos = exe.parent()?;
    if macos.file_name()? != "MacOS" || macos.parent()?.file_name()? != "Contents" { return None; }
    Some(macos.parent()?.join("Frameworks/libndi.dylib"))
}
#[cfg(any(sauce_ndi, test))]
fn runtime_candidates(bundled:Option<PathBuf>, developer_build:bool, explicit:Option<PathBuf>, environment:Option<std::ffi::OsString>, developer:Option<&str>) -> Vec<PathBuf> {
    // Missing/corrupt packaged runtime is a broken installation, not consent
    // to load a different user's/system library. Even debug .app bundles use
    // their own runtime; overrides apply only to unbundled developer builds.
    if let Some(path) = bundled { return vec![path]; }
    if !developer_build { return Vec::new(); }
    explicit.into_iter()
        .chain(environment.map(PathBuf::from).map(|p|p.join("libndi.dylib")))
        .chain([PathBuf::from("/usr/local/lib/libndi.dylib"),
            // NDI Tools 6.3.2 installs the standard runtime with its Adobe
            // transmitter, not at /usr/local/lib. This is a developer-only
            // fallback, never the source of our packaged runtime.
            PathBuf::from("/Library/Application Support/Adobe/Common/Plug-ins/7.0/MediaCore/NDI_Transmit_AdobeCC.bundle/Contents/Frameworks/libndi.dylib"),
            PathBuf::from("/Library/NDI SDK for Apple/lib/macOS/libndi.dylib")])
        .chain(developer.map(PathBuf::from))
        .collect()
}
pub fn find_program(id: &str) -> Option<Arc<Program>> { programs().lock().ok()?.entries.get(id).filter(|p| !p.stopped.load(Ordering::Acquire)).cloned() }
pub(crate) fn stop_room(generation: u64) { if let Ok(mut all) = programs().lock() { all.stop_room(generation); } }
pub fn stop_all() {
    if let Ok(mut all) = programs().lock() {
        all.generation += 1;
        for (_, p) in all.entries.drain() { p.stop(); }
    }
}

#[cfg(sauce_ndi)]
mod native {
    use super::*;
    use std::ffi::{c_char, c_void, CStr, CString};
    extern "C" {
        fn sauce_ndi_query(path: *const c_char, discover: bool) -> *mut c_char;
        fn sauce_ndi_free(value: *mut c_char);
        fn sauce_ndi_run_with_timing(path: *const c_char, name: *const c_char, context: *mut c_void,
            emit: extern "C" fn(*mut c_void, i32, *const u8, usize), stop: extern "C" fn(*mut c_void) -> bool,
            timing: extern "C" fn(*mut c_void) -> u64);
    }
    pub(super) fn query(path: &std::path::Path, discover: bool) -> Result<NativeDiscoveryResult, String> {
        let path = CString::new(path.to_string_lossy().as_bytes()).map_err(|_| "Invalid runtime path".to_string())?;
        // Bridge owns its C string; copy before freeing with its allocator.
        unsafe {
            let data = sauce_ndi_query(path.as_ptr(), discover);
            if data.is_null() { return Err("NDI query failed".to_string()); }
            let result = serde_json::from_slice(CStr::from_ptr(data).to_bytes())
                .map_err(|_| "NDI returned an invalid discovery response".to_string());
            sauce_ndi_free(data); result
        }
    }
    extern "C" fn emit(context: *mut c_void, kind: i32, data: *const u8, len: usize) {
        // Arc remains held by run's caller. Native teardown drains/disables its
        // segment delegate before returning. No Rust panic may cross C++.
        let _ = std::panic::catch_unwind(|| unsafe {
            if !data.is_null() && len <= MAX_SEGMENT { (&*(context as *const Program)).publish(kind, std::slice::from_raw_parts(data,len)); }
            else if len > MAX_SEGMENT && kind != 4 { (&*(context as *const Program)).fail("NDI segment is too large"); }
        });
    }
    extern "C" fn stop(context: *mut c_void) -> bool { unsafe { (&*(context as *const Program)).stopped.load(Ordering::Relaxed) } }
    extern "C" fn timing(context: *mut c_void) -> u64 {
        std::panic::catch_unwind(|| unsafe { (&*(context as *const Program)).timing_token() }).unwrap_or(0)
    }
    pub fn run(path: PathBuf, program: Arc<Program>) {
        let Ok(path) = CString::new(path.to_string_lossy().as_bytes()) else { program.fail("Invalid runtime path"); return; };
        let Ok(name) = CString::new(program.name.as_bytes()) else { program.fail("Invalid source name"); return; };
        unsafe { sauce_ndi_run_with_timing(path.as_ptr(),name.as_ptr(),Arc::as_ptr(&program) as *mut c_void,emit,stop,timing); }
        program.stop();
    }
}

#[tauri::command]
pub async fn ndi_discover() -> Result<NdiDiscoveryResult, AppError> {
    ndi_query(true).await
}

async fn ndi_query(discover: bool) -> Result<NdiDiscoveryResult, AppError> {
    #[cfg(not(sauce_ndi))]
    { let _ = discover; Ok(NdiDiscoveryResult { bridge_compiled:false, runtime:NdiRuntimeState::Missing,
        runtime_version:None, sources:Vec::new(),
        error:Some("This Sauce Bunny build does not include Premiere input. Install a build with NDI support.".into()) }) }
    #[cfg(sauce_ndi)] {
        let Some(path) = runtime_path() else { return Ok(NdiDiscoveryResult { bridge_compiled:true,
            runtime:NdiRuntimeState::Missing, runtime_version:None, sources:Vec::new(),
            error:Some(if cfg!(debug_assertions) { "NDI runtime not found. Configure the developer SDK runtime." } else { "Sauce Bunny's bundled NDI runtime is missing. Reinstall Sauce Bunny." }.into()) }); };
        let result = tokio::task::spawn_blocking(move || native::query(&path,discover)).await
            .map_err(|e| AppError::invalid(e.to_string()))?;
        Ok(match result {
            Ok(value) if value.available => NdiDiscoveryResult { bridge_compiled:true,
                runtime:NdiRuntimeState::Ready, runtime_version:value.version,
                sources:value.sources, error:value.error },
            Ok(value) => NdiDiscoveryResult { bridge_compiled:true,
                runtime:NdiRuntimeState::Incompatible, runtime_version:value.version,
                sources:Vec::new(), error:value.error.or_else(||Some("NDI runtime initialization failed".into())) },
            Err(error) => NdiDiscoveryResult { bridge_compiled:true,
                runtime:NdiRuntimeState::Incompatible, runtime_version:None,
                sources:Vec::new(), error:Some(error) },
        })
    }
}

#[tauri::command]
pub async fn ndi_preflight() -> Result<NdiPreflightResult, AppError> {
    // Called only from Premiere setup, never on guest startup or room join.
    let runtime=ndi_query(false).await?;
    let app=PathBuf::from("/Applications/Adobe Premiere Pro 2026/Adobe Premiere Pro 2026.app");
    let version=plist::Value::from_file(app.join("Contents/Info.plist")).ok()
        .and_then(|v|v.as_dictionary().and_then(|d|d.get("CFBundleShortVersionString")).and_then(|v|v.as_string()).map(str::to_owned));
    let plugin=PathBuf::from("/Library/Application Support/Adobe/Common/Plug-ins/7.0/MediaCore/NDI_Transmit_AdobeCC.bundle");
    let premiere_installed=installation_directory(&app,"Premiere application")?;
    let plugin_installed=installation_directory(&plugin,"Premiere output plugin")?;
    Ok(NdiPreflightResult {
        bridge_compiled:runtime.bridge_compiled, runtime:runtime.runtime, runtime_version:runtime.runtime_version,
        runtime_origin:if bundled_runtime().is_some_and(|p|p.is_file()) { "bundled" } else if runtime.runtime!=NdiRuntimeState::Missing { "developer" } else { "missing" }.into(),
        premiere_installed, premiere_version:version, plugin_installed, error:runtime.error,
    })
}

// Path::is_dir collapses permission and other I/O failures into false. Only a
// successful inspection or NotFound may support an installation claim.
fn installation_directory(path: &std::path::Path, label: &str) -> Result<bool, AppError> {
    installation_observation(std::fs::metadata(path), label)
}

fn installation_observation(result: io::Result<std::fs::Metadata>, label: &str) -> Result<bool, AppError> {
    match result {
        Ok(metadata) => Ok(metadata.is_dir()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(AppError::Io(format!("Cannot inspect the {label}: {error}"))),
    }
}

/// Explicit user-selected SDK folder or libndi.dylib; no remote path or
/// automatically discovered library is loaded from a network message.
#[tauri::command]
pub async fn ndi_set_runtime(path: String) -> Result<NdiDiscoveryResult, AppError> {
    if !cfg!(debug_assertions) || bundled_runtime().is_some() {
        return Err(AppError::invalid("Runtime overrides are available only in unbundled developer builds"));
    }
    let root = PathBuf::from(path);
    let library = if root.is_dir() { root.join("lib/macOS/libndi.dylib") } else { root };
    let library = library.canonicalize().map_err(|_| AppError::invalid("Choose the NDI SDK for Apple folder or libndi.dylib"))?;
    if library.file_name().and_then(|p|p.to_str()) != Some("libndi.dylib") { return Err(AppError::invalid("Expected libndi.dylib")); }
    *runtime_choice().lock().map_err(|_| AppError::invalid("Runtime state unavailable"))? = Some(library);
    ndi_discover().await
}

#[tauri::command]
pub async fn ndi_start(app: AppHandle, name: String) -> Result<NdiStarted, AppError> {
    if name.trim().is_empty() || name.len() > 1024 || name.contains('\0') { return Err(AppError::invalid("Select a discovered NDI source")); }
    #[cfg(not(sauce_ndi))] { let _ = app; Err(AppError::invalid("Native NDI support is not compiled into this build")) }
    #[cfg(sauce_ndi)] {
        let generation = programs().lock().map_err(|_| AppError::invalid("Program state unavailable"))?.generation;
        let room = super::session::ndi_room_generation(&app).await;
        let path = runtime_path().ok_or_else(|| AppError::invalid("NDI runtime is missing"))?;
        let base = crate::stream_proxy::base_url().ok_or_else(|| AppError::invalid("Program media proxy is not running"))?;
        let mut id = [0u8; 16]; getrandom::getrandom(&mut id).map_err(|_| AppError::invalid("Cannot create source identity"))?;
        let program = Program::new(hex::encode(id), name, Some(app));
        if let Some(room) = room { program.bind_room(room); }
        let result = NdiStarted{id:program.id.clone(),name:program.name.clone(),url:format!("{base}/program/v1/{}",program.id)};
        // Retain capacity until the worker has actually drained, not just
        // until its cancelled entry disappears from the UI registry.
        let permit=WorkerPermit::acquire()?;
        programs().lock().map_err(|_| AppError::invalid("Program state unavailable"))?.insert(program.clone(), generation)?;
        if let Err(error) = std::thread::Builder::new().name("ndi-program".into()).spawn(move || { let _permit=permit; native::run(path,program); }) {
            let _=stop_program(&result.id);
            return Err(AppError::invalid(error.to_string()));
        }
        Ok(result)
    }
}
#[tauri::command]
pub async fn ndi_stop(app: AppHandle, id: String) -> Result<(), AppError> {
    super::session::ndi_stop_local(&app, &id).await
}
pub(super) fn stop_program(id: &str) -> Result<(), AppError> {
    programs().lock().map_err(|_|AppError::internal("Program state unavailable"))?.stop(id)
}
#[tauri::command]
pub fn ndi_status(id: Option<String>) -> NdiStatusResult {
    let base = crate::stream_proxy::base_url().unwrap_or_default();
    programs().lock().ok().and_then(|all| {
        // Compatibility with the previous single-program UI, without choosing
        // an arbitrary session once a private preview and a feed coexist.
        let p = id.as_ref().and_then(|id|all.entries.get(id)).or_else(||
            (id.is_none() && all.entries.len()==1).then(||all.entries.values().next()).flatten());
        p.map(|p|p.snapshot(&base))
    }).unwrap_or(NdiStatusResult { program:None, telemetry:NdiTelemetry::default(), encoded_ready:false, room_generation:None })
}
#[tauri::command]
pub async fn ndi_sessions(app: AppHandle) -> NdiSessionsResult {
    let room = super::session::ndi_room_state(&app).await;
    let base = crate::stream_proxy::base_url().unwrap_or_default();
    NdiSessionsResult { programs: programs().lock().map(|all|all.entries.values().map(|p|p.snapshot(&base)).collect()).unwrap_or_default(), room }
}

/// Explicit local diagnostic capture. Does not connect a source, restart the
/// receiver, alter its timestamp cadence, or transmit observations to peers.
#[tauri::command]
pub fn ndi_timing_probe_start(id: String, duration_seconds: Option<u32>) -> Result<NdiTimingProbeResult, AppError> {
    let program = timing_program(&id)?;
    let mut probe = program.timing.lock().map_err(|_|AppError::internal("Timing capture unavailable"))?;
    if program.stopped.load(Ordering::Acquire) { return Err(AppError::invalid("The selected NDI input has stopped")); }
    let now = std::time::Instant::now();
    let mut next = timing::Probe::start(duration_seconds, now)?;
    let result = next.snapshot(&id, None, now);
    *probe = Some(next);
    Ok(result)
}

#[tauri::command]
pub fn ndi_timing_probe_read(id: String, probe_id: String, after_sequence: Option<u32>) -> Result<NdiTimingProbeResult, AppError> {
    let program = timing_program(&id)?;
    let mut state = program.timing.lock().map_err(|_|AppError::internal("Timing capture unavailable"))?;
    let probe = matching_probe(&mut state, &probe_id)?;
    Ok(probe.snapshot(&id, after_sequence, std::time::Instant::now()))
}

#[tauri::command]
pub fn ndi_timing_probe_stop(id: String, probe_id: String) -> Result<NdiTimingProbeResult, AppError> {
    let program = timing_program(&id)?;
    let mut state = program.timing.lock().map_err(|_|AppError::internal("Timing capture unavailable"))?;
    let probe = matching_probe(&mut state, &probe_id)?;
    probe.stop(program.stopped.load(Ordering::Acquire));
    Ok(probe.snapshot(&id, None, std::time::Instant::now()))
}

fn timing_program(id: &str) -> Result<Arc<Program>, AppError> {
    if !cfg!(sauce_ndi) { return Err(AppError::invalid("This build does not include the native NDI timing probe")); }
    programs().lock().map_err(|_|AppError::internal("NDI input state unavailable"))?
        .entries.get(id).cloned().ok_or_else(||AppError::invalid("Select a running local NDI input before capturing timing"))
}

fn matching_probe<'a>(state: &'a mut Option<timing::Probe>, probe_id: &str) -> Result<&'a mut timing::Probe, AppError> {
    state.as_mut().filter(|probe|probe.matches(probe_id))
        .ok_or_else(||AppError::invalid("This timing capture has ended or was replaced. Start a new capture."))
}

pub fn valid_program_id(id: &str) -> bool { id.len()==32 && id.bytes().all(|c|c.is_ascii_hexdigit()) }
#[tauri::command]
pub fn ndi_remote_source(id: String) -> Result<String, AppError> {
    if !valid_program_id(&id) { return Err(AppError::invalid("Invalid live source identity")); }
    let base=crate::stream_proxy::base_url().ok_or_else(||AppError::invalid("Program proxy unavailable"))?;
    Ok(format!("{base}/program-remote/v1/{id}"))
}

/// Framed binary protocol: kind u8 (1 init, 2 complete media), length u32 BE,
/// payload. Every media record begins at an independently decodable boundary.
pub struct ProgramReader { program: Arc<Program>, publication: Option<Arc<ProgramPublication>>, initialized: bool, after: Option<u64>, bytes: Arc<[u8]>, offset: usize, status_seq:u64 }
impl ProgramReader {
    pub fn new(program: Arc<Program>) -> Self { Self { program, publication:None, initialized:false, after:None, bytes:Arc::from([]), offset:0, status_seq:0 } }
    pub(crate) fn remote(publication: Arc<ProgramPublication>) -> Self {
        Self { publication:Some(publication.clone()), ..Self::new(publication.program.clone()) }
    }
    fn revoked(&self) -> bool { self.publication.as_ref().is_some_and(|p|!p.active()) }
    fn next(&mut self) -> io::Result<bool> {
        let mut b = self.program.buffer.lock().map_err(|_| io::Error::other("Program lock unavailable"))?;
        let deadline=std::time::Instant::now()+Duration::from_secs(10);
        loop {
            if self.revoked() { return Ok(false); }
            if self.program.stopped.load(Ordering::Relaxed) && self.status_seq==b.status_seq { return Ok(false); }
            if std::time::Instant::now()>=deadline { return Err(io::Error::new(io::ErrorKind::TimedOut,"No encoded NDI frames arrived")); }
            let record = if self.status_seq!=b.status_seq { self.status_seq=b.status_seq;b.telemetry.clone().map(|data|(3,data,None)) }
                else if !self.initialized { b.init.clone().map(|data|(1,data,None)) }
                else {
                    // Preserve continuity whenever the next segment is still
                    // retained. The old two-fragment freshness cutoff punched
                    // holes after ordinary ~300 ms delivery delays. Only a new
                    // reader or an actual ring overrun jumps to the live edge.
                    let next = b.segments.iter().find(|(seq,_)| self.after.is_some_and(|a|*seq==a+1));
                    let latest = b.segments.back();
                    let chosen = next.or(latest);
                    chosen.filter(|(seq,_)|self.after.is_none_or(|a|*seq>a)).map(|(seq,data)|(2,data.clone(),Some(*seq)))
                };
            if let Some((kind,data,seq)) = record {
                let mut packet = Vec::with_capacity(5+data.len()); packet.push(kind); packet.extend_from_slice(&(data.len() as u32).to_be_bytes()); packet.extend_from_slice(&data);
                self.bytes = Arc::from(packet);
                self.offset = 0;
                if kind == 1 { self.initialized = true; }
                if let Some(seq) = seq { self.after = Some(seq); }
                return Ok(true);
            }
            b = self.program.changed.wait_timeout(b,Duration::from_secs(1)).map_err(|_|io::Error::other("Program wait failed"))?.0;
        }
    }
}
impl Read for ProgramReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        if out.is_empty() || self.revoked() { return Ok(0); }
        if self.offset==self.bytes.len() && !self.next()? { return Ok(0); }
        let len = out.len().min(self.bytes.len()-self.offset); out[..len].copy_from_slice(&self.bytes[self.offset..self.offset+len]); self.offset+=len; Ok(len)
    }
}

#[cfg(test)] mod tests {
    use super::*;
    struct InstallationFixture(PathBuf);
    impl InstallationFixture {
        fn new() -> Self {
            let path=std::env::temp_dir().join(format!("sb-ndi-preflight-{}",uuid::Uuid::new_v4()));
            std::fs::create_dir(&path).unwrap();Self(path)
        }
        fn path(&self) -> &std::path::Path { &self.0 }
    }
    impl Drop for InstallationFixture {
        fn drop(&mut self) { let _=std::fs::remove_dir_all(&self.0); }
    }
    #[test] fn preflight_distinguishes_present_missing_and_non_directory_installations() {
        let root=InstallationFixture::new();
        let plugin=root.path().join("NDI_Transmit_AdobeCC.bundle");
        assert!(!installation_directory(&plugin,"Premiere output plugin").unwrap());
        std::fs::create_dir(&plugin).unwrap();
        assert!(installation_directory(&plugin,"Premiere output plugin").unwrap());
        let ordinary_file=root.path().join("not-a-plugin");
        std::fs::write(&ordinary_file,b"not a bundle").unwrap();
        assert!(!installation_directory(&ordinary_file,"Premiere output plugin").unwrap());
    }
    #[cfg(unix)]
    #[test] fn preflight_follows_an_installed_bundle_symlink() {
        let root=InstallationFixture::new();
        let bundle=root.path().join("installed.bundle");std::fs::create_dir(&bundle).unwrap();
        let link=root.path().join("NDI_Transmit_AdobeCC.bundle");
        std::os::unix::fs::symlink(&bundle,&link).unwrap();
        assert!(installation_directory(&link,"Premiere output plugin").unwrap());
    }
    #[test] fn preflight_reports_unreadable_installation_as_an_error_not_missing() {
        // Deterministic even in a root-run CI process where chmod cannot deny
        // metadata access. These are the actual filesystem result variants.
        for kind in [io::ErrorKind::PermissionDenied,io::ErrorKind::Interrupted,io::ErrorKind::Other] {
            let result=installation_observation(Err(io::Error::from(kind)),"Premiere output plugin");
            assert!(matches!(result,Err(AppError::Io(message)) if message.contains("Cannot inspect the Premiere output plugin")));
        }
        assert!(!installation_observation(Err(io::Error::from(io::ErrorKind::NotFound)),"Premiere output plugin").unwrap());
    }
    #[test] fn timing_probe_is_opt_in_source_scoped_and_never_a_peer_media_record() {
        let source=Program::new("source".into(),"Premiere".into(),None);
        let other=Program::new("other".into(),"Second Premiere".into(),None);
        assert_eq!(source.timing_token(),0); assert_eq!(other.timing_token(),0);
        let now=std::time::Instant::now();
        *source.timing.lock().unwrap()=Some(timing::Probe::start(None,now).unwrap());
        let first=source.timing_token();assert_ne!(first,0);assert_eq!(other.timing_token(),0);
        source.publish(4,&vec![0;timing::MAX_PACKET_BYTES+1]);
        assert!(!source.stopped.load(Ordering::Acquire));
        assert!(source.buffer.lock().unwrap().telemetry.is_none());
        assert!(source.buffer.lock().unwrap().segments.is_empty());
        *source.timing.lock().unwrap()=Some(timing::Probe::start(None,now).unwrap());
        assert!(matching_probe(&mut source.timing.lock().unwrap(),&first.to_string()).is_err());
        assert_ne!(source.timing_token(),0);
        source.publish(1,b"init");let mut reader=ProgramReader::new(source.clone());
        let mut bytes=[0;9];reader.read_exact(&mut bytes).unwrap();assert_eq!(bytes[0],1);assert_eq!(&bytes[5..],b"init");
        source.stop();assert_eq!(source.timing_token(),0);assert_eq!(other.timing_token(),0);
        assert_eq!(source.timing.lock().unwrap().as_mut().unwrap().snapshot("source",None,now).phase,timing::NdiTimingProbePhase::SourceStopped);
    }
    #[test] fn cancelled_workers_keep_capacity_until_their_native_teardown_finishes() {
        let a=WorkerPermit::acquire().unwrap();let b=WorkerPermit::acquire().unwrap();
        assert!(WorkerPermit::acquire().is_err());drop(a);
        let replacement=WorkerPermit::acquire().unwrap();assert!(WorkerPermit::acquire().is_err());
        drop(b);drop(replacement);
        assert_eq!(NATIVE_WORKERS.load(Ordering::SeqCst),0);
    }
    #[test] fn private_candidate_capacity_and_scoped_stop_preserve_the_published_receiver() {
        let mut all=Programs::default();
        let shared=Program::new("shared".into(),"Premiere A".into(),None);
        let preview=Program::new("private".into(),"Premiere B".into(),None);
        all.insert(shared.clone(),0).unwrap(); all.insert(preview.clone(),0).unwrap();
        assert!(all.insert(Program::new("third".into(),"Third".into(),None),0).is_err());
        all.stop("private").unwrap();
        assert!(preview.stopped.load(Ordering::Acquire));
        assert!(!shared.stopped.load(Ordering::Acquire));
        all.insert(Program::new("next".into(),"Next".into(),None),0).unwrap();
        all.stop("private").unwrap(); assert!(all.entries.contains_key("next"));
    }
    #[test] fn a_private_cancel_cannot_stop_a_published_source_even_if_the_same_session_was_reused() {
        let mut all=Programs::default();let p=Program::new("shared".into(),"Premiere".into(),None);
        all.insert(p.clone(),0).unwrap();
        let first=ProgramPublication::new(p.clone(),1,0);
        assert!(all.stop("shared").is_err());assert!(!p.stopped.load(Ordering::Acquire));
        let newer=ProgramPublication::new(p.clone(),1,0);first.revoke();
        assert!(all.stop("shared").is_err());
        newer.revoke();all.stop("shared").unwrap();assert!(p.stopped.load(Ordering::Acquire));
    }
    #[test] fn room_teardown_preserves_standalone_preview_and_cancels_pending_starts() {
        let mut all=Programs::default();
        let local=Program::new("local".into(),"Local".into(),None);
        let room=Program::new("room".into(),"Room".into(),None);room.bind_room(7);
        all.insert(local.clone(),0).unwrap();all.insert(room.clone(),0).unwrap();
        all.stop_room(7);
        assert!(!local.stopped.load(Ordering::Acquire));assert!(room.stopped.load(Ordering::Acquire));
        assert!(all.insert(Program::new("stale".into(),"Late".into(),None),0).is_err());
    }
    #[test] fn revoked_remote_reader_cannot_drain_already_buffered_bytes_but_local_preview_continues() {
        let p=Program::new("program".into(),"Premiere".into(),None);p.publish(1,b"init");p.publish(2,b"segment");
        let permission=ProgramPublication::new(p.clone(),1,0);
        let mut remote=ProgramReader::remote(permission.clone());let mut byte=[0];
        remote.read_exact(&mut byte).unwrap();permission.revoke();
        assert_eq!(remote.read(&mut byte).unwrap(),0);
        let mut local=ProgramReader::new(p.clone());local.read_exact(&mut byte).unwrap();assert_eq!(byte,[1]);
        assert!(p.encoded_ready());
    }
    #[tokio::test] async fn revocation_wakes_waiters_and_cannot_be_lost_before_subscription() {
        let p=Program::new("program".into(),"Premiere".into(),None);
        let lease=ProgramPublication::new(p,1,0);
        let waiting=lease.clone();let task=tokio::spawn(async move { waiting.cancelled().await; });
        lease.revoke();
        tokio::time::timeout(Duration::from_millis(100),task).await.unwrap().unwrap();
        tokio::time::timeout(Duration::from_millis(100),lease.cancelled()).await.unwrap();
    }
    #[test] fn a_revoked_publication_does_not_authorize_a_new_lease_for_the_same_source() {
        let p=Program::new("program".into(),"Premiere".into(),None);
        let first=ProgramPublication::new(p.clone(),1,0);first.revoke();
        let next=ProgramPublication::new(p,1,0);
        assert_ne!(first.revision,next.revision);assert!(!first.active());assert!(next.active());
    }
    #[test] fn slow_readers_skip_complete_segments_and_keep_the_init() {
        let p=Program::new("test".into(),"Synthetic".into(),None);
        p.publish(1,b"init"); for i in 0..20 { p.publish(2,&[i]); }
        assert_eq!(p.buffer.lock().unwrap().segments.len(),RETAINED_SEGMENTS);
        let mut r=ProgramReader::new(p.clone()); let mut out=[0;9]; r.read_exact(&mut out).unwrap(); assert_eq!(&out[5..],b"init");
        let mut out=[0;6]; r.read_exact(&mut out).unwrap(); assert_eq!(out[0],2); assert_eq!(out[5],19);
        p.stop(); assert_eq!(r.read(&mut out).unwrap(),0);
    }
    #[test] fn brief_reader_delays_do_not_discard_contiguous_audio_video() {
        // A WebKit append can take ~270 ms. Three 100 ms fragments arriving
        // while the reader is busy must not punch a hole in the AAC/video PTS.
        for remote in [false,true] {
            let p=Program::new("test".into(),"Synthetic".into(),None);
            p.publish(1,b"init");p.publish(2,&[0]);
            let mut r=if remote { ProgramReader::remote(ProgramPublication::new(p.clone(),1,0)) }
                else { ProgramReader::new(p.clone()) };
            let mut init=[0;9];r.read_exact(&mut init).unwrap();
            let mut packet=[0;6];r.read_exact(&mut packet).unwrap();assert_eq!(packet[5],0);
            for burst in 0..20u8 {
                let first=burst*3+1;
                for seq in first..first+3 { p.publish(2,&[seq]); }
                for seq in first..first+3 {
                    r.read_exact(&mut packet).unwrap();
                    assert_eq!(packet,[2,0,0,0,1,seq],"remote={remote}, burst={burst}");
                }
            }
            p.stop();
        }
    }
    #[test] fn reader_preserves_eight_fragment_bursts_across_partial_reads_and_telemetry() {
        for remote in [false,true] {
            let p=Program::new("test".into(),"Synthetic".into(),None);
            p.publish(1,b"init");p.publish(2,&[0]);
            let mut r=if remote { ProgramReader::remote(ProgramPublication::new(p.clone(),1,0)) }
                else { ProgramReader::new(p.clone()) };
            let mut init=[0;9];r.read_exact(&mut init).unwrap();
            let mut packet=[0;6];r.read_exact(&mut packet[..2]).unwrap();
            for seq in 1..=8 { p.publish(2,&[seq]); }
            p.publish(3,br#"{"phase":"live"}"#);
            // Finish the in-flight segment before any telemetry or next header.
            r.read_exact(&mut packet[2..]).unwrap();assert_eq!(packet,[2,0,0,0,1,0]);
            let mut header=[0;5];r.read_exact(&mut header).unwrap();assert_eq!(header[0],3);
            let mut body=vec![0;u32::from_be_bytes(header[1..].try_into().unwrap()) as usize];
            r.read_exact(&mut body).unwrap();
            for seq in 1..=8 {
                // One-byte consumers must receive the same framing/order.
                for byte in &mut packet { r.read_exact(std::slice::from_mut(byte)).unwrap(); }
                assert_eq!(packet,[2,0,0,0,1,seq],"remote={remote}");
            }
            p.stop();
        }
    }
    #[test] fn actual_ring_overrun_recovers_at_a_whole_fragment_then_resumes_contiguously() {
        for remote in [false,true] {
            let p=Program::new("test".into(),"Synthetic".into(),None);
            p.publish(1,b"init");p.publish(2,&[0]);
            let mut r=if remote { ProgramReader::remote(ProgramPublication::new(p.clone(),1,0)) }
                else { ProgramReader::new(p.clone()) };
            let mut init=[0;9];r.read_exact(&mut init).unwrap();
            let mut packet=[0;6];r.read_exact(&mut packet).unwrap();
            for seq in 1..=9 { p.publish(2,&[seq]); }
            assert_eq!(p.buffer.lock().unwrap().segments.len(),8);
            r.read_exact(&mut packet).unwrap();assert_eq!(packet,[2,0,0,0,1,9]);
            for seq in 10..=12 { p.publish(2,&[seq]); }
            for seq in 10..=12 { r.read_exact(&mut packet).unwrap();assert_eq!(packet,[2,0,0,0,1,seq]); }
            p.stop();assert_eq!(r.read(&mut packet).unwrap(),0);
        }
    }
    #[test] fn oversize_segments_stop_only_their_source() {
        let a=Program::new("a".into(),"A".into(),None); let b=Program::new("b".into(),"B".into(),None);
        a.publish(2,&vec![0;MAX_SEGMENT+1]); assert!(a.stopped.load(Ordering::Relaxed)); assert!(!b.stopped.load(Ordering::Relaxed));
    }
    #[test] fn runtime_precedence_prefers_installed_tools_over_sdk_without_overriding_user_choice() {
        let paths=runtime_candidates(None,true,Some(PathBuf::from("/chosen/libndi.dylib")),
            Some(std::ffi::OsString::from("/environment")),Some("/developer/libndi.dylib"));
        assert_eq!(paths,vec![PathBuf::from("/chosen/libndi.dylib"),PathBuf::from("/environment/libndi.dylib"),
            PathBuf::from("/usr/local/lib/libndi.dylib"),
            PathBuf::from("/Library/Application Support/Adobe/Common/Plug-ins/7.0/MediaCore/NDI_Transmit_AdobeCC.bundle/Contents/Frameworks/libndi.dylib"),
            PathBuf::from("/Library/NDI SDK for Apple/lib/macOS/libndi.dylib"),
            PathBuf::from("/developer/libndi.dylib")]);
    }
    #[test] fn packaged_runtime_cannot_be_overridden_or_replaced_by_a_developer_fallback() {
        let bundled=PathBuf::from("/Applications/Sauce Bunny.app/Contents/Frameworks/libndi.dylib");
        for developer_build in [false,true] {
            assert_eq!(runtime_candidates(Some(bundled.clone()),developer_build,Some(PathBuf::from("/chosen/libndi.dylib")),
                Some(std::ffi::OsString::from("/environment")),Some("/developer/libndi.dylib")),vec![bundled.clone()]);
        }
        assert!(runtime_candidates(None,false,None,None,Some("/developer/libndi.dylib")).is_empty());
    }
    #[test] fn native_telemetry_defaults_missing_fields_without_guessing_timing() {
        let state: NdiTelemetry=serde_json::from_str(r#"{"phase":"error","error":"encoder unavailable"}"#).unwrap();
        assert_eq!(state.phase,NdiPhase::Error);assert_eq!(state.error.as_deref(),Some("encoder unavailable"));
        assert_eq!(state.source_id,"");assert_eq!(state.encoded_bitrate_kbps,None);
    }
    #[test] fn telemetry_uses_receiver_identity_and_preserves_independent_counters() {
        let p=Program::new("expected-source".into(),"Premiere".into(),None);
        p.publish(3,br#"{"sourceId":"spoofed","phase":"live","receivedFrames":90,"ndiDroppedFrames":2,"encoderDroppedFrames":3,"lastInputAgeMs":14,"encodedBitrateKbps":6192}"#);
        let state=p.buffer.lock().unwrap().status.clone();
        assert_eq!(state.source_id,"expected-source");assert_eq!(state.phase,NdiPhase::Live);
        assert_eq!((state.received_frames,state.ndi_dropped_frames,state.encoder_dropped_frames),(90,2,3));
        assert_eq!(state.last_input_age_ms,14);assert_eq!(state.encoded_bitrate_kbps,Some(6192));
    }
    #[test] fn a_terminal_native_error_reaches_a_program_reader_before_eof() {
        let p=Program::new("source".into(),"Premiere".into(),None);
        let mut reader=ProgramReader::new(p.clone());p.fail("Hardware H.264 encoder unavailable");
        let mut header=[0u8;5];reader.read_exact(&mut header).unwrap();assert_eq!(header[0],3);
        let mut body=vec![0;u32::from_be_bytes(header[1..].try_into().unwrap()) as usize];reader.read_exact(&mut body).unwrap();
        let state: NdiTelemetry=serde_json::from_slice(&body).unwrap();
        assert_eq!(state.phase,NdiPhase::Error);assert_eq!(state.error.as_deref(),Some("Hardware H.264 encoder unavailable"));
        assert_eq!(reader.read(&mut header).unwrap(),0);
    }
    #[test] fn initial_telemetry_does_not_make_a_new_reader_skip_the_media_init() {
        let p=Program::new("source".into(),"Premiere".into(),None);
        p.publish(3,br#"{"phase":"live"}"#);p.publish(1,b"init");
        let mut reader=ProgramReader::new(p.clone());let mut header=[0u8;5];
        reader.read_exact(&mut header).unwrap();assert_eq!(header[0],3);
        let mut telemetry=vec![0;u32::from_be_bytes(header[1..].try_into().unwrap()) as usize];reader.read_exact(&mut telemetry).unwrap();
        reader.read_exact(&mut header).unwrap();assert_eq!(header[0],1);assert_eq!(u32::from_be_bytes(header[1..].try_into().unwrap()),4);
        let mut init=[0u8;4];reader.read_exact(&mut init).unwrap();assert_eq!(&init,b"init");p.stop();
    }
    #[cfg(sauce_ndi)] #[test] #[ignore="requires local NDI runtime and network discovery permission"]
    fn ndi_runtime_discovery_smoke() { let result=native::query(&runtime_path().expect("NDI runtime"),true).unwrap(); assert!(result.available); }
}
