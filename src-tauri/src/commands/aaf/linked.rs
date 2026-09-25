//! Resolves only local, explicitly selected or AAF-referenced media. No mounts,
//! network protocols, filename-only relinks, or changes to source recordings.
use super::{diagnostics, linked_paths, linked_probe::ProbeCache, model::*, process, store};
use crate::AppError;
use serde::Deserialize;
use std::{collections::{BTreeMap, BTreeSet}, path::{Path, PathBuf}};
use tauri::AppHandle;

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
pub(super) fn umid(value: &str) -> String {
    value.trim().trim_start_matches("urn:smpte:umid:").trim_start_matches("0x")
        .chars().filter(|c| c.is_ascii_hexdigit()).map(|c| c.to_ascii_lowercase()).collect()
}

pub(super) fn compatible_stream(source: &AafSource, json: &str) -> Result<u32, AppError> {
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
    if streams.len() != 1 {
        let observed = probe.streams.iter().take(8).map(|s| format!("stream {}: codec {}, channels {:?}, rate {:?}, bits {:?}/{:?}, duration_ts {:?}, time_base {:?}, duration {:?}", s.index, s.codec_name.as_deref().unwrap_or("unknown"), s.channels, s.sample_rate, s.bits_per_raw_sample, s.bits_per_sample, s.duration_ts, s.time_base, s.duration)).collect::<Vec<_>>().join("; ");
        return Err(AppError::invalid(format!("No unique PCM stream matches {} channels, {} Hz, {}-bit, and {} samples. Choose the original Avid media file. Observed: {observed}", source.channels, source.sample_rate, source.sample_width*8, source.sample_count)));
    }
    let stream = streams[0];
    for (key, value) in probe.format.tags.iter().chain(stream.tags.iter()) {
        if key.eq_ignore_ascii_case("file_package_umid") && umid(value) != umid(&source.mob_id) {
            return Err(AppError::invalid(format!("The MXF source identity does not match the AAF: expected {}, observed {value}", source.mob_id)));
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
            if kind.is_dir() {
                if depth >= 12 { return Err(AppError::invalid("Media folders are nested too deeply. Choose a closer MXF subfolder.")); }
                pending.push((entry.path(), depth+1));
            }
            if kind.is_file() { found.entry(entry.file_name().to_string_lossy().into_owned()).or_default().push(entry.path()); }
        }
    }
    Ok(found)
}

/// A verified user choice wins over a later same-name match. Keep its identity
/// while disconnected so reconnecting cannot quietly choose a different take.
fn refresh_binding(source: &mut AafSource) -> bool {
    let Some(binding) = &source.resolved else { return false; };
    let (status, note) = match store::source_fingerprint(Path::new(&binding.path)) {
        Ok(fingerprint) if fingerprint == binding.fingerprint => ("ready", None),
        Ok(_) => ("needs_relink", Some("Previously linked media changed. Locate the original recording again.".to_owned())),
        Err(error) => ("offline", Some(format!("Previously linked media is unavailable: {} · {error}. Reconnect the workspace, then refresh; or locate its new folder.", binding.path))),
    };
    source.status = status.into();
    source.resolution_note = note;
    true
}

/// Sources resolved (and saved as one checkpoint) per pass. Each pass costs
/// one header-reader launch, so this trades Stop granularity for NEXIS time.
const RESOLVE_BATCH: usize = 32;

