//! Reusable min/max pyramid, not one PCM extraction per viewport. Base buckets
//! contain 256 source samples (~5 ms at 48 kHz); parent buckets preserve extrema.
//! Binary i16 pairs keep the two-level sum below 1/32 of 16-bit mono PCM size.
use super::{audio::WorkDir, model::*, pcm, process, store};
use crate::AppError;
use std::{fs::File, io::{Read, Seek, SeekFrom, Write}, path::Path};
use tauri::AppHandle;

const BASE: u64 = 256;
const POINTS: u64 = 2048;
const HEADER: u64 = 32;
static BUILD: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn sample(bytes: &[u8]) -> i16 {
    // Round outwards below when reducing. Retain low-amplitude activity even
    // in 24/32-bit recordings, without inventing a normalized gain per track.
    match bytes.len() {
        2 => i16::from_le_bytes([bytes[0],bytes[1]]),
        3 => i16::from_le_bytes([bytes[1],bytes[2]]),
        _ => i16::from_le_bytes([bytes[2],bytes[3]]),
    }
}
fn write_pairs(file: &mut File, values: &[[i16; 2]]) -> Result<(), AppError> {
    let mut bytes = Vec::with_capacity(values.len() * 4);
    for pair in values { bytes.extend(pair[0].to_le_bytes()); bytes.extend(pair[1].to_le_bytes()); }
    file.write_all(&bytes)?; Ok(())
}
pub fn build(reader: &pcm::Reader, track: &pcm::Track, path: &Path, check: impl Fn() -> Result<(), AppError>) -> Result<(), AppError> {
    let samples = reader.index.sample(reader.index.duration_frames, track.sample_rate);
    // 24h/96k upper bound: at most ~130 MiB temporary base values, no PCM retained.
    let mut values = Vec::with_capacity(samples.div_ceil(BASE) as usize);
    let (mut low, mut high, mut count) = (0_i16, 0_i16, 0_u64);
    reader.blocks(track, 0, reader.index.duration_frames, |block| {
        check()?;
        for bytes in block.chunks_exact(track.sample_width as usize) {
            let value = sample(bytes); low = low.min(value); high = high.max(value);
            if track.sample_width > 2 && bytes[..bytes.len()-2].iter().any(|b| *b != 0) { high = high.max(value.saturating_add(1)); }
            count += 1;
            if count == BASE { values.push([low,high]); low = 0; high = 0; count = 0; }
        }
        Ok(())
    })?;
    if count > 0 { values.push([low,high]); }
    write_pyramid(values, samples, track.sample_rate, path, check)
}

pub fn write_pyramid(mut values: Vec<[i16;2]>, samples: u64, hz: u32, path: &Path, check: impl Fn() -> Result<(), AppError>) -> Result<(), AppError> {
    let mut file = File::create(path)?;
    file.write_all(b"SBPEAK01")?; file.write_all(&samples.to_le_bytes())?;
    file.write_all(&u64::from(hz).to_le_bytes())?; file.write_all(&BASE.to_le_bytes())?;
    loop {
        check()?; write_pairs(&mut file, &values)?;
        if values.len() <= 1 { break; }
        values = values.chunks(2).map(|pair| [pair.iter().map(|p|p[0]).min().unwrap_or(0), pair.iter().map(|p|p[1]).max().unwrap_or(0)]).collect();
    }
    file.flush()?; check()?; Ok(())
}

