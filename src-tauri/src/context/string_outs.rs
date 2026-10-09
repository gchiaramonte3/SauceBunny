//! String outs as a model reads them: who is patched to A1 and down, the
//! clips in order with record and source timecode and the words in each,
//! markers, and the undo history. Read from `timelines.sqlite` opened
//! read-only (`EditLog::open_read_only`), never from the JSON mirror in
//! Documents, which carries no id and keeps stale copies after a rename.
use super::{pick, sequences, timecode, Address, Context};
use crate::commands::aaf::model::AafDocument;
use crate::edit_doc::{EditDocument, EditSegment, EditTrack, EditTrackKind};
use crate::edit_log::EditLog;
use crate::AppError;
use serde::Serialize;
use std::sync::Arc;

/// Words shown per clip before it says how many more there are.
const CLIP_TEXT_LINES: usize = 40;

fn log(ctx: &Context) -> Result<Option<EditLog>, AppError> {
    if !ctx.roots.timelines.exists() { return Ok(None); }
    EditLog::open_read_only(&ctx.roots.timelines).map(Some)
}


fn rate(document: &EditDocument) -> u32 { timecode::rate_of(document.edit_rate.numerator, document.edit_rate.denominator) }

fn seconds(document: &EditDocument, frames: i64) -> f64 {
    let fps = f64::from(document.edit_rate.numerator) / f64::from(document.edit_rate.denominator.max(1));
    (frames as f64 / fps * 100.0).round() / 100.0
}

#[derive(Serialize)]
pub struct Summary { string_out: String, title: String, running_time: String, seconds: f64, sources: Vec<String>, tracks: Vec<String>, updated_ms: i64, steps: i64 }

/// Every string out's title by its address, for naming them in rows.
pub fn titles(ctx: &Context) -> std::collections::HashMap<String, String> {
    list(ctx).map(|all| all.into_iter().map(|item| (item.string_out, item.title)).collect()).unwrap_or_default()
}

pub fn list(ctx: &Context) -> Result<Vec<Summary>, AppError> {
    let Some(log) = log(ctx)? else { return Ok(Vec::new()) };
    log.list()?.into_iter().map(|summary| {
        let document = log.head(&summary.id)?.document;
        let frames: i64 = document.segments.iter().map(EditSegment::frames).sum();
        Ok(Summary {
            string_out: Address::StringOut(summary.id.clone()).to_string(), title: summary.title, running_time: timecode::format(frames, rate(&document), false),
            seconds: seconds(&document, frames), sources: document.sources.iter().map(|source| source.name.clone()).collect(),
            tracks: record_tracks(&document),
            updated_ms: summary.updated_at, steps: summary.states,
        })
    }).collect()
}

/// Each record track (A1…) with everyone on it somewhere, in order of
/// appearance: tracks are layers, so one can hold several people.
fn layered(document: &EditDocument, plays: &[Vec<crate::edit_doc::EditPlay>]) -> Vec<(String, String)> {
    let count = plays.iter().flatten().map(|play| play.layer).max().unwrap_or(0);
    (1..=count).map(|layer| {
        let mut names: Vec<String> = Vec::new();
        for play in plays.iter().flatten().filter(|play| play.layer == layer) {
            let name = document.tracks.iter().find(|track| track.id == play.lane).map(|track| track.name.clone()).unwrap_or_else(|| play.lane.to_string());
            if !names.contains(&name) { names.push(name); }
        }
        (format!("A{layer}"), names.join(", "))
    }).collect()
}

fn record_tracks(document: &EditDocument) -> Vec<String> {
    layered(document, &document.plays()).into_iter().map(|(track, people)| format!("{track} {people}")).collect()
}

/// A string out a model named, by address, id or title, as its edit id.
fn resolve(log: &EditLog, wanted: &str) -> Result<String, AppError> {
    let wanted = wanted.trim();
    if wanted.starts_with(super::address::SCHEME) {
        return match Address::parse(wanted)? {
            Address::StringOut(id) | Address::StringOutAt { string_out: id, .. } | Address::Clip { string_out: id, .. } | Address::History(id) => Ok(id),
            _ => Err(AppError::invalid(format!("{wanted} is not a string out."))),
        };
    }
    let all = log.list()?;
    Ok(pick(&all, wanted, |summary| summary.id.as_str(), |summary| summary.title.as_str(), "string out")?.id.clone())
}

#[derive(Serialize)]
struct Track { track: String, person: String }

#[derive(Serialize)]
struct Clip {
    kind: &'static str, clip: String, record_in: String, record_out: String, seconds: f64,
    #[serde(skip_serializing_if = "Option::is_none")] sequence: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] source_in: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] source_out: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")] people: Vec<String>,
    /// Tracks that play something else across this clip: an Overwrite or a
    /// Lift made with only that track selected, e.g. "Kara: MG 3 Kitchen
    /// 01:00:04:00 to 01:00:06:00" or "Kara: lifted".
    #[serde(skip_serializing_if = "Vec::is_empty")] instead: Vec<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")] text: Vec<String>,
}