pub async fn resolve(app: &AppHandle, document: &mut AafDocument, source_id: Option<&str>, selected: Option<&Path>, job: &str,
    mut checkpoint: impl FnMut(&AafGraph) -> Result<(), AppError>) -> Result<(), AppError> {
    let Some(graph) = document.manifest.graph.as_mut() else { return Ok(()); };
    diagnostics::log(app, job, "info", "media", &format!("Resolve {} linked sources · {} saved path mappings", graph.sources.len(), graph.path_mappings.len()));
    if source_id.is_some_and(|id| !graph.sources.iter().any(|s| s.id == id)) { return Err(AppError::invalid("Unknown AAF media source")); }
    let selected = selected.map(std::fs::canonicalize).transpose()?;
    let selected = selected.as_deref();
    let root = selected.filter(|p| p.is_dir());
    if selected.is_some_and(|p| p.is_file()) && source_id.is_none() { return Err(AppError::invalid("Choose the source to relink first")); }
    let mut cache = ProbeCache::default();
    // Visible sequence microphones first; alternatives never delay them.
    // Batches amortize runtime startup without holding every source hostage.
    let order = resolution_order(&document.manifest.tracks, graph, source_id);
    let total = order.len() as i64;
    let mut completed = 0;
    process::progress(app, job, None, "resolving", 0, total);
    for batch in order.chunks(RESOLVE_BATCH) {
    let mut direct_mxfs = BTreeSet::new();
    for &index in batch {
        let source = &graph.sources[index];
        if selected.is_none() && source.resolved.is_some() { continue; }
        let mut paths = linked_paths::candidates(source, &graph.path_mappings);
        if let Some(root) = root { paths.extend(linked_paths::under_root(source, root).into_iter().filter(|p| linked_paths::contained(p, root))); }
        if let Some(file) = selected.filter(|p| p.is_file()) { paths = BTreeSet::from([file.to_path_buf()]); }
        for path in paths {
            process::check_cancelled(app, job)?;
            if path.is_file() && path.extension().is_some_and(|e| e.eq_ignore_ascii_case("mxf")) {
                direct_mxfs.insert(path);
            }
        }
    }
    cache.index(app, job, &direct_mxfs.into_iter().collect::<Vec<_>>()).await?;
    for &index in batch {
        let source = &mut graph.sources[index];
        process::check_cancelled(app, job)?;
        if selected.is_none() && refresh_binding(source) {
            diagnostics::log(app, job, if source.status == "ready" { "ok" } else { "warn" }, "media", &format!("{} · {} · {}", source.id, source.status, source.resolution_note.as_deref().unwrap_or("Verified saved binding")));
        } else {
        let mut candidates = linked_paths::candidates(source, &graph.path_mappings);
        if let Some(resolved) = &source.resolved { candidates.insert(PathBuf::from(&resolved.path)); }
        if let Some(root) = root {
            candidates.extend(linked_paths::under_root(source, root).into_iter().filter(|p| linked_paths::contained(p, root)));
        }
        if let Some(path) = selected.filter(|p| p.is_file()) { candidates = BTreeSet::from([path.to_path_buf()]); }
        choose(app, job, source, candidates, &mut cache).await?;
        if selected.is_some() && source.status == "ready" { linked_paths::remember(source, &mut graph.path_mappings); }
        }
        completed += 1;
        process::progress(app, job, None, "resolving", completed, total);
    }
    process::check_cancelled(app, job)?;
    refresh_lanes(&document.manifest.tracks, graph);
    checkpoint(graph)?;
    }
    // Most NEXIS relinks finish above, without enumerating a workspace. Only
    // unresolved sources trigger a bounded scan of the folder the user chose.
    if let Some(root) = root.filter(|_| graph.sources.iter().any(|s| s.status != "ready" && source_id.is_none_or(|id| id == s.id))) {
        let folder_root = root.to_path_buf();
        let owner = app.clone(); let job_id = job.to_owned();
        process::progress(app, job, None, "searching-media", 0, total);
        diagnostics::log(app, job, "info", "search", &format!("Search only the chosen folder: {}", root.display()));
        let folder = tauri::async_runtime::spawn_blocking(move || folder_candidates(&folder_root, || process::check_cancelled(&owner, &job_id))).await.map_err(|e| AppError::internal(e.to_string()))?;
        match folder {
            Ok(folder) => {
                // Header cache doubles as a source-identity index for renamed
                // MXFs. Never match a recorder ancestor or use filename alone.
                let mxfs: Vec<_> = folder.values().flatten().filter(|p| p.extension().is_some_and(|e| e.eq_ignore_ascii_case("mxf")) && linked_paths::contained(p, root)).cloned().collect();
                let index_all = mxfs.len() <= 5000;
                if index_all { cache.index(app, job, &mxfs).await?; }
                for batch in order.chunks(RESOLVE_BATCH) {
                for &index in batch {
                    let source = &mut graph.sources[index];
                    process::check_cancelled(app, job)?;
                    if source.status == "ready" || source_id.is_some_and(|id| id != source.id) { continue; }
                    let mut candidates: BTreeSet<_> = cache.matches(source).into_iter().filter(|p| linked_paths::contained(p, root)).collect();
                    for locator in linked_paths::locators(source) {
                        if let Some(matches) = locator.path.file_name().and_then(|n| folder.get(n.to_string_lossy().as_ref())) { candidates.extend(matches.iter().filter(|p| linked_paths::contained(p, root)).cloned()); }
                    }
                    choose(app, job, source, candidates, &mut cache).await?;
                    if source.status == "ready" { linked_paths::remember(source, &mut graph.path_mappings); }
                    else if !index_all { source.resolution_note = Some("More than 5,000 MXFs in this folder. Choose a numbered MXF subfolder to search renamed files by identity.".into()); }
                }
                refresh_lanes(&document.manifest.tracks, graph);
                process::check_cancelled(app, job)?;
                checkpoint(graph)?;
                }
            }
            Err(AppError::Cancelled) => return Err(AppError::Cancelled),
            Err(error) => {
                diagnostics::log(app, job, "err", "search", &error.to_string());
                for source in &mut graph.sources {
                    if source.status != "ready" && source_id.is_none_or(|id| id == source.id) { source.resolution_note = Some(error.to_string()); }
                }
            },
        }
    }
    refresh_lanes(&document.manifest.tracks, graph);
    process::check_cancelled(app, job)?;
    checkpoint(graph)?;
    cache.report(app, job);
    let ready = graph.sources.iter().filter(|s| s.status == "ready" && s.resolved.is_some()).count();
    diagnostics::log(app, job, if ready == graph.sources.len() { "ok" } else { "warn" }, "media", &format!("{ready}/{} linked sources available; unavailable media is not timeline silence. Saved transcripts are retained.", graph.sources.len()));
    Ok(())
}

