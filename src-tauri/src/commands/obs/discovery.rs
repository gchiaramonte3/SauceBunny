//! Bounded metadata-only queries to the packaged discovery helper. Neither
//! enumeration path starts capture or changes screen-recording permission.
use std::{collections::HashMap, path::Path, process::Stdio, time::Duration};
use serde::{de::DeserializeOwned, Deserialize};
use tokio::io::AsyncReadExt;
use crate::AppError;
use super::{command, valid_application, valid_display_uuid, ObsApplication, ObsWindow, ObsWindowChoice, ObsDisplayChoice};

const MAX_BYTES: u64 = 64 * 1024;
const MAX_ENTRIES: usize = 1024;
const QUERY_DEADLINE: Duration = Duration::from_secs(5);
const ADMISSION_DEADLINE: Duration = Duration::from_millis(250);
static DISCOVERY_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

#[derive(Deserialize)]
struct Response<T> {
    #[serde(flatten)]
    data: T,
    error: String,
    #[serde(rename = "capturedUserContent")]
    captured_user_content: bool,
}

async fn query<T: DeserializeOwned>(root: &Path, argument: &str, subject: &str) -> Result<T, AppError> {
    // Superseded focus/refresh requests must not accumulate helper processes.
    // Admission is part of the same total deadline; no child exists before it.
    let deadline = tokio::time::Instant::now() + QUERY_DEADLINE;
    let _slot = tokio::time::timeout(ADMISSION_DEADLINE, DISCOVERY_SLOTS.acquire()).await
        .map_err(|_|AppError::invalid("Capture discovery is busy. Refresh windows to try again."))?
        .map_err(|_|AppError::internal("Capture discovery is unavailable"))?;
    let mut child = command(root, "window-probe").arg(argument).stdin(Stdio::null())
        .stdout(Stdio::piped()).stderr(Stdio::null()).spawn()?;
    let Some(output) = child.stdout.take() else {
        let _ = child.kill().await; let _ = child.wait().await;
        return Err(AppError::internal(format!("{subject} discovery pipe did not open")));
    };
    let mut output = output.take(MAX_BYTES + 1);
    let result = tokio::time::timeout_at(deadline, async {
        let mut bytes = Vec::new(); output.read_to_end(&mut bytes).await?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err(AppError::invalid(format!("{subject} list exceeded its safety limit")));
        }
        let status = child.wait().await?;
        let response: Response<T> = serde_json::from_slice(&bytes)
            .map_err(|_|AppError::invalid(format!("Cannot read the {} list", subject.to_lowercase())))?;
        if response.captured_user_content {
            return Err(AppError::invalid("Discovery unexpectedly reported captured user content"));
        }
        if !response.error.is_empty() {
            return Err(AppError::invalid(match response.error.as_str() {
                "screen_capture_permission_required" => "Screen recording access is not active for this copy of Sauce Bunny. Allow this app in macOS Screen & System Audio Recording settings, then quit and reopen it. If already enabled, remove its entry and add this copy of the app again.".into(),
                "application_list_too_large" => "Application list exceeded its safety limit".into(),
                "window_list_too_large" => "Application window list exceeded its safety limit".into(),
                "window_discovery_timeout" => "Application window discovery timed out".into(),
                _ => format!("{subject} discovery failed; no capture was started"),
            }));
        }
        if !status.success() {
            return Err(AppError::invalid(format!("{subject} discovery helper failed; no capture was started")));
        }
        Ok(response.data)
    }).await;
    match result {
        Ok(Ok(value)) => Ok(value),
        other => {
            let _ = child.kill().await; let _ = child.wait().await;
            match other { Ok(Err(error)) => Err(error), _ => Err(AppError::invalid(format!("{subject} discovery timed out"))) }
        }
    }
}

pub(super) async fn applications(root: &Path) -> Result<Vec<ObsApplication>, AppError> {
    #[derive(Deserialize)] struct Applications { applications: Vec<ObsApplication> }
    let response: Applications = query(root, "--applications", "Application").await?;
    if response.applications.len() > MAX_ENTRIES { return Err(AppError::invalid("Application list exceeded its safety limit")); }
    let mut identities = HashMap::new();
    let mut applications = Vec::new();
    for app in response.applications {
        if app.pid <= 0 || !valid_application(&app.app) || app.name.is_empty() || app.name.contains('\0') || app.name.len() > 4096 {
            return Err(AppError::invalid("Invalid application list"));
        }
        if let Some(previous) = identities.insert(app.pid, app.clone()) {
            if previous != app { return Err(AppError::invalid("Conflicting application identities")); }
        } else { applications.push(app); }
    }
    Ok(applications)
}

