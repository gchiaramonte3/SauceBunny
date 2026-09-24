//! Cached, read-only MXF package identities. A cache hit is tied to the current
//! file fingerprint; final FFprobe validation still runs before any relink.
use super::{diagnostics, linked, model::*, process, store};
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
    fingerprints: BTreeMap<PathBuf, (u64, u64, String)>,
    memory_hits: usize,
    disk_hits: usize,
    misses: usize,
    header_ms: u128,
    ffprobe_ms: u128,
}

/// Headers read per sidecar launch. One launch per few files was most of an
/// import on NEXIS; a bigger batch still checkpoints and honours Stop.
const INSPECT_BATCH: usize = 32;
impl ProbeCache {
    pub async fn index(&mut self, app: &AppHandle, job: &str, paths: &[PathBuf]) -> Result<(), AppError> {
        let root = store::cache(app)?;
        for chunk in paths.chunks(INSPECT_BATCH) {
            let mut pending = BTreeMap::new();
            for path in chunk {
                let started = std::time::Instant::now();
                process::check_cancelled(app, job)?;
                let Ok(path) = std::fs::canonicalize(path) else { continue; };
                let Ok(fingerprint) = self.fingerprint(&path) else { continue; };
                if self.headers.get(&path).is_some_and(|h| h.fingerprint == fingerprint) { self.memory_hits += 1; continue; }
                let cache = root.join(format!("mxf-header-v1-{fingerprint}.json"));
                if let Ok(mut header) = store::read_json::<Header>(&cache) {
                    if reusable_header(&header, &fingerprint) {
                        self.disk_hits += 1;
                        diagnostics::log(app, job, "ok", "mxf-cache", &format!("{} · disk hit · {} ms", path.display(), started.elapsed().as_millis()));
                        header.path = path.to_string_lossy().into_owned();
                        self.headers.insert(path, header); continue;
                    }
                }
                self.misses += 1;
                pending.insert(path, (fingerprint, cache));
            }
            if pending.is_empty() { continue; }
            let mut args = vec!["mxf-info".into(), "--input".into()];
            args.extend(pending.keys().map(|p| p.to_string_lossy().into_owned()));
            let started = std::time::Instant::now();
            let result = process::run(app, job, "inspect-mxf", "saucebunny-aaf", args).await?;
            self.header_ms += started.elapsed().as_millis();
            result.require_success("saucebunny-aaf")?;
            let headers: Headers = serde_json::from_str(&result.stdout)?;
            if headers.schema_version != 1 || headers.files.len() != pending.len() { return Err(AppError::invalid("Invalid MXF inspection response")); }
            for mut header in headers.files {
                let path = PathBuf::from(&header.path);
                let Some((expected, cache)) = pending.remove(&path) else { return Err(AppError::invalid("Unexpected MXF inspection path")); };
                process::check_cancelled(app, job)?;
                if self.fingerprint(&path)? != expected { return Err(AppError::invalid("MXF changed during inspection. Refresh availability.")); }
                if header.error.is_none() {
                    if header.fingerprint != expected || header.tracks.len() > 256 { return Err(AppError::invalid("Invalid MXF inspection identity")); }
                    if !header.tracks.is_empty() {
                        crate::commands::system::write_bytes_impl(&cache.to_string_lossy(), &serde_json::to_vec(&header)?, false, false, true)?;
                    }
                }
                header.fingerprint = expected;
                self.headers.insert(path, header);
            }
        }
        self.report(app, job);
        Ok(())
    }

    pub fn report(&self, app: &AppHandle, job: &str) {
        diagnostics::log(app, job, "info", "mxf-cache", &format!("MXF header cache: {} memory hits · {} disk hits · {} misses · headers {} ms · ffprobe {} ms",
            self.memory_hits, self.disk_hits, self.misses, self.header_ms, self.ffprobe_ms));
    }

    /// Fingerprint once per file per job. The fingerprint reads both ends of
    /// the file, which is a network round trip on NEXIS; a stat that still
    /// shows the same size and mtime reuses it, any change rehashes.
    fn fingerprint(&mut self, path: &Path) -> Result<String, AppError> {
        let metadata = std::fs::metadata(path)?;
        let stamp = (metadata.len(), store::modified_ms(&metadata));
        if let Some((len, modified, value)) = self.fingerprints.get(path) {
            if (*len, *modified) == stamp { return Ok(value.clone()); }
        }
        let value = store::source_fingerprint(path)?;
        self.fingerprints.insert(path.to_path_buf(), (stamp.0, stamp.1, value.clone()));
        Ok(value)
    }

    pub fn matches(&self, source: &AafSource) -> Vec<PathBuf> {
        self.headers.iter().filter(|(_, h)| h.error.is_none() && h.tracks.iter().any(|t| same_source(t, source)))
            .map(|(path, _)| path.clone()).collect()
    }