#[derive(Serialize)]
struct Marker { tc: String, name: String, comment: String, color: String, #[serde(skip_serializing_if = "Option::is_none")] track: Option<String> }

#[derive(Serialize)]
pub struct Detail {
    string_out: String, title: String, start: String, running_time: String, seconds: f64,
    tracks: Vec<Track>, #[serde(skip_serializing_if = "Vec::is_empty")] not_on_a_track: Vec<String>,
    clips: Vec<Clip>, markers: Vec<Marker>, last_change: String,
    #[serde(skip_serializing_if = "Option::is_none")] can_redo: Option<String>,
}

/// Each source's AAF Audio document, or why it could not be read.
fn sources(ctx: &Context, document: &EditDocument) -> Vec<(String, Option<Arc<AafDocument>>)> {
    document.sources.iter().map(|source| (source.id.clone(), ctx.document(&source.document_id).ok())).collect()
}

pub fn detail(ctx: &Context, wanted: &str) -> Result<Detail, AppError> {
    let log = log(ctx)?.ok_or_else(|| AppError::not_found("There are no string outs yet."))?;
    let edit = resolve(&log, wanted)?;
    let head = log.head(&edit)?;
    let document = &head.document;
    let fps = rate(document);
    let loaded = sources(ctx, document);
    let aaf = |source: &str| loaded.iter().find(|(id, _)| id == source).and_then(|(_, doc)| doc.clone());
    let drop = loaded.iter().find_map(|(_, doc)| doc.as_ref().filter(|doc| doc.manifest.timecode_fps == fps).map(|doc| doc.manifest.drop_frame)).unwrap_or(false);
    let record = |frames: i64| timecode::format(document.start_timecode_frames + frames, fps, drop);
    let on_track = document.patched();
    let name_of = |lane: &str| document.tracks.iter().find(|track| track.id == lane).map(|track| track.name.clone()).unwrap_or_else(|| lane.to_string());
    let lane_of = |id: &str| on_track.iter().copied().find(|track| track.id == id);
    let source_name = |id: &str| document.sources.iter().find(|item| item.id == id).map(|item| item.name.clone()).unwrap_or_else(|| id.to_string());
    // Who is on which record track in each clip: tracks are layers, as in Avid.
    let plays = document.plays();
    let mut at = 0;
    let mut clips = Vec::new();
    for (index, segment) in document.segments.iter().enumerate() {
        let length = segment.frames();
        match segment {
            EditSegment::Gap { id: gap, .. } => clips.push(Clip { kind: "gap", clip: Address::Clip { string_out: edit.clone(), clip: gap.clone() }.to_string(),
                record_in: record(at), record_out: record(at + length), seconds: seconds(document, length), sequence: None, source_in: None, source_out: None, people: Vec::new(), instead: Vec::new(), text: Vec::new() }),
            EditSegment::Source { id: clip, source, in_frame, out_frame, overrides, .. } => {
                let sequence = aaf(source);
                // Each person's words from the range they play here, in record order.
                let mut text: Vec<(i64, String)> = Vec::new();
                let mut words = |lane: &EditTrack, from_source: &str, first: i64| {
                    let Some(doc) = aaf(from_source) else { return };
                    let Some(mic) = lane.source_tracks.get(from_source) else { return };
                    let Some(transcript) = doc.transcripts.iter().find(|item| &item.track_id == mic) else { return };
                    for cue in &transcript.cues {
                        let from = sequences::frame_of(cue.start_sample, transcript.sample_rate, &doc.manifest.edit_rate);
                        let to = sequences::frame_of(cue.end_sample, transcript.sample_rate, &doc.manifest.edit_rate);
                        let middle = (from + to) / 2;
                        let silenced = document.mutes.iter().any(|mute| mute.source == from_source && mute.track == lane.id && mute.in_frame <= middle && middle < mute.out_frame);
                        if first <= middle && middle < first + length && !silenced { text.push((from - first, format!("{}: {}", lane.name, cue.text.trim()))); }
                    }
                };
                let mut people = Vec::new();
                let mut instead = Vec::new();
                for play in &plays[index] {
                    let Some(lane) = lane_of(play.lane) else { continue };
                    people.push(format!("A{} {}", play.layer, lane.name));
                    words(lane, play.source, play.in_frame);
                    // Playing something other than the clip here: an Overwrite on that track alone.
                    if play.source != source || play.in_frame != *in_frame {
                        let range = aaf(play.source).map(|doc| format!(" {} to {}", sequences::tc(&doc, play.in_frame), sequences::tc(&doc, play.in_frame + length))).unwrap_or_default();
                        instead.push(format!("A{} {}: {}{range}", play.layer, lane.name, source_name(play.source)));
                    }
                }
                for (lane, over) in overrides.iter().flatten() {
                    if over.source.is_none() { instead.push(format!("{}: lifted", name_of(lane))); }
                }
                text.sort_by_key(|(frame, _)| *frame);
                let more = text.len().saturating_sub(CLIP_TEXT_LINES);
                let mut lines: Vec<String> = text.into_iter().take(CLIP_TEXT_LINES).map(|(_, line)| line).collect();
                if more > 0 { lines.push(format!("… {more} more lines")); }
                clips.push(Clip {
                    kind: "clip", clip: Address::Clip { string_out: edit.clone(), clip: clip.clone() }.to_string(), record_in: record(at), record_out: record(at + length), seconds: seconds(document, length),
                    sequence: Some(source_name(source)),
                    source_in: sequence.as_ref().map(|doc| sequences::tc(doc, *in_frame)), source_out: sequence.as_ref().map(|doc| sequences::tc(doc, *out_frame)),
                    people, instead, text: lines,
                });
            }
        }
        at += length;
    }
    let tracks = layered(document, &plays).into_iter().map(|(track, person)| Track { track, person }).collect();
    let starts: Vec<i64> = document.segments.iter().scan(0, |at, segment| { let start = *at; *at += segment.frames(); Some(start) }).collect();
    let track_of = |lane: &str, frame: i64| starts.iter().rposition(|start| *start <= frame)
        .and_then(|at| plays.get(at)?.iter().find(|play| play.lane == lane).map(|play| play.layer))
        .or_else(|| on_track.iter().position(|track| track.id == lane).map(|index| index as u32 + 1))
        .map(|layer| format!("A{layer}"));
    Ok(Detail {
        string_out: Address::StringOut(edit.clone()).to_string(), title: document.title.clone(), start: record(0), running_time: timecode::format(at, fps, false), seconds: seconds(document, at),
        tracks,
        not_on_a_track: document.tracks.iter().filter(|track| track.kind == EditTrackKind::Sound && track.featured == Some(false)).map(|track| track.name.clone()).collect(),
        clips, markers: document.markers.iter().map(|marker| Marker { tc: record(marker.frame), name: marker.name.clone(), comment: marker.comment.clone(), color: marker.color.clone(),
            track: marker.track.as_deref().and_then(|lane| track_of(lane, marker.frame).map(|track| format!("{track} {}", name_of(lane)))) }).collect(),
        last_change: head.label.clone(), can_redo: head.redo.clone(),
    })
}

#[derive(Serialize)]
struct Step { state: i64, label: String, at_ms: i64, #[serde(skip_serializing_if = "Option::is_none")] pinned: Option<String>, #[serde(skip_serializing_if = "std::ops::Not::not")] current: bool }

#[derive(Serialize)]
pub struct History { string_out: String, title: String, steps: Vec<Step>, undone_branches: usize }

pub fn history(ctx: &Context, wanted: &str) -> Result<History, AppError> {
    let log = log(ctx)?.ok_or_else(|| AppError::not_found("There are no string outs yet."))?;
    let id = resolve(&log, wanted)?;
    let title = log.head(&id)?.document.title;
    let history = log.history(&id)?;
    let children = |state: i64| history.states.iter().filter(|item| item.parent == Some(state)).count();
    Ok(History {
        string_out: Address::History(id.clone()).to_string(), title,
        undone_branches: history.states.iter().filter(|item| children(item.id) > 1).map(|item| children(item.id) - 1).sum(),
        steps: history.states.iter().map(|state| Step { state: state.id, label: state.label.clone(), at_ms: state.at, pinned: state.pinned.clone(), current: state.id == history.head }).collect(),
    })
}

/// Where the string outs play a sequence: per AAF track, the source frames
/// each clip covers, for a line's `in`.
pub struct Use { pub track: String, pub from: i64, pub to: i64, pub string_out: String }

pub fn uses(ctx: &Context, sequence: &str) -> Result<Vec<Use>, AppError> {
    let Some(log) = log(ctx)? else { return Ok(Vec::new()) };
    let mut out = Vec::new();
    for summary in log.list()? {
        let document = log.head(&summary.id)?.document;
        let address = Address::StringOut(summary.id.clone()).to_string();
        // What each person plays wherever they are, their overrides included (edit_doc.rs `plays`).
        for (segment, here) in document.segments.iter().zip(document.plays()) {
            for play in here {
                let Some(source) = document.sources.iter().find(|source| source.id == play.source && source.document_id == sequence) else { continue };
                let Some(mic) = document.tracks.iter().find(|track| track.id == play.lane).and_then(|lane| lane.source_tracks.get(&source.id)) else { continue };
                out.push(Use { track: mic.clone(), from: play.in_frame, to: play.in_frame + segment.frames(), string_out: address.clone() });
            }
        }
    }
    Ok(out)
}
