//! Thin invoke surface; the paired native socket and durable queue live in
//! premiere_bridge, never in the video proxy or a renderer-local web server.
use crate::{premiere_bridge::{self, PremiereBridgeSnapshot, PremiereMarkerRecord, PremiereMarkerRequest, PremierePairing}, AppError};
use tauri::{AppHandle, Manager};

#[tauri::command]
pub async fn premiere_bridge_start(app: AppHandle) -> Result<PremierePairing, AppError> { premiere_bridge::start(app).await }

#[tauri::command]
pub fn premiere_bridge_stop(app: AppHandle) -> Result<(), AppError> { premiere_bridge::stop(&app) }

#[tauri::command]
pub fn premiere_bridge_status(app: AppHandle) -> Result<PremiereBridgeSnapshot, AppError> { premiere_bridge::snapshot(&app) }

#[tauri::command]
pub fn premiere_enqueue_note(app: AppHandle, request: PremiereMarkerRequest) -> Result<PremiereMarkerRecord, AppError> { premiere_bridge::enqueue(&app, request) }

#[tauri::command]
pub fn premiere_marker_notes(app: AppHandle) -> Result<Vec<PremiereMarkerRecord>, AppError> { premiere_bridge::notes(&app) }

/// Open ONLY the companion packaged with this app (or its fixed development
/// artifact). Creative Cloud retains installation and permission handling.
#[tauri::command]
pub async fn premiere_install_companion(app: AppHandle) -> Result<(), AppError> {
    let packaged = app.path().resource_dir()
        .map_err(|error| AppError::internal(format!("Cannot locate the bundled companion: {error}")))?
        .join("companion/SauceBunnyPremiere.ccx");
    let development = if cfg!(debug_assertions) {
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent()
            .map(|root| root.join("premiere-companion/dist/SauceBunnyPremiere.ccx"))
    } else { None };
    let package = select_companion_package(packaged, development)?;
    let status = tokio::process::Command::new("/usr/bin/open").arg(&package).status().await?;
    if !status.success() { return Err(AppError::invalid("Creative Cloud could not open the companion package. Open SauceBunnyPremiere.ccx manually.")); }
    Ok(())
}

fn select_companion_package(packaged: std::path::PathBuf, development: Option<std::path::PathBuf>) -> Result<std::path::PathBuf, AppError> {
    // Reject symlinks: neither production nor developer installation should
    // become an arbitrary-file opener through a replaced artifact.
    let regular = |path: &std::path::Path| std::fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_file()).unwrap_or(false);
    if regular(&packaged) { return Ok(packaged); }
    if let Some(path) = development.filter(|path| regular(path)) { return Ok(path); }
    Err(AppError::not_found("The Premiere companion package is missing. Install the separately supplied SauceBunnyPremiere.ccx, or rebuild with npm run build:dmg."))
}

#[cfg(test)]
mod package_tests {
    use super::select_companion_package;
    struct TempDirectory(std::path::PathBuf);
    impl TempDirectory {
        fn new() -> std::io::Result<Self> {
            let path = std::env::temp_dir().join(format!("sauce-companion-package-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&path)?;
            Ok(Self(path))
        }
        fn path(&self) -> &std::path::Path { &self.0 }
    }
    impl Drop for TempDirectory {
        fn drop(&mut self) {
            for name in ["packaged.ccx", "development.ccx", "target.ccx", "link.ccx"] {
                let _ = std::fs::remove_file(self.0.join(name));
            }
            let _ = std::fs::remove_dir(&self.0);
        }
    }
    #[test]
    fn packaged_companion_wins_and_release_has_no_developer_fallback() -> Result<(), Box<dyn std::error::Error>> {
        let directory = TempDirectory::new()?;
        let packaged = directory.path().join("packaged.ccx");
        let development = directory.path().join("development.ccx");
        std::fs::write(&development, b"fixture")?;
        assert!(select_companion_package(packaged.clone(), None).is_err());
        assert_eq!(select_companion_package(packaged.clone(), Some(development.clone()))?, development);
        std::fs::write(&packaged, b"fixture")?;
        assert_eq!(select_companion_package(packaged.clone(), Some(development))?, packaged);
        Ok(())
    }
    #[test]
    fn symlinks_are_not_install_packages() -> Result<(), Box<dyn std::error::Error>> {
        let directory = TempDirectory::new()?;
        let target = directory.path().join("target.ccx");
        let link = directory.path().join("link.ccx");
        std::fs::write(&target, b"fixture")?;
        std::os::unix::fs::symlink(&target, &link)?;
        assert!(select_companion_package(link.clone(), Some(link)).is_err());
        Ok(())
    }
}
