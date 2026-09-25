//! Cached, read-only MXF package identities. A cache hit is tied to the current
//! file fingerprint. Headers are read natively (`mxf_header`), falling back to
//! the sidecar's full parser; FFprobe confirms any format the header cannot.
use super::{diagnostics, linked, model::*, mxf_header::{self, MxfSound}, process, store};
use futures_util::{stream, StreamExt};
use crate::AppError;
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::{Path, PathBuf}};
use tauri::AppHandle;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct MxfTrack { pub material_track_id: u32, pub mob_id: String, pub slot_id: u32, pub aligned: bool }
#[derive(Clone, Deserialize, Serialize)]
struct Header {
    path: String,
    #[serde(default)] fingerprint: String,
    #[serde(default)] tracks: Vec<MxfTrack>,
    #[serde(default)] sound: Option<MxfSound>,
    #[serde(default)] error: Option<String>,
}
#[derive(Deserialize)]
struct Headers { schema_version: u32, files: Vec<Header> }

#[derive(Default)]
pub struct ProbeCache {
    headers: BTreeMap<PathBuf, Header>,
    probes: BTreeMap<(String, String), String>,
    fingerprints: BTreeMap<PathBuf, (u64, u128, String)>,
    memory_hits: usize,
    disk_hits: usize,
    misses: usize,
    header_ms: u128,
    ffprobe_ms: u128,
}

