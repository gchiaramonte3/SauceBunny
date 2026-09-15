//! Explicit, memory-only ScreenCaptureKit previews. OBS discovery never enters
//! this path. Limits bound the untrusted process/IPC image, not capture quality.
use crate::AppError;
use crate::commands::obs::{ObsDisplayGeometry, ObsDisplaySelection};
use base64::Engine;
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{io::{AsyncRead, AsyncReadExt}, process::Command};

const MAX_JPEG_BYTES: usize = 128 * 1024;
const THUMBNAIL_OUTPUT_BYTES: usize = MAX_JPEG_BYTES.div_ceil(3) * 4 + 1024;
const CAPTURE_STDERR_BYTES: usize = 16 * 1024;
pub(super) const CAPTURE_DEADLINE: Duration = Duration::from_secs(10);
// Bound aggregate screenshot work across dialogs, refreshes and stale invokes.
static THUMBNAIL_SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(2);

#[derive(Debug, serde::Deserialize, serde::Serialize, ts_rs::TS)]
#[serde(deny_unknown_fields)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct CaptureWindowThumbnail {
    pub application: String,
    pub process: u32,
    pub window: u32,
    /// Base64 JPEG only, without a data URL or persistent file path.
    pub thumb: String,
}

#[derive(Debug, serde::Deserialize, serde::Serialize, ts_rs::TS)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct CaptureDisplayThumbnail {
    pub display_uuid: String,
    pub display_id: u32,
    pub geometry: ObsDisplayGeometry,
    pub thumb: String,
}

fn validate_identity(application: &str, process: u32, window: u32) -> Result<(), AppError> {
    if application.len() > 256 || !application.contains('.') ||
        !application.bytes().all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b)) ||
        process == 0 || process > i32::MAX as u32 || window == 0 {
        return Err(AppError::invalid("Thumbnail needs an exact application, process and window"));
    }
    Ok(())
}

async fn read_capped(reader: impl AsyncRead + Unpin, limit: usize) -> std::io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    reader.take(limit as u64 + 1).read_to_end(&mut bytes).await?;
    if bytes.len() > limit {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "Capture helper output exceeded its preview limit"));
    }
    Ok(bytes)
}

/// Own and reap the exact child on error, timeout or excessive output. Dropping
/// an invoke future also kills its child; no background capture survives it.
pub(super) async fn capture_output(binary: &Path, args: &[String], limit: usize, deadline: Duration) -> Result<Vec<u8>, AppError> {
    let mut child = Command::new(binary).args(args).env_clear().env("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true).spawn()?;
    let stdout = child.stdout.take().ok_or_else(|| AppError::internal("Capture helper stdout missing"))?;
    let stderr = child.stderr.take().ok_or_else(|| AppError::internal("Capture helper stderr missing"))?;
    let result = tokio::time::timeout(deadline, async {
        tokio::try_join!(read_capped(stdout, limit), read_capped(stderr, CAPTURE_STDERR_BYTES), child.wait())
    }).await;
    let (out, err, status) = match result
        .map_err(|_| "Capture helper timed out; preview unavailable".to_owned())
        .and_then(|r| r.map_err(|e| format!("Capture helper failed: {e}"))) {
        Ok(value) => value,
        Err(message) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err(AppError::internal(message));
        }
    };
    if !status.success() {
        let message = String::from_utf8_lossy(&err);
        return Err(AppError::internal(format!("Capture helper exited {}: {}", status, message.trim())));
    }
    Ok(out)
}

fn decode_thumbnail(bytes: &[u8], application: &str, process: u32, window: u32) -> Result<CaptureWindowThumbnail, AppError> {
    let result: CaptureWindowThumbnail = serde_json::from_slice(bytes)
        .map_err(|e| AppError::internal(format!("Invalid window thumbnail response: {e}")))?;
    if result.application != application || result.process != process || result.window != window {
        return Err(AppError::invalid("The selected window changed before its thumbnail was ready"));
    }
    validate_jpeg(&result.thumb)?;
    Ok(result)
}

fn validate_jpeg(thumb: &str) -> Result<(), AppError> {
    if thumb.len() > MAX_JPEG_BYTES.div_ceil(3) * 4 {
        return Err(AppError::invalid("Thumbnail exceeded the preview limit"));
    }
    let jpeg = base64::engine::general_purpose::STANDARD.decode(thumb)
        .map_err(|_| AppError::invalid("Thumbnail is not a base64 JPEG"))?;
    if jpeg.len() > MAX_JPEG_BYTES || !jpeg.starts_with(&[0xff, 0xd8, 0xff]) || !jpeg.ends_with(&[0xff, 0xd9]) {
        return Err(AppError::invalid("Thumbnail is not a bounded JPEG"));
    }
    Ok(())
}

