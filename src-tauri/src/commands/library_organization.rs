//! Reference-only Library curation. Never moves or deletes an original asset.
use crate::AppError;
use std::{io::Read, path::{Path, PathBuf}, sync::Mutex};
use tauri::{AppHandle, Manager};

static WRITER: Mutex<()> = Mutex::new(());
const MAX_BYTES: u64 = 8 * 1024 * 1024;

fn path(app: &AppHandle) -> Result<PathBuf, AppError> {
    Ok(app.path().document_dir().map_err(|e| AppError::internal(e.to_string()))?
        .join("Sauce Bunny").join("Library").join("organization.json"))
}

fn read(path: &Path) -> Result<Option<String>, AppError> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    let mut text = String::new();
    file.take(MAX_BYTES + 1).read_to_string(&mut text)?;
    if text.len() as u64 > MAX_BYTES { return Err(AppError::invalid("Library organization is too large to open safely")); }
    Ok(Some(text))
}

fn save(path: &Path, expected: Option<&str>, text: &str) -> Result<(), AppError> {
    let _guard = WRITER.lock().map_err(|_| AppError::internal("Library save lock unavailable"))?;
    let parent = path.parent().ok_or_else(|| AppError::invalid("Invalid Library location"))?;
    std::fs::create_dir_all(parent)?;
    // Lock a stable sibling, not organization.json: atomic replacement changes
    // the document's inode. This also serializes separate installed app copies.
    let lock = std::fs::OpenOptions::new().create(true).truncate(false).write(true)
        .open(parent.join("organization.lock"))?;
    lock.try_lock().map_err(|_| AppError::invalid("Another Sauce Bunny is saving Library folders. Try again."))?;
    let current = read(path)?;
    if current.as_deref() != expected {
        return Err(AppError::invalid("Library organization changed in another window. Reload folders before trying again."));
    }
    if text.len() as u64 > MAX_BYTES { return Err(AppError::invalid("Library organization exceeds the save limit")); }
    let next: serde_json::Value = serde_json::from_str(text)?;
    if next.get("version").and_then(|v| v.as_u64()) != Some(1) {
        return Err(AppError::invalid("Unsupported Library organization format"));
    }
    if let Some(prior) = current.as_deref() {
        let prior: serde_json::Value = serde_json::from_str(prior)?;
        if prior.get("version").and_then(|v| v.as_u64()) != Some(1) {
            return Err(AppError::invalid("Update Sauce Bunny before editing these folders"));
        }
    }
    super::system::write_bytes_impl(&path.to_string_lossy(), text.as_bytes(), false, false, true)?;
    Ok(())
}

#[derive(serde::Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct LibraryReferenceStatus {
    path: String,
    /// Unknown on access errors; a denied drive is not a missing file.
    exists: Option<bool>,
}

#[tauri::command]
pub async fn library_reference_status(paths: Vec<String>) -> Result<Vec<LibraryReferenceStatus>, AppError> {
    if paths.len() > 500 { return Err(AppError::invalid("Check Library references in batches of at most 500")); }
    tauri::async_runtime::spawn_blocking(move || paths.into_iter().map(|path| {
        if !Path::new(&path).is_absolute() { return Err(AppError::invalid("Choose an absolute file location")); }
        let exists = match std::fs::metadata(&path) {
            Ok(metadata) => Some(metadata.is_file()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(false),
            Err(_) => None,
        };
        Ok(LibraryReferenceStatus { path, exists })
    }).collect()).await.map_err(|e| AppError::internal(e.to_string()))?
}

#[tauri::command]
pub async fn library_organization_load(app: AppHandle) -> Result<Option<String>, AppError> {
    let path = path(&app)?;
    tauri::async_runtime::spawn_blocking(move || read(&path)).await
        .map_err(|e| AppError::internal(e.to_string()))?
}

#[tauri::command]
pub async fn library_organization_save(app: AppHandle, expected: Option<String>, text: String) -> Result<(), AppError> {
    let path = path(&app)?;
    tauri::async_runtime::spawn_blocking(move || save(&path, expected.as_deref(), &text)).await
        .map_err(|e| AppError::internal(e.to_string()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    const EMPTY: &str = r#"{"version":1,"assets":[],"folders":[],"favorites":[]}"#;
    struct TempDirectory(PathBuf);
    impl TempDirectory {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("sb-organization-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn path(&self) -> &Path { &self.0 }
    }
    impl Drop for TempDirectory { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }

    #[test]
    fn persists_and_rejects_stale_writers() {
        let dir = TempDirectory::new();
        let path = dir.path().join("Library/organization.json");
        assert_eq!(read(&path).unwrap(), None);
        save(&path, None, EMPTY).unwrap();
        assert_eq!(read(&path).unwrap().as_deref(), Some(EMPTY));
        assert!(save(&path, None, EMPTY).is_err());
        save(&path, Some(EMPTY), EMPTY).unwrap();
    }

    #[test]
    fn corrupt_and_future_documents_are_never_overwritten() {
        let dir = TempDirectory::new();
        let path = dir.path().join("organization.json");
        for prior in ["{broken", r#"{"version":2}"#] {
            std::fs::write(&path, prior).unwrap();
            assert!(save(&path, Some(prior), EMPTY).is_err());
            assert_eq!(read(&path).unwrap().as_deref(), Some(prior));
        }
    }

    #[test]
    fn concurrent_first_saves_cannot_both_succeed() {
        let dir = TempDirectory::new();
        let path = dir.path().join("organization.json");
        let results = std::thread::scope(|scope| {
            let a = scope.spawn(|| save(&path, None, EMPTY));
            let b = scope.spawn(|| save(&path, None, EMPTY));
            [a.join().unwrap().is_ok(), b.join().unwrap().is_ok()]
        });
        assert_eq!(results.iter().filter(|&&ok| ok).count(), 1);
        assert_eq!(read(&path).unwrap().as_deref(), Some(EMPTY));
    }

    #[test]
    fn io_failure_is_not_an_empty_library_and_assets_are_untouched() {
        let dir = TempDirectory::new();
        assert!(read(dir.path()).is_err());
        let original = dir.path().join("original.mov");
        std::fs::write(&original, b"original bytes").unwrap();
        save(&dir.path().join("organization.json"), None, EMPTY).unwrap();
        assert_eq!(std::fs::read(original).unwrap(), b"original bytes");
    }

    #[test]
    fn a_separate_file_handle_cannot_bypass_the_document_lock() {
        let dir = TempDirectory::new();
        let held = std::fs::File::create(dir.path().join("organization.lock")).unwrap();
        held.lock().unwrap();
        assert!(save(&dir.path().join("organization.json"), None, EMPTY).is_err());
        drop(held);
        save(&dir.path().join("organization.json"), None, EMPTY).unwrap();
    }
}
