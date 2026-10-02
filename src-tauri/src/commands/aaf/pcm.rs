//! Read-only indexed PCM. Python resolves the AAF graph once; Rust performs
//! bounded sample reads for audition and ASR preparation. No second full audio copy.
use super::{model::*, process, store};
use crate::AppError;
use serde::Deserialize;
use std::{collections::HashMap, fs::File, io::{Read, Seek, SeekFrom, Write}, path::Path,
    sync::{Arc, Mutex, OnceLock}};
use tauri::AppHandle;

#[derive(Deserialize)]
pub struct Index {
    schema_version: u32, source_fingerprint: String, pub edit_rate: AafRate,
    pub duration_frames: i64, pub tracks: Vec<Track>, sources: HashMap<String, Source>,
}
#[derive(Deserialize)]
pub struct Track { pub id: String, pub sample_rate: u32, pub sample_width: u32, clips: Vec<Clip> }
#[derive(Deserialize)]
struct Clip { start_frame: i64, duration_frames: i64, kind: String, source_id: Option<String>, source_sample_position: Option<Position> }
#[derive(Deserialize)]
struct Position { numerator: i64, denominator: i64 }
#[derive(Deserialize)]
struct Source {
    extents: Vec<[u64; 2]>, data_offset: u64, sample_count: u64, sample_rate: u32, sample_width: u32,
    #[serde(default = "mono")] channels: u32,
    #[serde(default)] channel: u32,
}
fn mono() -> u32 { 1 }
pub struct Reader { pub index: Index, file: Mutex<File> }
type Readers = tokio::sync::Mutex<Vec<(String, Arc<Reader>)>>;
static READERS: OnceLock<Readers> = OnceLock::new();

pub async fn get(app: &AppHandle, document: &AafDocument, job: &str) -> Result<Arc<Reader>, AppError> {
    store::source_ready(document)?;
    let key = store::cache_key(document, "all", "pcm-v2");
    // One index build at a time; failed/cancelled owners do not poison the cache.
    let mut readers = READERS.get_or_init(Default::default).lock().await;
    process::check_cancelled(app, job)?;
    if let Some((_, reader)) = readers.iter().find(|(id, _)| id == &key) { return Ok(reader.clone()); }
    let path = store::cache(app)?.join(format!("{key}.index-v2.json"));
    let cached = store::read_json::<Index>(&path).ok().filter(|index| index.validate(document).is_ok());
    let index: Index = if let Some(index) = cached { index } else {
        let mut args = vec!["index".into(), "--input".into(), document.source_path.clone(),
            "--expected-fingerprint".into(), document.manifest.source_fingerprint.clone()];
        if let Some(graph) = &document.manifest.graph { args.extend(["--graph".into(), "--sequence".into(), graph.sequence_id.clone()]); }
        let result = process::run(app, job, "index", "saucebunny-aaf", args).await?;
        result.require_success("saucebunny-aaf")?;
        let index: Index = serde_json::from_str(&result.stdout)?;
        index.validate(document)?;
        process::check_cancelled(app, job)?;
        crate::commands::system::write_bytes_impl(&path.to_string_lossy(), result.stdout.as_bytes(), false, false, true)?;
        index
    };
    index.validate(document)?;
    let source = document.source_path.clone();
    let file = tauri::async_runtime::spawn_blocking(move || File::open(source)).await
        .map_err(|e| AppError::internal(e.to_string()))??;
    process::check_cancelled(app, job)?; store::source_ready(document)?;
    let reader = Arc::new(Reader { index, file: Mutex::new(file) });
    if readers.len() == 2 { readers.remove(0); }
    readers.push((key, reader.clone())); Ok(reader)
}

