//! Versioned, local-only AAF project and analysis contracts.
use crate::AppError;
use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 3;
pub const DOCUMENT_SCHEMA_VERSION: u32 = 4;
pub const ASR_RATE: i64 = 16_000;

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AafRate {
    pub numerator: u32,
    pub denominator: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AafClip {
    #[ts(type = "number")]
    pub start_frame: i64,
    #[ts(type = "number")]
    pub duration_frames: i64,
    pub kind: String,
    pub master_id: Option<String>,
    pub source_id: Option<String>,
    #[ts(type = "number | null")]
    pub source_start_sample: Option<i64>,
    pub sample_rate: Option<u32>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AafTrack {
    pub id: String,
    pub name: String,
    // Composition audio lane, not the MobSlot ID. Missing in older imports.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub physical_track_number: Option<u32>,
    pub clips: Vec<AafClip>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AafManifest {
    pub schema_version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub graph: Option<AafGraph>,
    pub name: String,
    pub source_fingerprint: String,
    #[serde(default)]
    #[ts(optional)]
    pub recording_dates: Option<Vec<AafRecordingDate>>,
    pub edit_rate: AafRate,
    #[ts(type = "number")]
    pub start_frame: i64,
    #[ts(type = "number")]
    pub duration_frames: i64,
    pub timecode_fps: u32,
    pub drop_frame: bool,
    pub tracks: Vec<AafTrack>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AafTrackLabel {
    pub track_id: String,
    pub owner_name: String,
    pub cast_member_id: Option<String>,
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub gender: Option<AafGender>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub marker_color: Option<AafMarkerColor>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum AafGender { Unspecified, Man, Woman, Nonbinary, Other }

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum AafMarkerColor { Red, Green, Blue, Cyan, Yellow, Magenta, White, Black, Purple, Violet, Pink, Denim, Forest, Orange, Gold, Grey }

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AafRecordingDate { pub source_id: String, pub date: String, pub provenance: String }

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AafCue {
    pub id: String,
    /// Sequence-relative position at 16 kHz. Never raw VAD-compacted token time.
    #[ts(type = "number")]
    pub start_sample: i64,
    #[ts(type = "number")]
    pub end_sample: i64,
    pub text: String,
    #[serde(default)]
    pub boundary_review: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum AafEngine { Whisper, Parakeet }

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum AafTranscriptStatus { Completed, Empty, Review }

/// Keep recognizer text with unusable timing, without inventing a seek position.
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AafTimingIssue {
    pub id: String,
    pub text: String,
    pub reported_timing: String,
    #[ts(type = "number")]
    pub chunk_start_frame: i64,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AafTrackTranscript {
    pub track_id: String,
    #[ts(type = "number")]
    pub start_frame: i64,
    #[ts(type = "number")]
    pub duration_frames: i64,
    pub engine: AafEngine,
    pub model_id: String,
    pub status: AafTranscriptStatus,
    pub sample_rate: u32,
    pub cues: Vec<AafCue>,
    #[serde(default)]
    pub timing_issues: Vec<AafTimingIssue>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AafDocument {
    pub schema_version: u32,
    pub id: String,
    pub source_path: String,
    #[ts(type = "number")]
    pub source_size: u64,
    #[ts(type = "number")]
    pub source_modified_ms: u64,
    pub manifest: AafManifest,
    pub labels: Vec<AafTrackLabel>,
    pub transcripts: Vec<AafTrackTranscript>,
    /// None uses source metadata; Some("") explicitly clears an unknown date.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub shoot_date_override: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AafDocumentSummary {
    pub id: String,
    pub name: String,
    pub track_count: u32,
    pub transcribed_tracks: u32,
    pub source_path: String,
    #[serde(default)]
    #[ts(optional, type = "number")]
    pub modified_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AafWaveform {
    pub track_id: String,
    pub peaks: Vec<[f32; 2]>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AafAudioAsset {
    pub path: String,
    #[ts(type = "number")]
    pub start_frame: i64,
    #[ts(type = "number")]
    pub duration_frames: i64,
    pub sample_rate: u32,
    #[ts(type = "number")]
    pub sample_count: i64,
    pub peaks: Vec<[f32; 2]>,
}

#[derive(Clone, Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AafProgress {
    pub job_id: String,
    pub track_id: Option<String>,
    pub phase: String,
    #[ts(type = "number")]
    pub completed_frames: i64,
    #[ts(type = "number")]
    pub total_frames: i64,
}

pub fn frame_samples(frame: i64, rate: &AafRate) -> Result<i64, AppError> {
    if frame < 0 || rate.numerator == 0 || rate.denominator == 0 {
        return Err(AppError::invalid("Invalid AAF frame position or edit rate"));
    }
    let value = i128::from(frame) * i128::from(rate.denominator) * i128::from(ASR_RATE)
        / i128::from(rate.numerator);
    i64::try_from(value).map_err(|_| AppError::invalid("AAF duration exceeds supported range"))
}

pub fn validate_manifest(manifest: &AafManifest) -> Result<(), AppError> {
    if manifest.recording_dates.as_ref().is_some_and(|dates| dates.len() > 640_000 || dates.iter().any(|date|
        date.source_id.is_empty() || date.source_id.len() > 256 || !super::store::valid_date(&date.date)
            || !matches!(date.provenance.as_str(), "bwf-origination-date" | "explicit-recording-date"))) {
        return Err(AppError::invalid("Invalid recording-date metadata"));
    }
    if !(1..=SCHEMA_VERSION).contains(&manifest.schema_version) {
        return Err(AppError::invalid("This AAF document version is not supported. Update Sauce Bunny."));
    }
    if manifest.duration_frames <= 0 || manifest.start_frame < 0
        || manifest.timecode_fps == 0 || manifest.timecode_fps > 120
        || manifest.tracks.is_empty() || manifest.tracks.len() > if manifest.graph.is_some() { 256 } else { 64 }
        || manifest.source_fingerprint.len() != 64
        || !manifest.source_fingerprint.bytes().all(|b| b.is_ascii_hexdigit())
    { return Err(AppError::invalid("Invalid or unsupported AAF manifest")); }
    // JS integers, sample arithmetic and bounded job estimates must remain exact.
    let samples = frame_samples(manifest.duration_frames, &manifest.edit_rate)?;
    if samples > 16_000 * 60 * 60 * 24 * 7 {
        return Err(AppError::invalid("AAF sequences longer than seven days are not supported"));
    }
    let mut ids = std::collections::HashSet::new();
    for track in &manifest.tracks {
        if track.id.is_empty() || !ids.insert(&track.id) || track.clips.len() > 10_000
            || track.physical_track_number == Some(0) {
            return Err(AppError::invalid("Invalid AAF track identity or clip count"));
        }
        let mut previous_end = 0;
        for clip in &track.clips {
            let end = clip.start_frame.checked_add(clip.duration_frames)
                .ok_or_else(|| AppError::invalid("AAF clip duration overflow"))?;
            if clip.start_frame < previous_end || clip.duration_frames < 0
                || end > manifest.duration_frames || !matches!(clip.kind.as_str(), "audio" | "gap" | "unavailable")
            { return Err(AppError::invalid("Unsupported overlapping or out-of-range AAF clips")); }
            previous_end = end;
        }
    }
    if let Some(graph) = &manifest.graph {
        let bad = || AppError::invalid("Invalid AAF source graph");
        if graph.sequence_id.is_empty() || graph.sequence_id.len() > 256 || graph.lanes.len() != ids.len()
            || graph.sources.len() > 10000 || graph.positions.len() > 2560000 || graph.path_mappings.len() > 10000
            || graph.markers.len() > 100000 || graph.picture_tracks.len() > 256 { return Err(bad()); }
        let mut lanes = std::collections::HashSet::new();
        for lane in &graph.lanes {
            if !ids.contains(&lane.track_id) || !lanes.insert(&lane.track_id)
                || !matches!(lane.availability.as_str(), "ready" | "offline" | "needs_relink" | "unsupported") { return Err(bad()); }
            if let Some(parent) = &lane.parent_track_id {
                if parent == &lane.track_id || !graph.lanes.iter().any(|p| &p.track_id == parent && p.parent_track_id.is_none()) { return Err(bad()); }
            }
        }
        if graph.lanes.iter().filter(|l| l.parent_track_id.is_none()).count() > 64 { return Err(bad()); }
        let mut sources = std::collections::HashSet::new();
        for source in &graph.sources {
            if source.id.len() > 512 || !sources.insert(&source.id) || !(1..=256).contains(&source.channels)
                || source.channel >= source.channels || ![44100,48000,96000].contains(&source.sample_rate)
                || ![2,3,4].contains(&source.sample_width) || source.sample_count > 96_000*60*60*24*7
                || source.locators.len() > 256 || source.ancestors.len() > 16
                || source.locators.iter().any(|p| p.len() > 32768)
                || source.resolution_note.as_ref().is_some_and(|n| n.len() > 4000)
                || !matches!(source.status.as_str(), "ready" | "offline" | "needs_relink") { return Err(bad()); }
            if let Some(binding) = &source.resolved {
                if !std::path::Path::new(&binding.path).is_absolute() || binding.path.len() > 32768
                    || binding.fingerprint.len() != 64 || !binding.fingerprint.bytes().all(|b| b.is_ascii_hexdigit()) { return Err(bad()); }
            }
        }
        let mut positions = std::collections::HashSet::new();
        for position in &graph.positions {
            if position.numerator < 0 || position.denominator <= 0 || position.denominator > 1_000_000_000
                || !positions.insert((&position.track_id, position.clip_index))
                || !manifest.tracks.iter().any(|t| t.id == position.track_id && t.clips.get(position.clip_index).is_some_and(|c| c.kind == "audio")) { return Err(bad()); }
        }
        for mapping in &graph.path_mappings {
            if !std::path::Path::new(&mapping.from).is_absolute() || !std::path::Path::new(&mapping.to).is_absolute()
                || mapping.from.len() > 32768 || mapping.to.len() > 32768 { return Err(bad()); }
            if mapping.authority.as_ref().is_some_and(|h| h.is_empty() || h.len() > 253 || !h.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')) { return Err(bad()); }
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AafGraph {
    pub sequence_id: String,
    pub sources: Vec<AafSource>,
    pub lanes: Vec<AafLane>,
    pub positions: Vec<AafSourcePosition>,
    pub markers: Vec<AafImportedMarker>,
    pub picture_tracks: Vec<AafPictureTrack>,
    #[serde(default)]
    pub path_mappings: Vec<AafPathMapping>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AafLane {
    pub track_id: String,
    pub parent_track_id: Option<String>,
    pub branch_id: Option<String>,
    pub group_name: Option<String>,
    pub availability: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AafSourcePosition {
    pub track_id: String,
    pub clip_index: usize,
    #[ts(type = "number")]
    pub numerator: i64,
    #[ts(type = "number")]
    pub denominator: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AafSource {
    pub id: String,
    pub mob_id: String,
    pub slot_id: u32,
    pub locators: Vec<String>,
    pub ancestors: Vec<AafSourceAncestor>,
    pub channel: u32,
    pub channels: u32,
    pub sample_rate: u32,
    pub sample_width: u32,
    #[ts(type = "number")]
    pub sample_count: u64,
    pub descriptor: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub resolution_note: Option<String>,
    #[serde(default)]
    #[ts(optional)]
    pub resolved: Option<AafResolvedSource>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AafSourceAncestor {
    pub mob_id: String,
    pub slot_id: u32,
    #[ts(type = "number")]
    pub start: i64,
    pub edit_rate: String,
    pub locators: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AafResolvedSource {
    pub path: String,
    pub fingerprint: String,
    pub stream_index: u32,
    #[ts(type = "number")]
    pub size: u64,
    #[ts(type = "number")]
    pub modified_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AafPathMapping {
    pub from: String,
    pub to: String,
    /// Namespace of a file://server locator, never a server to contact.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub authority: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AafImportedMarker {
    #[ts(type = "number")]
    pub position: i64,
    pub comment: String,
    pub described_slots: Vec<u32>,
    pub attributes: std::collections::BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AafPictureTrack {
    pub slot_id: u32,
    pub physical_track_number: Option<u32>,
    pub name: String,
    pub component: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AafSequenceChoice { pub id: String, pub name: String }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn audio_track_number_is_optional_for_legacy_documents_and_roundtrips() {
        let legacy = serde_json::json!({"id": "slot-11", "name": "Nathaniel", "clips": [], "warnings": []});
        let mut track: AafTrack = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(track.physical_track_number, None);
        assert_eq!(serde_json::to_value(&track).unwrap(), legacy);
        track.physical_track_number = Some(2);
        let saved = serde_json::to_value(&track).unwrap();
        assert_eq!(saved["physical_track_number"], 2);
        assert_eq!(serde_json::from_value::<AafTrack>(saved).unwrap().physical_track_number, Some(2));
    }
    #[test]
    fn fractional_rate_mapping_is_rational_not_rounded_fps() {
        let rate = AafRate { numerator: 24000, denominator: 1001 };
        assert_eq!(frame_samples(24_000, &rate).unwrap(), 16_016_000);
        assert_eq!(frame_samples(146_759, &rate).unwrap(), 97_937_172);
        assert!(frame_samples(-1, &rate).is_err());
        assert!(frame_samples(1, &AafRate { numerator: 0, denominator: 1 }).is_err());
    }
}
