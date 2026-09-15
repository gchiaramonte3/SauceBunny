//! Versioned, local-only AAF project and analysis contracts.
use crate::AppError;
use serde::{Deserialize, Serialize};

pub const SCHEMA_VERSION: u32 = 1;
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
    pub clips: Vec<AafClip>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AafManifest {
    pub schema_version: u32,
    pub name: String,
    pub source_fingerprint: String,
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
}

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
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AafDocumentSummary {
    pub id: String,
    pub name: String,
    pub track_count: u32,
    pub transcribed_tracks: u32,
    pub source_path: String,
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
    if manifest.schema_version != SCHEMA_VERSION {
        return Err(AppError::invalid("This AAF document version is not supported. Update Sauce Bunny."));
    }
    if manifest.duration_frames <= 0 || manifest.start_frame < 0
        || manifest.timecode_fps == 0 || manifest.timecode_fps > 120
        || manifest.tracks.is_empty() || manifest.tracks.len() > 64
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
        if track.id.is_empty() || !ids.insert(&track.id) || track.clips.len() > 10_000 {
            return Err(AppError::invalid("Invalid AAF track identity or clip count"));
        }
        let mut previous_end = 0;
        for clip in &track.clips {
            let end = clip.start_frame.checked_add(clip.duration_frames)
                .ok_or_else(|| AppError::invalid("AAF clip duration overflow"))?;
            if clip.start_frame < previous_end || clip.duration_frames < 0
                || end > manifest.duration_frames || !matches!(clip.kind.as_str(), "audio" | "gap")
            { return Err(AppError::invalid("Unsupported overlapping or out-of-range AAF clips")); }
            previous_end = end;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fractional_rate_mapping_is_rational_not_rounded_fps() {
        let rate = AafRate { numerator: 24000, denominator: 1001 };
        assert_eq!(frame_samples(24_000, &rate).unwrap(), 16_016_000);
        assert_eq!(frame_samples(146_759, &rate).unwrap(), 97_937_172);
        assert!(frame_samples(-1, &rate).is_err());
        assert!(frame_samples(1, &AafRate { numerator: 0, denominator: 1 }).is_err());
    }
}
