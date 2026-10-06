//! Bounded timeline extraction, audition assets, and viewport waveform detail.
use super::{model::*, process, store};
use crate::AppError;
use std::{io::{Read, Seek, SeekFrom}, path::{Path, PathBuf}};
use tauri::{AppHandle, Manager};

/// Playback windows and transcription extracts. Waveform overviews have their
/// own gate, so an hour-long build never holds up audition on a network volume.
const PREPARATION_PERMITS: usize = 2;
static PREPARATION: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(PREPARATION_PERMITS);
pub async fn preparation(app: &AppHandle, job: &str) -> Result<tokio::sync::SemaphorePermit<'static>, AppError> {
    acquire(app, job, &PREPARATION).await
}

/// True while audition or transcription is reading audio.
pub fn foreground_busy() -> bool { PREPARATION.available_permits() < PREPARATION_PERMITS }

/// A separate gate is not enough on its own: an overview build and an audition
/// window still share one network volume and one set of cores, and measured
/// on NEXIS each audition window took 1.5-2.3 s while a build ran. So a build
/// waits between its windows while anyone is preparing audio. Transcription
/// releases the gate while it recognises, which is when a build catches up.
pub async fn yield_to_foreground(app: &AppHandle, job: &str) -> Result<(), AppError> {
    while foreground_busy() {
        process::check_cancelled(app, job)?;
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    Ok(())
}

/// `yield_to_foreground` for a build running on a blocking thread.
pub fn yield_to_foreground_blocking(check: impl Fn() -> Result<(), AppError>) -> Result<(), AppError> {
    while foreground_busy() {
        check()?;
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    check()
}

/// Wait for a permit, but leave the queue as soon as the job is stopped. A
/// plain `acquire().await` keeps cancelled requests queued behind live work.
pub async fn acquire(app: &AppHandle, job: &str, gate: &'static tokio::sync::Semaphore) -> Result<tokio::sync::SemaphorePermit<'static>, AppError> {
    acquire_until(gate, || process::check_cancelled(app, job)).await
}

async fn acquire_until(gate: &'static tokio::sync::Semaphore, check: impl Fn() -> Result<(), AppError>) -> Result<tokio::sync::SemaphorePermit<'static>, AppError> {
    loop {
        check()?;
        tokio::select! {
            permit = gate.acquire() => return permit.map_err(|_| AppError::internal("Audio preparation unavailable")),
            _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {},
        }
    }
}

pub struct WorkDir(pub PathBuf);
impl WorkDir {
    pub fn new(app: &AppHandle, job: &str) -> Result<Self, AppError> {
        let root = app.path().app_cache_dir().map_err(|e| AppError::internal(e.to_string()))?;
        let scratch = crate::commands::scratch_dir(&root);
        std::fs::create_dir_all(&scratch)?;
        let path = scratch.join(format!("aaf-{job}-{}", crate::stream_proxy::mint_token()?));
        std::fs::create_dir(&path)?;
        Ok(Self(path))
    }
}
impl Drop for WorkDir {
    fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.0); }
}

pub fn validate_range(document: &AafDocument, start: i64, duration: i64) -> Result<(), AppError> {
    let end = start.checked_add(duration).ok_or_else(|| AppError::invalid("AAF range overflow"))?;
    if start < 0 || duration <= 0 || end > document.manifest.duration_frames
        || frame_samples(duration, &document.manifest.edit_rate)? > ASR_RATE * 600
    { return Err(AppError::invalid("Select an AAF range between one frame and ten minutes")); }
    Ok(())
}

pub async fn extract_16k(app: &AppHandle, document: &AafDocument, track: &str, start: i64,
    duration: i64, job: &str, directory: &Path) -> Result<(PathBuf, WavInfo), AppError>
{
    validate_range(document, start, duration)?;
    store::track(document, track)?;
    store::source_ready(document)?;
    let raw = directory.join("raw.wav");
    let wav = directory.join("audio.wav");
    // Share audition's read-only index; do not boot Python or compute unused
    // waveform peaks for every recognition chunk. FFmpeg remains the resampler.
    if super::linked_audio::needed(document) {
        super::linked_audio::render(app, document, track, start, duration, job, &raw).await?;
    } else {
        let _permit = preparation(app, job).await?;
        let reader = super::pcm::get(app, document, job).await?;
        let (app2, job2, track2, raw2) = (app.clone(), job.to_owned(), track.to_owned(), raw.clone());
        tauri::async_runtime::spawn_blocking(move || reader.wav(reader.index.track(&track2)?, start, duration, &raw2,
            || process::check_cancelled(&app2, &job2))).await.map_err(|e| AppError::internal(e.to_string()))??;
    }
    process::check_cancelled(app, job)?;
    let _permit = preparation(app, job).await?;
    let mut args = crate::commands::transcript::wav_16k_mono_args(&raw.to_string_lossy(), None, &wav.to_string_lossy());
    args.splice(0..0, ["-nostdin".into(), "-hide_banner".into(), "-loglevel".into(), "error".into()]);
    process::run(app, job, "resample", "ffmpeg", args).await?.require_success("ffmpeg")?;
    let info = inspect_wav(&wav)?;
    let expected = frame_samples(duration, &document.manifest.edit_rate)?;
    if (info.sample_count - expected).abs() > 2 {
        return Err(AppError::invalid("Prepared audio duration does not match the AAF timeline"));
    }
    process::check_cancelled(app, job)?;
    store::source_ready(document)?;
    Ok((wav, info))
}

/// One mic's five seconds for playback, from the cache when it is there. A
/// window is made once: a second request for it waits for the first and
/// reads its file, and nothing the page does short of opening another
/// document stops a window being made, so what Pause or a scrub walks away
/// from is on disk when Play comes back for it.
pub async fn prepare(app: &AppHandle, document: &AafDocument, track: &str, start: i64,
    duration: i64, job: &str) -> Result<AafAudioAsset, AppError>
{
    validate_range(document, start, duration)?;
    store::track(document, track)?;
    store::source_ready(document)?;
    if super::linked_audio::needed(document) { return prepare_linked(app, document, track, start, duration, job).await; }
    let reader = super::pcm::get(app, document, job).await?;
    let selected = reader.index.track(track)?;
    let (sample_rate, sample_width) = (selected.sample_rate, selected.sample_width);
    let expected = reader.index.sample(start + duration, sample_rate) - reader.index.sample(start, sample_rate);
    let key = store::cache_key(document, track, &format!("audition-native-v1-{start}-{duration}"));
    let cache = store::cache(app)?;
    let metadata_path = cache.join(format!("{key}.asset.json"));
    let destination = cache.join(format!("{key}.wav"));
    let kept = || {
        let asset = store::read_json::<AafAudioAsset>(&metadata_path).ok()?;
        (asset.path == destination.to_string_lossy() && asset.start_frame == start && asset.duration_frames == duration
            && asset.sample_rate == sample_rate && asset.sample_count == expected as i64
            && native_wav_valid(&destination, sample_rate, sample_width, expected)).then_some(asset)
    };
    if let Some(asset) = kept() { used(&destination); return Ok(asset); }
    let _claim = process::claim(app, job, &destination).await?;
    if let Some(asset) = kept() { used(&destination); return Ok(asset); }
    let _permit = preparation(app, job).await?;
    let work = WorkDir::new(app, job)?;
    process::progress(app, job, Some(track), "preparing-audio", 0, duration);
    let wav = work.0.join("audio.wav");
    let (app2, job2, track2, wav2) = (app.clone(), job.to_owned(), track.to_owned(), wav.clone());
    let sample_count = tauri::async_runtime::spawn_blocking(move || reader.wav(reader.index.track(&track2)?, start, duration, &wav2, || process::check_cancelled(&app2, &job2))).await
        .map_err(|e| AppError::internal(e.to_string()))??;
    process::check_cancelled(app, job)?;
    store::source_ready(document)?;
    std::fs::rename(wav, &destination)?;
    let asset = AafAudioAsset { path: destination.to_string_lossy().into_owned(), start_frame: start,
        duration_frames: duration, sample_rate, sample_count: sample_count as i64, peaks: Vec::new() };
    crate::commands::system::write_bytes_impl(&metadata_path.to_string_lossy(), &serde_json::to_vec(&asset)?, false, false, true)?;
    sweep_soon(&cache);
    Ok(asset)
}

async fn prepare_linked(app: &AppHandle, document: &AafDocument, track: &str, start: i64, duration: i64, job: &str) -> Result<AafAudioAsset, AppError> {
    super::linked::check_window_sources(document, store::track(document, track)?, start, duration)?;
    let expected = super::linked_audio::sample(start+duration, &document.manifest.edit_rate)-super::linked_audio::sample(start, &document.manifest.edit_rate);
    let key = store::cache_key(document, track, &format!("linked-pcm-v1-{start}-{duration}"));
    let cache = store::cache(app)?;
    let destination = cache.join(format!("{key}.wav"));
    if !native_wav_valid(&destination, 48000, 3, expected) {
        let _claim = process::claim(app, job, &destination).await?;
        if !native_wav_valid(&destination, 48000, 3, expected) {
            let work = WorkDir::new(app, job)?; let partial = work.0.join("window.wav");
            super::linked_audio::render(app, document, track, start, duration, job, &partial).await?;
            process::check_cancelled(app, job)?;
            std::fs::rename(partial, &destination)?;
            sweep_soon(&cache);
        }
    }
    used(&destination);
    Ok(AafAudioAsset { path: destination.to_string_lossy().into_owned(), start_frame: start, duration_frames: duration,
        sample_rate: 48000, sample_count: expected as i64, peaks: Vec::new() })
}

/// Playback windows kept on disk, at most; past it the least recently played
/// go first. A window is about 0.72 MB (five seconds of one mic at 48 kHz,
/// 24-bit), so this holds a little under 3,000: several minutes of a large
/// sequence, every mic. They were kept for ever (1.29 GB on the development
/// Mac), outside Settings' sizes and Clear all.
pub const PLAYBACK_CACHE_BYTES: u64 = 2 << 30;
static LAST_SWEEP: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// A playback window's file, by name: the window (`.wav`) and, for embedded
/// audio, what it was made from (`.asset.json`). Nothing else in the AAF
/// media cache ends this way: overviews, indexes and probes stay.
pub fn is_playback_file(name: &str) -> bool { name.ends_with(".wav") || name.ends_with(".asset.json") }

/// A window was played: the sweep takes the least recently played first.
fn used(path: &Path) {
    let _ = std::fs::File::options().write(true).open(path).and_then(|file| file.set_modified(std::time::SystemTime::now()));
}

/// Sweep after a window is made, a minute apart at most, off the request.
fn sweep_soon(cache: &Path) {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |since| since.as_secs());
    let last = LAST_SWEEP.load(std::sync::atomic::Ordering::Relaxed);
    if now.saturating_sub(last) < 60 || LAST_SWEEP.compare_exchange(last, now, std::sync::atomic::Ordering::Relaxed, std::sync::atomic::Ordering::Relaxed).is_err() { return; }
    let cache = cache.to_path_buf();
    tauri::async_runtime::spawn_blocking(move || sweep_playback(&cache, PLAYBACK_CACHE_BYTES));
}

/// Remove the least recently played windows until the rest fit in `cap`.
/// Returns how many windows went.
pub fn sweep_playback(cache: &Path, cap: u64) -> u32 {
    let Ok(entries) = std::fs::read_dir(cache) else { return 0 };
    let mut windows = Vec::new();
    let mut total = 0_u64;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() || !is_playback_file(&name) { continue; }
        total += meta.len();
        if name.ends_with(".wav") { windows.push((entry.path(), meta.modified().unwrap_or(std::time::UNIX_EPOCH))); }
    }
    windows.sort_by_key(|(_, played)| *played);
    let mut removed = 0;
    for (wav, _) in windows {
        if total <= cap { break; }
        let sidecar = wav.with_extension("asset.json");
        let bytes = std::fs::metadata(&wav).map_or(0, |meta| meta.len()) + std::fs::metadata(&sidecar).map_or(0, |meta| meta.len());
        if std::fs::remove_file(&wav).is_ok() {
            let _ = std::fs::remove_file(&sidecar);
            total = total.saturating_sub(bytes); removed += 1;
        }
    }
    removed
}

