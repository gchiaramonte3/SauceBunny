//! Cached, read-only MXF package identities. A cache hit is tied to the current
//! file fingerprint; final FFprobe validation still runs before any relink.
use super::{linked, model::*, process, store};
use crate::AppError;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::{Path, PathBuf}};
use tauri::AppHandle;

#[derive(Clone, Deserialize, Serialize)]
pub struct MxfTrack { pub material_track_id: u32, pub mob_id: String, pub slot_id: u32, pub aligned: bool }
#[derive(Clone, Deserialize, Serialize)]
struct Header {
    path: String,
    #[serde(default)] fingerprint: String,
    #[serde(default)] tracks: Vec<MxfTrack>,
    #[serde(default)] error: Option<String>,
}
#[derive(Deserialize)]
struct Headers { schema_version: u32, files: Vec<Header> }

#[derive(Default)]
pub struct ProbeCache {
    headers: BTreeMap<PathBuf, Header>,
    probes: BTreeMap<(String, String), String>,
}
impl ProbeCache {
    pub async fn index(&mut self, app: &AppHandle, job: &str, paths: &[PathBuf]) -> Result<(), AppError> {
        let root = store::cache(app)?;
        for chunk in paths.chunks(256) {
            let mut pending = BTreeMap::new();
            for path in chunk {
                process::check_cancelled(app, job)?;
                let Ok(path) = std::fs::canonicalize(path) else { continue; };
                let Ok(fingerprint) = store::source_fingerprint(&path) else { continue; };
                if self.headers.get(&path).is_some_and(|h| h.fingerprint == fingerprint) { continue; }
                let cache = root.join(format!("mxf-header-v1-{fingerprint}.json"));
                if let Ok(mut header) = store::read_json::<Header>(&cache) {
                    if header.fingerprint == fingerprint && header.error.is_none() && header.tracks.len() <= 256 {
                        header.path = path.to_string_lossy().into_owned();
                        self.headers.insert(path, header); continue;
                    }
                }
                pending.insert(path, (fingerprint, cache));
            }
            if pending.is_empty() { continue; }
            let mut args = vec!["mxf-info".into(), "--input".into()];
            args.extend(pending.keys().map(|p| p.to_string_lossy().into_owned()));
            let result = process::run(app, job, "inspect-mxf", "saucebunny-aaf", args).await?;
            result.require_success("saucebunny-aaf")?;
            let headers: Headers = serde_json::from_str(&result.stdout)?;
            if headers.schema_version != 1 || headers.files.len() != pending.len() { return Err(AppError::invalid("Invalid MXF inspection response")); }
            for mut header in headers.files {
                let path = PathBuf::from(&header.path);
                let Some((expected, cache)) = pending.remove(&path) else { return Err(AppError::invalid("Unexpected MXF inspection path")); };
                process::check_cancelled(app, job)?;
                if store::source_fingerprint(&path)? != expected { return Err(AppError::invalid("MXF changed during inspection. Refresh availability.")); }
                if header.error.is_none() {
                    if header.fingerprint != expected || header.tracks.len() > 256 { return Err(AppError::invalid("Invalid MXF inspection identity")); }
                    crate::commands::system::write_bytes_impl(&cache.to_string_lossy(), &serde_json::to_vec(&header)?, false, false, true)?;
                }
                header.fingerprint = expected;
                self.headers.insert(path, header);
            }
        }
        Ok(())
    }

    pub fn matches(&self, source: &AafSource) -> Vec<PathBuf> {
        self.headers.iter().filter(|(_, h)| h.error.is_none() && h.tracks.iter().any(|t| linked::umid(&t.mob_id) == linked::umid(&source.mob_id) && t.slot_id == source.slot_id))
            .map(|(path, _)| path.clone()).collect()
    }

    pub async fn probe(&mut self, app: &AppHandle, job: &str, source: &AafSource, path: &Path) -> Result<AafResolvedSource, AppError> {
        let path = std::fs::canonicalize(path)?;
        let metadata = std::fs::metadata(&path)?;
        let extension = path.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
        if !metadata.is_file() || !matches!(extension.as_str(), "wav" | "bwf" | "mxf") { return Err(AppError::invalid("Choose a WAV, BWF, or MXF audio file")); }
        let fingerprint = store::source_fingerprint(&path)?;
        let selector = if extension == "mxf" {
            self.index(app, job, std::slice::from_ref(&path)).await?;
            let header = self.headers.get(&path).ok_or_else(|| AppError::invalid("MXF is unreadable. Check the mounted workspace and file permissions."))?;
            if let Some(error) = &header.error { return Err(AppError::invalid(error.clone())); }
            format!("i:{}", material_track(&header.tracks, source)?)
        } else { "a".into() };
        let key = (fingerprint.clone(), selector.clone());
        if !self.probes.contains_key(&key) {
            let result = process::run(app, job, "probe-linked-audio", "ffprobe", vec!["-v".into(), "error".into(),
                "-protocol_whitelist".into(), "file".into(), "-select_streams".into(), selector,
                "-show_streams".into(), "-show_format".into(), "-of".into(), "json".into(), path.to_string_lossy().into_owned()]).await?;
            result.require_success("ffprobe")?;
            self.probes.insert(key.clone(), result.stdout);
        }
        let stream_index = linked::compatible_stream(source, &self.probes[&key])?;
        if store::source_fingerprint(&path)? != fingerprint { return Err(AppError::invalid("Media changed while relinking. Refresh availability.")); }
        Ok(AafResolvedSource { path: path.to_string_lossy().into_owned(), fingerprint, stream_index,
            size: metadata.len(), modified_ms: store::modified_ms(&metadata) })
    }
}

pub fn material_track(tracks: &[MxfTrack], source: &AafSource) -> Result<u32, AppError> {
    let matches: Vec<_> = tracks.iter().filter(|t| linked::umid(&t.mob_id) == linked::umid(&source.mob_id) && t.slot_id == source.slot_id).collect();
    if matches.len() != 1 {
        let observed = tracks.iter().take(8).map(|t| format!("{} slot {} → material track {}", t.mob_id, t.slot_id, t.material_track_id)).collect::<Vec<_>>().join("; ");
        return Err(AppError::invalid(format!("MXF source identity {} or audio slot {} does not match this AAF. Choose the original Avid media, not a recorder-file ancestor. Observed: {observed}", source.mob_id, source.slot_id)));
    }
    if !matches[0].aligned { return Err(AppError::invalid("MXF has a nonzero internal audio origin that needs an additional timing transform. This source has not been relinked.")); }
    Ok(matches[0].material_track_id)
}
