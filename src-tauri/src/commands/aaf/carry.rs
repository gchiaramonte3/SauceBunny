//! Transcripts carried into a re-exported sequence.
//!
//! When Media Composer exports the group again (a new day's cut, a trim, the
//! same scenes in another order) the import is a new document, and it used to
//! start with nothing: every mic transcribed again, hours of recognizer time
//! for words the app already had. The words were never about the SEQUENCE,
//! though: they are about the source media under it. Each clip says which
//! source it plays (`source_id`, the master clip's channel) and from where, so
//! a line can be followed from the old sequence into its source and from the
//! source to wherever the new sequence plays that same stretch.
//!
//! What is carried is conservative. A line comes across only when the whole
//! of it plays, unbroken, in the new sequence, so a line the new cut trims
//! into is left for a fresh run rather than shown half-heard. The new
//! transcript's envelope is the track's audio, and whatever no earlier
//! transcript covered is a gap (`gaps`, which the track's status already says
//! out loud: "Selected ranges transcribed, N gaps left out"). Owner names
//! come with the words, and so do the editor's own calls on whose a line is.

use super::model::{AafClip, AafCue, AafCueOwnership, AafDocument, AafTrack, AafTrackLabel, AafTrackTranscript};

/// Within this many seconds two positions are the same instant (well under a 16 kHz sample).
const SAME: f64 = 1e-5;

fn fps(document: &AafDocument) -> f64 {
    let rate = &document.manifest.edit_rate;
    if rate.denominator == 0 { 0.0 } else { f64::from(rate.numerator) / f64::from(rate.denominator) }
}

/// A clip's audio as spans of seconds: where it sits in the sequence and where in its source.
#[derive(Clone, Copy)]
struct Span { from: f64, to: f64, source_from: f64 }

fn span(clip: &AafClip, fps: f64) -> Option<(String, Span)> {
    let (source, start, rate) = (clip.source_id.as_ref()?, clip.source_start_sample?, clip.sample_rate?);
    if clip.kind != "audio" || fps <= 0.0 || rate == 0 || clip.duration_frames <= 0 { return None; }
    let from = clip.start_frame as f64 / fps;
    Some((source.clone(), Span { from, to: from + clip.duration_frames as f64 / fps, source_from: start as f64 / f64::from(rate) }))
}

fn spans(track: &AafTrack, fps: f64) -> Vec<(String, Span)> { track.clips.iter().filter_map(|clip| span(clip, fps)).collect() }

/// Where sequence time `at` on a track plays in its source: the source and the second in it.
fn into_source(spans: &[(String, Span)], at: f64) -> Option<(&str, f64)> {
    spans.iter().find(|(_, span)| span.from - SAME <= at && at < span.to - SAME).map(|(source, span)| (source.as_str(), span.source_from + at - span.from))
}

/// Every place in the new track where that second of that source plays (a stretch can be used twice).
fn out_of_source<'a>(spans: &'a [(String, Span)], source: &'a str, at: f64) -> impl Iterator<Item = f64> + 'a {
    spans.iter().filter(move |(id, span)| id == source && span.source_from - SAME <= at && at < span.source_from + span.to - span.from - SAME)
        .map(move |(_, span)| span.from + at - span.source_from)
}

/// Seconds `[from, to)` with `gaps` taken out, as frames on the old transcript.
fn transcribed(transcript: &AafTrackTranscript, fps: f64) -> Vec<(f64, f64)> {
    let (from, to) = (transcript.start_frame as f64 / fps, (transcript.start_frame + transcript.duration_frames) as f64 / fps);
    let mut out = vec![(from, to)];
    for [a, b] in transcript.gaps.clone().unwrap_or_default() {
        let (a, b) = (a as f64 / fps, b as f64 / fps);
        out = out.into_iter().flat_map(|(x, y)| [(x, y.min(a)), (x.max(b), y)]).filter(|(x, y)| y - x > SAME).collect();
    }
    out
}

