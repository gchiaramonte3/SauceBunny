//! An edit as a `write-edit` request for the AAF sidecar (aaf-sidecar/writer.py).
//!
//! Pure translation, no I/O: the edit keeps silenced ranges in SOURCE frames
//! per person and markers on a lane id, while the writer wants mutes relative
//! to a segment on a track index and markers on a track index. Doing the
//! conversion here, with tests, keeps the writer's request format out of the
//! frontend and the edit's model out of Python.

use crate::edit_doc::{EditDocument, EditSegment, EditTrack, EditTrackKind};
use crate::AppError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// What the writer needs to know about one source sequence.
#[derive(Clone)]
pub struct ExportSource {
    pub id: String,
    pub aaf_path: String,
    pub sequence_id: String,
    /// The sequence's V1 (or its first picture track with clips), carried as
    /// V1 so the cut relinks to picture in Media Composer. Never decoded.
    pub picture_slot: Option<u32>,
    /// Lanes that are one angle of a group rather than a track of their own,
    /// by AAF Audio track id.
    pub alternates: std::collections::BTreeMap<String, Alternate>,
}

/// Where a group angle lives: the source track holding the group, and the
/// angles to choose there as the reader names them (`<mob id>:<slot id>`):
/// every angle of this person's under that track, since their recorder can
/// be a different master clip in each group.
#[derive(Clone)]
pub struct Alternate {
    pub parent_slot: u32,
    pub angles: Vec<String>,
}

/// One lane of an imported sequence as far as groups go: `(track id, parent
/// track id, angle id, owner)`, where parent and angle are the reader's
/// `parent_track_id` and `branch_id`.
pub type GroupLane<'a> = (&'a str, Option<&'a str>, Option<&'a str>, String);

/// Every group-angle lane's Alternate. A person's angles under one group
/// track are gathered together (same owner, same parent), because String Outs
/// keeps one lane per person and their recorder can be a different master
/// clip in each group edit on that track.
pub fn alternates_of(lanes: &[GroupLane]) -> std::collections::BTreeMap<String, Alternate> {
    let mut gathered: std::collections::BTreeMap<(u32, &str), Vec<String>> = Default::default();
    for (_, parent, angle, owner) in lanes {
        let (Some(parent), Some(angle)) = (parent.and_then(|id| id.parse::<u32>().ok()), angle) else { continue };
        let angles = gathered.entry((parent, owner.as_str())).or_default();
        if !angles.iter().any(|known| known == angle) { angles.push(angle.to_string()); }
    }
    lanes.iter().filter_map(|(track, parent, angle, owner)| {
        let parent_slot = parent.and_then(|id| id.parse::<u32>().ok())?;
        angle.as_ref()?;
        Some((track.to_string(), Alternate { parent_slot, angles: gathered.get(&(parent_slot, owner.as_str()))?.clone() }))
    }).collect()
}

/// Media Composer's eight marker colours, as the writer spells them.
const COLORS: [&str; 8] = ["Red", "Green", "Blue", "Cyan", "Magenta", "Yellow", "White", "Black"];

fn marker_color(color: &str) -> &'static str {
    COLORS.iter().find(|known| known.eq_ignore_ascii_case(color.trim())).copied().unwrap_or("Red")
}

/// The writer's own limits (aaf-sidecar/writer.py): it refuses rather than
/// trims, so a long title or a marker on the last frame used to fail the whole
/// export after the edit had saved without complaint.
const MAX_NAME: usize = 240;
const MAX_COMMENT: usize = 5000;
/// Media Composer's audio track ceiling, which the writer enforces too.
const MAX_SOUND_TRACKS: usize = 64;

fn clip(text: &str, limit: usize) -> String { text.chars().take(limit).collect() }

fn slot(person: &str, track_id: &str) -> Result<u32, AppError> {
    track_id.parse().map_err(|_| AppError::invalid(format!(
        "{person}'s mic is no longer in its AAF Audio sequence. Import the AAF again, then export.")))
}