    pub async fn probe(&mut self, app: &AppHandle, job: &str, source: &AafSource, path: &Path) -> Result<AafResolvedSource, AppError> {
        let path = std::fs::canonicalize(path)?;
        let metadata = std::fs::metadata(&path)?;
        let extension = path.extension().and_then(|s| s.to_str()).unwrap_or("").to_ascii_lowercase();
        if !metadata.is_file() || !matches!(extension.as_str(), "wav" | "bwf" | "mxf") { return Err(AppError::invalid("Choose a WAV, BWF, or MXF audio file")); }
        let fingerprint = self.fingerprint(&path)?;
        let selector = if extension == "mxf" {
            self.index(app, job, std::slice::from_ref(&path)).await?;
            let header = self.headers.get(&path).ok_or_else(|| AppError::invalid("MXF is unreadable. Check the mounted workspace and file permissions."))?;
            if let Some(error) = &header.error { return Err(AppError::invalid(error.clone())); }
            format!("i:{}", material_track(&header.tracks, source)?)
        } else { "a".into() };
        let key = (fingerprint.clone(), selector.clone());
        if !self.probes.contains_key(&key) {
            let started = std::time::Instant::now();
            let result = process::run(app, job, "probe-linked-audio", "ffprobe", vec!["-v".into(), "error".into(),
                "-protocol_whitelist".into(), "file".into(), "-select_streams".into(), selector,
                "-show_streams".into(), "-show_format".into(), "-of".into(), "json".into(), path.to_string_lossy().into_owned()]).await?;
            self.ffprobe_ms += started.elapsed().as_millis();
            result.require_success("ffprobe")?;
            self.probes.insert(key.clone(), result.stdout);
        }
        let stream_index = linked::compatible_stream(source, &self.probes[&key])?;
        if self.fingerprint(&path)? != fingerprint { return Err(AppError::invalid("Media changed while relinking. Refresh availability.")); }
        Ok(AafResolvedSource { path: path.to_string_lossy().into_owned(), fingerprint, stream_index,
            size: metadata.len(), modified_ms: store::modified_ms(&metadata) })
    }
}

pub fn material_track(tracks: &[MxfTrack], source: &AafSource) -> Result<u32, AppError> {
    if tracks.is_empty() { return Err(AppError::invalid("MXF header has no recognized audio source mappings. This does not establish a source-identity mismatch. Export diagnostics for this file.")); }
    let matches: Vec<_> = tracks.iter().filter(|t| same_source(t, source)).collect();
    if matches.len() > 1 { return Err(AppError::invalid(format!("MXF maps {} audio tracks to source {} slot {}. This source has not been relinked.", matches.len(), source.mob_id, source.slot_id))); }
    if matches.is_empty() {
        let observed = tracks.iter().take(8).map(|t| format!("{} slot {} → material track {}", t.mob_id, t.slot_id, t.material_track_id)).collect::<Vec<_>>().join("; ");
        return Err(AppError::invalid(format!("This MXF belongs to a different source. The AAF expects {} slot {}; the MXF header has: {observed}", source.mob_id, source.slot_id)));
    }
    if !matches[0].aligned { return Err(AppError::invalid("MXF has a nonzero internal audio origin that needs an additional timing transform. This source has not been relinked.")); }
    Ok(matches[0].material_track_id)
}

fn same_source(track: &MxfTrack, source: &AafSource) -> bool {
    linked::umid(&track.mob_id) == linked::umid(&source.mob_id) && track.slot_id == source.slot_id
}

fn reusable_header(header: &Header, fingerprint: &str) -> bool {
    header.fingerprint == fingerprint && header.error.is_none() && (1..=256).contains(&header.tracks.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn empty_failed_or_changed_headers_are_never_persistent_cache_hits() {
        let mut header = Header { path: "audio.mxf".into(), fingerprint: "one".into(), tracks: vec![], error: None };
        assert!(!reusable_header(&header, "one"));
        header.tracks.push(MxfTrack { material_track_id: 1, mob_id: "abcd".into(), slot_id: 1, aligned: true });
        assert!(reusable_header(&header, "one"));
        assert!(!reusable_header(&header, "two"));
        header.error = Some("Unreadable".into());
        assert!(!reusable_header(&header, "one"));
    }

    #[test]
    fn fingerprints_are_reused_until_size_or_mtime_changes() {
        let path = std::env::temp_dir().join(format!("probe-fingerprint-{}.mxf", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"first contents").unwrap();
        let modified = std::fs::metadata(&path).unwrap().modified().unwrap();
        let mut cache = ProbeCache::default();
        let first = cache.fingerprint(&path).unwrap();
        // Same size and mtime: the memo answers without rereading the file.
        std::fs::write(&path, b"other contents").unwrap();
        std::fs::File::options().write(true).open(&path).unwrap().set_modified(modified).unwrap();
        assert_eq!(cache.fingerprint(&path).unwrap(), first);
        // Any size change rehashes.
        std::fs::write(&path, b"longer replacement contents").unwrap();
        assert_ne!(cache.fingerprint(&path).unwrap(), first);
        std::fs::remove_file(path).unwrap();
    }
}