/// One cue moved by `shift` seconds, its words with it, in samples at `rate`.
fn shifted(cue: &AafCue, shift: f64, rate: f64) -> AafCue {
    let by = (shift * rate).round() as i64;
    let mut out = cue.clone();
    out.start_sample += by; out.end_sample += by;
    if let Some(words) = out.words.as_mut() { for word in words { word.start_sample += by; word.end_sample += by; } }
    out
}

/// Merge overlapping spans and return them sorted.
fn union(mut spans: Vec<(f64, f64)>) -> Vec<(f64, f64)> {
    spans.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut out: Vec<(f64, f64)> = Vec::new();
    for (from, to) in spans {
        match out.last_mut() { Some(last) if from <= last.1 + SAME => last.1 = last.1.max(to), _ => out.push((from, to)) }
    }
    out
}

/// What was carried into a new document: how many tracks got words, and from which earlier documents.
pub struct Carried { pub tracks: usize, pub from: Vec<String> }

/**
 * Fill `document` (a new import, with no transcripts yet) from `earlier`
 * documents that share its source media, newest first: each of its tracks
 * gets the lines that play whole in it, the owner name of the track most of
 * them came from, and the editor's ownership calls on those lines.
 */
pub fn carry(document: &mut AafDocument, earlier: &[AafDocument]) -> Carried {
    let rate_new = fps(document);
    let mut carried = Carried { tracks: 0, from: Vec::new() };
    if rate_new <= 0.0 || !document.transcripts.is_empty() { return carried; }
    let mut labels: Vec<AafTrackLabel> = Vec::new();
    let mut ownership: Vec<AafCueOwnership> = Vec::new();
    for track in &document.manifest.tracks {
        let mine = spans(track, rate_new);
        if mine.is_empty() { continue; }
        let mut cues: Vec<AafCue> = Vec::new();
        let mut covered: Vec<(f64, f64)> = Vec::new();
        let mut votes: Vec<(String, usize, AafTrackLabel)> = Vec::new();
        let mut engine = None;
        for old in earlier {
            let rate_old = fps(old);
            if rate_old <= 0.0 || old.id == document.id { continue; }
            let mut used = false;
            for transcript in &old.transcripts {
                let Some(old_track) = old.manifest.tracks.iter().find(|item| item.id == transcript.track_id) else { continue };
                let theirs = spans(old_track, rate_old);
                if !theirs.iter().any(|(source, _)| mine.iter().any(|(id, _)| id == source)) { continue; }
                // What the old run covered, followed into this track.
                for (from, to) in transcribed(transcript, rate_old) {
                    for (source, span) in &theirs {
                        let (a, b) = (from.max(span.from), to.min(span.to));
                        if b - a <= SAME { continue; }
                        let (sa, sb) = (span.source_from + a - span.from, span.source_from + b - span.from);
                        for (id, here) in &mine {
                            if id != source { continue; }
                            let (x, y) = (sa.max(here.source_from), sb.min(here.source_from + here.to - here.from));
                            if y - x > SAME { covered.push((here.from + x - here.source_from, here.from + y - here.source_from)); }
                        }
                    }
                }
                // Each line whose start and end land in one unbroken stretch here, with the same shift.
                let rate = f64::from(transcript.sample_rate.max(1));
                let mut count = 0;
                for cue in &transcript.cues {
                    // The line's first instant, and its last (just inside its end).
                    let (start, end) = (cue.start_sample as f64 / rate, cue.end_sample as f64 / rate);
                    let probe = (end - SAME).max(start);
                    let Some((source, at)) = into_source(&theirs, start) else { continue };
                    let Some((end_source, end_at)) = into_source(&theirs, probe) else { continue };
                    // One unbroken stretch of one source in the old cut.
                    if end_source != source || (end_at - at - (probe - start)).abs() > 2.0 * SAME { continue; }
                    for landed in out_of_source(&mine, source, at).collect::<Vec<_>>() {
                        let shift = landed - start;
                        // And in the new one: the end plays right after the start, not in another clip that happens to use the same source.
                        if !out_of_source(&mine, source, end_at).any(|end_landed| (end_landed - (probe + shift)).abs() < 2.0 * SAME) { continue; }
                        // A second earlier document with the same line at the same place adds nothing.
                        let moved = shifted(cue, shift, rate);
                        if cues.iter().any(|other| (other.start_sample - moved.start_sample).abs() <= 1 && other.text == moved.text) { continue; }
                        if let Some(call) = old.ownership.as_ref().and_then(|calls| calls.iter().find(|call| call.track_id == transcript.track_id && call.cue_id == cue.id)) {
                            ownership.push(AafCueOwnership { track_id: track.id.clone(), cue_id: moved.id.clone(), label: call.label, heard_on: None });
                        }
                        cues.push(moved);
                        count += 1;
                    }
                }
                if count > 0 {
                    used = true;
                    engine.get_or_insert((transcript.engine.clone(), transcript.model_id.clone(), transcript.sample_rate));
                    if let Some(label) = old.labels.iter().find(|label| label.track_id == transcript.track_id) {
                        match votes.iter_mut().find(|(name, _, _)| *name == label.owner_name) { Some(vote) => vote.1 += count, None => votes.push((label.owner_name.clone(), count, label.clone())) }
                    }
                }
            }
            if used && !carried.from.contains(&old.manifest.name) { carried.from.push(old.manifest.name.clone()); }
        }
        let Some((engine, model_id, sample_rate)) = engine else { continue };
        cues.sort_by_key(|cue| (cue.start_sample, cue.end_sample));
        // The envelope is the track's audio; what no earlier run covered inside it is a gap.
        let (first, last) = mine.iter().fold((f64::MAX, f64::MIN), |(a, b), (_, span)| (a.min(span.from), b.max(span.to)));
        let mut gaps: Vec<[i64; 2]> = Vec::new();
        let mut cursor = first;
        for (from, to) in union(covered) {
            if from - cursor > SAME { gaps.push([(cursor * rate_new).round() as i64, (from * rate_new).round() as i64]); }
            cursor = cursor.max(to);
        }
        if last - cursor > SAME { gaps.push([(cursor * rate_new).round() as i64, (last * rate_new).round() as i64]); }
        gaps.retain(|[a, b]| b > a);
        let start_frame = (first * rate_new).round() as i64;
        let names: Vec<String> = carried.from.clone();
        document.transcripts.push(AafTrackTranscript {
            track_id: track.id.clone(), start_frame, duration_frames: (last * rate_new).round() as i64 - start_frame,
            engine, model_id, status: super::model::AafTranscriptStatus::Completed, sample_rate, cues,
            timing_issues: Vec::new(), warnings: vec![format!("Carried from an earlier import of the same media ({}). Only lines that play whole in this sequence came across.", names.join(", "))],
            gaps: (!gaps.is_empty()).then_some(gaps),
        });
        if let Some((_, _, label)) = votes.into_iter().max_by_key(|(_, count, _)| *count) {
            labels.push(AafTrackLabel { track_id: track.id.clone(), ..label });
        }
        carried.tracks += 1;
    }
    for label in labels {
        match document.labels.iter_mut().find(|item| item.track_id == label.track_id) { Some(item) => *item = label, None => document.labels.push(label) }
    }
    if !ownership.is_empty() { document.ownership = Some(ownership); }
    carried
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::aaf::model::{AafEngine, AafManifest, AafRate, AafTranscriptStatus};

    // 25 fps, 48 kHz sources, cues at 16 kHz. One mic, master clip "kara:1".
    fn clip(start_frame: i64, frames: i64, source: &str, source_second: f64) -> AafClip {
        AafClip { start_frame, duration_frames: frames, kind: "audio".into(), master_id: None, source_id: Some(source.into()),
            source_start_sample: Some((source_second * 48_000.0) as i64), sample_rate: Some(48_000), warnings: vec![] }
    }
    fn document(id: &str, clips: Vec<AafClip>) -> AafDocument {
        AafDocument { schema_version: 1, id: id.into(), source_path: format!("/{id}.aaf"), source_size: 0, source_modified_ms: 0, shoot_date_override: None, ownership: None, title: None,
            manifest: AafManifest { schema_version: 1, graph: None, name: id.into(), source_fingerprint: id.into(), recording_dates: None, edit_rate: AafRate { numerator: 25, denominator: 1 },
                start_frame: 0, duration_frames: 10_000, timecode_fps: 25, drop_frame: false, tracks: vec![AafTrack { id: "t1".into(), name: "A1".into(), physical_track_number: Some(1), clips, warnings: vec![] }], warnings: vec![] },
            labels: vec![AafTrackLabel { track_id: "t1".into(), owner_name: "A1".into(), cast_member_id: None, color: None, gender: None, marker_color: None }], transcripts: vec![] }
    }
    fn cue(id: &str, from: f64, to: f64, text: &str) -> AafCue {
        AafCue { id: id.into(), start_sample: (from * 16_000.0) as i64, end_sample: (to * 16_000.0) as i64, text: text.into(), boundary_review: false, words: None, suspect: None }
    }
    fn transcribed_old() -> AafDocument {
        // The old cut: source 100-120 s at the start, then 300-310 s.
        let mut old = document("Day 1", vec![clip(0, 500, "kara:1", 100.0), clip(500, 250, "kara:1", 300.0)]);
        old.labels[0].owner_name = "Kara".into();
        old.transcripts.push(AafTrackTranscript { track_id: "t1".into(), start_frame: 0, duration_frames: 750, engine: AafEngine::Parakeet, model_id: "parakeet".into(),
            status: AafTranscriptStatus::Completed, sample_rate: 16_000,
            cues: vec![cue("a", 2.0, 4.0, "I moved here in May."), cue("b", 18.0, 22.0, "Across the cut."), cue("c", 21.0, 24.0, "Later on.")],
            timing_issues: vec![], warnings: vec![], gaps: None });
        old.ownership = Some(vec![AafCueOwnership { track_id: "t1".into(), cue_id: "a".into(), label: crate::bleed::AafOwnershipLabel::Bleed, heard_on: None }]);
        old
    }

    #[test]
    fn a_line_follows_its_source_into_the_new_cut_and_the_owner_comes_with_it() {
        // The new cut opens on source 300-310 s, then plays 100-105 s.
        let mut new = document("Day 2", vec![clip(0, 250, "kara:1", 300.0), clip(250, 125, "kara:1", 100.0)]);
        let carried = carry(&mut new, &[transcribed_old()]);
        assert_eq!((carried.tracks, carried.from.clone()), (1, vec!["Day 1".to_string()]));
        let transcript = &new.transcripts[0];
        // "I moved here in May." said 102-104 s in the source: 12-14 s in the new cut.
        // "Later on." (old 21-24 s, source 301-304 s) lands 1-4 s in. "Across the cut." spanned two old clips and stays behind.
        let lines: Vec<_> = transcript.cues.iter().map(|cue| (cue.text.as_str(), cue.start_sample as f64 / 16_000.0, cue.end_sample as f64 / 16_000.0)).collect();
        assert_eq!(lines, vec![("Later on.", 1.0, 4.0), ("I moved here in May.", 12.0, 14.0)]);
        assert_eq!(new.labels[0].owner_name, "Kara");
        // The editor's call on "a" came with it.
        assert_eq!(new.ownership.as_ref().map(|calls| calls.iter().map(|call| call.cue_id.as_str()).collect::<Vec<_>>()), Some(vec!["a"]));
        // The whole track was covered by the old run: no gaps.
        assert_eq!(transcript.gaps, None);
        assert_eq!((transcript.start_frame, transcript.duration_frames), (0, 375));
    }

    #[test]
    fn what_no_earlier_run_heard_is_a_gap_and_a_track_with_none_of_it_gets_no_transcript() {
        // Source 100-105 s (heard) then 500-510 s, which the old cut never used.
        let mut new = document("Day 2", vec![clip(0, 125, "kara:1", 100.0), clip(125, 250, "kara:1", 500.0)]);
        carry(&mut new, &[transcribed_old()]);
        assert_eq!(new.transcripts[0].gaps, Some(vec![[125, 375]]));
        // Different media altogether: nothing to carry.
        let mut other = document("Other", vec![clip(0, 250, "stef:1", 100.0)]);
        assert_eq!(carry(&mut other, &[transcribed_old()]).tracks, 0);
        assert!(other.transcripts.is_empty());
    }
}