pub fn build_request(document: &EditDocument, sources: &[ExportSource], approach: &str, output_path: &str) -> Result<Value, AppError> {
    document.validate()?;
    // "V": picture keeps its groups (C, still switchable in Avid) while each
    // person's audio is the clip that plays (B), their own mic. A 20-lav
    // multigroup written as C would put a twenty-way group on every track of
    // every bite, which nobody switches and the reader has to expand.
    let (sound_approach, picture_approach) = match approach {
        "B" => ("B", "B"),
        "C" => ("C", "C"),
        "V" => ("B", "C"),
        _ => return Err(AppError::invalid("Choose how groups are written: keep picture groups, keep all groups, or the clip that plays.")),
    };
    if !document.segments.iter().any(|segment| matches!(segment, EditSegment::Source { .. })) {
        return Err(AppError::invalid("This string out is empty. Add something to it before exporting."));
    }
    let find = |id: &str| sources.iter().find(|source| source.id == id)
        .ok_or_else(|| AppError::not_found(format!("Source {id} of this string out is no longer in AAF Audio.")));
    let mut out_sources = Vec::new();
    for source in &document.sources {
        let known = find(&source.id)?;
        out_sources.push(json!({ "id": known.id, "aaf_path": known.aaf_path, "sequence_id": known.sequence_id }));
    }

    // Everyone is on a track except a group angle nobody has given one
    // (`featured: false`), which is exactly the frontend's rule (`onTrack` in
    // edit-new.ts), so the track numbers, markers and mutes agree with what
    // String Outs shows. addSource keeps `false` for people who are only ever
    // an angle; their audio still travels in the group's alternates with Keep
    // groups.
    let alternate = |source: &str, track_id: &str| sources.iter().find(|known| known.id == source).and_then(|known| known.alternates.get(track_id));
    let on_track = |track: &&EditTrack| track.featured != Some(false);
    let sound: Vec<_> = document.tracks.iter().filter(|track| track.kind == EditTrackKind::Sound).filter(on_track).collect();
    // Record tracks are layers, as in Avid (edit_doc.rs `plays`): A1 can carry
    // one person's mic in one clip and someone else's in the next.
    let home = |id: &str| sound.iter().position(|track| track.id == id).map(|index| index as u32 + 1);
    let plays: Vec<Vec<Play>> = document.plays().into_iter().map(|here| here.into_iter().filter_map(|play| Some(Play {
        layer: play.layer, person: sound.iter().copied().find(|person| person.id == play.lane)?, source: play.source, in_frame: play.in_frame,
    })).collect()).collect();
    let count = plays.iter().flatten().map(|play| play.layer).max().unwrap_or(1).max(1);
    if count as usize > MAX_SOUND_TRACKS {
        return Err(AppError::invalid(format!("This string out uses {count} audio tracks, and Media Composer takes {MAX_SOUND_TRACKS}. \
            Move clips onto fewer tracks, or split it into two string outs.")));
    }
    // A person's mic in a source, as the writer names it: their slot, or their
    // group's track with their angle chosen.
    let slot_of = |person: &EditTrack, source: &str| -> Result<Mic, AppError> {
        let track_id = person.source_tracks.get(source).map(String::as_str).unwrap_or_default();
        Ok(match alternate(source, track_id) {
            Some(angle) => (angle.parent_slot, Some(angle.angles.clone())),
            None => (slot(&person.name, track_id)?, None),
        })
    };
    // Each track's own mic per source: whoever plays on it from that source
    // most often, so a track that holds one person throughout needs nothing
    // more, and the rest are the writer's overrides.
    let mut defaults: Vec<std::collections::BTreeMap<String, Mic>> = Vec::new();
    for layer in 1..=count {
        let mut counts: std::collections::BTreeMap<(&str, &str), usize> = Default::default();
        for play in plays.iter().flatten().filter(|play| play.layer == layer) { *counts.entry((play.source, play.person.id.as_str())).or_default() += 1; }
        let mut chosen: std::collections::BTreeMap<String, Mic> = Default::default();
        // Where nobody plays on it from a source, the person patched to it, as before layers.
        let patched = sound.get(layer as usize - 1).copied();
        for source in &document.sources {
            let best = counts.iter().filter(|((from, _), _)| *from == source.id).max_by_key(|(_, times)| **times).map(|((_, id), _)| *id);
            let person = best.and_then(|id| sound.iter().copied().find(|person| person.id == id))
                .or_else(|| patched.filter(|person| person.source_tracks.contains_key(&source.id)));
            if let Some(person) = person { chosen.insert(source.id.clone(), slot_of(person, &source.id)?); }
        }
        defaults.push(chosen);
    }
    let mut tracks = Vec::new();
    for (index, chosen) in defaults.iter().enumerate() {
        let slots: serde_json::Map<String, Value> = chosen.iter().map(|(source, (slot, _))| (source.clone(), json!(slot))).collect();
        let choices: serde_json::Map<String, Value> = chosen.iter().filter_map(|(source, (_, angles))| angles.as_ref().map(|angles| (source.clone(), json!(angles)))).collect();
        let mut out = json!({ "kind": "sound", "physical_track_number": index + 1, "source_slots": slots });
        if !choices.is_empty() { out["choices"] = Value::Object(choices); }
        tracks.push(out);
    }
    let mut picture = serde_json::Map::new();
    for source in &document.sources {
        if let Some(slot) = find(&source.id)?.picture_slot { picture.insert(source.id.clone(), json!(slot)); }
    }
    let has_picture = |source: &str| picture.contains_key(source);
    let mut segments = Vec::new();
    let mut mutes = Vec::new();
    let mut replaced = Vec::new();
    for (index, segment) in document.segments.iter().enumerate() {
        match segment {
            EditSegment::Gap { frames, .. } => segments.push(json!({ "kind": "gap", "frames": frames })),
            EditSegment::Source { source, in_frame, out_frame, .. } => {
                let length = out_frame - in_frame;
                let here = &plays[index];
                // Nothing to write anywhere: filler, which the writer can always place.
                if here.is_empty() && !has_picture(source) && !defaults.iter().any(|chosen| chosen.contains_key(source)) {
                    segments.push(json!({ "kind": "gap", "frames": length }));
                    continue;
                }
                segments.push(json!({ "kind": "source", "source": source, "in_frame": in_frame, "out_frame": out_frame }));
                for (track, chosen) in defaults.iter().enumerate() {
                    let Some(play) = here.iter().find(|play| play.layer as usize == track + 1) else {
                        // Nobody on this track here: filler, as an Avid track that was not part of the edit.
                        if chosen.contains_key(source) {
                            mutes.push(json!({ "segment_index": index, "track_index": track, "from_frame": 0, "to_frame": length }));
                        }
                        continue;
                    };
                    let mine = slot_of(play.person, play.source)?;
                    if play.source != source || play.in_frame != *in_frame || chosen.get(source) != Some(&mine) {
                        let mut over = json!({ "segment_index": index, "track_index": track, "source": play.source, "slot": mine.0, "in_frame": play.in_frame });
                        if let Some(angles) = &mine.1 { over["choices"] = json!(angles); }
                        replaced.push(over);
                    }
                    // What the editor muted in what they play, relative to the
                    // segment. Kept: it goes to Avid as a muted clip, which
                    // Unmute Clip brings back, not as filler.
                    for mute in document.mutes.iter().filter(|mute| mute.source == play.source && mute.track == play.person.id) {
                        let (from, to) = (mute.in_frame.max(play.in_frame), mute.out_frame.min(play.in_frame + length));
                        if to > from {
                            mutes.push(json!({ "segment_index": index, "track_index": track, "from_frame": from - play.in_frame, "to_frame": to - play.in_frame, "keep": true }));
                        }
                    }
                }
            }
        }
    }
    // Picture, stacked with the audio: one video track per record track, V1
    // carrying the picture of the moment A1 plays, V2 of A2's, and so on, so two
    // voices from different moments each keep their own picture and neither
    // overwrites the other. Where a track's picture is the same moment as a lower
    // one's there, it is filler rather than a copy; video tracks that would be
    // filler from end to end are left off.
    let moments: Vec<Vec<Option<(&str, i64)>>> = plays.iter().map(|here| {
        let mut seen: Vec<(&str, i64)> = Vec::new();
        (1..=count).map(|layer| {
            let play = here.iter().find(|play| play.layer == layer)?;
            if !has_picture(play.source) || seen.contains(&(play.source, play.in_frame)) { return None; }
            seen.push((play.source, play.in_frame));
            Some((play.source, play.in_frame))
        }).collect()
    }).collect();
    let videos = (1..=count as usize).filter(|layer| moments.iter().any(|row| row[layer - 1].is_some())).max().unwrap_or(0);
    let first_video = tracks.len();
    for layer in 1..=videos {
        let mut video = json!({ "kind": "picture", "physical_track_number": layer, "source_slots": picture });
        if picture_approach != sound_approach { video["approach"] = json!(picture_approach); }
        tracks.push(video);
    }
    for (index, segment) in document.segments.iter().enumerate() {
        let EditSegment::Source { source, in_frame, out_frame, .. } = segment else { continue };
        if segments[index]["kind"] != "source" { continue; }
        for layer in 1..=videos {
            let track = first_video + layer - 1;
            match moments[index][layer - 1] {
                None => if has_picture(source) {
                    mutes.push(json!({ "segment_index": index, "track_index": track, "from_frame": 0, "to_frame": out_frame - in_frame }));
                },
                Some((from, first)) => if from != source || first != *in_frame {
                    replaced.push(json!({ "segment_index": index, "track_index": track, "source": from, "slot": picture[from], "in_frame": first }));
                },
            }
        }
    }
    // The writer joins a track's pieces wherever its material simply carries
    // on, as the timeline draws it; an Add Edit made on purpose there stays an
    // edit, on the audio track and on the picture stacked with it.
    let mut cuts = Vec::new();
    for (index, segment) in document.segments.iter().enumerate() {
        let EditSegment::Source { cuts: Some(lanes), .. } = segment else { continue };
        if segments[index]["kind"] != "source" { continue; }
        let mut layers: Vec<u32> = plays[index].iter().filter(|play| lanes.contains(&play.person.id)).map(|play| play.layer).collect();
        layers.sort_unstable(); layers.dedup();
        for layer in layers {
            cuts.push(json!({ "segment_index": index, "track_index": layer - 1 }));
            if (layer as usize) <= videos && moments[index][layer as usize - 1].is_some() {
                cuts.push(json!({ "segment_index": index, "track_index": first_video + layer as usize - 1 }));
            }
        }
    }
    // A marker sits on the track its person is on at that frame, or the one
    // they were patched to; someone without a track lands on their group's.
    let starts: Vec<i64> = document.segments.iter().scan(0, |at, segment| { let start = *at; *at += segment.frames(); Some(start) }).collect();
    let marker_track = |id: &str, frame: i64| {
        let at = starts.iter().rposition(|start| *start <= frame);
        let placed = at.and_then(|at| plays[at].iter().find(|play| play.person.id == id)).map(|play| play.layer);
        placed.or_else(|| home(id)).map(|layer| (layer as usize - 1).min(count as usize - 1)).or_else(|| {
            let person = document.tracks.iter().find(|track| track.id == id)?;
            person.source_tracks.iter().find_map(|(source, track_id)| {
                let parent = alternate(source, track_id)?.parent_slot;
                defaults.iter().position(|chosen| chosen.get(source).is_some_and(|(slot, _)| *slot == parent))
            })
        })
    };
    // A marker must sit on a frame of the edit; one exactly at its end (after
    // the last bite) moves onto the last frame rather than failing the export.
    let length: i64 = document.segments.iter().map(|segment| match segment {
        EditSegment::Gap { frames, .. } => *frames,
        EditSegment::Source { in_frame, out_frame, .. } => out_frame - in_frame,
    }).sum();
    let markers: Vec<Value> = document.markers.iter().map(|marker| json!({
        "frame": marker.frame.min(length - 1).max(0), "track_index": marker.track.as_deref().and_then(|id| marker_track(id, marker.frame)).unwrap_or(0),
        "name": clip(&marker.name, MAX_NAME), "comment": clip(&marker.comment, MAX_COMMENT), "color": marker_color(&marker.color),
    })).collect();

    // Overrides need a writer that knows them (request version 2); an edit
    // whose tracks each hold one person throughout is written as before.
    let mut request = json!({
        "schema_version": if replaced.is_empty() { 1 } else { 2 }, "name": clip(&document.title, MAX_NAME),
        "edit_rate": format!("{}/{}", document.edit_rate.numerator, document.edit_rate.denominator),
        "start_timecode_frames": document.start_timecode_frames, "approach": sound_approach,
        "sources": out_sources, "tracks": tracks, "segments": segments, "mutes": mutes, "markers": markers,
        "output_path": output_path,
    });
    if !replaced.is_empty() { request["overrides"] = Value::Array(replaced); }
    if !cuts.is_empty() { request["cuts"] = Value::Array(cuts); }
    Ok(request)
}

