//! Resolves only local, explicitly selected or AAF-referenced media. No mounts,
//! network protocols, filename-only relinks, or changes to source recordings.
use super::{model::*, process, store};
use crate::AppError;
use serde::Deserialize;
use std::{collections::{BTreeMap, BTreeSet}, path::{Path, PathBuf}};
use tauri::AppHandle;

pub fn locator_paths(locator: &str) -> Vec<PathBuf> {
    if locator.starts_with('/') { return vec![PathBuf::from(locator)]; }
    let Ok(url) = url::Url::parse(locator) else { return Vec::new(); };
    if url.scheme() != "file" || url.host_str().is_some_and(|h| h != "localhost") { return Vec::new(); }
    let Ok(path) = url.to_file_path() else { return Vec::new(); };
    let mut paths = vec![path.clone()];
    let text = path.to_string_lossy();
    if let Some(index) = text.find("/Volumes/") {
        if index > 0 { paths.push(PathBuf::from(&text[index..])); }
    }
    paths
}

fn mapped_paths(source: &AafSource, mappings: &[AafPathMapping]) -> BTreeSet<PathBuf> {
    let mut paths = BTreeSet::new();
    for locator in &source.locators {
        for path in locator_paths(locator) {
            for mapping in mappings {
                if let Ok(suffix) = path.strip_prefix(&mapping.from) { paths.insert(Path::new(&mapping.to).join(suffix)); }
            }
            paths.insert(path);
        }
    }
    paths
}

