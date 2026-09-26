//! Bounded native decoding into the existing Multitrack clock. Original media
//! stays read-only. Only generated PCM windows enter the webview/cache.
use super::{audio::WorkDir, linked, model::*, process, store};
use crate::AppError;
use std::{io::{Read, Seek, SeekFrom, Write}, path::Path};
use tauri::AppHandle;

const HZ: u32 = 48_000;

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

pub async fn render(app: &AppHandle, document: &AafDocument, id: &str, start: i64, duration: i64, job: &str, output: &Path) -> Result<u64, AppError> {
    super::audio::validate_range(document, start, duration)?;
    let _permit = super::audio::preparation(app, job).await?;
    render_window(app, document, id, start, duration, job, output).await
}

/// The caller holds whichever gate governs this work: a playback permit, or
/// the overview build gate for the chunks of a waveform.
async fn render_window(app: &AppHandle, document: &AafDocument, id: &str, start: i64, duration: i64, job: &str, output: &Path) -> Result<u64, AppError> {
    super::audio::validate_range(document, start, duration)?;
    process::check_cancelled(app, job)?;
    let track = store::track(document, id)?;
    linked::check_sources(document, track)?;
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
            let offset = position.numerator as f64 / position.denominator as f64 / f64::from(source.sample_rate)
                + (first-clip.start_frame) as f64 * f64::from(rate.denominator)/f64::from(rate.numerator);
            let seconds = count as f64/f64::from(HZ);
            let args = vec!["-nostdin".into(), "-hide_banner".into(), "-loglevel".into(), "error".into(),
                "-protocol_whitelist".into(), "file".into(), "-ss".into(), format!("{offset:.12}"), "-i".into(), binding.path.clone(),
                "-map".into(), format!("0:{}", binding.stream_index), "-vn".into(), "-t".into(), format!("{seconds:.12}"),
                "-af".into(), format!("pan=mono|c0=c{}", source.channel), "-ar".into(), HZ.to_string(),
                "-c:a".into(), "pcm_s24le".into(), "-f".into(), "s24le".into(), raw.to_string_lossy().into_owned()];
            process::run(app, job, "decode-linked-audio", "ffmpeg", args).await?.require_success("ffmpeg")?;
        } else {
            // Mixed embedded/linked documents still extract embedded essence by
            // the established exact graph reader, never by a guessed locator.
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
    linked::check_sources(document, track)?; store::source_ready(document)?; process::check_cancelled(app, job)?;
    let mut file = std::fs::File::create(output)?;
    file.write_all(&header(total)?)?; file.write_all(&pcm)?;
    if !pcm.len().is_multiple_of(2) { file.write_all(&[0])?; } file.flush()?;
    Ok(total)
}

pub async fn waveform(app: &AppHandle, document: &AafDocument, id: &str, start: i64, duration: i64, may_build: bool, job: &str) -> Result<AafWaveform, AppError> {
    let track = store::track(document, id)?; linked::check_sources(document, track)?;
    let path = store::cache(app)?.join(format!("{}.peaks-v2.bin", store::cache_key(document, id, "linked-pyramid")));
    let rate = &document.manifest.edit_rate;
    let total = sample(document.manifest.duration_frames, rate);
    let cached = || super::peaks::query(&path, sample(start,rate), sample(start+duration,rate), total, HZ).map(|peaks| AafWaveform { track_id:id.into(), peaks });
    if let Ok(waveform) = cached() { return Ok(waveform); }
    // Reading every source for an hour-long track is the heaviest thing this
    // app does on NEXIS. Only the overview request builds it; zoomed detail
    // waits for that result instead of starting its own copy.
    if !may_build { return Err(AppError::invalid("The waveform overview for this track is still being prepared")); }
    let _build = super::audio::acquire(app, job, &super::peaks::BUILD).await?;
    if let Ok(waveform) = cached() { return Ok(waveform); }
    let work = WorkDir::new(app, job)?;
    let mut values = Vec::new(); let (mut low, mut high, mut bucket) = (0_i16, 0_i16, 0_u64);
    let chunk = (60*u64::from(rate.numerator)/u64::from(rate.denominator)) as i64;
    let mut first = 0;
    while first < document.manifest.duration_frames {
        let count = chunk.min(document.manifest.duration_frames-first);
        let wav = work.0.join("window.wav");
        let samples = render_window(app, document, id, first, count, job, &wav).await?;
        let mut file = std::fs::File::open(&wav)?; file.seek(SeekFrom::Start(44))?;
        let mut bytes = vec![0; (samples*3) as usize]; file.read_exact(&mut bytes)?;
        for sample in bytes.as_chunks::<3>().0 {
            let value = i16::from_le_bytes([sample[1],sample[2]]);
            low = low.min(value); high = high.max(value.saturating_add(i16::from(sample[0] != 0))); bucket += 1;
            if bucket == 256 { values.push([low,high]); low=0; high=0; bucket=0; }
        }
        first += count; process::progress(app, job, Some(id), "waveform", first, document.manifest.duration_frames);
    }
    if bucket>0 { values.push([low,high]); }
    let partial = work.0.join("peaks.bin");
    super::peaks::write_pyramid(values, total, HZ, &partial, || process::check_cancelled(app,job))?;
    linked::check_sources(document, track)?; process::check_cancelled(app,job)?;
    std::fs::rename(partial, &path)?;
    Ok(AafWaveform { track_id:id.into(), peaks: super::peaks::query(&path,sample(start,rate),sample(start+duration,rate),total,HZ)? })
}
