//! The voice check (docs/TRANSCRIPT-ACCURACY-SPEC-2026-10-04.md, phase 4).
//!
//! A voiceprint is 256 numbers describing what a voice sounds like (the shape
//! of the vocal tract, the pitch range), from FluidAudio's WeSpeaker model in
//! the diarize sidecar (`--embed`). The check learns each mic owner's voice
//! from stretches where that mic clearly dominates (nobody records a sample),
//! then listens to the words the bleed resolver was unsure of. It is the
//! tie-breaker, not the main signal: voiceprints degrade on short words,
//! distant reverberant audio and overlapped speech, which is where bleed lives.
//!
//! Voiceprints are biometric data: kept in `app_data_dir()/voiceprints/`, never
//! in iCloud-synced Documents, never on the wire, never given to an assistant
//! (only the labels they settle reach the ownership cache). Settings deletes them.
use super::{audio, model::*, ownership, peaks, process, store};
use crate::bleed::{self, AafOwnershipLabel, AafWordOwnership};
use crate::AppError;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// A mic dominates a stretch it is this much louder than every other mic in.
pub const ENROL_DB: f32 = 15.0;
/// Stretches shorter than this say little about a voice.
pub const ENROL_MIN_SECONDS: f64 = 2.0;
/// About a minute of a voice is enough to know it.
pub const ENROL_SECONDS: f64 = 60.0;
/// Learned from one window of a mic (the most it can extract at once).
pub const WINDOW_SECONDS: f64 = 600.0;
/// A voice matches when its cosine reaches this... MEASURED on AFF BANK 1
/// (20 lavs, 4 minutes): the same person's two halves scored 0.29 to 0.7
/// (median 0.54), different people 0.09 median and 0.30 at most, and on 20
/// held-out 1.5 s clips 0.40 called 35% right and none wrong (0.50: 20% right;
/// 0.30: 40% right, 5% wrong). Synthetic speech had suggested 0.5; real lavs
/// are noisier. A small sample: phase 0's scenes should move it.
pub const MATCH: f32 = 0.4;
/// ...and beats the next voice by this much.
pub const MARGIN: f32 = 0.1;
/// Two owners this alike cannot be told apart by voice.
pub const TWIN: f32 = 0.6;
/// A mic's late voice this unlike its early one has probably changed hands.
pub const SWAP: f32 = 0.5;
/// The window listened to around an unsure word.
pub const WORD_SECONDS: f64 = 1.5;
/// The owner's mic hears a word first, by a few milliseconds of air.
pub const LEAD_MS: f32 = 2.0;
/// A check stays bounded on a sequence full of unsure words: about a 3-hour,
/// 20-mic sequence whose mics barely separate (AFF BANK 1 had 2,000 unsure
/// words a minute). Words are heard a ten-minute window at a time.
pub const MAX_WORDS: usize = 100_000;
const HZ: f64 = 16_000.0;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Voice { pub track_id: String, pub early: Vec<f32>, #[serde(default)] pub late: Option<Vec<f32>> }

/// One document's learned voices and the calls they settled.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Voiceprints { pub document_id: String, pub voices: Vec<Voice>, pub decisions: Vec<AafWordOwnership>, pub warnings: Vec<String> }

pub fn dir(app_data: &Path) -> PathBuf { app_data.join("voiceprints") }
pub fn file(app_data: &Path, document_id: &str) -> PathBuf { dir(app_data).join(format!("{document_id}.json")) }

pub fn cos(a: &[f32], b: &[f32]) -> f32 { a.iter().zip(b).map(|(x, y)| x * y).sum() }

fn unit(mut vector: Vec<f32>) -> Option<Vec<f32>> {
    let norm = vector.iter().map(|value| value * value).sum::<f32>().sqrt();
    if !(norm > 0.0 && norm.is_finite()) { return None; }
    for value in &mut vector { *value /= norm; }
    Some(vector)
}

/// The mean of a voice's prints, after dropping the ones far from the first
/// mean (a cough, a neighbour leaning in), at unit length.
pub fn centroid(prints: &[Vec<f32>]) -> Option<Vec<f32>> {
    let mean = |list: &[&Vec<f32>]| -> Option<Vec<f32>> {
        let first = list.first()?;
        let mut sum = vec![0f32; first.len()];
        for print in list { for (slot, value) in sum.iter_mut().zip(print.iter()) { *slot += value; } }
        unit(sum)
    };
    let all: Vec<&Vec<f32>> = prints.iter().filter(|print| !print.is_empty()).collect();
    let rough = mean(&all)?;
    let kept: Vec<&Vec<f32>> = all.iter().copied().filter(|print| cos(print, &rough) >= 0.4).collect();
    mean(if kept.is_empty() { &all } else { &kept })
}

/// Stretches where a mic clearly dominates, from its owner words (start, end,
/// delta dB) in time order: words at least `ENROL_DB` louder than every other
/// mic, joined across gaps under 0.3 s, kept when at least 2 s long.
pub fn stretches(words: &[(i64, i64, f32)]) -> Vec<(i64, i64)> {
    join(&words.iter().filter(|(_, _, delta)| *delta >= ENROL_DB).map(|(s, e, _)| (*s, *e)).collect::<Vec<_>>(), ENROL_MIN_SECONDS)
}

/// Spans in time order joined across gaps under 0.3 s, kept when at least
/// `shortest` seconds long.
pub fn join(spans: &[(i64, i64)], shortest: f64) -> Vec<(i64, i64)> {
    let (gap, shortest) = ((0.3 * HZ) as i64, (shortest * HZ) as i64);
    let mut out: Vec<(i64, i64)> = Vec::new();
    for &(start, end) in spans {
        match out.last_mut() {
            Some(last) if start - last.1 <= gap => last.1 = last.1.max(end),
            _ => out.push((start, end)),
        }
    }
    out.retain(|(start, end)| end - start >= shortest);
    out
}

/// Below this much dominant speech, a voice is learned from the words only
/// this mic heard instead.
pub const ENROL_FALLBACK_SECONDS: f64 = 15.0;

/// The window of `WINDOW_SECONDS` inside [from, to) holding the most stretch
/// time, and the stretches in it up to `ENROL_SECONDS`.
pub fn best_window(stretches: &[(i64, i64)], from: i64, to: i64) -> Option<(i64, Vec<(i64, i64)>)> {
    let window = (WINDOW_SECONDS * HZ) as i64;
    let inside: Vec<(i64, i64)> = stretches.iter().copied().filter(|(start, end)| *start >= from && *end <= to).collect();
    let mut best: Option<(i64, i64)> = None;
    for &(start, _) in &inside {
        let covered: i64 = inside.iter().filter(|(s, e)| *s >= start && *e <= start + window).map(|(s, e)| e - s).sum();
        if best.is_none_or(|(_, most)| covered > most) { best = Some((start, covered)); }
    }
    let (start, _) = best?;
    let mut taken = Vec::new();
    let mut total = 0;
    for &(s, e) in inside.iter().filter(|(s, e)| *s >= start && *e <= start + window) {
        if total as f64 >= ENROL_SECONDS * HZ { break; }
        taken.push((s, e));
        total += e - s;
    }
    Some((start, taken))
}

#[derive(Debug, Clone, PartialEq)]
pub enum Call { Owner, Other(String), Unknown }

/// Whose voice a word is, from its cosine against every learned owner. Twins
/// (owners too alike to tell apart) never decide anything by voice.
pub fn decide(own: &str, scores: &[(String, f32)], twins: &HashSet<String>) -> Call {
    if twins.contains(own) { return Call::Unknown; }
    let mine = scores.iter().find(|(track, _)| track == own).map(|(_, score)| *score);
    let best = scores.iter().filter(|(track, _)| track != own).max_by(|a, b| a.1.total_cmp(&b.1));
    match (mine, best) {
        (Some(mine), best) if mine >= MATCH && best.is_none_or(|(_, other)| mine - other >= MARGIN) => Call::Owner,
        (mine, Some((track, other))) if *other >= MATCH && other - mine.unwrap_or(0.0) >= MARGIN && !twins.contains(track) => Call::Other(track.clone()),
        _ => Call::Unknown,
    }
}

/// How many ms after `a` the same sound reaches `b` (positive: `a` heard it
/// first), by normalised cross-correlation within ±20 ms after a pre-emphasis
/// that flattens the voice's low end, and how strong that peak is.
pub fn lag_ms(a: &[f32], b: &[f32]) -> Option<(f32, f32)> {
    let emphasise = |signal: &[f32]| -> Vec<f32> { signal.windows(2).map(|pair| pair[1] - 0.97 * pair[0]).collect() };
    let (a, b) = (emphasise(a), emphasise(b));
    let length = a.len().min(b.len());
    let reach = (0.020 * HZ) as usize;
    if length <= 2 * reach + 160 { return None; }
    let energy = |signal: &[f32]| signal[reach..length - reach].iter().map(|v| v * v).sum::<f32>();
    let scale = (energy(&a) * energy(&b)).sqrt();
    if scale <= 0.0 { return None; }
    let mut best = (0i64, f32::MIN);
    for shift in -(reach as i64)..=(reach as i64) {
        let sum: f32 = (reach..length - reach).map(|n| a[n] * b[(n as i64 + shift) as usize]).sum();
        if sum > best.1 { best = (shift, sum); }
    }
    Some((best.0 as f32 / HZ as f32 * 1000.0, best.1 / scale))
}

fn frame_at(sample: i64, rate: &AafRate) -> i64 {
    (i128::from(sample.max(0)) * i128::from(rate.numerator) / (i128::from(ASR_RATE) * i128::from(rate.denominator))) as i64
}

/// Extract [start, end) samples of a mic at 16 kHz: (samples, the sample the
/// clip actually starts at, which lands on a frame).
async fn clip(app: &AppHandle, document: &AafDocument, track: &str, start: i64, end: i64, job: &str) -> Result<(PathBuf, audio::WorkDir, i64), AppError> {
    let rate = &document.manifest.edit_rate;
    let first = frame_at(start, rate);
    // extract_16k reads at most ten minutes; a full enrolment window plus the
    // frame of rounding would ask for one frame more.
    let most = (i128::from(rate.numerator) * 600 / i128::from(rate.denominator.max(1))) as i64;
    let last = (frame_at(end, rate) + 1).min(document.manifest.duration_frames).min(first + most);
    let work = audio::WorkDir::new(app, job)?;
    let (wav, _) = audio::extract_16k(app, document, track, first, (last - first).max(1), job, &work.0).await?;
    Ok((wav, work, frame_samples(first, rate)?))
}

/// One voiceprint per span (seconds into the clip), from the diarize sidecar.
async fn prints(app: &AppHandle, job: &str, wav: &Path, spans: &[(f64, f64)]) -> Result<Vec<Option<Vec<f32>>>, AppError> {
    if spans.is_empty() { return Ok(vec![]); }
    let folder = wav.parent().ok_or_else(|| AppError::internal("clip has no folder"))?;
    let (input, output) = (folder.join("spans.json"), folder.join("prints.json"));
    std::fs::write(&input, serde_json::to_vec(&spans.iter().map(|(a, b)| [*a, *b]).collect::<Vec<_>>())?)?;
    let args = vec!["--embed".into(), "--input".into(), wav.to_string_lossy().into_owned(), "--spans".into(), input.to_string_lossy().into_owned(),
        "--output".into(), output.to_string_lossy().into_owned()];
    process::run(app, job, "voices", "saucebunny-diarize", args).await?.require_success("saucebunny-diarize --embed")?;
    let list: Vec<Option<Vec<f32>>> = store::read_json(&output)?;
    Ok(list.into_iter().map(|print| print.and_then(unit)).collect())
}

/// Learn the voices, settle the unsure words, save, and answer with the
/// document's labels as they now stand.
pub async fn check(app: &AppHandle, document_id: &str, job: &str) -> Result<ownership::AafOwnership, AppError> {
    let root = store::root(app)?;
    let document = store::load(&root, document_id)?;
    let mut overviews = Vec::new();
    for track in &document.manifest.tracks {
        let path = peaks::overview_path(app, &document, &track.id)?;
        if path.is_file() { overviews.push((track.id.clone(), path)); }
    }
    if overviews.len() < 2 { return Err(AppError::invalid("Measure the mics first: the voice check starts from their levels.")); }
    let (doc, list) = (document.clone(), overviews.clone());
    let analysis = tauri::async_runtime::spawn_blocking(move || ownership::analyse(&doc, &list)).await.map_err(|e| AppError::internal(e.to_string()))?;
    let total = frame_samples(document.manifest.duration_frames, &document.manifest.edit_rate)?;
    let at: HashMap<(String, String, u32), (i64, i64)> = analysis.words.iter().map(|w| ((w.track_id.clone(), w.cue_id.clone(), w.index), (w.start, w.end))).collect();
    let tracks: Vec<String> = document.transcripts.iter().map(|t| t.track_id.clone()).filter(|t| analysis.measured.contains(t)).collect();
    let unique = bleed::unique_words(&analysis.words);

    // 1. Each owner's voice, early in the day and (on a long sequence) late.
    let mut voices = Vec::new();
    for (index, track) in tracks.iter().enumerate() {
        process::check_cancelled(app, job)?;
        process::progress(app, job, Some(track), "learning-voices", index as i64, tracks.len() as i64);
        let mut owned: Vec<(i64, i64, f32)> = analysis.labels.values().filter(|w| &w.track_id == track && w.label == AafOwnershipLabel::Owner && !w.manual)
            .filter_map(|w| at.get(&(w.track_id.clone(), w.cue_id.clone(), w.index)).map(|(s, e)| (*s, *e, w.delta_db))).collect();
        owned.sort_by_key(|(start, _, _)| *start);
        let mut found = stretches(&owned);
        // When no mic clearly dominates (AFF BANK 1: none was 15 dB louder
        // for two seconds), learn the voice from what only this mic heard.
        if (found.iter().map(|(s, e)| e - s).sum::<i64>() as f64) < ENROL_FALLBACK_SECONDS * HZ {
            let mut own_words: Vec<(i64, i64)> = analysis.words.iter().filter(|w| &w.track_id == track && unique.contains(&(w.track_id.clone(), w.cue_id.clone(), w.index)))
                .map(|w| (w.start, w.end)).collect();
            own_words.sort_unstable();
            found = join(&own_words, 1.5);
        }
        let Some((early_at, early)) = best_window(&found, 0, total) else { continue };
        let mut learned = Vec::new();
        let half = total / 2;
        let late_range = if early_at < half { (half, total) } else { (0, half) };
        let late = if total as f64 >= 1800.0 * HZ { best_window(&found, late_range.0, late_range.1) } else { None };
        for spans in std::iter::once(Some(early)).chain(std::iter::once(late.map(|(_, spans)| spans))) {
            let Some(spans) = spans else { learned.push(None); continue };
            let (from, to) = (spans.iter().map(|s| s.0).min().unwrap_or(0), spans.iter().map(|s| s.1).max().unwrap_or(0));
            let (wav, _work, offset) = clip(app, &document, track, from, to, job).await?;
            let relative: Vec<(f64, f64)> = spans.iter().map(|(s, e)| ((s - offset) as f64 / HZ, (e - offset) as f64 / HZ)).collect();
            let got: Vec<Vec<f32>> = prints(app, job, &wav, &relative).await?.into_iter().flatten().collect();
            learned.push(centroid(&got));
        }
        if let Some(Some(early)) = learned.first().cloned() { voices.push(Voice { track_id: track.clone(), early, late: learned.get(1).cloned().flatten() }); }
    }

    // 2. Look-alikes and mics that changed hands.
    let mut warnings = Vec::new();
    let mut twins = HashSet::new();
    let name = |track: &str| document.labels.iter().find(|label| label.track_id == track).map(|label| label.owner_name.clone()).filter(|name| !name.trim().is_empty())
        .or_else(|| document.manifest.tracks.iter().find(|t| t.id == track).map(|t| t.name.clone())).unwrap_or_else(|| track.to_string());
    for (i, a) in voices.iter().enumerate() {
        for b in &voices[i + 1..] {
            if cos(&a.early, &b.early) >= TWIN {
                twins.insert(a.track_id.clone()); twins.insert(b.track_id.clone());
                warnings.push(format!("{} and {} sound too alike to tell apart by voice; their lines rely on mic levels alone.", name(&a.track_id), name(&b.track_id)));
            }
        }
        if let Some(late) = &a.late {
            if cos(&a.early, late) < SWAP {
                let like = voices.iter().filter(|other| other.track_id != a.track_id).find(|other| cos(&other.early, late) >= TWIN);
                warnings.push(match like {
                    Some(other) => format!("{}'s mic may have changed hands: later in the day it sounds like {}.", name(&a.track_id), name(&other.track_id)),
                    None => format!("{}'s mic may have changed hands: later in the day it sounds like someone else.", name(&a.track_id)),
                });
                twins.insert(a.track_id.clone());
            }
        }
    }

    // 3. The unsure words, a mic and a ten-minute window at a time: one clip
    //    per window, every word in it heard by voice in one sidecar call, and
    //    the loudest other mic's clip only for words the voice cannot settle.
    //    On AFF BANK 1, whose mics sit 0.8 dB apart, 80% of words were unsure,
    //    so this has to be the window's cost, not a clip per word.
    let mut unsure: Vec<&AafWordOwnership> = analysis.labels.values().filter(|w| w.label == AafOwnershipLabel::Unsure && voices.iter().any(|v| v.track_id == w.track_id)).collect();
    unsure.sort_by_key(|w| (w.track_id.clone(), at.get(&(w.track_id.clone(), w.cue_id.clone(), w.index)).map(|(s, _)| *s).unwrap_or(0)));
    unsure.truncate(MAX_WORDS);
    let window = (WINDOW_SECONDS * HZ) as i64;
    let mut by_window: std::collections::BTreeMap<(String, i64), Vec<&AafWordOwnership>> = std::collections::BTreeMap::new();
    for word in &unsure {
        let (start, _) = at[&(word.track_id.clone(), word.cue_id.clone(), word.index)];
        by_window.entry((word.track_id.clone(), start / window)).or_default().push(word);
    }
    let scores_for = |print: &[f32]| -> Vec<(String, f32)> { voices.iter().map(|v| (v.track_id.clone(), cos(print, &v.early))).collect() };
    let text_of = |w: &AafWordOwnership| analysis.words.iter().find(|x| x.track_id == w.track_id && x.cue_id == w.cue_id && x.index == w.index).map(|x| x.text.clone()).unwrap_or_default();
    let mut decisions = Vec::new();
    let pad = (0.25 * HZ) as i64;
    let windows = by_window.len();
    for (done, ((track, slot), words)) in by_window.into_iter().enumerate() {
        process::check_cancelled(app, job)?;
        process::progress(app, job, Some(&track), "checking-voices", done as i64, windows as i64);
        let (from, to) = (slot * window, ((slot + 1) * window).min(total));
        let (wav, _work, offset) = clip(app, &document, &track, from, to, job).await?;
        let spans: Vec<(i64, i64)> = words.iter().map(|w| at[&(w.track_id.clone(), w.cue_id.clone(), w.index)]).collect();
        let listened: Vec<(f64, f64)> = spans.iter().map(|(s, e)| {
            let middle = (s + e) as f64 / 2.0 - offset as f64;
            (((middle / HZ) - WORD_SECONDS / 2.0).max(0.0), (middle / HZ) + WORD_SECONDS / 2.0)
        }).collect();
        let heard = prints(app, job, &wav, &listened).await?;
        let mut undecided = Vec::new();
        for ((word, span), print) in words.iter().zip(&spans).zip(heard) {
            match print.as_deref().map(|print| decide(&track, &scores_for(print), &twins)).unwrap_or(Call::Unknown) {
                Call::Owner => decisions.push(AafWordOwnership { label: AafOwnershipLabel::Owner, heard_on: None, ..(*word).clone() }),
                // Another owner's voice on this mic: when their own mic heard
                // the same word, this copy is bleed from it; when it did not,
                // they leaned into this mic, and the line stays visible as theirs.
                Call::Other(other) => {
                    let label = if bleed::heard_on(&analysis.words, &other, span.0, &text_of(word)) { AafOwnershipLabel::Bleed } else { AafOwnershipLabel::Other };
                    decisions.push(AafWordOwnership { label, heard_on: Some(other), ..(*word).clone() });
                }
                Call::Unknown => undecided.push((*word, *span)),
            }
        }
        // Who heard it first, for what the voice left open: each word against
        // the loudest other mic over it, one clip per rival in this window.
        let mine = if undecided.is_empty() { None } else { audio::read_wav(&wav).ok() };
        let mut rivals: HashMap<String, Option<(Vec<f32>, i64)>> = HashMap::new();
        for (word, span) in undecided {
            let Some(mine) = &mine else { break };
            let Some(rival) = analysis.channels.iter().filter(|c| c.track_id != track)
                .filter_map(|c| bleed::snr(c, span.0, span.1).map(|level| (c.track_id.clone(), level))).max_by(|a, b| a.1.total_cmp(&b.1)).map(|(id, _)| id) else { continue };
            if !rivals.contains_key(&rival) {
                let read = match clip(app, &document, &rival, from, to, job).await {
                    Ok((other, _work2, other_offset)) => audio::read_wav(&other).ok().map(|samples| (samples, other_offset)),
                    Err(error) => return Err(error),
                };
                rivals.insert(rival.clone(), read);
            }
            let Some(Some((theirs, their_offset))) = rivals.get(&rival) else { continue };
            let cut = |samples: &Vec<f32>, origin: i64| -> Vec<f32> {
                let (s, e) = ((span.0 - origin - pad).max(0) as usize, ((span.1 - origin + pad).max(0) as usize).min(samples.len()));
                if s < e { samples[s..e].to_vec() } else { vec![] }
            };
            if let Some((lead, strength)) = lag_ms(&cut(mine, offset), &cut(theirs, *their_offset)) {
                if lead >= LEAD_MS && strength >= 0.3 { decisions.push(AafWordOwnership { label: AafOwnershipLabel::Owner, heard_on: None, ..word.clone() }); }
            }
        }
    }
    let app_data = app.path().app_data_dir().map_err(|e| AppError::internal(e.to_string()))?;
    let saved = Voiceprints { document_id: document_id.into(), voices, decisions, warnings };
    std::fs::create_dir_all(dir(&app_data))?;
    crate::commands::system::write_bytes_impl(&file(&app_data, document_id).to_string_lossy(), &serde_json::to_vec(&saved)?, false, false, true)?;
    ownership::resolve(app, document_id, false, job).await
}

/// How many documents have learned voices, and how many voices in all.
pub fn summary(app_data: &Path) -> (u32, u32) {
    let Ok(entries) = std::fs::read_dir(dir(app_data)) else { return (0, 0) };
    entries.flatten().filter_map(|entry| store::read_json::<Voiceprints>(&entry.path()).ok())
        .fold((0, 0), |(documents, voices), saved| (documents + 1, voices + saved.voices.len() as u32))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn v(values: &[f32]) -> Vec<f32> { unit(values.to_vec()).unwrap() }

    #[test]
    fn a_voice_is_the_mean_of_its_prints_without_the_odd_one_out() {
        let me = [v(&[1.0, 0.1, 0.0]), v(&[0.9, 0.0, 0.1]), v(&[1.0, 0.05, 0.05]), v(&[0.0, 0.0, 1.0])];
        let centre = centroid(&me).unwrap();
        assert!(cos(&centre, &v(&[1.0, 0.0, 0.0])) > 0.99, "{centre:?}");
        assert!((cos(&centre, &centre) - 1.0).abs() < 1e-5);
        assert!(centroid(&[]).is_none());
    }

    #[test]
    fn stretches_join_dominant_words_and_keep_only_long_ones() {
        let s = |seconds: f64| (seconds * HZ) as i64;
        let words = [(s(1.0), s(1.8), 20.0), (s(1.9), s(3.5), 18.0), (s(10.0), s(10.5), 25.0), (s(20.0), s(23.0), 9.0)];
        assert_eq!(stretches(&words), [(s(1.0), s(3.5))], "a short stretch and a quiet one were kept");
    }

    #[test]
    fn the_window_with_the_most_dominant_speech_is_chosen() {
        let s = |seconds: f64| (seconds * HZ) as i64;
        let found = [(s(5.0), s(8.0)), (s(1000.0), s(1010.0)), (s(1020.0), s(1030.0))];
        let (start, taken) = best_window(&found, 0, s(3600.0)).unwrap();
        assert_eq!((start, taken.len()), (s(1000.0), 2));
        assert!(best_window(&found, s(2000.0), s(3600.0)).is_none());
    }

    #[test]
    fn a_word_is_its_owners_only_with_a_clear_margin_and_twins_decide_nothing() {
        let scores = |rosa: f32, dev: f32| vec![("rosa".to_string(), rosa), ("dev".to_string(), dev)];
        let none = HashSet::new();
        assert_eq!(decide("rosa", &scores(0.72, 0.10), &none), Call::Owner);
        assert_eq!(decide("rosa", &scores(0.20, 0.70), &none), Call::Other("dev".into()));
        assert_eq!(decide("rosa", &scores(0.55, 0.50), &none), Call::Unknown, "too close to call");
        assert_eq!(decide("rosa", &scores(0.35, 0.20), &none), Call::Unknown, "matches nobody");
        let twins: HashSet<String> = ["rosa".to_string(), "dev".to_string()].into();
        assert_eq!(decide("rosa", &scores(0.72, 0.10), &twins), Call::Unknown);
    }

    #[test]
    fn the_mic_that_heard_it_first_is_found_to_the_millisecond() {
        // A noisy burst, then the same burst 5 ms (80 samples) later, quieter.
        let mut seed = 7u32;
        let mut noise = || { seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345); (seed >> 16) as f32 / 65_536.0 - 0.5 };
        let source: Vec<f32> = (0..8_000).map(|_| noise()).collect();
        let near = source.clone();
        let far: Vec<f32> = (0..8_000).map(|n| if n >= 80 { source[n - 80] * 0.2 } else { 0.0 }).collect();
        let (lead, strength) = lag_ms(&near, &far).unwrap();
        assert!((lead - 5.0).abs() < 0.2, "{lead}");
        assert!(strength > 0.5);
        let (back, _) = lag_ms(&far, &near).unwrap();
        assert!((back + 5.0).abs() < 0.2);
        assert!(lag_ms(&near[..100], &far[..100]).is_none());
    }
}