impl Index {
    fn validate(&self, document: &AafDocument) -> Result<(), AppError> {
        let bad = || AppError::invalid("Invalid embedded PCM index; re-import the AAF");
        if !(1..=2).contains(&self.schema_version) || self.source_fingerprint != document.manifest.source_fingerprint
            || self.duration_frames != document.manifest.duration_frames
            || self.edit_rate.numerator != document.manifest.edit_rate.numerator
            || self.edit_rate.denominator != document.manifest.edit_rate.denominator
            || self.tracks.len() != document.manifest.tracks.len() || self.sources.len() > 10000 { return Err(bad()); }
        if self.sources.values().map(|s| s.extents.len()).sum::<usize>() > 200000 { return Err(bad()); }
        for source in self.sources.values() {
            if !(1..=256).contains(&source.channels) || source.channel >= source.channels || ![2,3,4].contains(&source.sample_width) { return Err(bad()); }
            let mut size = 0_u64;
            for [offset, count] in &source.extents {
                if *count == 0 || offset.checked_add(*count).is_none_or(|end| end > document.source_size) { return Err(bad()); }
                size = size.checked_add(*count).ok_or_else(bad)?;
            }
            if source.sample_count.checked_mul(u64::from(source.sample_width)*u64::from(source.channels)).and_then(|bytes| source.data_offset.checked_add(bytes)).is_none_or(|end| end > size) { return Err(bad()); }
        }
        let mut ids = std::collections::HashSet::new();
        for track in &self.tracks {
            if !ids.insert(&track.id) { return Err(bad()); }
            store::track(document, &track.id)?;
            if ![44100,48000,96000].contains(&track.sample_rate) || ![2,3,4].contains(&track.sample_width) || track.clips.len() > 10000 { return Err(bad()); }
            let mut end = 0;
            for clip in &track.clips {
                if clip.start_frame != end || clip.duration_frames <= 0 { return Err(bad()); }
                end = end.checked_add(clip.duration_frames).ok_or_else(bad)?;
                if end > self.duration_frames { return Err(bad()); }
                if clip.kind == "audio" {
                    let source = clip.source_id.as_ref().and_then(|id| self.sources.get(id)).ok_or_else(bad)?;
                    let position = clip.source_sample_position.as_ref().ok_or_else(bad)?;
                    if position.numerator < 0 || position.denominator <= 0 || position.denominator > 1_000_000_000 || source.sample_rate != track.sample_rate
                        || source.sample_width != track.sample_width
                        || source.data_offset > document.source_size || source.sample_count > document.source_size / u64::from(track.sample_width) { return Err(bad()); }
                } else if !matches!(clip.kind.as_str(), "gap" | "unavailable") || clip.source_id.is_some() || clip.source_sample_position.is_some() { return Err(bad()); }
            }
            if end != self.duration_frames { return Err(bad()); }
        }
        Ok(())
    }
    pub fn track(&self, id: &str) -> Result<&Track, AppError> {
        self.tracks.iter().find(|t| t.id == id).ok_or_else(|| AppError::invalid("Unknown microphone track"))
    }
    pub fn sample(&self, frame: i64, hz: u32) -> u64 {
        rounded(i128::from(frame) * i128::from(hz) * i128::from(self.edit_rate.denominator), i128::from(self.edit_rate.numerator))
    }
}
fn rounded(numerator: i128, denominator: i128) -> u64 { ((numerator * 2 + denominator) / (denominator * 2)) as u64 }