pub fn query(path: &Path, first: u64, end: u64, expected_samples: u64, hz: u32) -> Result<Vec<[f32; 2]>, AppError> {
    let bad = || AppError::invalid("Invalid cached waveform; re-open the AAF to rebuild it");
    let mut file = File::open(path)?; let mut header = [0_u8; HEADER as usize]; file.read_exact(&mut header)?;
    let number = |at| { let mut value = [0_u8; 8]; value.copy_from_slice(&header[at..at+8]); u64::from_le_bytes(value) };
    if &header[..8] != b"SBPEAK01" || number(8) != expected_samples || number(16) != u64::from(hz) || number(24) != BASE || first >= end || end > expected_samples { return Err(bad()); }
    let mut offset = HEADER; let mut bucket = BASE; let mut count = expected_samples.div_ceil(BASE);
    while bucket * 2 <= (end-first) / POINTS && count > 1 { offset += count * 4; bucket *= 2; count = count.div_ceil(2); }
    let lo = first / bucket; let hi = end.div_ceil(bucket).min(count);
    if hi - lo > POINTS * 2 + 2 || offset + hi * 4 > file.metadata()?.len() { return Err(bad()); }
    file.seek(SeekFrom::Start(offset + lo * 4))?;
    let mut bytes = vec![0; ((hi-lo)*4) as usize]; file.read_exact(&mut bytes)?;
    let pairs: Vec<[i16;2]> = bytes.chunks_exact(4).map(|p| [i16::from_le_bytes([p[0],p[1]]),i16::from_le_bytes([p[2],p[3]])]).collect();
    if pairs.iter().any(|p| p[0] > p[1]) { return Err(bad()); }
    let points = POINTS.min(end-first);
    Ok((0..points).map(|x| {
        let a = (first + x*(end-first)/points)/bucket-lo;
        let b = (first + ((x+1)*(end-first)).div_ceil(points)).div_ceil(bucket).min(hi)-lo;
        let values = &pairs[a as usize..b.max(a+1).min(pairs.len() as u64) as usize];
        [f32::from(values.iter().map(|p|p[0]).min().unwrap_or(0))/32768., f32::from(values.iter().map(|p|p[1]).max().unwrap_or(0))/32768.]
    }).collect())
}

pub async fn waveform(app: &AppHandle, document: &AafDocument, track: &str, start: i64, duration: i64, job: &str) -> Result<AafWaveform, AppError> {
    store::track(document, track)?; store::source_ready(document)?;
    if super::linked_audio::needed(document) { return super::linked_audio::waveform(app, document, track, start, duration, job).await; }
    let reader = pcm::get(app, document, job).await?;
    let selected = reader.index.track(track)?;
    let first = reader.index.sample(start, selected.sample_rate);
    let end = reader.index.sample(start + duration, selected.sample_rate);
    let total = reader.index.sample(document.manifest.duration_frames, selected.sample_rate);
    let path = store::cache(app)?.join(format!("{}.peaks-v1.bin", store::cache_key(document, track, "pyramid")));
    if path.is_file() {
        if let Ok(peaks) = query(&path, first, end, total, selected.sample_rate) { return Ok(AafWaveform { track_id: track.into(), peaks }); }
    }
    // Cancellation is checked after waiting and once per bounded read. No detached
    // scans survive tab changes; a new request can rebuild a cancelled partial.
    let _build = BUILD.lock().await;
    process::check_cancelled(app, job)?;
    if path.is_file() {
        if let Ok(peaks) = query(&path, first, end, total, selected.sample_rate) { return Ok(AafWaveform { track_id: track.into(), peaks }); }
    }
    let work = WorkDir::new(app, job)?; let partial = work.0.join("peaks.bin");
    let _permit = super::audio::preparation(app, job).await?;
    let (app2, job2, track2, partial2) = (app.clone(), job.to_owned(), track.to_owned(), partial.clone());
    tauri::async_runtime::spawn_blocking(move || build(&reader, reader.index.track(&track2)?, &partial2, || process::check_cancelled(&app2, &job2))).await
        .map_err(|e| AppError::internal(e.to_string()))??;
    process::check_cancelled(app, job)?; store::source_ready(document)?;
    std::fs::rename(partial, &path)?;
    let reader = pcm::get(app, document, job).await?;
    let peaks = query(&path, first, end, total, reader.index.track(track)?.sample_rate)?;
    Ok(AafWaveform { track_id: track.into(), peaks })
}