fn resolution_order(tracks: &[AafTrack], graph: &AafGraph, source_id: Option<&str>) -> Vec<usize> {
    let selected: BTreeSet<_> = tracks.iter()
        .filter(|t| graph.lanes.iter().any(|l| l.track_id == t.id && l.parent_track_id.is_none()))
        .flat_map(|t| t.clips.iter().filter_map(|c| c.source_id.as_deref())).collect();
    let mut order: Vec<_> = graph.sources.iter().enumerate()
        .filter(|(_, s)| source_id.is_none_or(|id| id == s.id)).map(|(i, _)| i).collect();
    order.sort_by_key(|&i| !selected.contains(graph.sources[i].id.as_str()));
    order
}

async fn choose(app: &AppHandle, job: &str, source: &mut AafSource, candidates: BTreeSet<PathBuf>, cache: &mut ProbeCache) -> Result<(), AppError> {
    diagnostics::log(app, job, "info", "media", &format!("{} · UMID {} · slot {} · channel {}/{} · {} Hz · {}-bit · {} samples · {} candidate paths", source.id, source.mob_id, source.slot_id, source.channel + 1, source.channels, source.sample_rate, source.sample_width * 8, source.sample_count, candidates.len()));
    let mut valid = BTreeMap::new();
    let mut reason = if candidates.is_empty() && source.status == "needs_relink" { source.resolution_note.clone() } else { None };
    for candidate in candidates {
        let started = std::time::Instant::now();
        process::check_cancelled(app, job)?;
        match std::fs::metadata(&candidate) {
            Ok(meta) if meta.is_file() => diagnostics::log(app, job, "info", "candidate", &format!("{} · {} · {} bytes", source.id, candidate.display(), meta.len())),
            Ok(_) => { diagnostics::log(app, job, "warn", "candidate", &format!("{} · {} · not a regular file", source.id, candidate.display())); continue; },
            Err(error) => {
                let detail = format!("{} · {error}", candidate.display());
                diagnostics::log(app, job, "warn", "candidate", &format!("{} · {detail}", source.id));
                if error.kind() != std::io::ErrorKind::NotFound { reason = Some(detail); }
                continue;
            },
        }
        match cache.probe(app, job, source, &candidate).await {
            Ok(binding) => {
                diagnostics::log(app, job, "ok", "candidate", &format!("{} · {} · verified stream {}, channel {} · {} ms", source.id, binding.path, binding.stream_index, source.channel + 1, started.elapsed().as_millis()));
                valid.insert(binding.path.clone(), binding);
            },
            Err(AppError::Cancelled) => return Err(AppError::Cancelled),
            Err(error) => {
                diagnostics::log(app, job, "warn", "candidate", &format!("{} · {} · rejected: {error} · {} ms", source.id, candidate.display(), started.elapsed().as_millis()));
                reason = Some(error.to_string().chars().take(2000).collect::<String>());
            },
        }
    }
    if valid.len() == 1 {
        source.resolved = valid.into_values().next(); source.status = "ready".into(); source.resolution_note = None;
    } else {
        if valid.len() > 1 { reason = Some(format!("{} matching files found. Use Locate file to choose the intended copy.", valid.len())); }
        source.status = if reason.is_some() { "needs_relink" } else { "offline" }.into();
        source.resolution_note = Some(reason.unwrap_or_else(|| "Referenced media was not found. Choose its mounted workspace or media folder.".into()));
        diagnostics::log(app, job, "warn", "media", &format!("{} · {} · {}", source.id, source.status, source.resolution_note.as_deref().unwrap_or("Unavailable")));
        // Keep the previous verified binding and all saved transcripts.
    }
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
            sample_width:2, sample_count:96000, descriptor:"PCMDescriptor".into(), status:"offline".into(), resolved:None, resolution_note:None }
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
        let mut s=source(); s.locators=vec!["file:///Editing-Mac/Volumes/Show%20Audio/roll.wav".into()];
        assert_eq!(linked_paths::candidates(&s, &[]), BTreeSet::from([PathBuf::from("/Editing-Mac/Volumes/Show Audio/roll.wav"),PathBuf::from("/Volumes/Show Audio/roll.wav")]));
        s.locators=vec!["/Editing-Mac/Volumes/Show Audio/roll.wav".into()];
        assert!(linked_paths::candidates(&s,&[]).contains(Path::new("/Volumes/Show Audio/roll.wav")));
        s.locators=vec!["file:///Volumes/Show/roll.wav".into()];
        assert!(!linked_paths::candidates(&s,&[AafPathMapping { from:"/Volumes/Sho".into(),to:"/tmp/wrong".into(), authority:None }]).contains(&PathBuf::from("/tmp/wrong/w/roll.wav")));
    }
    #[test]
    fn nexis_workspace_mapping_is_host_scoped_and_remembers_verified_parent() {
        let mut s=source(); s.locators=vec!["file://TestNexis/Show%20Audio/Avid%20MediaFiles/MXF/Editor.2/A01.mxf".into()];
        assert!(linked_paths::candidates(&s,&[]).contains(Path::new("/Volumes/Show Audio/Avid MediaFiles/MXF/Editor.2/A01.mxf")));
        assert!(linked_paths::under_root(&s,Path::new("/tmp/Renamed Mount")).contains(Path::new("/tmp/Renamed Mount/Avid MediaFiles/MXF/Editor.2/A01.mxf")));
        s.resolved=Some(AafResolvedSource {path:"/tmp/Renamed Mount/Avid MediaFiles/MXF/Editor.2/A01.mxf".into(),fingerprint:"a".repeat(64),stream_index:0,size:1,modified_ms:0});
        let mut mappings=vec![]; linked_paths::remember(&s,&mut mappings);
        assert_eq!(mappings.len(),1); assert_eq!(mappings[0].authority.as_deref(),Some("testnexis"));
        s.locators[0]=s.locators[0].replace("A01.mxf","A02.mxf");
        assert!(linked_paths::candidates(&s,&mappings).contains(Path::new("/tmp/Renamed Mount/Avid MediaFiles/MXF/Editor.2/A02.mxf")));
        s.locators[0]=s.locators[0].replace("TestNexis","OtherServer");
        assert!(!linked_paths::candidates(&s,&mappings).iter().any(|p| p.starts_with("/tmp/Renamed Mount")));
    }
    #[test]
    fn op1a_uses_source_slot_and_material_track_not_channel_or_stream_order() {
        use super::super::linked_probe::{MxfTrack,material_track};
        let mut s=source(); s.slot_id=38;
        let tracks=vec![MxfTrack{material_track_id:7,mob_id:s.mob_id.clone(),slot_id:38,aligned:true},MxfTrack{material_track_id:5,mob_id:s.mob_id.clone(),slot_id:42,aligned:true}];
        assert_eq!(material_track(&tracks,&s).unwrap(),7);
        s.slot_id=42; assert_eq!(material_track(&tracks,&s).unwrap(),5);
        s.slot_id=7; assert!(material_track(&tracks,&s).is_err());
        s.slot_id=38; assert!(material_track(&[tracks[0].clone(),tracks[0].clone()],&s).is_err());
        let mut shifted=tracks[0].clone(); shifted.aligned=false; assert!(material_track(&[shifted],&s).is_err());
        s.mob_id="abcd1111".into(); assert!(material_track(&tracks,&s).is_err());
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
        // The bundled sidecar when setup installed it; CI only has zero-byte
        // stubs (which "run" and print nothing), so it falls back to PATH.
        let tool=|name:&str| { let bundled=Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries").join(format!("{name}-aarch64-apple-darwin"));
            if bundled.metadata().map(|m| m.len()>0).unwrap_or(false) { bundled } else { std::path::PathBuf::from(name) } };
        let ffmpeg=tool("ffmpeg");let ffprobe=tool("ffprobe");
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