impl Reader {
    /// Yields <=192 KiB per block. Release the file lock between blocks so audio
    /// preparation can interleave with background waveform scans.
    pub fn blocks(&self, track: &Track, start: i64, duration: i64, mut consume: impl FnMut(&[u8]) -> Result<(), AppError>) -> Result<(), AppError> {
        if start < 0 || duration <= 0 || start.checked_add(duration).is_none_or(|end| end > self.index.duration_frames) { return Err(AppError::invalid("Invalid PCM interval")); }
        let hz = track.sample_rate; let width = u64::from(track.sample_width);
        let mut bytes = vec![0_u8; 192 * 1024];
        for clip in &track.clips {
            let first = start.max(clip.start_frame); let end = (start + duration).min(clip.start_frame + clip.duration_frames);
            if first >= end { continue; }
            if clip.kind == "unavailable" { return Err(AppError::invalid("This range contains unsupported processing")); }
            let count = self.index.sample(end, hz) - self.index.sample(first, hz);
            let source = clip.source_id.as_ref().and_then(|id| self.index.sources.get(id));
            let offset = if let Some(source) = source {
                let p = clip.source_sample_position.as_ref().ok_or_else(|| AppError::invalid("Missing PCM position"))?;
                let rate = &self.index.edit_rate;
                let n = i128::from(p.numerator) * i128::from(rate.numerator)
                    + i128::from(first - clip.start_frame) * i128::from(hz) * i128::from(rate.denominator) * i128::from(p.denominator);
                let sample = rounded(n, i128::from(p.denominator) * i128::from(rate.numerator));
                if sample.checked_add(count).is_none_or(|end| end > source.sample_count) { return Err(AppError::invalid("PCM interval exceeds embedded audio")); }
                source.data_offset.checked_add(sample * width * u64::from(source.channels)).ok_or_else(|| AppError::invalid("PCM offset overflow"))?
            } else { 0 };
            let mut emitted = 0;
            while emitted < count * width {
                let channels = source.map_or(1, |s| s.channels) as usize;
                let limit = bytes.len() / (channels * width as usize) * width as usize;
                let size = (count * width - emitted).min(limit as u64) as usize;
                if let Some(source) = source {
                    let mut file = self.file.lock().map_err(|_| AppError::internal("PCM reader unavailable"))?;
                    if source.channels == 1 { source.read(&mut file, offset + emitted, &mut bytes[..size])?; }
                    else {
                        let stride = width as usize * source.channels as usize;
                        let mut interleaved = vec![0; size * source.channels as usize];
                        source.read(&mut file, offset + emitted*u64::from(source.channels), &mut interleaved)?;
                        for (input, output) in interleaved.chunks_exact(stride).zip(bytes[..size].chunks_exact_mut(width as usize)) {
                            let channel = source.channel as usize * width as usize;
                            output.copy_from_slice(&input[channel..channel+width as usize]);
                        }
                    }
                } else { bytes[..size].fill(0); }
                consume(&bytes[..size])?; emitted += size as u64;
            }
        }
        Ok(())
    }
    pub fn wav(&self, track: &Track, start: i64, duration: i64, path: &Path, check: impl Fn() -> Result<(), AppError>) -> Result<u64, AppError> {
        let count = self.index.sample(start + duration, track.sample_rate) - self.index.sample(start, track.sample_rate);
        let size = u32::try_from(count * u64::from(track.sample_width)).map_err(|_| AppError::invalid("PCM window too large"))?;
        let mut file = std::io::BufWriter::new(File::create(path)?);
        file.write_all(b"RIFF")?; file.write_all(&(36 + size + size % 2).to_le_bytes())?; file.write_all(b"WAVEfmt ")?;
        file.write_all(&16_u32.to_le_bytes())?; file.write_all(&1_u16.to_le_bytes())?; file.write_all(&1_u16.to_le_bytes())?;
        file.write_all(&track.sample_rate.to_le_bytes())?; file.write_all(&(track.sample_rate * track.sample_width).to_le_bytes())?;
        file.write_all(&(track.sample_width as u16).to_le_bytes())?; file.write_all(&((track.sample_width * 8) as u16).to_le_bytes())?;
        file.write_all(b"data")?; file.write_all(&size.to_le_bytes())?;
        self.blocks(track, start, duration, |block| { check()?; file.write_all(block)?; Ok(()) })?;
        if size % 2 != 0 { file.write_all(&[0])?; } file.flush()?; check()?; Ok(count)
    }
}

