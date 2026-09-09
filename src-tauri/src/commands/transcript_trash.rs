//! Explicit, confirmed transcript-only Trash action. Never a media-delete API.
use std::path::{Path, PathBuf};

fn transcript_file(path: &Path) -> Result<PathBuf, crate::AppError> {
    if !path.is_absolute() || !matches!(path.extension().and_then(|s| s.to_str()).map(str::to_ascii_lowercase).as_deref(), Some("srt" | "vtt")) {
        return Err("Only an absolute SRT or VTT transcript path can be moved to Trash.".into());
    }
    let metadata = std::fs::symlink_metadata(path).map_err(|e| format!("Cannot inspect transcript: {e}"))?;
    if !metadata.file_type().is_file() {
        return Err("Choose a regular transcript file, not a folder or symbolic link.".into());
    }
    // Resolve parent aliases before handing the exact target to the OS.
    std::fs::canonicalize(path).map_err(|e| format!("Cannot resolve transcript: {e}").into())
}

#[tauri::command]
pub fn trash_transcript(path: String) -> Result<(), crate::AppError> {
    let target = transcript_file(Path::new(&path))?;
    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::{NSFileManager, NSString, NSURL};
        let name = NSString::from_str(target.to_str().ok_or("Transcript path is not valid Unicode.")?);
        let url = NSURL::fileURLWithPath(&name);
        NSFileManager::defaultManager().trashItemAtURL_resultingItemURL_error(&url, None)
            .map_err(|e| format!("Could not move transcript to Trash: {e}").into())
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = target; Err("Transcript Trash is available on macOS only.".into()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct TempTree(PathBuf);
    impl TempTree {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("sb-transcript-trash-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn path(&self) -> &Path { &self.0 }
    }
    impl Drop for TempTree { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); } }
    #[test]
    fn refuses_media_directories_links_and_relative_paths() {
        let dir = TempTree::new();
        let movie = dir.path().join("clip.mov");
        std::fs::write(&movie, b"video must stay").unwrap();
        assert!(transcript_file(&movie).is_err());
        assert!(transcript_file(Path::new("relative.srt")).is_err());
        let folder = dir.path().join("folder.srt");
        std::fs::create_dir(&folder).unwrap();
        assert!(transcript_file(&folder).is_err());
        let srt = dir.path().join("note.SRT");
        std::fs::write(&srt, b"1\n00:00:00,000 --> 00:00:01,000\nHello\n").unwrap();
        assert!(transcript_file(&srt).is_ok());
        #[cfg(unix)] {
            let link = dir.path().join("linked.srt");
            std::os::unix::fs::symlink(&movie, &link).unwrap();
            assert!(transcript_file(&link).is_err());
        }
        assert_eq!(std::fs::read(&movie).unwrap(), b"video must stay");
    }
    #[test]
    #[cfg(target_os = "macos")]
    #[ignore = "Explicit macOS integration check; puts one generated transcript in Finder Trash"]
    fn finder_trash_moves_only_the_generated_transcript() {
        let dir = TempTree::new();
        let transcript = dir.path().join(format!("Sauce-Bunny-transcript-trash-test-{}.srt", uuid::Uuid::new_v4()));
        let movie = dir.path().join("source.mov");
        let analysis = dir.path().join("source.analysis.json");
        std::fs::write(&transcript, b"1\n00:00:00,000 --> 00:00:01,000\nTest fixture\n").unwrap();
        std::fs::write(&movie, b"source fixture").unwrap();
        std::fs::write(&analysis, b"{}").unwrap();
        trash_transcript(transcript.to_str().unwrap().into()).unwrap();
        assert!(!transcript.exists());
        assert!(movie.exists() && analysis.exists());
        assert!(trash_transcript(transcript.to_str().unwrap().into()).is_err());
    }
}
