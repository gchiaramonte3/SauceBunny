//! The Transcript Editor's document: what an edit IS, independent of how it
//! was made. The editing logic (ripple, gaps, lifts, dead space) lives in one
//! place, `src/lib/transcript-edit/`, because the text and the timeline must
//! react to it instantly; this is the typed shape that logic produces, that the
//! undo log stores, and that the AAF writer consumes.
//!
//! One idea carries it (see docs/TRANSCRIPT-EDITOR-UX.md, "The one model"):
//! an edit is an ordered list of SEGMENTS, each either a range of one source's
//! record frames that plays on every track at once, or a GAP of empty frames.
//! Program time is the running sum, so removing a range closes up by
//! construction. A MUTE silences one track over a source range and never
//! ripples. An OVERRIDE (schema version 2) is what one lane plays across a
//! whole segment instead of its clip: another source range (an Overwrite on
//! that track alone) or nothing (a Lift on that track alone), so a segment is
//! still cut on every track at once and nothing can slip out of sync. All times are whole frames at `edit_rate`: Avid cannot express a
//! subframe cut, so neither can the document.
use crate::AppError;
use serde::{Deserialize, Serialize};

pub const EDIT_SCHEMA_VERSION: u32 = 2;
/// The first version with per-lane overrides and record-track layers. A
/// string out with neither is still stamped 1, so an older build keeps opening
/// it; one with either must say 2, so an older build refuses it rather than
/// dropping them.
pub const OVERRIDES_SCHEMA_VERSION: u32 = 2;

const MAX_SOURCES: usize = 256;
/// Record tracks: Media Composer's audio track ceiling.
const MAX_LAYERS: u32 = 64;
const MAX_TRACKS: usize = 256;
const MAX_SEGMENTS: usize = 100_000;
const MAX_MUTES: usize = 200_000;
const MAX_MARKERS: usize = 100_000;
const MAX_TEXT: usize = 20_000;
/// 24 hours at 60 fps: longer than any real edit, short enough to stay exact.
const MAX_FRAMES: i64 = 24 * 60 * 60 * 60;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct EditRate {
    pub numerator: u32,
    pub denominator: u32,
}

/// Where segments come from: an AAF Audio document (one imported sequence).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct EditSource {
    pub id: String,
    pub name: String,
    /// The AAF Audio document id this source was imported as.
    pub document_id: String,
}

/// One output track. `source_tracks` maps a source id to that source's AAF
/// track id, so a person's lane can draw on a different mic in each source.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct EditTrack {
    pub id: String,
    pub name: String,
    pub kind: EditTrackKind,
    pub source_tracks: std::collections::BTreeMap<String, String>,
    /// Whether this person is patched to a record track. `false`: listed, so
    /// their words can be found and cut in, but on no track, so they neither
    /// play nor export. `true`: patched, on the next track down (tracks are
    /// numbered top-down in the order they appear here). Absent: patched, as
    /// every person was in string outs made before patching, so those open
    /// exactly as they were saved. A new string out patches nobody until
    /// someone's words are cut in, the way an Avid sequence starts with no
    /// tracks. `featured != Some(false)` is the on-track rule on both sides
    /// of the invoke. (The name predates patching: it first meant only a
    /// group angle given a track, and renaming it would orphan saved edits.)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub featured: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum EditTrackKind {
    Sound,
    Picture,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[serde(tag = "kind", rename_all = "lowercase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum EditSegment {
    Source {
        id: String,
        source: String,
        #[ts(type = "number")]
        in_frame: i64,
        #[ts(type = "number")]
        out_frame: i64,
        /// The lanes this clip plays on: a bite of one person, or an insert
        /// with some source mics turned off. Every other record track is
        /// filler for the clip, as it is in Avid when a track was not
        /// selected. Absent: every patched lane plays (whole-sequence cuts,
        /// and every clip made before clips named their tracks).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        tracks: Option<Vec<String>>,
        /// Per lane, what it plays across this whole segment instead of the
        /// clip: an Overwrite or a Lift made with only that track selected.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        overrides: Option<std::collections::BTreeMap<String, EditOverride>>,
        /// Per lane, the record track (1 for A1) it sits on in this segment.
        /// A record track is a layer, as in Avid, not a person: A1 can hold
        /// one person's mic here and someone else's in the next clip. A lane
        /// this does not name sits on the track it was patched to, which is
        /// all a string out from before layers knew.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        layers: Option<std::collections::BTreeMap<String, u32>>,
        /// Lanes with an edit of their own where this segment starts though
        /// their material runs straight on: a through edit made by Add Edit or
        /// the blade on their track.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        cuts: Option<Vec<String>>,
    },
    Gap {
        id: String,
        #[ts(type = "number")]
        frames: i64,
    },
}

/// What one lane plays across a segment instead of the segment's clip: the
/// segment's length of `source` from `in_frame`, or with no source, nothing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct EditOverride {
    pub source: Option<String>,
    #[ts(type = "number")]
    pub in_frame: i64,
}

