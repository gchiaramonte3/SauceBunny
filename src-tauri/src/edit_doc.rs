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
//! ripples. All times are whole frames at `edit_rate`: Avid cannot express a
//! subframe cut, so neither can the document.
use crate::AppError;
use serde::{Deserialize, Serialize};

pub const EDIT_SCHEMA_VERSION: u32 = 1;

const MAX_SOURCES: usize = 256;
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
    },
    Gap {
        id: String,
        #[ts(type = "number")]
        frames: i64,
    },
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

impl EditDocument {
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
                EditSegment::Source { source, in_frame, out_frame, tracks, .. } => {
                    if !source_ids.contains(source.as_str()) {
                        return bad("a segment refers to a source the string out does not have");
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
                EditSegment::Source { id: "a".into(), source: "s1".into(), in_frame: 0, out_frame: 100, tracks: None },
                EditSegment::Gap { id: "g".into(), frames: 24 },
                EditSegment::Source { id: "b".into(), source: "s1".into(), in_frame: 200, out_frame: 260, tracks: Some(vec!["rosa".into()]) },
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
    fn refuses_what_the_pipeline_could_not_honour() {
        let mut newer = sample();
        newer.schema_version = EDIT_SCHEMA_VERSION + 1;
        assert!(newer.validate().is_err());
        let mut empty_segment = sample();
        empty_segment.segments[0] = EditSegment::Source { id: "a".into(), source: "s1".into(), in_frame: 50, out_frame: 50, tracks: None };
        assert!(empty_segment.validate().is_err());
        let mut unknown_source = sample();
        unknown_source.segments[0] = EditSegment::Source { id: "a".into(), source: "nope".into(), in_frame: 0, out_frame: 5, tracks: None };
        assert!(unknown_source.validate().is_err());
        // A clip's tracks name lanes of this string out, each once.
        let mut unknown_lane = sample();
        unknown_lane.segments[0] = EditSegment::Source { id: "a".into(), source: "s1".into(), in_frame: 0, out_frame: 5, tracks: Some(vec!["nobody".into()]) };
        assert!(unknown_lane.validate().is_err());
        let mut twice = sample();
        twice.segments[0] = EditSegment::Source { id: "a".into(), source: "s1".into(), in_frame: 0, out_frame: 5, tracks: Some(vec!["rosa".into(), "rosa".into()]) };
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