fn decode_display_thumbnail(bytes: &[u8], selection: &ObsDisplaySelection) -> Result<CaptureDisplayThumbnail, AppError> {
    let result: CaptureDisplayThumbnail = serde_json::from_slice(bytes)
        .map_err(|e| AppError::internal(format!("Invalid display thumbnail response: {e}")))?;
    if result.display_uuid != selection.display_uuid || result.display_id != selection.display_id
        || result.geometry != selection.geometry {
        return Err(AppError::invalid("The selected display changed before its thumbnail was ready"));
    }
    validate_jpeg(&result.thumb)?;
    Ok(result)
}

pub(super) async fn window_thumbnail(application: String, process: u32, window: u32) -> Result<CaptureWindowThumbnail, AppError> {
    validate_identity(&application, process, window)?;
    let _slot = THUMBNAIL_SLOTS.try_acquire().map_err(|_| AppError::invalid("Window thumbnail capture is busy. Refresh to try again."))?;
    if process == std::process::id() {
        return Err(AppError::invalid("Sauce Bunny's own window is not a capture source"));
    }
    if !super::screen_recording_preflight() {
        return Err(AppError::invalid("Screen Recording access is not granted. Enable it in System Settings to preview this window."));
    }
    let binary = super::super::sidecar_path("saucebunny-capture")?;
    let args = vec!["thumbnail".into(), "--application".into(), application.clone(),
        "--process".into(), process.to_string(), "--window".into(), window.to_string()];
    let bytes = capture_output(&binary, &args, THUMBNAIL_OUTPUT_BYTES, CAPTURE_DEADLINE).await?;
    decode_thumbnail(&bytes, &application, process, window)
}