fn native_wav_valid(path: &Path, hz: u32, width: u32, samples: u64) -> bool {
    let Ok(mut file) = std::fs::File::open(path) else { return false; };
    let mut header = [0;44]; if file.read_exact(&mut header).is_err() { return false; }
    let data_size = samples * u64::from(width);
    &header[..4] == b"RIFF" && &header[8..16] == b"WAVEfmt " && header[16..20] == 16_u32.to_le_bytes()
        && header[20..24] == [1,0,1,0] && header[24..28] == hz.to_le_bytes()
        && header[28..32] == (hz*width).to_le_bytes() && header[32..34] == (width as u16).to_le_bytes()
        && header[34..36] == ((width*8) as u16).to_le_bytes() && &header[36..40] == b"data"
        && header[40..44] == (data_size as u32).to_le_bytes()
        && file.metadata().is_ok_and(|meta| meta.len() == 44 + data_size + data_size%2)
}

pub struct WavInfo { pub sample_count: i64, pub digital_silence: bool }

/// Validate the actual model input, including RIFF chunk bounds. An invalid file
/// must not become "empty" merely because whisper-cli exits zero.
pub fn inspect_wav(path: &Path) -> Result<WavInfo, AppError> {
    let mut file = std::fs::File::open(path)?;
    let length = file.metadata()?.len();
    let mut header = [0_u8; 12];
    file.read_exact(&mut header)?;
    if &header[..4] != b"RIFF" || &header[8..] != b"WAVE" {
        return Err(AppError::invalid("Prepared audio is not a WAV file"));
    }
    let mut format_ok = false;
    let mut data = None;
    while file.stream_position()? + 8 <= length {
        let mut chunk = [0_u8; 8];
        file.read_exact(&mut chunk)?;
        let size = u64::from(u32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]));
        let offset = file.stream_position()?;
        if offset.checked_add(size).is_none_or(|end| end > length) {
            return Err(AppError::invalid("Prepared WAV is truncated"));
        }
        if &chunk[..4] == b"fmt " {
            if size < 16 { return Err(AppError::invalid("Prepared WAV format is truncated")); }
            let mut fmt = [0_u8; 16];
            file.read_exact(&mut fmt)?;
            format_ok = u16::from_le_bytes([fmt[0], fmt[1]]) == 1
                && u16::from_le_bytes([fmt[2], fmt[3]]) == 1
                && u32::from_le_bytes([fmt[4], fmt[5], fmt[6], fmt[7]]) == ASR_RATE as u32
                && u16::from_le_bytes([fmt[12], fmt[13]]) == 2
                && u16::from_le_bytes([fmt[14], fmt[15]]) == 16;
        }
        if &chunk[..4] == b"data" { data = Some((offset, size)); }
        file.seek(SeekFrom::Start(offset + size + size % 2))?;
    }
    let (offset, size) = data.ok_or_else(|| AppError::invalid("Prepared WAV has no audio data"))?;
    if !format_ok || size == 0 || size % 2 != 0 { return Err(AppError::invalid("Prepared audio must be 16 kHz mono PCM")); }
    file.seek(SeekFrom::Start(offset))?;
    let mut remaining = size;
    let mut digital_silence = true;
    let mut buffer = [0_u8; 65_536];
    while remaining > 0 {
        let count = remaining.min(buffer.len() as u64) as usize;
        file.read_exact(&mut buffer[..count])?;
        digital_silence &= buffer[..count].iter().all(|byte| *byte == 0);
        remaining -= count as u64;
    }
    Ok(WavInfo { sample_count: (size / 2) as i64, digital_silence })
}