/// Headers read per pass. A bigger batch still checkpoints and honours Stop.
const INSPECT_BATCH: usize = 32;
/// Native header reads in flight. Each is one or two small reads, so on a
/// network volume the wait is latency and overlapping them is the win.
const NATIVE_READS: usize = 8;
impl ProbeCache {
    pub async fn index(&mut self, app: &AppHandle, job: &str, paths: &[PathBuf]) -> Result<(), AppError> {
        let root = store::cache(app)?;
        for chunk in paths.chunks(INSPECT_BATCH) {
            let mut pending = BTreeMap::new();
            for path in process::until_cancelled(app, job, self.prefetch_fingerprints(chunk)).await? {
                let started = std::time::Instant::now();
                process::check_cancelled(app, job)?;
                let fingerprint = match self.fingerprint(&path) {
                    Ok(fingerprint) => fingerprint,
                    Err(error) => { diagnostics::log(app, job, "warn", "mxf-file", &format!("{} · {error} · skipped", path.display())); continue; }
                };
                if self.headers.get(&path).is_some_and(|h| h.fingerprint == fingerprint) { self.memory_hits += 1; continue; }
                let cache = root.join(format!("mxf-header-v2-{fingerprint}.json"));
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
            let native: Vec<_> = process::until_cancelled(app, job, stream::iter(pending.keys().cloned().collect::<Vec<_>>()).map(|path| async move {
                let started = std::time::Instant::now();
                let read = path.clone();
                let result = tauri::async_runtime::spawn_blocking(move || mxf_header::read(&read)).await
                    .map_err(|e| AppError::internal(e.to_string())).and_then(|r| r);
                (path, result, started.elapsed().as_millis())
            }).buffered(NATIVE_READS).collect()).await?;
            for (path, result, ms) in native {
                process::check_cancelled(app, job)?;
                self.header_ms += ms;
                match result {
                    Ok(inspection) => {
                        let Some((expected, cache)) = pending.remove(&path) else { continue; };
                        if !self.unchanged(app, job, &path, &expected) { continue; }
                        diagnostics::log(app, job, "info", "mxf-file", &format!("{} · {} audio mappings · {ms} ms", path.display(), inspection.tracks.len()));
                        let header = Header { path: path.to_string_lossy().into_owned(), fingerprint: expected, tracks: inspection.tracks, sound: inspection.sound, error: None };
                        crate::commands::system::write_bytes_impl(&cache.to_string_lossy(), &serde_json::to_vec(&header)?, false, false, true)?;
                        self.headers.insert(path, header);
                    }
                    // Unusual layouts go to the full parser; nothing is rejected here.
                    Err(error) => diagnostics::log(app, job, "info", "mxf-file", &format!("{} · {error} · using the full parser", path.display())),
                }
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
                // The sidecar hashes the file itself, so a mismatch is the same
                // mid-capture change the stat check catches, seen from its side.
                if !self.unchanged(app, job, &path, &expected) { continue; }
                if header.error.is_none() && header.fingerprint != expected {
                    diagnostics::log(app, job, "warn", "mxf-file", &format!("{} · changed during inspection · skipped", path.display()));
                    continue;
                }
                if header.error.is_none() {
                    if header.tracks.len() > 256 { return Err(AppError::invalid("Invalid MXF inspection identity")); }
                    if !header.tracks.is_empty() {
                        crate::commands::system::write_bytes_impl(&cache.to_string_lossy(), &serde_json::to_vec(&header)?, false, false, true)?;
                    }
                }
                header.fingerprint = expected;
                self.headers.insert(path, header);
            }
        }
        Ok(())
    }

    pub fn report(&self, app: &AppHandle, job: &str) {
        diagnostics::log(app, job, "info", "mxf-cache", &format!("MXF header cache: {} memory hits · {} disk hits · {} misses · headers {} ms · ffprobe {} ms",
            self.memory_hits, self.disk_hits, self.misses, self.header_ms, self.ffprobe_ms));
    }

    /// Canonicalize a chunk and fill the fingerprint memo concurrently. Each
    /// fingerprint reads both ends of the file, so on NEXIS a chunk used to pay
    /// one serial round trip per file (all of them on a warm, all-disk-hit
    /// relink) before a single header read began. Returns the chunk's paths,
    /// canonical where possible, in order; a failed fingerprint is retried and
    /// reported by the caller.
    pub(super) async fn prefetch_fingerprints(&mut self, chunk: &[PathBuf]) -> Vec<PathBuf> {
        let known: std::sync::Arc<BTreeMap<PathBuf, (u64, u128)>> = std::sync::Arc::new(
            self.fingerprints.iter().map(|(path, (len, modified, _))| (path.clone(), (*len, *modified))).collect());
        let found: Vec<_> = stream::iter(chunk.to_vec()).map(|path| { let known = known.clone(); async move {
            tauri::async_runtime::spawn_blocking(move || {
                // An unreadable path is kept so the caller logs why, rather than
                // the file silently leaving identity matching.
                let path = std::fs::canonicalize(&path).unwrap_or(path);
                let metadata = std::fs::metadata(&path).ok();
                let stamp = metadata.as_ref().map(stamp);
                let fresh = stamp.filter(|stamp| known.get(&path) != Some(stamp))
                    .and_then(|stamp| store::source_fingerprint(&path).ok().map(|value| (stamp, value)));
                (path, fresh)
            }).await.ok()
        }}).buffered(NATIVE_READS).collect().await;
        found.into_iter().flatten().map(|(path, fresh)| {
            if let Some(((len, modified), value)) = fresh { self.fingerprints.insert(path.clone(), (len, modified, value)); }
            path
        }).collect()
    }

    /// A file that changed while its header was read (another workstation is
    /// still capturing into the workspace) is left out of this pass rather than
    /// ending the relink for every other source. A later probe of that path
    /// re-reads it from scratch.
    fn unchanged(&mut self, app: &AppHandle, job: &str, path: &Path, expected: &str) -> bool {
        match self.fingerprint(path) {
            Ok(current) if current == expected => true,
            Ok(_) => { diagnostics::log(app, job, "warn", "mxf-file", &format!("{} · changed during inspection · skipped", path.display())); false }
            Err(error) => { diagnostics::log(app, job, "warn", "mxf-file", &format!("{} · {error} · skipped", path.display())); false }
        }
    }

    /// Fingerprint once per file per job. The fingerprint reads both ends of
    /// the file, which is a network round trip on NEXIS; a stat that still
    /// shows the same size and mtime reuses it, any change rehashes.
    pub(super) fn fingerprint(&mut self, path: &Path) -> Result<String, AppError> {
        let stamp = stamp(&std::fs::metadata(path)?);
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
            let track = material_track(&header.tracks, source)?;
            // A single-track PCM header that states this source's exact format
            // is the proof ffprobe would give, without a process per file.
            // Playback still decodes through ffmpeg, so a lying file fails loudly.
            if header.tracks.len() == 1 && header.sound.as_ref().is_some_and(|sound| header_proves_format(sound, source)) {
                if self.fingerprint(&path)? != fingerprint { return Err(AppError::invalid("Media changed while relinking. Refresh availability.")); }
                return Ok(AafResolvedSource { path: path.to_string_lossy().into_owned(), fingerprint, stream_index: 0,
                    size: metadata.len(), modified_ms: store::modified_ms(&metadata) });
            }
            format!("i:{track}")
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

fn header_proves_format(sound: &MxfSound, source: &AafSource) -> bool {
    sound.pcm && sound.sample_rate == source.sample_rate && sound.bits == source.sample_width * 8
        && sound.channels == source.channels && source.channel < source.channels
        && sound.samples.abs_diff(source.sample_count) <= 2
}

fn same_source(track: &MxfTrack, source: &AafSource) -> bool {
    linked::umid(&track.mob_id) == linked::umid(&source.mob_id) && track.slot_id == source.slot_id
}

/// Size and nanosecond mtime: the same resolution the fingerprint hashes, so a
/// same-size rewrite within one millisecond is still seen as a change.
fn stamp(metadata: &std::fs::Metadata) -> (u64, u128) {
    (metadata.len(), metadata.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos()))
}

fn reusable_header(header: &Header, fingerprint: &str) -> bool {
    header.fingerprint == fingerprint && header.error.is_none() && (1..=256).contains(&header.tracks.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn empty_failed_or_changed_headers_are_never_persistent_cache_hits() {
        let mut header = Header { path: "audio.mxf".into(), fingerprint: "one".into(), tracks: vec![], sound: None, error: None };
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

    #[tokio::test]
    async fn prefetch_fills_the_memo_in_order_and_keeps_unreadable_paths() {
        let dir = std::env::temp_dir().join(format!("probe-prefetch-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        let files: Vec<_> = (0..12).map(|i| { let path = dir.join(format!("{i}.mxf")); std::fs::write(&path, vec![b'x'; i + 1]).unwrap(); path }).collect();
        let mut chunk = files.clone(); chunk.insert(3, dir.join("missing.mxf"));
        let mut cache = ProbeCache::default();
        let found = cache.prefetch_fingerprints(&chunk).await;
        let mut expected: Vec<_> = files.iter().map(|p| std::fs::canonicalize(p).unwrap()).collect();
        expected.insert(3, dir.join("missing.mxf"));
        assert_eq!(found, expected, "an unreadable path is kept so the caller can report it");
        assert_eq!(cache.fingerprints.len(), files.len());
        for path in found.iter().filter(|p| p.exists()) { assert_eq!(cache.fingerprint(path).unwrap(), store::source_fingerprint(path).unwrap()); }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn only_an_exact_single_channel_pcm_header_skips_ffprobe() {
        let source: AafSource = serde_json::from_value(serde_json::json!({"id":"s","mob_id":"mob","slot_id":1,"locators":[],"ancestors":[],"channel":0,"channels":1,
            "sample_rate":48000,"sample_width":3,"sample_count":96000,"descriptor":"PCMDescriptor","status":"offline"})).unwrap();
        let exact = MxfSound { sample_rate: 48000, bits: 24, channels: 1, samples: 96001, pcm: true };
        assert!(header_proves_format(&exact, &source));
        for other in [MxfSound { pcm: false, ..exact.clone() }, MxfSound { bits: 16, ..exact.clone() }, MxfSound { sample_rate: 44100, ..exact.clone() },
            MxfSound { channels: 2, ..exact.clone() }, MxfSound { samples: 96010, ..exact.clone() }] {
            assert!(!header_proves_format(&other, &source));
        }
    }
}