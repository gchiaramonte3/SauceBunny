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
#[cfg(feature = "obs-audio-acceptance")]
pub mod audio_acceptance;

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
pub struct ObsWindowChoice {
    #[serde(flatten)]
    pub window: ObsWindow,
    #[serde(rename = "applicationName")]
    pub application_name: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize, Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ObsApplication { pub pid: i32, pub app: String, pub name: String }

#[derive(Clone, Debug, Deserialize, Serialize, ts_rs::TS)]
#[serde(deny_unknown_fields)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ObsWindowSelection {
    pub application: String, pub process: i32, pub window: u32, pub crop: ObsCrop,
    // Include application audio. Omitted selections retain legacy audio capture.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub audio: Option<bool>,
}
impl ObsWindowSelection {
    fn valid(&self) -> bool { valid_application(&self.application) && self.process > 0 && self.window > 0 && self.crop.valid() }
}

/// Exact observed logical bounds and backing-pixel dimensions. A moved,
/// resized, rotated or reconfigured target must be selected again.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ObsDisplayGeometry {
    pub x: f64, pub y: f64, pub width: u32, pub height: u32,
    pub pixel_width: u32, pub pixel_height: u32,
}
impl ObsDisplayGeometry {
    pub(super) fn valid(&self) -> bool {
        self.x.is_finite() && self.y.is_finite() && self.x.abs() <= 1_000_000.0 && self.y.abs() <= 1_000_000.0 &&
        [self.width, self.height, self.pixel_width, self.pixel_height].iter().all(|n|(2..=16384).contains(n))
    }
}
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ObsDisplayChoice {
    pub display_uuid: String, pub display_id: u32, pub label: String, pub geometry: ObsDisplayGeometry,
}
#[derive(Clone, Debug, Deserialize, Serialize, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum ObsDisplayKind { Display }
#[derive(Clone, Debug, Deserialize, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ObsDisplaySelection {
    pub kind: ObsDisplayKind, pub display_uuid: String, pub display_id: u32,
    pub geometry: ObsDisplayGeometry, pub crop: ObsCrop, pub audio: bool,
}
impl ObsDisplaySelection {
    pub(super) fn valid(&self) -> bool {
        if !valid_display_uuid(&self.display_uuid) || self.display_id == 0 || !self.geometry.valid() || !self.crop.valid() { return false; }
        let inward = |start:f64, size:f64, pixels:u32, points:u32|
            (((start+size) * pixels as f64).floor() - (start * pixels as f64).ceil()) * points as f64 / pixels as f64;
        inward(self.crop.x,self.crop.width,self.geometry.pixel_width,self.geometry.width) > 16.0 &&
        inward(self.crop.y,self.crop.height,self.geometry.pixel_height,self.geometry.height) > 16.0
    }
}
pub(super) fn valid_display_uuid(value: &str) -> bool {
    value.len() == 36 && value.bytes().enumerate().all(|(i,b)| {
        if [8,13,18,23].contains(&i) { b == b'-' } else { b.is_ascii_hexdigit() }
    })
}
#[derive(Clone, Debug, Deserialize, Serialize, ts_rs::TS)]
#[serde(untagged)]
#[ts(export, export_to = "../../src/bindings/")]
pub enum ObsSelection { Window(ObsWindowSelection), Display(ObsDisplaySelection) }
impl ObsSelection {
    fn valid(&self) -> bool {
        match self { Self::Window(value) => value.valid(), Self::Display(value) => value.valid() }
    }
}
#[derive(Clone, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ObsEditSource { pub source_id: String }

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
pub async fn obs_all_windows() -> Result<Vec<ObsWindowChoice>, AppError> {
    let before = service::helper_process();
    let mut windows = discovery::all_windows(&runtime()?, std::process::id()).await?;
    let after = service::helper_process();
    windows.retain(|choice| ![before, after].into_iter().flatten().any(|pid|pid == choice.window.pid as u32));
    Ok(windows)
}

#[tauri::command]
pub async fn obs_displays() -> Result<Vec<ObsDisplayChoice>, AppError> { discovery::displays(&runtime()?).await }

