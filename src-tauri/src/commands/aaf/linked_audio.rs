//! Bounded native decoding into the existing Multitrack clock. Original media
//! stays read-only. Only generated PCM windows enter the webview/cache.
use super::{audio::WorkDir, linked, model::*, process, store};
use crate::AppError;
use std::{io::{Read, Seek, SeekFrom, Write}, path::Path};
use tauri::AppHandle;

const HZ: u32 = 48_000;
/// A detail or cache-only request for a track whose overview nobody has built.
pub const NOT_BUILT: &str = "This track's waveform has not been built";

pub fn needed(document: &AafDocument) -> bool { document.manifest.graph.as_ref().is_some_and(|g| !g.sources.is_empty()) }
pub fn sample(frame: i64, rate: &AafRate) -> u64 {
    let n = i128::from(frame) * i128::from(HZ) * i128::from(rate.denominator);
    ((n*2 + i128::from(rate.numerator))/(2*i128::from(rate.numerator))) as u64
}
fn header(samples: u64) -> Result<Vec<u8>, AppError> {
    let size = u32::try_from(samples*3).map_err(|_| AppError::invalid("Audio window is too large"))?;
    let mut bytes = Vec::with_capacity(44);
    bytes.extend(b"RIFF"); bytes.extend((36+size+size%2).to_le_bytes()); bytes.extend(b"WAVEfmt ");
    bytes.extend(16_u32.to_le_bytes()); bytes.extend(1_u16.to_le_bytes()); bytes.extend(1_u16.to_le_bytes());
    bytes.extend(HZ.to_le_bytes()); bytes.extend((HZ*3).to_le_bytes()); bytes.extend(3_u16.to_le_bytes());
    bytes.extend(24_u16.to_le_bytes()); bytes.extend(b"data"); bytes.extend(size.to_le_bytes()); Ok(bytes)
}

/// Min/max of every 256 samples, folded in by sequence position, so clips can
/// arrive in any order and a bucket two clips share keeps both. Values are the
/// top 16 bits of the 24-bit PCM, lifted by one when the low byte carries
/// signal, and every bucket starts at [0, 0], exactly as the window loop built
/// them, so existing overview caches stay valid.
struct Peaks { values: Vec<[i16; 2]> }
impl Peaks {
    const BUCKET: u64 = 256;
    fn new(samples: u64) -> Self { Self { values: vec![[0, 0]; samples.div_ceil(Self::BUCKET) as usize] } }
    fn fold(&mut self, at: u64, pcm: &[u8]) {
        for (offset, sample) in pcm.as_chunks::<3>().0.iter().enumerate() {
            let Some(bucket) = self.values.get_mut(((at + offset as u64) / Self::BUCKET) as usize) else { break };
            let value = i16::from_le_bytes([sample[1], sample[2]]);
            bucket[0] = bucket[0].min(value);
            bucket[1] = bucket[1].max(value.saturating_add(i16::from(sample[0] != 0)));
        }
    }
}