/// A person's mic in a source as the writer names it: a slot, and the group
/// angles to choose when the slot is their group's track.
type Mic = (u32, Option<Vec<String>>);

/// Someone sounding on a record track across one segment: who, on which
/// track, and the source range they play there.
struct Play<'a> { layer: u32, person: &'a EditTrack, source: &'a str, in_frame: i64 }

/// The part of the writer's answer the app shows. Unknown fields are ignored,
/// so the writer can report more without breaking the invoke.
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct EditExportResult {
    pub output: String,
    pub markers_output: Option<String>,
    pub name: String,
    #[ts(type = "number")]
    pub duration_frames: i64,
    pub segments: u32,
    pub markers: u32,
    pub copied_mobs: u32,
    pub warnings: Vec<String>,
}

/// One edit of a batch export: what was written, or why that edit was not.
/// The other edits of the batch are written either way.
#[derive(Debug, Clone, Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct EditExportOutcome {
    pub edit_id: String,
    pub result: Option<EditExportResult>,
    pub error: Option<String>,
}

impl EditExportOutcome {
    pub fn failed(edit_id: &str, error: String) -> Self {
        Self { edit_id: edit_id.to_owned(), result: None, error: Some(error) }
    }
}

/// `write-edits`' answer, one outcome per edit sent, in order. An edit the
/// writer refused carries `{"error": {"code", "message"}}` in its place, and
/// its message is the writer's own user-facing copy.
pub fn batch_outcomes(sent: &[String], stdout: &str) -> Result<Vec<EditExportOutcome>, AppError> {
    #[derive(Deserialize)]
    struct Batch { results: Vec<Value> }
    let batch: Batch = serde_json::from_str(stdout)?;
    if batch.results.len() != sent.len() {
        return Err(AppError::internal(format!("The AAF writer answered for {} of {} string outs.", batch.results.len(), sent.len())));
    }
    sent.iter().zip(batch.results).map(|(edit_id, result)| Ok(match result.get("error") {
        Some(error) => EditExportOutcome::failed(edit_id, error.get("message").and_then(Value::as_str)
            .unwrap_or("The AAF writer refused this string out.").to_owned()),
        None => EditExportOutcome { edit_id: edit_id.clone(), result: Some(serde_json::from_value(result)?), error: None },
    })).collect()
}