#[derive(Deserialize)]
struct Probe { #[serde(default)] streams: Vec<Stream>, #[serde(default)] format: Format }
#[derive(Default, Deserialize)]
struct Format { #[serde(default)] tags: BTreeMap<String, String> }
#[derive(Deserialize)]
struct Stream {
    index: u32, codec_name: Option<String>, sample_rate: Option<String>, channels: Option<u32>,
    bits_per_sample: Option<u32>, bits_per_raw_sample: Option<String>,
    duration_ts: Option<i64>, time_base: Option<String>, duration: Option<String>,
    #[serde(default)] tags: BTreeMap<String, String>,
}
fn umid(value: &str) -> String {
    value.trim().trim_start_matches("urn:smpte:umid:").trim_start_matches("0x")
        .chars().filter(|c| c.is_ascii_hexdigit()).map(|c| c.to_ascii_lowercase()).collect()
}

async fn probe(app: &AppHandle, job: &str, source: &AafSource, path: &Path) -> Result<AafResolvedSource, AppError> {
    let path = std::fs::canonicalize(path)?;
    let metadata = std::fs::metadata(&path)?;
    if !metadata.is_file() || !matches!(path.extension().and_then(|s| s.to_str()).map(str::to_ascii_lowercase).as_deref(), Some("wav" | "bwf" | "mxf")) {
        return Err(AppError::invalid("Choose a WAV, BWF, or MXF audio file"));
    }
    let result = process::run(app, job, "probe-linked-audio", "ffprobe", vec!["-v".into(), "error".into(),
        "-protocol_whitelist".into(), "file".into(), "-select_streams".into(), "a".into(),
        "-show_streams".into(), "-show_format".into(), "-of".into(), "json".into(), path.to_string_lossy().into_owned()]).await?;
    result.require_success("ffprobe")?;
    let stream_index = compatible_stream(source, &result.stdout)?;
    let fingerprint = store::source_fingerprint(&path)?;
    Ok(AafResolvedSource { path: path.to_string_lossy().into_owned(), fingerprint, stream_index,
        size: metadata.len(), modified_ms: store::modified_ms(&metadata) })
}

fn compatible_stream(source: &AafSource, json: &str) -> Result<u32, AppError> {
    let probe: Probe = serde_json::from_str(json)?;
    let streams: Vec<_> = probe.streams.iter().filter(|s| {
        let samples = s.duration_ts.zip(s.time_base.as_deref()).and_then(|(ts, base)| {
            let (n,d) = base.split_once('/')?;
            Some(ts as f64 * n.parse::<f64>().ok()? / d.parse::<f64>().ok()? * f64::from(source.sample_rate))
        }).or_else(|| s.duration.as_deref()?.parse::<f64>().ok().map(|d| d*f64::from(source.sample_rate)));
        s.codec_name.as_deref().is_some_and(|c| c.starts_with("pcm_"))
            && s.bits_per_raw_sample.as_deref().and_then(|v| v.parse::<u32>().ok()).filter(|n| *n > 0)
                .or(s.bits_per_sample.filter(|n| *n > 0)) == Some(source.sample_width * 8)
            && s.sample_rate.as_deref().and_then(|v| v.parse::<u32>().ok()) == Some(source.sample_rate)
            && s.channels == Some(source.channels) && source.channel < source.channels
            && samples.is_some_and(|n| n.is_finite() && (n-source.sample_count as f64).abs() <= 2.)
    }).collect();
    if streams.len() != 1 { return Err(AppError::invalid("Media format, channel count, or duration does not match this AAF source")); }
    let stream = streams[0];
    for (key, value) in probe.format.tags.iter().chain(stream.tags.iter()) {
        if key.eq_ignore_ascii_case("file_package_umid") && umid(value) != umid(&source.mob_id) {
            return Err(AppError::invalid("The MXF source identity does not match the AAF"));
        }
    }
    Ok(stream.index)
}

fn folder_candidates(root: &Path, check: impl Fn() -> Result<(), AppError>) -> Result<BTreeMap<String, Vec<PathBuf>>, AppError> {
    let mut found: BTreeMap<String, Vec<PathBuf>> = BTreeMap::new();
    let mut pending = vec![(root.to_path_buf(), 0)];
    let mut count = 0;
    while let Some((dir, depth)) = pending.pop() {
        for entry in std::fs::read_dir(dir)? {
            check()?;
            let entry = entry?; count += 1;
            if count > 20_000 { return Err(AppError::invalid("Choose a smaller media folder (at most 20,000 entries)")); }
            let kind = entry.file_type()?;
            if kind.is_symlink() { continue; }
            if kind.is_dir() && depth < 12 { pending.push((entry.path(), depth+1)); }
            if kind.is_file() { found.entry(entry.file_name().to_string_lossy().into_owned()).or_default().push(entry.path()); }
        }
    }
    Ok(found)
}

/// A verified user choice wins over a later same-name match. Keep its identity
/// while disconnected so reconnecting cannot quietly choose a different take.
fn refresh_binding(source: &mut AafSource) -> bool {
    let Some(binding) = &source.resolved else { return false; };
    source.status = match store::source_fingerprint(Path::new(&binding.path)) {
        Ok(fingerprint) if fingerprint == binding.fingerprint => "ready",
        Ok(_) => "needs_relink",
        Err(_) => "offline",
    }.into();
    true
}

pub async fn resolve(app: &AppHandle, document: &mut AafDocument, source_id: Option<&str>, selected: Option<&Path>, job: &str) -> Result<(), AppError> {
    let Some(graph) = document.manifest.graph.as_mut() else { return Ok(()); };
    if source_id.is_some_and(|id| !graph.sources.iter().any(|s| s.id == id)) { return Err(AppError::invalid("Unknown AAF media source")); }
    let folder = if let Some(path) = selected.filter(|p| p.is_dir()) {
        let path = path.to_path_buf();
        let owner = app.clone(); let job = job.to_owned();
        Some(tauri::async_runtime::spawn_blocking(move || folder_candidates(&path, || process::check_cancelled(&owner, &job))).await.map_err(|e| AppError::internal(e.to_string()))??)
    } else { None };
    if selected.is_some_and(|p| p.is_file()) && source_id.is_none() { return Err(AppError::invalid("Choose the source to relink first")); }
    for source in &mut graph.sources {
        process::check_cancelled(app, job)?;
        if source_id.is_some_and(|id| id != source.id) { continue; }
        if selected.is_none() && refresh_binding(source) { continue; }
        let mut candidates = mapped_paths(source, &graph.path_mappings);
        if let Some(resolved) = &source.resolved { candidates.insert(PathBuf::from(&resolved.path)); }
        if let Some(folder) = &folder {
            for path in mapped_paths(source, &[]) {
                if let Some(matches) = path.file_name().and_then(|n| folder.get(n.to_string_lossy().as_ref())) { candidates.extend(matches.iter().cloned()); }
            }
        }
        if let Some(path) = selected.filter(|p| p.is_file()) { candidates = BTreeSet::from([path.to_path_buf()]); }
        let mut valid = BTreeMap::new();
        let mut mismatch = false;
        for candidate in candidates {
            if !candidate.is_file() { continue; }
            match probe(app, job, source, &candidate).await {
                Ok(binding) => { valid.insert(binding.path.clone(), binding); },
                Err(AppError::Cancelled) => return Err(AppError::Cancelled),
                Err(error) if selected.is_some_and(|p| p.is_file()) => return Err(error),
                Err(_) => mismatch = true,
            }
        }
        let ambiguous = valid.len() > 1;
        let resolved = if valid.len() == 1 { valid.into_values().next() } else { None };
        source.status = if resolved.is_some() { "ready" } else if mismatch || ambiguous { "needs_relink" } else { "offline" }.into();
        if resolved.is_some() { source.resolved = resolved; }
        // Persist only a mapping validated by an explicit file/folder choice.
        if selected.is_some() && source.status == "ready" {
            if let Some(binding) = &source.resolved {
                if let Some(old) = source.locators.iter().flat_map(|l| locator_paths(l)).next().and_then(|p| p.parent().map(Path::to_path_buf)) {
                    if let Some(new) = Path::new(&binding.path).parent() {
                        let mapping = AafPathMapping { from: old.to_string_lossy().into_owned(), to: new.to_string_lossy().into_owned() };
                        if !graph.path_mappings.iter().any(|m| m.from == mapping.from && m.to == mapping.to) { graph.path_mappings.push(mapping); }
                    }
                }
            }
        }
    }
    refresh_lanes(&document.manifest.tracks, graph);
    Ok(())
}

pub fn refresh_lanes(tracks: &[AafTrack], graph: &mut AafGraph) {
    for lane in &mut graph.lanes {
        let Some(track) = tracks.iter().find(|t| t.id == lane.track_id) else { continue; };
        lane.availability = if track.clips.iter().any(|c| c.kind == "unavailable") { "unsupported" }
        else if track.clips.iter().filter_map(|c| c.source_id.as_ref()).filter_map(|id| graph.sources.iter().find(|s| &s.id == id)).any(|s| s.status == "needs_relink") { "needs_relink" }
        else if track.clips.iter().filter_map(|c| c.source_id.as_ref()).filter_map(|id| graph.sources.iter().find(|s| &s.id == id)).any(|s| s.resolved.is_none() || s.status != "ready") { "offline" }
        else { "ready" }.into();
    }
}

pub fn check_sources(document: &AafDocument, track: &AafTrack) -> Result<(), AppError> {
    if track.clips.iter().any(|c| c.kind == "unavailable") { return Err(AppError::invalid("This lane contains unsupported processing. See Multitrack settings.")); }
    if let Some(graph) = &document.manifest.graph {
        for source in graph.sources.iter().filter(|s| track.clips.iter().any(|c| c.source_id.as_deref() == Some(&s.id))) {
            if source.status != "ready" { return Err(AppError::not_found("Audio is unavailable. Refresh or locate media first.")); }
            let binding = source.resolved.as_ref().ok_or_else(|| AppError::not_found("Audio is offline. Locate media first."))?;
            if store::source_fingerprint(Path::new(&binding.path))? != binding.fingerprint { return Err(AppError::invalid("Linked media changed. Locate media again before processing.")); }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn source() -> AafSource {
        AafSource { id:"source:1".into(), mob_id:"urn:smpte:umid:abcd".into(), slot_id:1,
            locators:vec![], ancestors:vec![], channel:1, channels:2, sample_rate:48000,
            sample_width:2, sample_count:96000, descriptor:"PCMDescriptor".into(), status:"offline".into(), resolved:None }
    }
    #[test]
    fn verified_binding_survives_disconnection_but_never_silently_accepts_changed_media() {
        let path=std::env::temp_dir().join(format!("aaf-bound-{}",uuid::Uuid::new_v4()));
        std::fs::write(&path,b"first recording").unwrap(); let mut s=source();
        s.resolved=Some(AafResolvedSource { path:path.to_string_lossy().into_owned(),fingerprint:store::source_fingerprint(&path).unwrap(),stream_index:0,size:15,modified_ms:0 });
        let binding=s.resolved.as_ref().unwrap().fingerprint.clone();
        assert!(refresh_binding(&mut s)); assert_eq!(s.status,"ready");
        let parked=path.with_extension("offline"); std::fs::rename(&path,&parked).unwrap();
        assert!(refresh_binding(&mut s)); assert_eq!(s.status,"offline"); assert_eq!(s.resolved.as_ref().unwrap().fingerprint,binding);
        std::fs::rename(&parked,&path).unwrap(); refresh_binding(&mut s); assert_eq!(s.status,"ready");
        std::fs::write(&path,b"other recording").unwrap(); refresh_binding(&mut s); assert_eq!(s.status,"needs_relink");
        refresh_binding(&mut s); assert_eq!(s.status,"needs_relink"); assert_eq!(s.resolved.as_ref().unwrap().fingerprint,binding);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn local_locator_decoding_and_mount_prefixes_do_not_follow_network_urls() {
        assert_eq!(locator_paths("file:///Editing-Mac/Volumes/Show%20Audio/roll.wav"), vec![PathBuf::from("/Editing-Mac/Volumes/Show Audio/roll.wav"),PathBuf::from("/Volumes/Show Audio/roll.wav")]);
        for url in ["https://example.test/audio.wav","smb://nexis/roll.wav","file://remote/roll.wav","../roll.wav"] { assert!(locator_paths(url).is_empty()); }
        let mut s=source(); s.locators=vec!["file:///Volumes/Show/roll.wav".into()];
        assert!(!mapped_paths(&s,&[AafPathMapping { from:"/Volumes/Sho".into(),to:"/tmp/wrong".into() }]).contains(&PathBuf::from("/tmp/wrong/w/roll.wav")));
    }
    #[test]
    fn probe_rejects_wrong_channels_duration_compressed_audio_and_umid() {
        let s=source();
        let mut probe=serde_json::json!({"streams":[{"index":3,"codec_name":"pcm_s16le","bits_per_sample":16,"channels":2,"sample_rate":"48000","duration_ts":96000,"time_base":"1/48000"}]});
        assert_eq!(compatible_stream(&s,&probe.to_string()).unwrap(),3);
        for (key,value) in [("channels",serde_json::json!(1)),("bits_per_sample",serde_json::json!(24)),("sample_rate",serde_json::json!("44100")),("duration_ts",serde_json::json!(95000)),("codec_name",serde_json::json!("aac"))] {
            let mut invalid=probe.clone(); invalid["streams"][0][key]=value; assert!(compatible_stream(&s,&invalid.to_string()).is_err());
        }
        probe["format"]=serde_json::json!({"tags":{"file_package_umid":"0xABCD"}});
        assert!(compatible_stream(&s,&probe.to_string()).is_ok());
        probe["format"]["tags"]["file_package_umid"]=serde_json::json!("0x1234");
        assert!(compatible_stream(&s,&probe.to_string()).is_err());
    }
    #[test]
    fn scoped_folder_scan_retains_duplicates_skips_symlinks_and_cancels() {
        let root=std::env::temp_dir().join(format!("aaf-relink-{}",uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("a")).unwrap();std::fs::create_dir(root.join("b")).unwrap();
        std::fs::write(root.join("a/roll.wav"),b"fixture").unwrap();std::fs::write(root.join("b/roll.wav"),b"fixture").unwrap();
        std::os::unix::fs::symlink(root.join("a"),root.join("link")).unwrap();
        assert_eq!(folder_candidates(&root,|| Ok(())).unwrap()["roll.wav"].len(),2);
        assert!(folder_candidates(&root,|| Err(AppError::Cancelled)).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn bundled_ffprobe_validates_generated_wave_and_mxf_pcm() {
        use std::process::Command;
        let root=std::env::temp_dir().join(format!("aaf-codec-{}",uuid::Uuid::new_v4()));std::fs::create_dir(&root).unwrap();
        let bins=Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
        let ffmpeg=bins.join("ffmpeg-aarch64-apple-darwin");let ffprobe=bins.join("ffprobe-aarch64-apple-darwin");
        let mut s=source(); s.channels=1;s.channel=0;s.sample_width=3;
        for (extension,format) in [("wav","wav"),("mxf","mxf_opatom")] {
            let path=root.join(format!("generated.{extension}"));
            let result=Command::new(&ffmpeg).args(["-v","error","-f","lavfi","-i","sine=frequency=440:sample_rate=48000:duration=2","-c:a","pcm_s24le","-f",format]).arg(&path).output().unwrap();
            assert!(result.status.success(),"{}",String::from_utf8_lossy(&result.stderr));
            let result=Command::new(&ffprobe).args(["-v","error","-show_streams","-show_format","-of","json"]).arg(&path).output().unwrap();
            assert!(result.status.success()); let mut probe:serde_json::Value=serde_json::from_slice(&result.stdout).unwrap();
            // Generated MXF's file-package ID becomes the authoritative AAF ID.
            if let Some(id)=probe["format"]["tags"]["file_package_umid"].as_str() { s.mob_id=id.into(); }
            for stream in probe["streams"].as_array().unwrap() { if let Some(id)=stream["tags"]["file_package_umid"].as_str() { s.mob_id=id.into(); } }
            assert_eq!(compatible_stream(&s,&probe.to_string()).unwrap(),0);
            probe["streams"][0]["channels"]=serde_json::json!(3); assert!(compatible_stream(&s,&probe.to_string()).is_err());
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