/// A prepared 16 kHz mono WAV's samples, -1 to 1, after `inspect_wav` has
/// vouched for its format (accuracy spec, phase 4: the voice check reads
/// short windows of two mics to see which heard a word first).
pub fn read_wav(path: &Path) -> Result<Vec<f32>, AppError> {
    inspect_wav(path)?;
    let bytes = std::fs::read(path)?;
    let mut at = 12;
    while at + 8 <= bytes.len() {
        let size = u32::from_le_bytes([bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]]) as usize;
        let body = at + 8;
        if &bytes[at..at + 4] == b"data" {
            let end = body.saturating_add(size).min(bytes.len());
            return Ok(bytes[body..end].chunks_exact(2).map(|pair| f32::from(i16::from_le_bytes([pair[0], pair[1]])) / 32768.0).collect());
        }
        at = body.saturating_add(size + size % 2);
    }
    Err(AppError::invalid("Prepared WAV has no audio data"))
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn a_stopped_waiter_leaves_the_queue_and_playback_is_not_gated_by_waveforms() {
        static GATE: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
        let held = GATE.acquire().await.unwrap();
        let stopped = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = stopped.clone();
        let waiter = tokio::spawn(acquire_until(&GATE, move || if flag.load(std::sync::atomic::Ordering::SeqCst) { Err(AppError::Cancelled) } else { Ok(()) }));
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        stopped.store(true, std::sync::atomic::Ordering::SeqCst);
        let result = tokio::time::timeout(std::time::Duration::from_secs(1), waiter).await.expect("a stopped waiter must not stay queued").unwrap();
        assert!(matches!(result, Err(AppError::Cancelled)));
        drop(held);
        // A running overview build holds its own gate, never a playback permit.
        let _overview = super::super::peaks::BUILD.acquire().await.unwrap();
        let playback = tokio::time::timeout(std::time::Duration::from_secs(1), acquire_until(&PREPARATION, || Ok(()))).await;
        assert!(playback.is_ok_and(|permit| permit.is_ok()));
    }

    use super::*;
    fn wav(samples: &[i16]) -> Vec<u8> {
        let size = (samples.len() * 2) as u32;
        let mut bytes = b"RIFF".to_vec();
        bytes.extend((36 + size).to_le_bytes()); bytes.extend(b"WAVEfmt ");
        bytes.extend(16_u32.to_le_bytes()); bytes.extend(1_u16.to_le_bytes()); bytes.extend(1_u16.to_le_bytes());
        bytes.extend(16000_u32.to_le_bytes()); bytes.extend(32000_u32.to_le_bytes());
        bytes.extend(2_u16.to_le_bytes()); bytes.extend(16_u16.to_le_bytes());
        bytes.extend(b"data"); bytes.extend(size.to_le_bytes());
        for sample in samples { bytes.extend(sample.to_le_bytes()); }
        bytes
    }
    #[test]
    fn digital_silence_is_distinct_from_very_quiet_valid_audio() {
        let root = std::env::temp_dir().join(format!("aaf-pcm-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("pcm.wav");
        std::fs::write(&path, wav(&[0; 100])).unwrap();
        let info = inspect_wav(&path).unwrap();
        assert_eq!(info.sample_count, 100); assert!(info.digital_silence);
        std::fs::write(&path, wav(&[1; 100])).unwrap();
        assert!(!inspect_wav(&path).unwrap().digital_silence);
        let mut truncated = wav(&[0; 100]); truncated.pop();
        std::fs::write(&path, truncated).unwrap();
        assert!(inspect_wav(&path).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn the_sweep_takes_the_least_recently_played_windows_and_nothing_else() {
        let root = std::env::temp_dir().join(format!("aaf-sweep-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let window = |name: &str, age: u64| {
            let path = root.join(format!("{name}.wav"));
            std::fs::write(&path, vec![0_u8; 100]).unwrap();
            std::fs::File::options().write(true).open(&path).unwrap()
                .set_modified(std::time::SystemTime::now() - std::time::Duration::from_secs(age)).unwrap();
            path
        };
        let (old, middle, recent) = (window("old", 300), window("middle", 200), window("recent", 100));
        std::fs::write(old.with_extension("asset.json"), b"{}").unwrap();
        // An overview and an index live beside the windows and are never playback.
        std::fs::write(root.join("x.peaks-v1.bin"), vec![0_u8; 1000]).unwrap();
        std::fs::write(root.join("x.index-v2.json"), vec![0_u8; 1000]).unwrap();
        // 302 bytes of windows against 200: the oldest goes, with what it was made from.
        assert_eq!(sweep_playback(&root, 200), 1);
        assert!(!old.exists() && !old.with_extension("asset.json").exists());
        assert!(middle.exists() && recent.exists());
        assert!(root.join("x.peaks-v1.bin").exists() && root.join("x.index-v2.json").exists());
        // Played again, a window goes to the back of the line.
        used(&middle);
        assert_eq!(sweep_playback(&root, 100), 1);
        assert!(middle.exists() && !recent.exists());
        assert_eq!(sweep_playback(&root, 100), 0, "a cache inside its cap was swept");
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn invalid_audio_is_not_silence() {
        let root = std::env::temp_dir().join(format!("aaf-wav-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("bad.wav");
        std::fs::write(&path, b"not an audio file").unwrap();
        assert!(inspect_wav(&path).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cached_audition_requires_matching_pcm_header_and_complete_data() {
        let path=std::env::temp_dir().join(format!("aaf-audition-{}.wav",uuid::Uuid::new_v4()));
        std::fs::write(&path,wav(&[1;100])).unwrap();
        assert!(native_wav_valid(&path,16000,2,100));
        assert!(!native_wav_valid(&path,48000,2,100));
        assert!(!native_wav_valid(&path,16000,2,101));
        let mut bytes=wav(&[1;100]);bytes.pop();std::fs::write(&path,bytes).unwrap();
        assert!(!native_wav_valid(&path,16000,2,100));
        std::fs::remove_file(path).unwrap();
    }
}
