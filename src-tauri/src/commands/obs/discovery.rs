//! Bounded metadata-only queries to the packaged discovery helper. Neither
//! enumeration path starts capture or changes screen-recording permission.
use std::{collections::HashMap, path::Path, process::Stdio, time::Duration};
use serde::{de::DeserializeOwned, Deserialize};
use tokio::io::AsyncReadExt;
use crate::AppError;
use super::{command, valid_application, ObsApplication, ObsWindow};

const MAX_BYTES: u64 = 64 * 1024;
const MAX_ENTRIES: usize = 1024;

#[derive(Deserialize)]
struct Response<T> {
    #[serde(flatten)]
    data: T,
    error: String,
    #[serde(rename = "capturedUserContent")]
    captured_user_content: bool,
}

async fn query<T: DeserializeOwned>(root: &Path, argument: &str, subject: &str) -> Result<T, AppError> {
    let mut child = command(root, "window-probe").arg(argument).stdin(Stdio::null())
        .stdout(Stdio::piped()).stderr(Stdio::null()).spawn()?;
    let Some(output) = child.stdout.take() else {
        let _ = child.kill().await; let _ = child.wait().await;
        return Err(AppError::internal(format!("{subject} discovery pipe did not open")));
    };
    let mut output = output.take(MAX_BYTES + 1);
    let result = tokio::time::timeout(Duration::from_secs(5), async {
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
                "screen_capture_permission_required" => "Screen recording permission is required to list application windows".into(),
                "application_list_too_large" => "Application list exceeded its safety limit".into(),
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

#[path = "discovery_tests.rs"]
#[cfg(test)]
mod discovery_tests;
