//! An edit as a `write-edit` request for the AAF sidecar (aaf-sidecar/writer.py).
//!
//! Pure translation, no I/O: the edit keeps silenced ranges in SOURCE frames
//! per person and markers on a lane id, while the writer wants mutes relative
//! to a segment on a track index and markers on a track index. Doing the
//! conversion here, with tests, keeps the writer's request format out of the
//! frontend and the edit's model out of Python.

use crate::edit_doc::{EditDocument, EditSegment, EditTrackKind};
use crate::AppError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// What the writer needs to know about one source sequence.
pub struct ExportSource {
    pub id: String,
    pub aaf_path: String,
    pub sequence_id: String,
    /// The sequence's first picture track, carried as V1 so the cut relinks
    /// to picture in Media Composer. Never decoded.
    pub picture_slot: Option<u32>,
}

/// Media Composer's eight marker colours, as the writer spells them.
const COLORS: [&str; 8] = ["Red", "Green", "Blue", "Cyan", "Magenta", "Yellow", "White", "Black"];

fn marker_color(color: &str) -> &'static str {
    COLORS.iter().find(|known| known.eq_ignore_ascii_case(color.trim())).copied().unwrap_or("Red")
}

fn slot(track_id: &str) -> Result<u32, AppError> {
    track_id.parse().map_err(|_| AppError::invalid(format!(
        "Track {track_id} is an alternative microphone, which an exported edit cannot reference yet. Choose the group's main track.")))
}

pub fn build_request(document: &EditDocument, sources: &[ExportSource], approach: &str, output_path: &str) -> Result<Value, AppError> {
    document.validate()?;
    if approach != "B" && approach != "C" {
        return Err(AppError::invalid("Choose how groups are written: B (the clip that plays) or C (the whole group)."));
    }
    if !document.segments.iter().any(|segment| matches!(segment, EditSegment::Source { .. })) {
        return Err(AppError::invalid("This edit is empty. Add something to it before exporting."));
    }
    let find = |id: &str| sources.iter().find(|source| source.id == id)
        .ok_or_else(|| AppError::not_found(format!("Source {id} of this edit is no longer in AAF Audio.")));
    let mut out_sources = Vec::new();
    for source in &document.sources {
        let known = find(&source.id)?;
        out_sources.push(json!({ "id": known.id, "aaf_path": known.aaf_path, "sequence_id": known.sequence_id }));
    }

    let sound: Vec<_> = document.tracks.iter().filter(|track| track.kind == EditTrackKind::Sound).collect();
    let mut tracks = Vec::new();
    for (index, track) in sound.iter().enumerate() {
        let mut slots = serde_json::Map::new();
        for (source, track_id) in &track.source_tracks { slots.insert(source.clone(), json!(slot(track_id)?)); }
        tracks.push(json!({ "kind": "sound", "physical_track_number": index + 1, "source_slots": slots }));
    }
    let mut picture = serde_json::Map::new();
    for source in &document.sources {
        if let Some(slot) = find(&source.id)?.picture_slot { picture.insert(source.id.clone(), json!(slot)); }
    }
    if !picture.is_empty() { tracks.push(json!({ "kind": "picture", "physical_track_number": 1, "source_slots": picture })); }

    let lane = |id: &str| sound.iter().position(|track| track.id == id);
    let mut segments = Vec::new();
    let mut mutes = Vec::new();
    for (index, segment) in document.segments.iter().enumerate() {
        match segment {
            EditSegment::Gap { frames, .. } => segments.push(json!({ "kind": "gap", "frames": frames })),
            EditSegment::Source { source, in_frame, out_frame, .. } => {
                segments.push(json!({ "kind": "source", "source": source, "in_frame": in_frame, "out_frame": out_frame }));
                for mute in document.mutes.iter().filter(|mute| &mute.source == source) {
                    let (from, to) = (mute.in_frame.max(*in_frame), mute.out_frame.min(*out_frame));
                    let Some(track) = lane(&mute.track) else { continue };
                    if to > from {
                        mutes.push(json!({ "segment_index": index, "track_index": track, "from_frame": from - in_frame, "to_frame": to - in_frame }));
                    }
                }
            }
        }
    }
    let markers: Vec<Value> = document.markers.iter().map(|marker| json!({
        "frame": marker.frame, "track_index": marker.track.as_deref().and_then(lane).unwrap_or(0),
        "name": marker.name, "comment": marker.comment, "color": marker_color(&marker.color),
    })).collect();

    Ok(json!({
        "schema_version": 1, "name": document.title,
        "edit_rate": format!("{}/{}", document.edit_rate.numerator, document.edit_rate.denominator),
        "start_timecode_frames": document.start_timecode_frames, "approach": approach,
        "sources": out_sources, "tracks": tracks, "segments": segments, "mutes": mutes, "markers": markers,
        "output_path": output_path,
    }))
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edit_doc::{EditMarker, EditMute, EditRate, EditSource, EditTrack};
    use std::collections::BTreeMap;

    fn document() -> EditDocument {
        let lane = |id: &str, slot: &str| EditTrack { id: id.into(), name: id.into(), kind: EditTrackKind::Sound,
            source_tracks: BTreeMap::from([("s1".to_string(), slot.to_string())]) };
        EditDocument {
            schema_version: 1, title: "SO_Rosa".into(), edit_rate: EditRate { numerator: 24000, denominator: 1001 },
            start_timecode_frames: 86400,
            sources: vec![EditSource { id: "s1".into(), name: "Scene".into(), document_id: "d".into() }],
            tracks: vec![lane("rosa", "2"), lane("dev", "3")],
            segments: vec![
                EditSegment::Source { id: "a".into(), source: "s1".into(), in_frame: 100, out_frame: 200 },
                EditSegment::Gap { id: "g".into(), frames: 24 },
                EditSegment::Source { id: "b".into(), source: "s1".into(), in_frame: 150, out_frame: 300 },
            ],
            mutes: vec![EditMute { source: "s1".into(), track: "dev".into(), in_frame: 180, out_frame: 220 }],
            markers: vec![EditMarker { id: "m".into(), frame: 10, track: Some("dev".into()), name: "Rosa".into(), comment: "laugh".into(), color: "yellow".into() }],
        }
    }
    fn sources() -> Vec<ExportSource> {
        vec![ExportSource { id: "s1".into(), aaf_path: "/a.aaf".into(), sequence_id: "urn:x".into(), picture_slot: Some(1) }]
    }

    #[test]
    fn mutes_become_segment_relative_on_every_segment_they_touch() {
        let request = build_request(&document(), &sources(), "C", "/out.aaf").unwrap();
        // Source 180-220 on dev: frames 80-100 of the first segment and 30-70 of the third.
        assert_eq!(request["mutes"], json!([
            { "segment_index": 0, "track_index": 1, "from_frame": 80, "to_frame": 100 },
            { "segment_index": 2, "track_index": 1, "from_frame": 30, "to_frame": 70 },
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
    fn markers_land_on_their_lane_in_an_avid_colour() {
        let request = build_request(&document(), &sources(), "C", "/out.aaf").unwrap();
        assert_eq!(request["markers"][0]["track_index"], 1);
        assert_eq!(request["markers"][0]["color"], "Yellow");
        assert_eq!(marker_color("#abcdef"), "Red");
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