/// Room left in a 255-byte file name for " 9999 - Avid markers.txt".
const MAX_STEM_BYTES: usize = 200;

/// A Finder and Media Composer safe file name from an edit's title, without
/// the extension: `exportName` in src/lib/edit-export.ts, which the single
/// export's save dialog proposes, so a batch names files as one export
/// would. Two differences, both because a batch has no dialog to fix a name
/// in: it is cut to fit a file name, and it is not NFC-normalised (no
/// normaliser is in this crate's graph; APFS compares names either way, so
/// `unique_stem` still sees a clash on disk).
pub fn export_stem(title: &str) -> String {
    let mut safe = String::with_capacity(title.len());
    // A run of path separators becomes one "-", a run of spaces one " ".
    let mut run = None;
    for c in title.chars() {
        let (out, class) = match c {
            '/' | ':' | '\\' => ('-', Some('/')),
            c if c.is_whitespace() => (' ', Some(' ')),
            c => (c, None),
        };
        if class.is_some() && class == run { continue; }
        run = class;
        safe.push(out);
    }
    let safe = crate::commands::truncate_utf8_bytes(safe.trim(), MAX_STEM_BYTES).trim_end();
    if safe.is_empty() { "Edit".to_owned() } else { safe.to_owned() }
}

/// `stem`, else `stem 2`, `stem 3` and on: the first name `free` accepts.
/// Bounded, so a folder where nothing is free is an error rather than a hang.
pub fn unique_stem(stem: &str, mut free: impl FnMut(&str) -> bool) -> Result<String, AppError> {
    if free(stem) { return Ok(stem.to_owned()); }
    (2..10_000).map(|n| format!("{stem} {n}")).find(|candidate| free(candidate))
        .ok_or_else(|| AppError::invalid(format!("Every name from \"{stem}\" to \"{stem} 9999\" is taken in that folder. Choose another folder.")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edit_doc::{EditMarker, EditMute, EditRate, EditSource, EditTrack};
    use std::collections::BTreeMap;

    fn document() -> EditDocument {
        let lane = |id: &str, slot: &str| EditTrack { id: id.into(), name: id.into(), kind: EditTrackKind::Sound,
            source_tracks: BTreeMap::from([("s1".to_string(), slot.to_string())]), featured: None };
        EditDocument {
            schema_version: 1, title: "SO_Rosa".into(), edit_rate: EditRate { numerator: 24000, denominator: 1001 },
            start_timecode_frames: 86400,
            sources: vec![EditSource { id: "s1".into(), name: "Scene".into(), document_id: "d".into() }],
            tracks: vec![lane("rosa", "2"), lane("dev", "3")],
            segments: vec![
                EditSegment::Source { id: "a".into(), source: "s1".into(), in_frame: 100, out_frame: 200, tracks: None, overrides: None, layers: None, cuts: None },
                EditSegment::Gap { id: "g".into(), frames: 24 },
                EditSegment::Source { id: "b".into(), source: "s1".into(), in_frame: 150, out_frame: 300, tracks: None, overrides: None, layers: None, cuts: None },
            ],
            mutes: vec![EditMute { source: "s1".into(), track: "dev".into(), in_frame: 180, out_frame: 220 }],
            markers: vec![EditMarker { id: "m".into(), frame: 10, track: Some("dev".into()), name: "Rosa".into(), comment: "laugh".into(), color: "yellow".into() }],
        }
    }
    fn sources() -> Vec<ExportSource> {
        vec![ExportSource { id: "s1".into(), aaf_path: "/a.aaf".into(), sequence_id: "urn:x".into(), picture_slot: Some(1),
            alternates: BTreeMap::from([("branch-ana".to_string(), Alternate { parent_slot: 2, angles: vec!["urn:group:3".into(), "urn:group:7".into()] })]) }]
    }

    #[test]
    fn mutes_become_segment_relative_on_every_segment_they_touch() {
        let request = build_request(&document(), &sources(), "C", "/out.aaf").unwrap();
        // Source 180-220 on dev: frames 80-100 of the first segment and 30-70 of the third,
        // kept, so Avid gets them as muted clips rather than filler.
        assert_eq!(request["mutes"], json!([
            { "segment_index": 0, "track_index": 1, "from_frame": 80, "to_frame": 100, "keep": true },
            { "segment_index": 2, "track_index": 1, "from_frame": 30, "to_frame": 70, "keep": true },
        ]));
    }

    #[test]
    fn tracks_are_numbered_and_picture_rides_as_v1() {
        let request = build_request(&document(), &sources(), "B", "/out.aaf").unwrap();
        assert_eq!(request["tracks"][0], json!({ "kind": "sound", "physical_track_number": 1, "source_slots": { "s1": 2 } }));
        assert_eq!(request["tracks"][2], json!({ "kind": "picture", "physical_track_number": 1, "source_slots": { "s1": 1 } }));
        assert_eq!(request["edit_rate"], "24000/1001");
        assert_eq!(request["segments"][1], json!({ "kind": "gap", "frames": 24 }));
    }

    #[test]
    fn a_clip_cut_with_some_tracks_is_filler_on_the_rest() {
        let mut edit = document();
        edit.segments[2] = EditSegment::Source { id: "b".into(), source: "s1".into(), in_frame: 150, out_frame: 300, tracks: Some(vec!["rosa".into()]), overrides: None, layers: None, cuts: None };
        edit.mutes.clear();
        let request = build_request(&edit, &sources(), "B", "/out.aaf").unwrap();
        // Rosa's bite: dev's track (index 1) is filler for the whole clip; the first clip plays both.
        assert_eq!(request["mutes"], json!([{ "segment_index": 2, "track_index": 1, "from_frame": 0, "to_frame": 150 }]));
    }

    #[test]
    fn a_track_lifted_alone_is_filler_there_and_one_overwritten_alone_plays_its_override() {
        use crate::edit_doc::EditOverride;
        let mut edit = document();
        edit.schema_version = 2;
        edit.segments[2] = EditSegment::Source { id: "b".into(), source: "s1".into(), in_frame: 150, out_frame: 300, tracks: None,
            overrides: Some(BTreeMap::from([("dev".to_string(), EditOverride { source: None, in_frame: 0 })])), layers: None, cuts: None };
        let request = build_request(&edit, &sources(), "B", "/out.aaf").unwrap();
        // Dev is lifted across the third clip: one whole-clip filler, not
        // kept, and his muted range there is not written twice.
        assert_eq!(request["mutes"], json!([
            { "segment_index": 0, "track_index": 1, "from_frame": 80, "to_frame": 100, "keep": true },
            { "segment_index": 2, "track_index": 1, "from_frame": 0, "to_frame": 150 },
        ]));
        edit.segments[2] = EditSegment::Source { id: "b".into(), source: "s1".into(), in_frame: 150, out_frame: 300, tracks: None,
            overrides: Some(BTreeMap::from([("dev".to_string(), EditOverride { source: Some("s1".into()), in_frame: 900 })])), layers: None, cuts: None };
        // Overwritten alone, his track plays the other range there: a writer
        // override, which only a request saying version 2 may carry.
        let request = build_request(&edit, &sources(), "B", "/out.aaf").unwrap();
        assert_eq!(request["schema_version"], 2);
        // His moment's picture rides on V2 (track 3: A1, A2, V1, V2), stacked over Rosa's on V1.
        assert_eq!(request["overrides"], json!([{ "segment_index": 2, "track_index": 1, "source": "s1", "slot": 3, "in_frame": 900 },
            { "segment_index": 2, "track_index": 3, "source": "s1", "slot": 1, "in_frame": 900 }]));
    }

    #[test]
    fn a_record_track_is_a_layer_that_holds_one_persons_mic_and_then_anothers() {
        // Rosa's bite and then Dev's, both cut onto A1.
        let mut edit = document();
        edit.schema_version = 2;
        edit.segments = vec![
            EditSegment::Source { id: "a".into(), source: "s1".into(), in_frame: 100, out_frame: 200, tracks: Some(vec!["rosa".into()]), overrides: None,
                layers: Some(BTreeMap::from([("rosa".to_string(), 1)])), cuts: None },
            EditSegment::Source { id: "b".into(), source: "s1".into(), in_frame: 400, out_frame: 450, tracks: Some(vec!["dev".into()]), overrides: None,
                layers: Some(BTreeMap::from([("dev".to_string(), 1)])), cuts: None },
        ];
        edit.mutes.clear();
        edit.markers[0].frame = 120;
        let request = build_request(&edit, &sources(), "B", "/out.aaf").unwrap();
        // One audio track (and V1), playing Rosa's mic and then Dev's.
        assert_eq!(request["tracks"].as_array().unwrap().iter().filter(|track| track["kind"] == "sound").count(), 1);
        assert_eq!(request["tracks"][0]["source_slots"], json!({ "s1": 2 }));
        assert_eq!(request["schema_version"], 2);
        assert_eq!(request["overrides"], json!([{ "segment_index": 1, "track_index": 0, "source": "s1", "slot": 3, "in_frame": 400 }]));
        assert_eq!(request["mutes"], json!([]));
        // Dev's marker sits on the track he is on there.
        assert_eq!(request["markers"][0]["track_index"], 0);
    }

    #[test]
    fn each_record_track_has_its_moments_picture_stacked_on_its_own_video_track() {
        use crate::edit_doc::EditOverride;
        let mut edit = document();
        edit.schema_version = 2;
        edit.mutes.clear();
        edit.markers.clear();
        // The first clip: Rosa and Dev at the same moment, one picture, on V1 alone.
        let request = build_request(&edit, &sources(), "C", "/out.aaf").unwrap();
        assert_eq!(request["tracks"].as_array().unwrap().iter().filter(|track| track["kind"] == "picture").count(), 1);
        // Dev from another moment over the third clip: V2 carries his picture there, V1 keeps Rosa's, and V2 is filler elsewhere.
        edit.segments[2] = EditSegment::Source { id: "b".into(), source: "s1".into(), in_frame: 150, out_frame: 300, tracks: None,
            overrides: Some(BTreeMap::from([("dev".to_string(), EditOverride { source: Some("s1".into()), in_frame: 900 })])), layers: None, cuts: None };
        let request = build_request(&edit, &sources(), "C", "/out.aaf").unwrap();
        let kinds: Vec<_> = request["tracks"].as_array().unwrap().iter().map(|track| (track["kind"].clone(), track["physical_track_number"].clone())).collect();
        assert_eq!(kinds, vec![(json!("sound"), json!(1)), (json!("sound"), json!(2)), (json!("picture"), json!(1)), (json!("picture"), json!(2))]);
        assert_eq!(request["mutes"], json!([{ "segment_index": 0, "track_index": 3, "from_frame": 0, "to_frame": 100 }]));
        assert!(request["overrides"].as_array().unwrap().contains(&json!({ "segment_index": 2, "track_index": 3, "source": "s1", "slot": 1, "in_frame": 900 })));
    }

    #[test]
    fn an_add_edit_made_on_purpose_reaches_the_writer_on_its_track_and_the_picture_stacked_with_it() {
        let mut edit = document();
        edit.schema_version = 2;
        edit.mutes.clear();
        edit.markers.clear();
        // No Add Edit anywhere: nothing for the writer to keep, and it joins whatever carries on.
        assert!(build_request(&edit, &sources(), "C", "/out.aaf").unwrap().get("cuts").is_none());
        // An Add Edit on Dev (A2) at the third clip: kept on A2. V1 shows the moment both play, so it has no V2 to cut.
        if let EditSegment::Source { cuts, .. } = &mut edit.segments[2] { *cuts = Some(vec!["dev".into()]); }
        let request = build_request(&edit, &sources(), "C", "/out.aaf").unwrap();
        assert_eq!(request["cuts"], json!([{ "segment_index": 2, "track_index": 1 }]));
    }

    #[test]
    fn keep_picture_groups_writes_v1_as_groups_and_the_audio_as_the_clip_that_plays() {
        let request = build_request(&document(), &sources(), "V", "/out.aaf").unwrap();
        assert_eq!(request["approach"], "B");
        assert_eq!(request["tracks"][2], json!({ "kind": "picture", "physical_track_number": 1, "source_slots": { "s1": 1 }, "approach": "C" }));
        assert!(request["tracks"][0].get("approach").is_none());
        assert!(build_request(&document(), &sources(), "D", "/out.aaf").is_err());
    }

    #[test]
    fn markers_land_on_their_lane_in_an_avid_colour() {
        let request = build_request(&document(), &sources(), "C", "/out.aaf").unwrap();
        assert_eq!(request["markers"][0]["track_index"], 1);
        assert_eq!(request["markers"][0]["color"], "Yellow");
        assert_eq!(marker_color("#abcdef"), "Red");
    }

    #[test]
    fn fits_the_writers_limits_instead_of_failing_the_export() {
        let mut long = document();
        long.title = "é".repeat(400);
        long.markers[0].name = "n".repeat(300);
        long.markers[0].comment = "c".repeat(6000);
        // Segments total 100 + 24 + 150 frames; a marker at 274 is just past the last.
        long.markers[0].frame = 274;
        let request = build_request(&long, &sources(), "B", "/o.aaf").unwrap();
        assert_eq!(request["name"].as_str().unwrap().chars().count(), MAX_NAME);
        assert_eq!(request["markers"][0]["name"].as_str().unwrap().len(), MAX_NAME);
        assert_eq!(request["markers"][0]["comment"].as_str().unwrap().len(), MAX_COMMENT);
        assert_eq!(request["markers"][0]["frame"], 273);
    }

    #[test]
    fn a_group_alternate_gets_a_track_only_when_featured_and_then_plays_her_angle() {
        let mut edit = document();
        edit.tracks.push(EditTrack { id: "ana".into(), name: "Ana".into(), kind: EditTrackKind::Sound,
            source_tracks: BTreeMap::from([("s1".to_string(), "branch-ana".to_string())]), featured: Some(false) });
        edit.markers[0].track = Some("ana".into());
        let request = build_request(&edit, &sources(), "C", "/o.aaf").unwrap();
        // Not featured: two sound tracks and V1, and her marker sits on her group's track (Rosa's, slot 2).
        assert_eq!(request["tracks"].as_array().unwrap().len(), 3);
        assert_eq!(request["markers"][0]["track_index"], 0);
        edit.tracks[2].featured = Some(true);
        let request = build_request(&edit, &sources(), "C", "/o.aaf").unwrap();
        assert_eq!(request["tracks"][2], json!({ "kind": "sound", "physical_track_number": 3,
            "source_slots": { "s1": 2 }, "choices": { "s1": ["urn:group:3", "urn:group:7"] } }));
        assert_eq!(request["markers"][0]["track_index"], 2);
        assert_eq!(request["tracks"][3]["kind"], "picture");
    }

    #[test]
    fn gathers_a_persons_angles_under_one_group_track_and_no_one_elses() {
        let lanes: Vec<GroupLane> = vec![
            ("11", None, None, "Aidan".into()),
            ("branch-a", Some("11"), Some("m1:3"), "Ana".into()),
            ("branch-b", Some("11"), Some("m2:3"), "Ana".into()),
            ("branch-c", Some("11"), Some("m1:5"), "Bo".into()),
            ("branch-d", Some("12"), Some("m3:1"), "Ana".into()),
        ];
        let found = alternates_of(&lanes);
        assert!(!found.contains_key("11"));
        assert_eq!(found["branch-a"].angles, vec!["m1:3", "m2:3"]);
        assert_eq!(found["branch-b"].angles, vec!["m1:3", "m2:3"]);
        assert_eq!(found["branch-c"].angles, vec!["m1:5"]);
        assert_eq!((found["branch-d"].parent_slot, found["branch-d"].angles.clone()), (12, vec!["m3:1".to_string()]));
    }

    #[test]
    fn a_person_with_a_track_in_one_source_plays_their_angle_in_another() {
        let mut edit = document();
        edit.sources.push(EditSource { id: "s2".into(), name: "Kitchen, day 2".into(), document_id: "d2".into() });
        edit.tracks[0].source_tracks.insert("s2".into(), "branch-rosa".into());
        let mut two = sources();
        two.push(ExportSource { id: "s2".into(), aaf_path: "/b.aaf".into(), sequence_id: "urn:y".into(), picture_slot: None,
            alternates: BTreeMap::from([("branch-rosa".to_string(), Alternate { parent_slot: 5, angles: vec!["urn:g2:4".into()] })]) });
        let request = build_request(&edit, &two, "B", "/o.aaf").unwrap();
        assert_eq!(request["tracks"][0], json!({ "kind": "sound", "physical_track_number": 1,
            "source_slots": { "s1": 2, "s2": 5 }, "choices": { "s2": ["urn:g2:4"] } }));
    }

    #[test]
    fn who_is_on_a_track_is_the_frontends_rule_exactly() {
        // `featured` absent means on a track, even when the only mic is an angle:
        // String Outs numbers that lane, so the AAF must too.
        let mut edit = document();
        edit.tracks[1].source_tracks.insert("s1".into(), "branch-ana".into());
        let request = build_request(&edit, &sources(), "C", "/o.aaf").unwrap();
        assert_eq!(request["tracks"][1]["choices"], json!({ "s1": ["urn:group:3", "urn:group:7"] }));
        edit.tracks[1].featured = Some(false);
        let request = build_request(&edit, &sources(), "C", "/o.aaf").unwrap();
        assert_eq!(request["tracks"].as_array().unwrap().iter().filter(|track| track["kind"] == "sound").count(), 1);
    }

    #[test]
    fn says_so_when_more_people_are_on_tracks_than_media_composer_takes() {
        let mut crowded = document();
        for index in 0..63 {
            crowded.tracks.push(EditTrack { id: format!("p{index}"), name: format!("P{index}"), kind: EditTrackKind::Sound,
                source_tracks: BTreeMap::from([("s1".to_string(), format!("{}", 10 + index))]), featured: None });
        }
        let message = build_request(&crowded, &sources(), "C", "/o.aaf").unwrap_err().to_string();
        assert!(message.contains("65 audio tracks") && message.contains("64"), "{message}");
    }

    #[test]
    fn names_a_file_the_way_the_save_dialog_does() {
        // exportName: separators become one "-", whitespace one " ", trimmed, "Edit" when nothing is left.
        assert_eq!(export_stem("SO_E104/Rosa: v01"), "SO_E104-Rosa- v01");
        assert_eq!(export_stem("  Rosa \t and\n Dev  "), "Rosa and Dev");
        assert_eq!(export_stem("a//b\\:c"), "a-b-c");
        assert_eq!(export_stem("a / b"), "a - b");
        assert_eq!(export_stem(" / "), "-");
        assert_eq!(export_stem("   "), "Edit");
        assert_eq!(export_stem(""), "Edit");
        // Cut at a character boundary to leave room for " 9999 - Avid markers.txt" in 255 bytes.
        let long = export_stem(&"é".repeat(300));
        assert!(long.len() <= MAX_STEM_BYTES && long.chars().all(|c| c == 'é'), "{long}");
        assert!(long.len() + " 9999 - Avid markers.txt".len() <= 255);
    }

    #[test]
    fn a_taken_name_gets_the_next_number_and_never_overwrites() {
        let taken = ["Rosa", "Rosa 2"];
        assert_eq!(unique_stem("Rosa", |name| !taken.contains(&name)).unwrap(), "Rosa 3");
        assert_eq!(unique_stem("Dev", |name| !taken.contains(&name)).unwrap(), "Dev");
        let mut asked = 0;
        assert!(unique_stem("Full", |_| { asked += 1; false }).is_err());
        assert_eq!(asked, 10_000 - 1);
    }

    #[test]
    fn a_batch_answer_keeps_each_edit_in_its_place() {
        let written = json!({ "output": "/o/Rosa.aaf", "markers_output": null, "name": "Rosa", "duration_frames": 48,
            "segments": 2, "markers": 0, "copied_mobs": 3474, "warnings": [], "pack": { "built": false } });
        let stdout = json!({ "schema_version": 1, "results": [written,
            { "error": { "code": "invalid_input", "message": "segments[0]: out_frame is past the end of slot 2." } }] }).to_string();
        let outcomes = batch_outcomes(&["e1".into(), "e2".into()], &stdout).unwrap();
        assert_eq!(outcomes[0].edit_id, "e1");
        assert_eq!(outcomes[0].result.as_ref().map(|result| result.copied_mobs), Some(3474));
        assert!(outcomes[0].error.is_none());
        assert_eq!(outcomes[1].edit_id, "e2");
        assert!(outcomes[1].result.is_none());
        assert_eq!(outcomes[1].error.as_deref(), Some("segments[0]: out_frame is past the end of slot 2."));
        // An answer for a different number of edits is not matched up by guesswork.
        assert!(batch_outcomes(&["e1".into()], &stdout).is_err());
        assert!(batch_outcomes(&["e1".into()], "not json").is_err());
    }

    #[test]
    fn refuses_what_the_writer_cannot_write() {
        let mut empty = document();
        empty.segments = vec![EditSegment::Gap { id: "g".into(), frames: 24 }];
        assert!(build_request(&empty, &sources(), "C", "/o.aaf").is_err());
        assert!(build_request(&document(), &sources(), "A", "/o.aaf").is_err());
        assert!(build_request(&document(), &[], "C", "/o.aaf").is_err());
        let mut branch = document();
        branch.tracks[0].source_tracks.insert("s1".into(), "2:alt".into());
        assert!(build_request(&branch, &sources(), "C", "/o.aaf").is_err());
    }
}