impl Source {
    fn read(&self, file: &mut File, offset: u64, target: &mut [u8]) -> Result<(), AppError> {
        let mut logical = 0; let mut read = 0;
        for [physical, length] in &self.extents {
            let position = offset + read as u64;
            if position < logical + length {
                let within = position - logical;
                let count = ((length - within) as usize).min(target.len() - read);
                file.seek(SeekFrom::Start(physical + within))?; file.read_exact(&mut target[read..read + count])?;
                read += count;
                if read == target.len() { return Ok(()); }
            }
            logical += length;
        }
        Err(AppError::invalid("Embedded PCM ended before the requested position"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn multichannel_native_reader_isolates_slot_channel_across_blocks_and_frames() {
        let path = std::env::temp_dir().join(format!("pcm-channels-{}", uuid::Uuid::new_v4()));
        let samples = 120_120_u64;
        let bytes: Vec<u8> = (0..samples).flat_map(|i| [1234_i16, -((i%10000) as i16)].into_iter().flat_map(i16::to_le_bytes)).collect();
        std::fs::write(&path,&bytes).unwrap();
        let source = Source { extents:vec![[0,bytes.len() as u64]],data_offset:0,sample_count:samples,sample_rate:48000,sample_width:2,channels:2,channel:1 };
        let index = Index { schema_version:2,source_fingerprint:"f".repeat(64),edit_rate:AafRate { numerator:24000,denominator:1001 },duration_frames:60,
            sources:HashMap::from([("pcm".into(),source)]),tracks:vec![Track { id:"1".into(),sample_rate:48000,sample_width:2,clips:vec![Clip {
                start_frame:0,duration_frames:60,kind:"audio".into(),source_id:Some("pcm".into()),source_sample_position:Some(Position { numerator:0,denominator:1 }) }] }] };
        let reader=Reader { index,file:Mutex::new(File::open(&path).unwrap()) };
        let mut actual=vec![]; reader.blocks(reader.index.track("1").unwrap(),3,55,|block| { assert!(block.len()<=192*1024); actual.extend_from_slice(block); Ok(()) }).unwrap();
        let expected:Vec<u8>=(6006..116116).flat_map(|i| (-(i%10000) as i16).to_le_bytes()).collect();
        assert_eq!(actual,expected); std::fs::remove_file(path).unwrap();
    }
    #[test]
    fn rational_offsets_gaps_peaks_and_cancellation_remain_truthful() {
        let root = std::env::temp_dir().join(format!("pcm-pyramid-{}",uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap(); let path = root.join("source.pcm");
        let samples: Vec<i16> = (0..20000).map(|index| if index == 100 { i16::MIN } else if index == 8100 { i16::MAX } else { (index % 100) as i16 }).collect();
        let bytes: Vec<u8> = samples.iter().flat_map(|sample| sample.to_le_bytes()).collect(); std::fs::write(&path,&bytes).unwrap();
        let source = Source { extents: vec![[0,bytes.len() as u64]], data_offset:0, sample_count:20000, sample_rate:48000, sample_width:2, channels:1, channel:0 };
        let index = Index { schema_version:1, source_fingerprint:"f".repeat(64), edit_rate:AafRate { numerator:24,denominator:1 }, duration_frames:8,
            sources:HashMap::from([("pcm".into(),source)]), tracks:vec![Track { id:"1".into(),sample_rate:48000,sample_width:2,clips:vec![
                Clip { start_frame:0,duration_frames:4,kind:"audio".into(),source_id:Some("pcm".into()),source_sample_position:Some(Position { numerator:0,denominator:1 }) },
                Clip { start_frame:4,duration_frames:1,kind:"gap".into(),source_id:None,source_sample_position:None },
                Clip { start_frame:5,duration_frames:3,kind:"audio".into(),source_id:Some("pcm".into()),source_sample_position:Some(Position { numerator:16001,denominator:2 }) },
            ] }] };
        let reader = Reader { index,file:Mutex::new(File::open(&path).unwrap()) }; let track = reader.index.track("1").unwrap();
        let mut actual=vec![]; reader.blocks(track,0,8,|block| { actual.extend_from_slice(block);Ok(()) }).unwrap();
        let mut expected=bytes[..16000].to_vec();expected.extend(vec![0;4000]);expected.extend(&bytes[16002..28002]);assert_eq!(actual,expected);
        assert!(reader.wav(track,0,8,&root.join("cancelled.wav"),|| Err(AppError::Cancelled)).is_err());
        let cache=root.join("peaks.bin");super::super::peaks::build(&reader,track,&cache,||Ok(())).unwrap();
        let whole=super::super::peaks::query(&cache,0,16000,16000,48000).unwrap();
        assert!(whole.iter().any(|p|p[0]==-1.)); assert!(whole.iter().any(|p|p[1]>0.99));
        let gap=super::super::peaks::query(&cache,8448,9984,16000,48000).unwrap();assert!(gap.iter().all(|p|*p==[0.,0.]));
        assert!(super::super::peaks::query(&cache,15990,16000,16000,48000).is_ok());
        assert!(super::super::peaks::query(&cache,0,16001,16000,48000).is_err());
        std::fs::write(&cache,b"bad cache").unwrap();assert!(super::super::peaks::query(&cache,0,100,16000,48000).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn fragmented_extents_cross_boundaries_without_following_paths() {
        let path = std::env::temp_dir().join(format!("pcm-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, b"xxxabcdefxxxxxghij").unwrap();
        let source = Source { extents: vec![[3,6],[14,4]], data_offset: 0, sample_count: 5, sample_rate: 48000, sample_width: 2, channels:1, channel:0 };
        let mut file = File::open(&path).unwrap(); let mut bytes = [0;6];
        source.read(&mut file, 4, &mut bytes).unwrap(); assert_eq!(&bytes, b"efghij");
        assert!(source.read(&mut file, 9, &mut bytes).is_err());
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    #[ignore = "read-only real AAF PCM/cache benchmark; needs SB_AAF_REAL_INDEX, SB_AAF_REAL_INPUT, SB_AAF_BENCH_DIR"]
    fn real_index_pcm_matches_oracle_and_benchmarks_twenty_tracks() {
        let source = std::env::var("SB_AAF_REAL_INPUT").unwrap();
        let index: Index = serde_json::from_slice(&std::fs::read(std::env::var("SB_AAF_REAL_INDEX").unwrap()).unwrap()).unwrap();
        let root = std::path::PathBuf::from(std::env::var("SB_AAF_BENCH_DIR").unwrap());
        let manifest: AafManifest = serde_json::from_slice(&std::fs::read(std::env::var("SB_AAF_REAL_INDEX").unwrap()).unwrap()).unwrap();
        let metadata = std::fs::metadata(&source).unwrap();
        let document = AafDocument { schema_version: 1, shoot_date_override: None, id: "f".repeat(64), source_path: source.clone(), source_size: metadata.len(), source_modified_ms: store::modified_ms(&metadata), manifest, labels: vec![], transcripts: vec![] };
        index.validate(&document).unwrap(); store::source_ready(&document).unwrap();
        let reader = Reader { index, file: Mutex::new(File::open(&source).unwrap()) };
        let track = reader.index.track("10").unwrap();
        let mut bytes: Vec<u8> = vec![]; reader.blocks(track, 80000,48, |block| { bytes.extend_from_slice(block); Ok(()) }).unwrap();
        let oracle = std::fs::read(root.join("one.wav")).unwrap();
        assert_eq!(bytes, oracle[44..], "native PCM must be byte-identical to the established reader");
        let mut timings = vec![];
        for run in 0..20 {
            let timer = std::time::Instant::now();
            for track in &reader.index.tracks { reader.wav(track, 80000+run*120,120,&root.join(format!("native-{}.wav",track.id)),|| Ok(())).unwrap(); }
            timings.push(timer.elapsed().as_secs_f64()*1000.);
        }
        eprintln!("TWENTY_TRACK_WINDOW_MS={timings:?}");
        let path = root.join("native-peaks.bin"); let timer = std::time::Instant::now();
        super::super::peaks::build(&reader, track, &path, || Ok(())).unwrap();
        eprintln!("ONE_TRACK_COLD_PYRAMID_MS={}", timer.elapsed().as_millis());
        let timer = std::time::Instant::now(); let total = reader.index.sample(reader.index.duration_frames,track.sample_rate);
        for zoom in 0..11 {
            let span = reader.index.duration_frames / (1<<zoom); let start = (80000-span/2).max(0).min(reader.index.duration_frames-span);
            let first = reader.index.sample(start,track.sample_rate); let end = reader.index.sample(start+span,track.sample_rate);
            for _ in 0..20 { assert!(!super::super::peaks::query(&path,first,end,total,track.sample_rate).unwrap().is_empty()); }
        }
        eprintln!("ELEVEN_ZOOMS_TWENTY_TRACK_QUERIES_MS={}", timer.elapsed().as_millis());
        if std::env::var_os("SB_AAF_BENCH_ALL_PEAKS").is_some() {
            let timer=std::time::Instant::now();
            for track in &reader.index.tracks { super::super::peaks::build(&reader,track,&root.join(format!("peaks-{}.bin",track.id)),||Ok(())).unwrap(); }
            eprintln!("ALL_TWENTY_COLD_PYRAMIDS_MS={}",timer.elapsed().as_millis());
            for zoom in 0..11 {
                let timer=std::time::Instant::now(); let span=reader.index.duration_frames/(1<<zoom);let start=(80000-span/2).max(0).min(reader.index.duration_frames-span);
                for track in &reader.index.tracks { super::super::peaks::query(&root.join(format!("peaks-{}.bin",track.id)),reader.index.sample(start,track.sample_rate),reader.index.sample(start+span,track.sample_rate),total,track.sample_rate).unwrap(); }
                eprintln!("ZOOM_{}_ALL_TWENTY_MS={}",1<<zoom,timer.elapsed().as_secs_f64()*1000.);
            }
        }
        store::source_ready(&document).unwrap();
    }
    #[test]
    #[ignore = "real AAF recorder-join comparison; needs SB_AAF_REAL_INDEX, SB_AAF_REAL_INPUT"]
    fn real_recorder_joins_match_established_extractor_byte_for_byte() {
        let source=std::env::var("SB_AAF_REAL_INPUT").unwrap();
        let index:Index=serde_json::from_slice(&std::fs::read(std::env::var("SB_AAF_REAL_INDEX").unwrap()).unwrap()).unwrap();
        let reader=Reader { index,file:Mutex::new(File::open(&source).unwrap()) };
        let worker=crate::commands::sidecar_path("saucebunny-aaf").unwrap();
        let root=std::env::temp_dir().join(format!("aaf-join-check-{}",uuid::Uuid::new_v4()));std::fs::create_dir(&root).unwrap();
        for id in ["10","23"] {
            let track=reader.index.track(id).unwrap();
            for (index,clip) in track.clips.iter().enumerate().skip(1) {
                let start=clip.start_frame-4; let path=root.join(format!("{id}-{index}.wav"));
                let result=std::process::Command::new(&worker).env("PATH","/usr/bin:/bin").args(["extract","--input",&source,"--track",id,"--start-frame",&start.to_string(),"--duration-frames","8","--output",path.to_str().unwrap()]).output().unwrap();
                assert!(result.status.success(),"{}",String::from_utf8_lossy(&result.stderr));
                let mut native=vec![];reader.blocks(track,start,8,|block| { native.extend_from_slice(block);Ok(()) }).unwrap();
                let oracle=std::fs::read(path).unwrap(); assert_eq!(native,oracle[44..],"recorder {id} join {index}");
            }
        }
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    #[ignore = "real indexed ASR input check; needs SB_AAF_REAL_INDEX, SB_AAF_REAL_INPUT"]
    fn real_indexed_asr_input_is_identical_after_resampling() {
        let source = std::env::var("SB_AAF_REAL_INPUT").unwrap();
        let index: Index = serde_json::from_slice(&std::fs::read(std::env::var("SB_AAF_REAL_INDEX").unwrap()).unwrap()).unwrap();
        let reader = Reader { index, file: Mutex::new(File::open(&source).unwrap()) };
        let root = std::env::temp_dir().join(format!("aaf-asr-input-{}", uuid::Uuid::new_v4())); std::fs::create_dir(&root).unwrap();
        let extractor = crate::commands::sidecar_path("saucebunny-aaf").unwrap();
        let ffmpeg = crate::commands::sidecar_path("ffmpeg").unwrap();
        for start in [2853, 22992, 113500] {
            let raw = root.join(format!("{start}.raw.wav")); let old = root.join(format!("{start}.old.wav"));
            let begun = std::time::Instant::now();
            reader.wav(reader.index.track("10").unwrap(), start, 2925, &raw, || Ok(())).unwrap();
            eprintln!("native 122-second ASR input at {start}: {:?}", begun.elapsed());
            let result = std::process::Command::new(&extractor).args(["extract", "--input", &source, "--track", "10", "--start-frame", &start.to_string(), "--duration-frames", "2925", "--output", old.to_str().unwrap()]).output().unwrap();
            assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
            let mut outputs = Vec::new();
            for (index, input) in [raw, old].into_iter().enumerate() {
                let path = root.join(format!("{index}.16k.wav"));
                let args = crate::commands::transcript::wav_16k_mono_args(input.to_str().unwrap(), None, path.to_str().unwrap());
                assert!(std::process::Command::new(&ffmpeg).args(args).output().unwrap().status.success());
                let info = super::super::audio::inspect_wav(&path).unwrap();
                assert!((info.sample_count - super::super::model::frame_samples(2925, &reader.index.edit_rate).unwrap()).abs() <= 2);
                outputs.push(std::fs::read(path).unwrap());
            }
            assert_eq!(outputs[0], outputs[1], "ASR must receive the same PCM at {start}");
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