pub(super) async fn windows(root: &Path, application: &str) -> Result<Vec<ObsWindow>, AppError> {
    if !valid_application(application) { return Err(AppError::invalid("Choose an application bundle identifier")); }
    #[derive(Deserialize)] struct Windows { windows: Vec<ObsWindow> }
    let response: Windows = query(root, application, "Application window").await?;
    if response.windows.len() > MAX_ENTRIES { return Err(AppError::invalid("Application window list exceeded its safety limit")); }
    let mut identities = HashMap::new();
    let mut windows = Vec::new();
    for window in response.windows {
        if window.app != application || window.pid <= 0 || window.id == 0 ||
            !(2..=16384).contains(&window.width) || !(2..=16384).contains(&window.height) || window.title.len() > 4096 {
            return Err(AppError::invalid("Invalid application window list"));
        }
        if let Some(previous) = identities.insert(window.id, window.clone()) {
            if previous != window { return Err(AppError::invalid("Conflicting application window identities")); }
        } else { windows.push(window); }
    }
    Ok(windows)
}

/// One metadata-only OS snapshot. Application names label the cards, but only
/// the exact bundle/PID/window tuple can become a capture selection.
pub(super) async fn all_windows(root: &Path, own_process: u32) -> Result<Vec<ObsWindowChoice>, AppError> {
    #[derive(Deserialize)] struct Windows { windows: Vec<ObsWindowChoice> }
    let response: Windows = query(root, "--all-windows", "Application window").await?;
    if response.windows.len() > MAX_ENTRIES { return Err(AppError::invalid("Application window list exceeded its safety limit")); }
    let mut identities = HashMap::new();
    let mut applications = HashMap::new();
    let mut windows = Vec::new();
    for choice in response.windows {
        let window = &choice.window;
        if !valid_application(&window.app) || window.pid <= 0 || window.id == 0 ||
            !(2..=16384).contains(&window.width) || !(2..=16384).contains(&window.height) ||
            window.title.len() > 4096 || window.title.contains('\0') || choice.application_name.is_empty() ||
            choice.application_name.len() > 4096 || choice.application_name.contains('\0') {
            return Err(AppError::invalid("Invalid application window list"));
        }
        if let Some(previous) = applications.insert(window.pid, (window.app.clone(), choice.application_name.clone())) {
            if previous != (window.app.clone(), choice.application_name.clone()) {
                return Err(AppError::invalid("Conflicting application identities"));
            }
        }
        if let Some(previous) = identities.insert(window.id, choice.clone()) {
            if previous != choice { return Err(AppError::invalid("Conflicting application window identities")); }
        } else if window.pid as u32 != own_process { windows.push(choice); }
    }
    Ok(windows)
}

/// Display geometry is metadata; enumeration never creates a stream or asks
/// macOS for recording access. Both UUID and transient CG ID must agree.
pub(super) async fn displays(root: &Path) -> Result<Vec<ObsDisplayChoice>, AppError> {
    #[derive(Deserialize)] struct Displays { displays: Vec<ObsDisplayChoice> }
    let response: Displays = query(root, "--displays", "Screen").await?;
    if response.displays.len() > 32 { return Err(AppError::invalid("Screen list exceeded its safety limit")); }
    let mut ids = HashMap::new();
    let mut uuids = HashMap::new();
    let mut displays = Vec::new();
    for display in response.displays {
        if !valid_display_uuid(&display.display_uuid) || display.display_id == 0 || !display.geometry.valid() ||
            display.label.is_empty() || display.label.len() > 4096 || display.label.contains('\0') {
            return Err(AppError::invalid("Invalid screen list"));
        }
        if let Some(previous) = uuids.insert(display.display_uuid.clone(), display.display_id) {
            if previous != display.display_id { return Err(AppError::invalid("Conflicting screen identities")); }
        }
        if let Some(previous) = ids.insert(display.display_id, display.clone()) {
            if previous != display { return Err(AppError::invalid("Conflicting screen identities")); }
        } else { displays.push(display); }
    }
    Ok(displays)
}

#[path = "discovery_tests.rs"]
#[cfg(test)]
mod discovery_tests;