impl EditSegment {
    pub fn frames(&self) -> i64 {
        match self {
            Self::Source { in_frame, out_frame, .. } => out_frame - in_frame,
            Self::Gap { frames, .. } => *frames,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct EditMute {
    pub source: String,
    pub track: String,
    #[ts(type = "number")]
    pub in_frame: i64,
    #[ts(type = "number")]
    pub out_frame: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct EditMarker {
    pub id: String,
    /// Program frame.
    #[ts(type = "number")]
    pub frame: i64,
    pub track: Option<String>,
    pub name: String,
    pub comment: String,
    pub color: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct EditDocument {
    pub schema_version: u32,
    pub title: String,
    pub edit_rate: EditRate,
    #[ts(type = "number")]
    pub start_timecode_frames: i64,
    pub sources: Vec<EditSource>,
    pub tracks: Vec<EditTrack>,
    pub segments: Vec<EditSegment>,
    pub mutes: Vec<EditMute>,
    pub markers: Vec<EditMarker>,
}

/// Someone sounding on a record track across one segment: who (a lane id),
/// on which track (1 for A1), and the source range they play there.
#[derive(Debug, Clone, PartialEq)]
pub struct EditPlay<'a> { pub layer: u32, pub lane: &'a str, pub source: &'a str, pub in_frame: i64 }

impl EditDocument {
    /// The people on record tracks (a sound lane not left off with
    /// `featured: false`), in track order: a lane's place here is the track a
    /// clip that does not name its tracks puts them on.
    pub fn patched(&self) -> Vec<&EditTrack> {
        self.tracks.iter().filter(|track| track.kind == EditTrackKind::Sound && track.featured != Some(false)).collect()
    }

    /// Who sounds on which record track in each segment. Record tracks are
    /// layers, as in Avid: a clip says which track each person in it sits on
    /// (`layers`), and one that does not puts them on the track they were
    /// patched to. A person plays their override, else the clip if it is cut
    /// for them, where they have a mic in what they play. One clip per track
    /// at once; the first named keeps it. The same rule as edit-model.ts
    /// `playersOf`, which String Outs draws and plays by.
    pub fn plays(&self) -> Vec<Vec<EditPlay<'_>>> {
        let patched = self.patched();
        let home = |id: &str| patched.iter().position(|track| track.id == id).map(|index| index as u32 + 1);
        self.segments.iter().map(|segment| {
            let EditSegment::Source { source, in_frame, tracks: lanes, overrides, layers, .. } = segment else { return Vec::new() };
            let own: Vec<&str> = match lanes {
                Some(lanes) => lanes.iter().map(String::as_str).collect(),
                None => patched.iter().filter(|person| person.source_tracks.contains_key(source)).map(|person| person.id.as_str()).collect(),
            };
            let mut out: Vec<EditPlay> = Vec::new();
            for id in own.iter().copied().chain(overrides.iter().flat_map(|all| all.keys().map(String::as_str))) {
                let Some(person) = patched.iter().copied().find(|person| person.id == id) else { continue };
                if out.iter().any(|play| play.lane == id) { continue; }
                let (from, first) = match overrides.as_ref().and_then(|all| all.get(id)) {
                    Some(over) => match &over.source { Some(other) => (other.as_str(), over.in_frame), None => continue },
                    None if own.contains(&id) => (source.as_str(), *in_frame),
                    None => continue,
                };
                if !person.source_tracks.contains_key(from) { continue; }
                let Some(layer) = layers.as_ref().and_then(|all| all.get(id).copied()).or_else(|| home(id)) else { continue };
                if out.iter().any(|play| play.layer == layer) { continue; }
                out.push(EditPlay { layer, lane: person.id.as_str(), source: from, in_frame: first });
            }
            out
        }).collect()
    }

    /// Refuse anything the rest of the pipeline could not honour. A document
    /// from a NEWER build is refused rather than rewritten, like every other
    /// versioned store (store-version-contract).
    pub fn validate(&self) -> Result<(), AppError> {
        let bad = |message: &str| Err(AppError::Invalid(format!("This string out cannot be saved: {message}.")));
        if self.schema_version > EDIT_SCHEMA_VERSION {
            return bad("it was made by a newer version of Sauce Bunny");
        }
        if self.edit_rate.numerator == 0 || self.edit_rate.denominator == 0 || self.edit_rate.numerator / self.edit_rate.denominator > 120 {
            return bad("its frame rate is invalid");
        }
        if self.title.chars().count() > 500 || self.sources.len() > MAX_SOURCES || self.tracks.len() > MAX_TRACKS
            || self.segments.len() > MAX_SEGMENTS || self.mutes.len() > MAX_MUTES || self.markers.len() > MAX_MARKERS {
            return bad("it is larger than a string out can be");
        }
        if !(0..=MAX_FRAMES).contains(&self.start_timecode_frames) {
            return bad("its start timecode is out of range");
        }
        let source_ids: std::collections::HashSet<&str> = self.sources.iter().map(|source| source.id.as_str()).collect();
        let track_ids: std::collections::HashSet<&str> = self.tracks.iter().map(|track| track.id.as_str()).collect();
        if source_ids.len() != self.sources.len() || track_ids.len() != self.tracks.len() {
            return bad("two sources or two tracks share an id");
        }
        for track in &self.tracks {
            if track.source_tracks.keys().any(|source| !source_ids.contains(source.as_str())) {
                return bad("a track refers to a source the string out does not have");
            }
        }
        let mut total: i64 = 0;
        for segment in &self.segments {
            match segment {
                EditSegment::Source { source, in_frame, out_frame, tracks, overrides, layers, cuts, .. } => {
                    if !source_ids.contains(source.as_str()) {
                        return bad("a segment refers to a source the string out does not have");
                    }
                    if let Some(cuts) = cuts {
                        if self.schema_version < OVERRIDES_SCHEMA_VERSION {
                            return bad("it has edits on single tracks but says it is an older kind of string out");
                        }
                        if cuts.iter().any(|lane| !track_ids.contains(lane.as_str())) {
                            return bad("a clip names a track the string out does not have");
                        }
                    }
                    if let Some(layers) = layers {
                        if self.schema_version < OVERRIDES_SCHEMA_VERSION {
                            return bad("it puts people on record tracks but says it is an older kind of string out");
                        }
                        if layers.keys().any(|lane| !track_ids.contains(lane.as_str())) {
                            return bad("a clip names a track the string out does not have");
                        }
                        if layers.values().any(|layer| !(1..=MAX_LAYERS).contains(layer)) {
                            return bad("a clip sits on a record track that cannot exist");
                        }
                    }
                    if let Some(overrides) = overrides {
                        if self.schema_version < OVERRIDES_SCHEMA_VERSION {
                            return bad("it edits single tracks but says it is an older kind of string out");
                        }
                        for (lane, over) in overrides {
                            if !track_ids.contains(lane.as_str()) {
                                return bad("a clip names a track the string out does not have");
                            }
                            if over.source.as_deref().is_some_and(|source| !source_ids.contains(source)) {
                                return bad("a segment refers to a source the string out does not have");
                            }
                            if over.source.is_some() && (over.in_frame < 0 || over.in_frame + (out_frame - in_frame) > MAX_FRAMES) {
                                return bad("a segment's frames are out of range");
                            }
                        }
                    }
                    if let Some(lanes) = tracks {
                        let unique: std::collections::HashSet<&str> = lanes.iter().map(String::as_str).collect();
                        if unique.len() != lanes.len() || lanes.iter().any(|lane| !track_ids.contains(lane.as_str())) {
                            return bad("a clip names a track the string out does not have");
                        }
                    }
                    if *in_frame < 0 || out_frame <= in_frame || *out_frame > MAX_FRAMES {
                        return bad("a segment's frames are out of range");
                    }
                }
                EditSegment::Gap { frames, .. } => {
                    if *frames <= 0 || *frames > MAX_FRAMES {
                        return bad("a gap's length is out of range");
                    }
                }
            }
            total += segment.frames();
            if total > MAX_FRAMES {
                return bad("it is longer than 24 hours");
            }
        }
        for mute in &self.mutes {
            if !source_ids.contains(mute.source.as_str()) || !track_ids.contains(mute.track.as_str())
                || mute.in_frame < 0 || mute.out_frame <= mute.in_frame || mute.out_frame > MAX_FRAMES {
                return bad("a silenced range is invalid");
            }
        }
        for marker in &self.markers {
            if marker.frame < 0 || marker.frame > total.max(0) || marker.name.len() > MAX_TEXT || marker.comment.len() > MAX_TEXT
                || marker.track.as_deref().is_some_and(|track| !track_ids.contains(track)) {
                return bad("a marker is invalid");
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(crate) fn sample() -> EditDocument {
        EditDocument {
            schema_version: EDIT_SCHEMA_VERSION,
            title: "Kitchen, first pass".into(),
            edit_rate: EditRate { numerator: 24000, denominator: 1001 },
            start_timecode_frames: 86_400,
            sources: vec![EditSource { id: "s1".into(), name: "MG 3 Kitchen".into(), document_id: "doc-1".into() }],
            tracks: vec![EditTrack { id: "rosa".into(), name: "Rosa".into(), kind: EditTrackKind::Sound, featured: None,
                source_tracks: [("s1".to_string(), "track-3".to_string())].into() }],
            segments: vec![
                EditSegment::Source { id: "a".into(), source: "s1".into(), in_frame: 0, out_frame: 100, tracks: None, overrides: None, layers: None, cuts: None },
                EditSegment::Gap { id: "g".into(), frames: 24 },
                EditSegment::Source { id: "b".into(), source: "s1".into(), in_frame: 200, out_frame: 260, tracks: Some(vec!["rosa".into()]), overrides: None, layers: None, cuts: None },
            ],
            mutes: vec![EditMute { source: "s1".into(), track: "rosa".into(), in_frame: 10, out_frame: 20 }],
            markers: vec![EditMarker { id: "m".into(), frame: 30, track: None, name: "Rosa".into(), comment: "bite".into(), color: "Red".into() }],
        }
    }

    #[test]
    fn a_valid_edit_passes_and_runs_the_sum_of_its_segments() {
        let doc = sample();
        assert!(doc.validate().is_ok());
        assert_eq!(doc.segments.iter().map(EditSegment::frames).sum::<i64>(), 184);
    }

    #[test]
    fn serialises_segments_as_a_tagged_union() {
        let json = serde_json::to_value(sample()).unwrap_or_default();
        assert_eq!(json["segments"][1]["kind"], "gap");
        assert_eq!(json["segments"][0]["kind"], "source");
        assert_eq!(json["tracks"][0]["kind"], "sound");
        // A clip names its tracks only when it has some; older clips read as every track.
        assert!(json["segments"][0].get("tracks").is_none());
        assert_eq!(json["segments"][2]["tracks"], serde_json::json!(["rosa"]));
        let back: EditDocument = serde_json::from_value(json).unwrap_or_else(|_| sample());
        assert_eq!(back, sample());
    }

    #[test]
    fn a_track_edited_alone_round_trips_and_needs_version_two() {
        let mut doc = sample();
        let lane = |source: Option<&str>, in_frame| std::collections::BTreeMap::from([("rosa".to_string(), EditOverride { source: source.map(String::from), in_frame })]);
        doc.segments[0] = EditSegment::Source { id: "a".into(), source: "s1".into(), in_frame: 0, out_frame: 100, tracks: None, overrides: Some(lane(Some("s1"), 400)), layers: None, cuts: None };
        // Saved as version 1, an older build would open it and drop the override: refused.
        doc.schema_version = 1;
        assert!(doc.validate().is_err());
        doc.schema_version = OVERRIDES_SCHEMA_VERSION;
        assert!(doc.validate().is_ok());
        let json = serde_json::to_value(&doc).unwrap_or_default();
        assert_eq!(json["segments"][0]["overrides"], serde_json::json!({ "rosa": { "source": "s1", "in_frame": 400 } }));
        let back: EditDocument = serde_json::from_value(json).unwrap_or_else(|_| sample());
        assert_eq!(back, doc);
        // A lift is a lane with no source.
        doc.segments[0] = EditSegment::Source { id: "a".into(), source: "s1".into(), in_frame: 0, out_frame: 100, tracks: None, overrides: Some(lane(None, 0)), layers: None, cuts: None };
        assert!(doc.validate().is_ok());
        let bad = |overrides| { let mut doc = doc.clone(); doc.segments[0] = EditSegment::Source { id: "a".into(), source: "s1".into(), in_frame: 0, out_frame: 100, tracks: None, overrides: Some(overrides), layers: None, cuts: None }; doc.validate().is_err() };
        assert!(bad(std::collections::BTreeMap::from([("nobody".to_string(), EditOverride { source: None, in_frame: 0 })])));
        assert!(bad(lane(Some("nope"), 0)));
        assert!(bad(lane(Some("s1"), -1)));
        assert!(bad(lane(Some("s1"), MAX_FRAMES)));
    }

    #[test]
    fn refuses_what_the_pipeline_could_not_honour() {
        let mut newer = sample();
        newer.schema_version = EDIT_SCHEMA_VERSION + 1;
        assert!(newer.validate().is_err());
        let mut empty_segment = sample();
        empty_segment.segments[0] = EditSegment::Source { id: "a".into(), source: "s1".into(), in_frame: 50, out_frame: 50, tracks: None, overrides: None, layers: None, cuts: None };
        assert!(empty_segment.validate().is_err());
        let mut unknown_source = sample();
        unknown_source.segments[0] = EditSegment::Source { id: "a".into(), source: "nope".into(), in_frame: 0, out_frame: 5, tracks: None, overrides: None, layers: None, cuts: None };
        assert!(unknown_source.validate().is_err());
        // A clip's tracks name lanes of this string out, each once.
        let mut unknown_lane = sample();
        unknown_lane.segments[0] = EditSegment::Source { id: "a".into(), source: "s1".into(), in_frame: 0, out_frame: 5, tracks: Some(vec!["nobody".into()]), overrides: None, layers: None, cuts: None };
        assert!(unknown_lane.validate().is_err());
        let mut twice = sample();
        twice.segments[0] = EditSegment::Source { id: "a".into(), source: "s1".into(), in_frame: 0, out_frame: 5, tracks: Some(vec!["rosa".into(), "rosa".into()]), overrides: None, layers: None, cuts: None };
        assert!(twice.validate().is_err());
        let mut bad_mute = sample();
        bad_mute.mutes[0].track = "nobody".into();
        assert!(bad_mute.validate().is_err());
        let mut late_marker = sample();
        late_marker.markers[0].frame = 10_000;
        assert!(late_marker.validate().is_err());
        let mut zero_gap = sample();
        zero_gap.segments[1] = EditSegment::Gap { id: "g".into(), frames: 0 };
        assert!(zero_gap.validate().is_err());
    }
}