#[tauri::command]
pub async fn obs_start(app: AppHandle, selection: ObsSelection) -> Result<ObsStarted, AppError> {
    if !selection.valid() { return Err(AppError::invalid("Select an exact screen or visible window and a valid crop.")); }
    let generation = ndi::producer_generation()?;
    let root = runtime()?;
    let name = match &selection {
        ObsSelection::Window(target) => {
            let available = discovery::windows(&root, &target.application).await?;
            if own_capture_process(target.process, service::helper_process()) {
                return Err(AppError::invalid("Sauce Bunny's own windows and capture controls are not capture sources"));
            }
            let chosen = available.iter().find(|w|w.id == target.window && w.pid == target.process)
                .ok_or_else(||AppError::invalid("The selected application window is no longer visible"))?;
            if chosen.title.is_empty() { chosen.app.clone() } else { chosen.title.clone() }
        }
        ObsSelection::Display(target) => {
            discovery::displays(&root).await?.into_iter()
                .find(|d|d.display_uuid == target.display_uuid && d.display_id == target.display_id && d.geometry == target.geometry)
                .ok_or_else(||AppError::invalid("The selected screen changed. Refresh screens and choose it again."))?.label
        }
    };
    let room = super::session::ndi_room_generation(&app).await;
    service::check_start(&root)?;
    let (program, result, permit) = ndi::register_obs(name, &selection, app, room, generation)?;
    service::enqueue(root, service::Request { selection:selection.clone(), program, permit:Some(permit) })?;
    Ok(ObsStarted { program:result, selection })
}
fn own_capture_process(process: i32, helper: Option<u32>) -> bool {
    process > 0 && (process as u32 == std::process::id() || helper == Some(process as u32))
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
    fn capture_controls_are_excluded_by_exact_owned_process_not_a_name() {
        assert!(own_capture_process(std::process::id() as i32,None));
        assert!(own_capture_process(42,Some(42)));
        assert!(!own_capture_process(43,Some(42)));
        assert!(!own_capture_process(42,None));
        assert!(!own_capture_process(-1,None));
    }
    #[test]
    fn source_and_crop_do_not_allow_fallback_or_nonfinite_values() {
        let mut selection = ObsWindowSelection { application:"com.example.editor".into(), process:1, window:2, audio:None,
            crop:ObsCrop { x:0.0, y:0.0, width:1.0, height:1.0 } };
        assert!(selection.valid()); selection.window = 0; assert!(!selection.valid()); selection.window = 2;
        for width in [0.0, -1.0, 1.1, f64::NAN, f64::INFINITY] { selection.crop.width = width; assert!(!selection.valid()); }
        for app in ["", "--all", "/Applications/Editor.app", "com.editor\n", "com.editor\0"] { assert!(!valid_application(app)); }
    }
    #[test]
    fn display_selection_is_explicit_strict_and_retains_exact_observed_geometry() {
        let value = serde_json::json!({"kind":"display","displayUuid":"12345678-1234-1234-1234-123456789ABC","displayId":42,
            "geometry":{"x":-1920.0,"y":10.0,"width":1920,"height":1080,"pixelWidth":3840,"pixelHeight":2160},
            "crop":{"x":0.125,"y":0.25,"width":0.5,"height":0.5},"audio":false});
        let selection: ObsSelection = serde_json::from_value(value.clone()).unwrap();
        assert!(selection.valid());
        assert_eq!(serde_json::to_value(selection).unwrap(), value);
        for audio in [false, true] {
            let mut changed=value.clone(); changed["audio"]=serde_json::json!(audio);
            assert!(serde_json::from_value::<ObsSelection>(changed).unwrap().valid());
        }
        for (key, invalid) in [("kind",serde_json::json!("window")),("audio",serde_json::json!("true")),
            ("displayId",serde_json::json!(0)),("displayUuid",serde_json::json!("invalid"))] {
            let mut changed=value.clone(); changed[key]=invalid;
            assert!(serde_json::from_value::<ObsSelection>(changed).map_or(true,|v|!v.valid()),"{key}");
        }
        for key in ["kind","audio","geometry","displayUuid","displayId"] {
            let mut changed=value.clone(); changed.as_object_mut().unwrap().remove(key);
            assert!(serde_json::from_value::<ObsSelection>(changed).is_err(),"{key}");
        }
        let mut mixed=value.clone();
        mixed["application"]=serde_json::json!("com.example.editor"); mixed["process"]=serde_json::json!(1); mixed["window"]=serde_json::json!(2);
        assert!(serde_json::from_value::<ObsSelection>(mixed).is_err());
        // Exclusions belong to the native helper, never to renderer input.
        for key in ["audioPolicy","parentPid","parentBundle","excludedApplications"] {
            let mut changed=value.clone(); changed[key]=serde_json::json!(1);
            assert!(serde_json::from_value::<ObsSelection>(changed).is_err(),"{key}");
        }
        for key in ["width","height","pixelWidth","pixelHeight"] {
            for invalid in [serde_json::json!(0),serde_json::json!(1.5),serde_json::json!(16385)] {
                let mut changed=value.clone(); changed["geometry"][key]=invalid;
                assert!(serde_json::from_value::<ObsSelection>(changed).map_or(true,|v|!v.valid()));
            }
        }
        let mut narrow=value.clone(); narrow["geometry"]=serde_json::json!({"x":0,"y":0,"width":1000,"height":1000,"pixelWidth":2000,"pixelHeight":2000});
        narrow["crop"]=serde_json::json!({"x":0,"y":0,"width":0.0161,"height":1});
        assert!(!serde_json::from_value::<ObsSelection>(narrow).unwrap().valid(),"inward-rounded width must exceed16 logical points");
    }
}