pub(super) async fn display_thumbnail(selection: ObsDisplaySelection) -> Result<CaptureDisplayThumbnail, AppError> {
    // A picker tile is always an audio-free, full-screen snapshot. A malformed
    // crop cannot accidentally widen an explicitly requested region capture.
    if !selection.valid() || selection.audio || selection.crop.x != 0.0 || selection.crop.y != 0.0
        || selection.crop.width != 1.0 || selection.crop.height != 1.0 {
        return Err(AppError::invalid("Display thumbnail needs an exact display and a full-screen, audio-free snapshot request"));
    }
    let _slot = THUMBNAIL_SLOTS.try_acquire().map_err(|_| AppError::invalid("Thumbnail capture is busy. Refresh to try again."))?;
    if !super::screen_recording_preflight() {
        return Err(AppError::invalid("Screen Recording access is not granted. Enable it in System Settings to preview this display."));
    }
    let binary = super::super::sidecar_path("saucebunny-capture")?;
    let identity = serde_json::json!({ "displayUuid": selection.display_uuid, "displayId": selection.display_id,
        "geometry": selection.geometry }).to_string();
    let args = vec!["display-thumbnail".into(), "--identity".into(), identity];
    let bytes = capture_output(&binary, &args, THUMBNAIL_OUTPUT_BYTES, CAPTURE_DEADLINE).await?;
    decode_display_thumbnail(&bytes, &selection)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_identity_is_required() {
        for (app, pid, window) in [("", 2, 3), ("/Applications/Editor.app", 2, 3), ("com.editor\n", 2, 3),
            ("com.editor", 0, 3), ("com.editor", u32::MAX, 3), ("com.editor", 2, 0)] {
            assert!(validate_identity(app, pid, window).is_err());
        }
        assert!(validate_identity("com.example.Editor", 2, 3).is_ok());
    }
    fn response(app: &str, pid: u32, window: u32, thumb: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({"application":app,"process":pid,"window":window,"thumb":thumb})).unwrap()
    }
    #[test]
    fn response_must_match_every_identity_field_and_contain_only_bounded_jpeg() {
        let image = base64::engine::general_purpose::STANDARD.encode([0xff, 0xd8, 0xff, 0xd9]);
        assert!(decode_thumbnail(&response("com.editor", 2, 3, &image), "com.editor", 2, 3).is_ok());
        for (app, pid, window) in [("com.other",2,3),("com.editor",4,3),("com.editor",2,5)] {
            assert!(decode_thumbnail(&response(app,pid,window,&image), "com.editor",2,3).is_err());
        }
        for invalid in ["not base64".to_owned(), "data:image/jpeg;base64,abc".into(),
            base64::engine::general_purpose::STANDARD.encode(b"not jpeg"), "A".repeat(THUMBNAIL_OUTPUT_BYTES)] {
            assert!(decode_thumbnail(&response("com.editor",2,3,&invalid), "com.editor",2,3).is_err());
        }
    }
    fn display_selection() -> ObsDisplaySelection {
        serde_json::from_value(serde_json::json!({ "kind":"display",
            "displayUuid":"AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", "displayId":7,
            "geometry":{"x":-1920.0,"y":0.0,"width":1920,"height":1080,"pixelWidth":3840,"pixelHeight":2160},
            "crop":{"x":0.0,"y":0.0,"width":1.0,"height":1.0},"audio":false })).unwrap()
    }
    #[test]
    fn display_response_matches_uuid_id_and_every_geometry_field() {
        let request = display_selection();
        let image = base64::engine::general_purpose::STANDARD.encode([0xff, 0xd8, 0xff, 0xd9]);
        let response = serde_json::json!({"displayUuid":request.display_uuid,"displayId":request.display_id,
            "geometry":request.geometry,"thumb":image});
        assert!(decode_display_thumbnail(&serde_json::to_vec(&response).unwrap(), &request).is_ok());
        for field in ["x","y","width","height","pixelWidth","pixelHeight"] {
            let mut changed = response.clone();
            changed["geometry"][field] = serde_json::json!(999);
            assert!(decode_display_thumbnail(&serde_json::to_vec(&changed).unwrap(), &request).is_err(), "{field}");
        }
        for (field, value) in [("displayUuid", serde_json::json!("BBBBBBBB-BBBB-CCCC-DDDD-EEEEEEEEEEEE")),
            ("displayId", serde_json::json!(8)), ("thumb", serde_json::json!("not JPEG")), ("unexpected", serde_json::json!(true))] {
            let mut changed = response.clone(); changed[field] = value;
            assert!(decode_display_thumbnail(&serde_json::to_vec(&changed).unwrap(), &request).is_err(), "{field}");
        }
    }
    #[tokio::test]
    async fn process_errors_are_preserved_and_output_is_bounded() {
        let run = |script: &str| vec!["-c".into(), script.into()];
        assert_eq!(capture_output(Path::new("/bin/sh"), &run("printf '{}'"), 32, CAPTURE_DEADLINE).await.unwrap(), b"{}");
        let err = capture_output(Path::new("/bin/sh"), &run("printf 'Selected window closed' >&2; exit 3"), 32, CAPTURE_DEADLINE).await.unwrap_err();
        assert!(err.to_string().contains("Selected window closed"));
        let err = capture_output(Path::new("/bin/sh"), &run("while :; do printf '0123456789'; done"), 32, CAPTURE_DEADLINE).await.unwrap_err();
        assert!(err.to_string().contains("exceeded"));
        let err = capture_output(Path::new("/bin/sh"), &run("while :; do :; done"), 32, Duration::from_millis(30)).await.unwrap_err();
        assert!(err.to_string().contains("timed out"));
    }
    #[tokio::test]
    async fn timed_out_child_is_killed_and_reaped_before_returning() {
        let directory = std::env::temp_dir().join(format!("sauce-thumbnail-reap-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).unwrap();
        let pid_path = directory.join("pid");
        let args = vec!["-c".into(), "printf '%s' $$ > \"$1\"; while :; do :; done".into(),
            "capture-fixture".into(), pid_path.to_string_lossy().into_owned()];
        let result = capture_output(Path::new("/bin/sh"), &args, 32, Duration::from_millis(200)).await;
        assert!(result.unwrap_err().to_string().contains("timed out"));
        let pid: i32 = std::fs::read_to_string(&pid_path).unwrap().parse().unwrap();
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1, "owned child must not survive the timeout");
        assert_eq!(std::io::Error::last_os_error().raw_os_error(), Some(libc::ESRCH));
        std::fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn stale_invokes_cannot_exceed_the_two_global_thumbnail_slots() {
        let first = THUMBNAIL_SLOTS.try_acquire().unwrap();
        let second = THUMBNAIL_SLOTS.try_acquire().unwrap();
        assert!(THUMBNAIL_SLOTS.try_acquire().is_err());
        drop(first);
        assert!(THUMBNAIL_SLOTS.try_acquire().is_ok());
        drop(second);
    }
}
