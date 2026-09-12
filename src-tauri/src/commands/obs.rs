//! Embedded OBS application capture. No OBS UI installation, external program
//! search path, desktop fallback, or implicit room/NDI broadcast.
mod framing;
#[cfg(test)]
mod worker;
mod service;
mod service_wire;
mod discovery;
mod raw_control;
mod raw_service;
mod broadcast;
mod renderer;

// Native consumers can own an explicit raw-output attempt without exposing
// descriptors, controls, or media through the renderer invoke API.
pub use raw_control::Reason as RawOutputReason;
pub use raw_service::{RawFeed, RawGenerations, RawStatus};
pub use broadcast::{BroadcastHandle, BroadcastStatus, BroadcastFailure, CleanupProof};
pub use renderer::{ObsBroadcastPhase, ObsBroadcastStatus};

use std::path::{Path, PathBuf};
use serde::{Deserialize, Serialize};
use tokio::process::Command;
use tauri::AppHandle;
use crate::AppError;
use super::ndi;

#[derive(Clone, Debug, Deserialize, Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ObsCrop { pub x: f64, pub y: f64, pub width: f64, pub height: f64 }
impl ObsCrop {
    fn valid(&self) -> bool {
        [self.x,self.y,self.width,self.height].iter().all(|v|v.is_finite()) &&
        self.x >= 0.0 && self.y >= 0.0 && self.width > 0.0 && self.height > 0.0 &&
        self.x + self.width <= 1.0 && self.y + self.height <= 1.0
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ObsWindow {
    pub id: u32, pub pid: i32, pub app: String, pub title: String, pub width: u32, pub height: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ObsApplication { pub pid: i32, pub app: String, pub name: String }

#[derive(Clone, Debug, Deserialize, Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ObsSelection { pub application: String, pub process: i32, pub window: u32, pub crop: ObsCrop }
impl ObsSelection {
    fn valid(&self) -> bool { valid_application(&self.application) && self.process > 0 && self.window > 0 && self.crop.valid() }
}

#[derive(Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ObsPreflight { pub available: bool, pub error: Option<String> }

#[derive(Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ObsStarted { pub program: ndi::NdiStarted, pub selection: ObsSelection }

fn valid_application(value: &str) -> bool {
    (3..=256).contains(&value.len()) && value.contains('.') && value.bytes().all(|b| b.is_ascii_alphanumeric() || b".-_".contains(&b))
}

fn runtime_candidate(executable: &Path, developer: bool, override_path: Option<PathBuf>) -> Option<PathBuf> {
    let parent = executable.parent()?;
    if parent.file_name()? == "MacOS" && parent.parent()?.file_name()? == "Contents" {
        // Even debug app bundles cannot substitute an environment/user library.
        return Some(parent.parent()?.join("Helpers/OBS.bundle/Contents"));
    }
    developer.then_some(override_path).flatten()
}

fn runtime() -> Result<PathBuf, AppError> {
    if !cfg!(target_os = "macos") { return Err(AppError::invalid("Embedded OBS capture requires macOS")); }
    let executable = std::env::current_exe()?;
    let path = runtime_candidate(&executable, cfg!(debug_assertions), std::env::var_os("SAUCE_OBS_DEV_RUNTIME").map(PathBuf::from))
        .ok_or_else(||AppError::invalid("This build does not include the embedded OBS capture runtime"))?;
    let root = path.canonicalize().map_err(|_|AppError::invalid("The embedded OBS capture runtime is missing"))?;
    for name in ["capture-service", "window-probe"] {
        let binary = root.join(format!("MacOS/saucebunny-obs-{name}"));
        let path = binary.canonicalize().map_err(|_|AppError::invalid("The embedded OBS capture runtime is incomplete"))?;
        if !path.starts_with(&root) || !path.is_file() { return Err(AppError::invalid("Invalid embedded OBS capture runtime")); }
    }
    Ok(root)
}

fn command(root: &Path, executable: &str) -> Command {
    let mut result = Command::new(root.join(format!("MacOS/saucebunny-obs-{executable}")));
    // No Homebrew, user plugin paths, DYLD injection or inherited media args.
    result.env_clear().env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin").kill_on_drop(true);
    result
}

#[tauri::command]
pub fn obs_preflight() -> ObsPreflight {
    match runtime() { Ok(_) => ObsPreflight { available:true, error:None },
        Err(error) => ObsPreflight { available:false, error:Some(error.to_string()) } }
}

#[tauri::command]
pub async fn obs_applications() -> Result<Vec<ObsApplication>, AppError> { discovery::applications(&runtime()?).await }

#[tauri::command]
pub async fn obs_windows(application: String) -> Result<Vec<ObsWindow>, AppError> { discovery::windows(&runtime()?, &application).await }

#[tauri::command]
pub async fn obs_start(app: AppHandle, selection: ObsSelection) -> Result<ObsStarted, AppError> {
    if !selection.valid() { return Err(AppError::invalid("Select a visible application window and a valid viewer crop")); }
    let generation = ndi::producer_generation()?;
    let root = runtime()?;
    let available = discovery::windows(&root, &selection.application).await?;
    let chosen = available.iter().find(|w|w.id == selection.window && w.pid == selection.process)
        .ok_or_else(||AppError::invalid("The selected application window is no longer visible"))?;
    let room = super::session::ndi_room_generation(&app).await;
    let name = if chosen.title.is_empty() { chosen.app.clone() } else { chosen.title.clone() };
    service::check_start(&root)?;
    let (program, result, permit) = ndi::register_obs(name, &selection, app, room, generation)?;
    service::enqueue(root, service::Request { selection:selection.clone(), program, permit:Some(permit) })?;
    Ok(ObsStarted { program:result, selection })
}

#[tauri::command]
pub fn obs_broadcast_status(id: String) -> Result<ObsBroadcastStatus, AppError> { renderer::status(&id) }
#[tauri::command]
pub fn obs_broadcast_start(id: String, attempt: u64) -> Result<ObsBroadcastStatus, AppError> { renderer::start(&id, attempt) }
#[tauri::command]
pub fn obs_broadcast_stop(id: String, attempt: u64) -> Result<ObsBroadcastStatus, AppError> { renderer::stop(&id, attempt) }

pub(super) async fn wait_stopped(id: &str) -> Result<(), AppError> { service::wait_stopped(id).await }

/// Native output seam, not a renderer command or a network broadcast. The
/// caller owns the feed/cancellation handle and must drain EOF before claiming
/// that an external consumer has stopped. Dropping it cancels only raw output.
pub fn begin_raw_output(id: &str) -> Result<RawFeed, AppError> {
    service::begin_raw_output(id)
}

/// Reserve without delivering media. The owner arms this exact generation
/// only after its independently supervised consumer is ready.
pub fn prepare_raw_output(id: &str) -> Result<RawFeed, AppError> { service::prepare_raw_output(id) }

/// Explicit native broadcast seam. Preview/discovery never call this. The
/// returned handle must stay owned; dropping it cancels and starts cleanup.
pub fn begin_broadcast(id: &str) -> Result<BroadcastHandle, AppError> { broadcast::begin(id) }
pub(super) fn cancel_broadcasts() { broadcast::cancel_all(); }

pub(crate) fn begin_broadcast_shutdown() -> Vec<tokio::sync::watch::Receiver<BroadcastStatus>> {
    broadcast::begin_shutdown()
}
pub(crate) async fn wait_broadcast_shutdown(
    pending: Vec<tokio::sync::watch::Receiver<BroadcastStatus>>, deadline: std::time::Duration,
) -> bool { broadcast::await_shutdown(pending, deadline).await }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn packaged_runtime_never_uses_developer_override() {
        let override_path = Some(PathBuf::from("/tmp/other"));
        assert_eq!(runtime_candidate(Path::new("/Applications/Test.app/Contents/MacOS/app"), true, override_path.clone()),
            Some(PathBuf::from("/Applications/Test.app/Contents/Helpers/OBS.bundle/Contents")));
        assert_eq!(runtime_candidate(Path::new("/tmp/debug/app"), false, override_path.clone()), None);
        assert_eq!(runtime_candidate(Path::new("/tmp/debug/app"), true, override_path.clone()), override_path);
    }
    #[test]
    fn source_and_crop_do_not_allow_fallback_or_nonfinite_values() {
        let mut selection = ObsSelection { application:"com.example.editor".into(), process:1, window:2,
            crop:ObsCrop { x:0.0, y:0.0, width:1.0, height:1.0 } };
        assert!(selection.valid()); selection.window = 0; assert!(!selection.valid()); selection.window = 2;
        for width in [0.0, -1.0, 1.1, f64::NAN, f64::INFINITY] { selection.crop.width = width; assert!(!selection.valid()); }
        for app in ["", "--all", "/Applications/Editor.app", "com.editor\n", "com.editor\0"] { assert!(!valid_application(app)); }
    }
}