/// One clip's streamed PCM: whole samples go into the peaks at their sequence
/// position; a sample split across two pipe reads waits for its other bytes.
/// Anything past the clip's length is ignored, and a stream more than two
/// samples short or long fails like the window check did.
struct ClipStream<'a> { peaks: &'a mut Peaks, at: u64, expected: u64, received: u64, carry: Vec<u8> }
impl<'a> ClipStream<'a> {
    fn new(peaks: &'a mut Peaks, at: u64, expected: u64) -> Self { Self { peaks, at, expected, received: 0, carry: Vec::with_capacity(3) } }
    fn push(&mut self, mut bytes: &[u8]) {
        if !self.carry.is_empty() {
            let take = (3 - self.carry.len()).min(bytes.len());
            self.carry.extend_from_slice(&bytes[..take]); bytes = &bytes[take..];
            if self.carry.len() < 3 { return; }
            let sample = std::mem::take(&mut self.carry);
            self.accept(&sample);
        }
        let whole = bytes.len() - bytes.len() % 3;
        self.accept(&bytes[..whole]);
        self.carry.extend_from_slice(&bytes[whole..]);
    }
    fn accept(&mut self, pcm: &[u8]) {
        let room = self.expected.saturating_sub(self.received) as usize * 3;
        self.peaks.fold(self.at + self.received, &pcm[..pcm.len().min(room)]);
        self.received += (pcm.len() / 3) as u64;
    }
    fn finish(&self) -> Result<(), AppError> {
        if !self.carry.is_empty() || self.received.abs_diff(self.expected) > 2 { return Err(AppError::invalid("Decoded audio does not match the AAF range")); }
        Ok(())
    }
}

pub async fn render(app: &AppHandle, document: &AafDocument, id: &str, start: i64, duration: i64, job: &str, output: &Path) -> Result<u64, AppError> {
    super::audio::validate_range(document, start, duration)?;
    let _permit = super::audio::preparation(app, job).await?;
    let track = store::track(document, id)?;
    linked::check_window_sources(app, job, document, track, start, duration).await?;
    let total = render_window(app, document, id, start, duration, job, output).await?;
    linked::check_window_sources(app, job, document, track, start, duration).await?;
    Ok(total)
}

/// ffmpeg arguments that decode `count` 48 kHz samples of one clip's channel,
/// from timeline frame `first`, as mono s24le into `target` (a file, or
/// `pipe:1` to stream). One definition, so a window for audition and a whole
/// clip for an overview cannot disagree about where the clip's audio starts.
#[allow(clippy::too_many_arguments)]
fn decode_args(source: &AafSource, binding: &AafResolvedSource, position: &AafSourcePosition, clip: &AafClip,
    first: i64, count: u64, rate: &AafRate, target: &str) -> Vec<String>
{
    let offset = position.numerator as f64 / position.denominator as f64 / f64::from(source.sample_rate)
        + (first-clip.start_frame) as f64 * f64::from(rate.denominator)/f64::from(rate.numerator);
    ffmpeg_decode(&binding.path, binding.stream_index, source.channel, offset, count, target)
}

fn ffmpeg_decode(path: &str, stream: u32, channel: u32, offset: f64, count: u64, target: &str) -> Vec<String> {
    let seconds = count as f64/f64::from(HZ);
    vec!["-nostdin".into(), "-hide_banner".into(), "-loglevel".into(), "error".into(),
        "-protocol_whitelist".into(), "file".into(), "-ss".into(), format!("{offset:.12}"), "-i".into(), path.into(),
        "-map".into(), format!("0:{stream}"), "-vn".into(), "-t".into(), format!("{seconds:.12}"),
        "-af".into(), format!("pan=mono|c0=c{channel}"), "-ar".into(), HZ.to_string(),
        "-c:a".into(), "pcm_s24le".into(), "-f".into(), "s24le".into(), target.into()]
}

/// The caller holds whichever gate governs this work (a playback permit, or
/// the overview build gate for the chunks of a waveform) and checks that the
/// media is unchanged before and after. Checking inside, per window, meant
/// fingerprinting every source of the track twice for each minute of an
/// overview: tens of thousands of opens over NEXIS for an hour-long lane.
async fn render_window(app: &AppHandle, document: &AafDocument, id: &str, start: i64, duration: i64, job: &str, output: &Path) -> Result<u64, AppError> {
    super::audio::validate_range(document, start, duration)?;
    process::check_cancelled(app, job)?;
    let track = store::track(document, id)?;
    let graph = document.manifest.graph.as_ref().ok_or_else(|| AppError::invalid("Missing source graph"))?;
    let rate = &document.manifest.edit_rate;
    let total = sample(start+duration, rate)-sample(start, rate);
    let mut pcm = vec![0_u8; (total*3) as usize];
    let work = WorkDir::new(app, job)?;
    for (index, clip) in track.clips.iter().enumerate() {
        let first = start.max(clip.start_frame); let end = (start+duration).min(clip.start_frame+clip.duration_frames);
        if first >= end || clip.kind == "gap" { continue; }
        if clip.kind != "audio" { return Err(AppError::invalid("This range contains unsupported processing")); }
        process::check_cancelled(app, job)?;
        let count = sample(end, rate)-sample(first, rate);
        let raw = work.0.join(format!("{index}.pcm"));
        if let Some(source) = graph.sources.iter().find(|s| Some(s.id.as_str()) == clip.source_id.as_deref()) {
            let binding = source.resolved.as_ref().ok_or_else(|| AppError::not_found("Locate this microphone's media first"))?;
            let position = graph.positions.iter().find(|p| p.track_id == id && p.clip_index == index)
                .ok_or_else(|| AppError::invalid("Missing rational source position"))?;
            let args = decode_args(source, binding, position, clip, first, count, rate, &raw.to_string_lossy());
            process::run(app, job, "decode-linked-audio", "ffmpeg", args).await?.require_success("ffmpeg")?;
        } else {
            // Mixed embedded/linked documents still extract embedded essence by
            // the established exact graph reader, never by a guessed locator.
            // This clip IS read out of the AAF, so it needs the AAF present and
            // unchanged (store::audio_source_ready skips that for linked media).
            store::source_ready(document)?;
            let wav = work.0.join(format!("{index}.wav"));
            let args = vec!["extract".into(), "--graph".into(), "--sequence".into(), graph.sequence_id.clone(),
                "--input".into(), document.source_path.clone(), "--expected-fingerprint".into(), document.manifest.source_fingerprint.clone(),
                "--track".into(), id.into(), "--start-frame".into(), first.to_string(), "--duration-frames".into(), (end-first).to_string(),
                "--output".into(), wav.to_string_lossy().into_owned()];
            process::run(app, job, "extract-embedded-audio", "saucebunny-aaf", args).await?.require_success("saucebunny-aaf")?;
            process::run(app, job, "resample-embedded-audio", "ffmpeg", vec!["-nostdin".into(), "-v".into(), "error".into(),
                "-i".into(), wav.to_string_lossy().into_owned(), "-ar".into(), HZ.to_string(), "-ac".into(), "1".into(),
                "-c:a".into(), "pcm_s24le".into(), "-f".into(), "s24le".into(), raw.to_string_lossy().into_owned()]).await?.require_success("ffmpeg")?;
        }
        let bytes = std::fs::read(raw)?;
        if bytes.len() % 3 != 0 || (bytes.len() as i64/3-count as i64).abs() > 2 { return Err(AppError::invalid("Decoded audio does not match the AAF range")); }
        let at = ((sample(first,rate)-sample(start,rate))*3) as usize;
        let take = bytes.len().min((count*3) as usize);
        pcm[at..at+take].copy_from_slice(&bytes[..take]);
    }
    process::check_cancelled(app, job)?;
    let mut file = std::fs::File::create(output)?;
    file.write_all(&header(total)?)?; file.write_all(&pcm)?;
    if !pcm.len().is_multiple_of(2) { file.write_all(&[0])?; } file.flush()?;
    Ok(total)
}

pub async fn waveform(app: &AppHandle, document: &AafDocument, id: &str, start: i64, duration: i64, may_build: bool, job: &str) -> Result<AafWaveform, AppError> {
    let track = store::track(document, id)?; linked::check_sources(app, job, document, track).await?;
    let path = store::cache(app)?.join(format!("{}.peaks-v2.bin", store::cache_key(document, id, "linked-pyramid")));
    let rate = &document.manifest.edit_rate;
    let total = sample(document.manifest.duration_frames, rate);
    let cached = || super::peaks::query(&path, sample(start,rate), sample(start+duration,rate), total, HZ).map(|peaks| AafWaveform { track_id:id.into(), peaks });
    if let Ok(waveform) = cached() { return Ok(waveform); }
    // Reading every source for an hour-long track is the heaviest thing this
    // app does on NEXIS. Only the overview request builds it; zoomed detail
    // waits for that result instead of starting its own copy.
    if !may_build { return Err(AppError::invalid(NOT_BUILT)); }
    let _claim = process::claim(app, job, &path).await?;
    let _build = super::audio::acquire(app, job, &super::peaks::BUILD).await?;
    if let Ok(waveform) = cached() { return Ok(waveform); }
    let work = WorkDir::new(app, job)?;
    let graph = document.manifest.graph.as_ref().ok_or_else(|| AppError::invalid("Missing source graph"))?;
    let mut peaks = Peaks::new(total);
    let sequence = document.manifest.duration_frames;
    // Progress is sequence position, reported as the stream arrives (a single
    // multi-hour clip would otherwise sit at 0% until it finished), and at
    // most once per percent so the event channel is not flooded.
    let per_frame = f64::from(HZ) * f64::from(rate.denominator) / f64::from(rate.numerator);
    let step = (sequence / 100).max(1);
    // Clip by clip rather than minute by minute. Each 60-second window used to
    // start its own ffmpeg, open the MXF and seek: measured on NEXIS, 223
    // launches and ~115 s for a 3h39m track, ~515 ms each whatever the audio,
    // so the cost was the launches, not the decoding. Now one ffmpeg streams a
    // whole clip. Gaps stay silent, as they did.
    for (index, clip) in track.clips.iter().enumerate() {
        let (first, end) = (clip.start_frame.max(0), (clip.start_frame + clip.duration_frames).min(sequence));
        if first >= end || clip.kind == "gap" { continue; }
        if clip.kind != "audio" { return Err(AppError::invalid("This range contains unsupported processing")); }
        super::audio::yield_to_foreground(app, job).await?;
        let linked = graph.sources.iter().find(|s| Some(s.id.as_str()) == clip.source_id.as_deref());
        if let Some(source) = linked {
            let binding = source.resolved.as_ref().ok_or_else(|| AppError::not_found("Locate this microphone's media first"))?;
            let position = graph.positions.iter().find(|p| p.track_id == id && p.clip_index == index)
                .ok_or_else(|| AppError::invalid("Missing rational source position"))?;
            let (at, count) = (sample(first, rate), sample(end, rate) - sample(first, rate));
            let mut stream = ClipStream::new(&mut peaks, at, count);
            let (mut received, mut reported) = (0_u64, first);
            process::run_streaming(app, job, "decode-linked-audio", "ffmpeg", decode_args(source, binding, position, clip, first, count, rate, "pipe:1"),
                |bytes| {
                    stream.push(bytes);
                    received += bytes.len() as u64;
                    let at = (first + ((received / 3) as f64 / per_frame) as i64).min(end);
                    if at - reported >= step { reported = at; process::progress(app, job, Some(id), "waveform", at, sequence); }
                    Ok(())
                }).await?.require_success("ffmpeg")?;
            stream.finish()?;
        } else {
            // Embedded essence keeps the established exact extractor, a minute at a time.
            let chunk = (60*u64::from(rate.numerator)/u64::from(rate.denominator)) as i64;
            let mut window = first;
            while window < end {
                let count = chunk.min(end - window);
                let wav = work.0.join("window.wav");
                super::audio::yield_to_foreground(app, job).await?;
                let samples = render_window(app, document, id, window, count, job, &wav).await?;
                let mut file = std::fs::File::open(&wav)?; file.seek(SeekFrom::Start(44))?;
                let mut bytes = vec![0; (samples*3) as usize]; file.read_exact(&mut bytes)?;
                peaks.fold(sample(window, rate), &bytes);
                window += count;
            }
        }
        process::progress(app, job, Some(id), "waveform", end, sequence);
    }
    let values = peaks.values;
    let partial = work.0.join("peaks.bin");
    super::peaks::write_pyramid(values, total, HZ, &partial, || process::check_cancelled(app,job))?;
    linked::check_sources(app, job, document, track).await?; process::check_cancelled(app,job)?;
    std::fs::rename(partial, &path)?;
    Ok(AafWaveform { track_id:id.into(), peaks: super::peaks::query(&path,sample(start,rate),sample(start+duration,rate),total,HZ)? })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 24-bit little-endian PCM from signed values, some with a nonzero low byte.
    fn pcm(values: &[i32]) -> Vec<u8> { values.iter().flat_map(|v| v.to_le_bytes()[..3].to_vec()).collect() }
    fn signal(samples: usize) -> Vec<i32> { (0..samples).map(|i| ((i as i32 * 7919) % 8_000_000) - 4_000_000).collect() }

    /// The loop this replaced, byte for byte: buckets from sample 0, each
    /// starting at [0, 0]. Existing peaks-v2 caches were written by it.
    fn window_loop(bytes: &[u8]) -> Vec<[i16; 2]> {
        let (mut values, mut low, mut high, mut bucket) = (Vec::new(), 0_i16, 0_i16, 0_u64);
        for sample in bytes.as_chunks::<3>().0 {
            let value = i16::from_le_bytes([sample[1], sample[2]]);
            low = low.min(value); high = high.max(value.saturating_add(i16::from(sample[0] != 0))); bucket += 1;
            if bucket == 256 { values.push([low, high]); low = 0; high = 0; bucket = 0; }
        }
        if bucket > 0 { values.push([low, high]); }
        values
    }

    #[test]
    fn a_streamed_clip_builds_the_same_peaks_as_the_window_loop_however_the_pipe_splits_it() {
        let bytes = pcm(&signal(10_000));
        for split in [1, 2, 4, 5, 8192, bytes.len()] {
            let mut peaks = Peaks::new(10_000);
            let mut stream = ClipStream::new(&mut peaks, 0, 10_000);
            for chunk in bytes.chunks(split) { stream.push(chunk); }
            stream.finish().unwrap();
            assert_eq!(peaks.values, window_loop(&bytes), "split {split}");
        }
    }

    #[test]
    fn clips_fold_in_by_position_and_a_shared_bucket_keeps_both() {
        // Two clips meeting mid-bucket at sample 300, streamed in reverse order.
        let (a, b) = (pcm(&vec![-1_000_000; 300]), pcm(&vec![2_000_000; 212]));
        let mut peaks = Peaks::new(512);
        { let mut stream = ClipStream::new(&mut peaks, 300, 212); stream.push(&b); stream.finish().unwrap(); }
        { let mut stream = ClipStream::new(&mut peaks, 0, 300); stream.push(&a); stream.finish().unwrap(); }
        let mut whole = a.clone(); whole.extend(&b);
        assert_eq!(peaks.values, window_loop(&whole));
        assert!(peaks.values[1][0] < 0 && peaks.values[1][1] > 0);
    }

    #[test]
    fn a_stream_the_wrong_length_or_cut_mid_sample_is_an_error_and_extra_audio_is_ignored() {
        let mut peaks = Peaks::new(100);
        let mut short = ClipStream::new(&mut peaks, 0, 100); short.push(&pcm(&signal(97)));
        assert!(short.finish().is_err());
        let mut peaks = Peaks::new(100);
        let mut ragged = ClipStream::new(&mut peaks, 0, 100); ragged.push(&pcm(&signal(100))[..299]);
        assert!(ragged.finish().is_err());
        // Two samples over is within ffmpeg's rounding, and never spills past the clip.
        let mut peaks = Peaks::new(512);
        let mut long = ClipStream::new(&mut peaks, 0, 256); long.push(&pcm(&vec![3_000_000; 258]));
        long.finish().unwrap();
        assert_eq!(peaks.values[1], [0, 0]);
    }

    /// The real ffmpeg, both ways, on a generated clip read from an offset:
    /// one decode per minute into files (the old build) and one streamed pipe
    /// (the new). The peaks must be identical.
    /// cd src-tauri && cargo test --lib nightly_streamed -- --ignored --nocapture
    #[test]
    #[ignore]
    fn nightly_streamed_overview_matches_the_per_minute_decode() {
        use std::{io::Read, process::{Command, Stdio}};
        let ffmpeg = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries/ffmpeg-aarch64-apple-darwin");
        let dir = std::env::temp_dir().join(format!("sb-stream-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("clip.wav");
        assert!(Command::new(&ffmpeg).args(["-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=331:duration=190,volume=0.4",
            "-ac", "1", "-ar", "48000", "-c:a", "pcm_s24le"]).arg(&wav).status().unwrap().success());
        let (offset, count) = (7.25, 180 * u64::from(HZ));
        let started = std::time::Instant::now();
        let mut windows = Vec::new();
        let mut first = 0;
        while first < count {
            let take = (60 * u64::from(HZ)).min(count - first);
            let raw = dir.join("window.raw");
            let args = ffmpeg_decode(&wav.to_string_lossy(), 0, 0, offset + first as f64 / f64::from(HZ), take, &raw.to_string_lossy());
            assert!(Command::new(&ffmpeg).args(&args).status().unwrap().success());
            windows.extend(std::fs::read(&raw).unwrap());
            first += take;
        }
        let expected = window_loop(&windows);
        let per_minute = started.elapsed();
        let started = std::time::Instant::now();
        let mut peaks = Peaks::new(count);
        let mut stream = ClipStream::new(&mut peaks, 0, count);
        let mut child = Command::new(&ffmpeg).args(ffmpeg_decode(&wav.to_string_lossy(), 0, 0, offset, count, "pipe:1")).stdout(Stdio::piped()).spawn().unwrap();
        let mut out = child.stdout.take().unwrap();
        let mut buffer = vec![0; 8192];
        loop { let read = out.read(&mut buffer).unwrap(); if read == 0 { break; } stream.push(&buffer[..read]); }
        assert!(child.wait().unwrap().success());
        stream.finish().unwrap();
        let streamed = started.elapsed();
        // Local launches are cheap; on NEXIS each one measured ~515 ms, so this
        // is a correctness check first and a timing only for the curious.
        eprintln!("3 minutes of audio, decode and peaks: per-minute {per_minute:?}, streamed {streamed:?}");
        assert_eq!(peaks.values, expected);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
