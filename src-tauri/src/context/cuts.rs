//! How long a story cut runs, before anything is built
//! (docs/STORY-CUT-SPEC-2026-10-08.md). A model building a cut from an idea
//! picks lines by id and is asked to land near a running time; it cannot
//! add up timecodes reliably, so this does it for it, with the rules String
//! Outs uses to lay the cut out (`src/lib/edit-story.ts`): each run of lines
//! from one sequence that follow each other closely plays as one stretch,
//! with a short handle before and after, stretches butt together within a
//! beat, and a pause sits between beats. The figure is close rather than
//! exact: laying a cut out also moves a stretch's edges out of any word (by
//! up to a second and a half each side).
//!
//! It reads and never writes, like every tool here.
use super::{sequences, Address, Context};
use crate::AppError;
use serde::Serialize;
use std::collections::{HashMap, HashSet};

/// Seconds of air kept before a stretch's first word, after its last, how
/// close two lines must be to play as one stretch, and the pause between
/// beats. Pinned against `src/lib/edit-story.ts` by duplicated-tables-contract.
pub const CUT_HEAD_SECONDS: f64 = 0.25;
pub const CUT_TAIL_SECONDS: f64 = 0.5;
pub const CUT_JOIN_SECONDS: f64 = 2.0;
pub const CUT_BEAT_PAUSE_SECONDS: f64 = 1.0;
/// How far off the target a cut may run before it is said to miss it.
const TARGET_SLACK: f64 = 0.1;

/// One beat as a model names it: a title and line ids (or addresses) in play order.
pub struct Beat { pub title: String, pub lines: Vec<String> }

#[derive(Debug, Serialize)]
pub struct BeatMeasure { pub title: String, pub seconds: f64, pub runtime: String, pub stretches: usize, pub lines: usize }

#[derive(Debug, Serialize)]
pub struct Measure {
    pub seconds: f64,
    pub runtime: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_seconds: Option<f64>,
    pub beats: Vec<BeatMeasure>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

/// A cited line, placed: its sequence and where it sits there, in seconds.
struct Placed { sequence: String, from: f64, to: f64 }

pub fn measure(ctx: &Context, beats: &[Beat], target: Option<f64>) -> Result<Measure, AppError> {
    if beats.is_empty() { return Err(AppError::invalid("\"beats\" needs at least one beat.")); }
    let mut warnings = Vec::new();
    let mut used: HashSet<String> = HashSet::new();
    let mut bleed: HashMap<String, HashMap<(String, String), f64>> = HashMap::new();
    let mut out = Vec::new();
    for (index, beat) in beats.iter().enumerate() {
        let title = if beat.title.trim().is_empty() { format!("Beat {}", index + 1) } else { beat.title.trim().to_string() };
        let mut placed = Vec::new();
        for cited in &beat.lines {
            let Some(address) = ctx.ids.address(cited) else {
                warnings.push(format!("{cited} names no line handed out; cite a row id exactly as a tool gave it."));
                continue;
            };
            let Ok(Address::Line { sequence, track, cue }) = Address::parse(&address) else {
                warnings.push(format!("{cited} is not a line."));
                continue;
            };
            if !used.insert(address.clone()) { warnings.push(format!("{cited} plays twice; a line belongs in one place.")); }
            let document = ctx.document(&sequence)?;
            let Some((from, to, words)) = span(&document, &track, &cue) else {
                warnings.push(format!("{cited} is no longer in its sequence's transcript."));
                continue;
            };
            let shares = bleed.entry(sequence.clone()).or_insert_with(|| bleed_shares(ctx, &sequence));
            if shares.get(&(track.clone(), cue.clone())).is_some_and(|count| *count / words as f64 >= 0.6) {
                warnings.push(format!("{cited} was heard on another person's mic; cite the line from the mic it was said into."));
            }
            placed.push(Placed { sequence, from, to });
        }
        let stretches = stretches(&placed);
        let seconds: f64 = stretches.iter().map(|(from, to)| to - from + CUT_HEAD_SECONDS + CUT_TAIL_SECONDS).sum();
        out.push(BeatMeasure { title, seconds: round(seconds), runtime: runtime(seconds), stretches: stretches.len(), lines: placed.len() });
    }
    let playing = out.iter().filter(|beat| beat.lines > 0).count();
    let total = out.iter().map(|beat| beat.seconds).sum::<f64>() + CUT_BEAT_PAUSE_SECONDS * playing.saturating_sub(1) as f64;
    if let Some(target) = target.filter(|target| *target > 0.0) {
        if (total - target).abs() > target * TARGET_SLACK {
            let (way, by) = if total > target { ("over", total - target) } else { ("under", target - total) };
            warnings.push(format!("Runs {} against a target of {}: {} {way}.", runtime(total), runtime(target), runtime(by)));
        }
    }
    for beat in out.iter().filter(|beat| beat.lines == 0) { warnings.push(format!("\"{}\" has no lines that play.", beat.title)); }
    Ok(Measure { seconds: round(total), runtime: runtime(total), target_seconds: target, beats: out, warnings })
}

/// A cue's start and end in seconds from its sequence's start, and its word count.
fn span(document: &crate::commands::aaf::model::AafDocument, track: &str, cue: &str) -> Option<(f64, f64, usize)> {
    let transcript = document.transcripts.iter().find(|item| item.track_id == track)?;
    let found = transcript.cues.iter().find(|item| item.id == cue)?;
    let rate = &document.manifest.edit_rate;
    let fps = f64::from(rate.numerator) / f64::from(rate.denominator.max(1));
    let from = sequences::frame_of(found.start_sample, transcript.sample_rate, rate);
    let to = sequences::frame_of(found.end_sample, transcript.sample_rate, rate).max(from + 1);
    Some((from as f64 / fps, to as f64 / fps, found.text.split_whitespace().count().max(1)))
}

/// Per cue, how many of its words the bleed resolver says came from another mic.
fn bleed_shares(ctx: &Context, sequence: &str) -> HashMap<(String, String), f64> {
    let mut out = HashMap::new();
    for word in ctx.ownership(sequence).iter().flat_map(|answer| answer.words.iter()) {
        if word.label == crate::bleed::AafOwnershipLabel::Bleed { *out.entry((word.track_id.clone(), word.cue_id.clone())).or_insert(0.0) += 1.0; }
    }
    out
}

/// Lines in play order, joined into the stretches that play: the same
/// sequence, each line starting within the join of the stretch so far (or
/// inside it), as `exchangesOf` joins them. Each is (from, to) in seconds.
fn stretches(placed: &[Placed]) -> Vec<(f64, f64)> {
    let mut out: Vec<(String, f64, f64)> = Vec::new();
    for line in placed {
        if let Some(last) = out.last_mut() {
            if last.0 == line.sequence && line.from <= last.2 + CUT_JOIN_SECONDS && line.to >= last.1 - CUT_JOIN_SECONDS {
                last.1 = last.1.min(line.from);
                last.2 = last.2.max(line.to);
                continue;
            }
        }
        out.push((line.sequence.clone(), line.from, line.to));
    }
    out.into_iter().map(|(_, from, to)| (from, to)).collect()
}

fn round(seconds: f64) -> f64 { (seconds * 10.0).round() / 10.0 }

/// "4:05" for a running time.
fn runtime(seconds: f64) -> String {
    let whole = seconds.max(0.0).round() as i64;
    format!("{}:{:02}", whole / 60, whole % 60)
}
