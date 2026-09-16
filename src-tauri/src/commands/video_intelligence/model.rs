use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(tag = "operation", rename_all = "kebab-case")]
#[serde(deny_unknown_fields)]
#[ts(export, export_to = "../../src/bindings/")]
pub enum VideoRequest {
    Models {},
    Download { model_id: String },
    DeleteModel { model_id: String },
    Sources {},
    Forget { source_key: String },
    Index { paths: Vec<String> },
    Search { query: String, scope: Vec<String>, rerank: bool },
    Reason { query: String, segments: Vec<u32>, transcripts: std::collections::HashMap<String, String> },
    InspectVideo { path: String },
    PrepareShotProxy { path: String },
    AnalyzeShots { path: String, source_sha256: String, analysis_id: String, query: String, shots: Vec<VideoShot> },
    AnalyzeAudio { path: String, source_sha256: String, analysis_id: String,
        #[ts(type = "number")] origin_us: i64, #[ts(type = "number")] duration_us: u64, audio_track_index: u32 },
}
impl VideoRequest {
    pub fn read_only(&self) -> bool { matches!(self, Self::Models {} | Self::Sources {}) }
    pub fn reasoning(&self) -> bool { matches!(self, Self::Reason { .. } | Self::AnalyzeShots { .. }) }
    pub fn native_audio(&self) -> bool { matches!(self, Self::AnalyzeAudio { .. }) }
    pub fn heavy(&self) -> bool { self.reasoning() || self.native_audio() || matches!(self, Self::Index { .. } | Self::Search { .. } | Self::PrepareShotProxy { .. }) }
    pub fn saved_work_note(&self) -> &'static str {
        if matches!(self, Self::Index { .. }) { " Completed index segments are saved." } else { "" }
    }
    pub fn validate(&self) -> Result<(), crate::AppError> {
        let valid_query = |q: &str| !q.trim().is_empty() && q.chars().count() <= 1000;
        let valid_key = |key: &str| key.len() == 64 && key.bytes().all(|b| b.is_ascii_hexdigit());
        let valid_path = |path: &str| path.len() <= 4096 && std::path::Path::new(path).is_absolute()
            && std::path::Path::new(path).is_file();
        let valid = match self {
            Self::Models {} | Self::Sources {} => true,
            Self::Download { model_id } | Self::DeleteModel { model_id } => matches!(model_id.as_str(),
                "qwen3-vl-embedding-2b" | "qwen3-vl-reranker-2b" | "qwen3.5-9b-video"),
            Self::Forget { source_key } => valid_key(source_key),
            Self::Index { paths } => !paths.is_empty() && paths.len() <= 2000 && paths.iter().all(|path|
                path.len() <= 4096 && std::path::Path::new(path).is_absolute() && std::path::Path::new(path).is_file()),
            Self::Search { query, scope, .. } => valid_query(query) && !scope.is_empty()
                && scope.len() <= 2000 && scope.iter().all(|key| valid_key(key)),
            Self::Reason { query, segments, transcripts } => valid_query(query) && !segments.is_empty()
                && segments.len() <= 4 && segments.iter().all(|id| *id > 0)
                && transcripts.len() <= 4 && transcripts.values().all(|text| text.len() <= 12000),
            Self::InspectVideo { path } | Self::PrepareShotProxy { path } => valid_path(path),
            Self::AnalyzeShots { path, source_sha256, analysis_id, query, shots } => valid_path(path)
                && valid_key(source_sha256) && !source_sha256.bytes().any(|b| b.is_ascii_uppercase())
                && valid_key(analysis_id) && !analysis_id.bytes().any(|b| b.is_ascii_uppercase())
                && valid_query(query) && valid_shots(shots),
            Self::AnalyzeAudio { path, source_sha256, analysis_id, origin_us, duration_us, .. } => valid_path(path)
                && valid_key(source_sha256) && !source_sha256.bytes().any(|b| b.is_ascii_uppercase())
                && valid_key(analysis_id) && !analysis_id.bytes().any(|b| b.is_ascii_uppercase())
                && (1..=MAX_SHOT_TIME_US).contains(duration_us) && origin_us.checked_add(*duration_us as i64).is_some(),
        };
        if valid { Ok(()) } else { Err(crate::AppError::invalid("Invalid Video Intelligence request")) }
    }
}

const MAX_SHOTS_PER_REQUEST: usize = 64;
const MAX_SHOT_TIME_US: u64 = 24 * 3600 * 1_000_000;

/// Boundaries are supplied by the scene detector in source-relative time.
/// The video model may describe them, never generate or reposition them.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct VideoShot {
    pub id: u32,
    #[ts(type = "number")] pub start_us: u64,
    #[ts(type = "number")] pub end_us: u64,
    pub transcript: String,
}

fn valid_shots(shots: &[VideoShot]) -> bool {
    if shots.is_empty() || shots.len() > MAX_SHOTS_PER_REQUEST { return false; }
    let mut ids = std::collections::HashSet::new();
    let mut previous_end = 0;
    shots.iter().all(|shot| {
        let valid = shot.id > 0 && ids.insert(shot.id) && shot.start_us >= previous_end
            && shot.start_us < shot.end_us && shot.end_us <= MAX_SHOT_TIME_US && shot.transcript.len() <= 12000;
        previous_end = shot.end_us;
        valid
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct VideoAnalysisSource {
    pub path: String, pub sha256: String,
    #[ts(type = "number")] pub duration_us: u64,
    #[ts(type = "number")] pub origin_us: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct VideoProxyTimeSpan {
    #[ts(type = "number")] pub analysis_start_us: u64,
    #[ts(type = "number")] pub analysis_end_us: u64,
    #[ts(type = "number")] pub source_start_us: u64,
    #[ts(type = "number")] pub source_end_us: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct VideoSceneProxy {
    pub schema_version: String, pub proxy_version: String, pub time_map_version: String,
    pub source: VideoAnalysisSource, pub path: String, pub sha256: String,
    #[ts(type = "number")] pub frame_count: u64,
    pub pts_sha256: String, pub time_map: Vec<VideoProxyTimeSpan>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct VideoShotAnswer {
    pub id: u32,
    #[ts(type = "number")] pub start_us: u64,
    #[ts(type = "number")] pub end_us: u64,
    #[ts(type = "number[]")] pub frame_pts_us: Vec<u64>,
    pub transcript: String, pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct VideoShotAnalysis {
    pub analysis_id: String, pub source: VideoAnalysisSource,
    pub model_id: String, pub model_revision: String, pub sampling_version: String,
    pub audio_analyzed: bool, pub shots: Vec<VideoShotAnswer>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum VideoAudioWindowStatus { Classified, DigitalSilence, InsufficientContext }

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct VideoAudioScore { pub identifier: String, pub score: f64 }

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(deny_unknown_fields)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct VideoAudioWindow {
    #[ts(type = "number")] pub start_us: u64,
    #[ts(type = "number")] pub end_us: u64,
    pub rms: f64, pub peak: f64, pub status: VideoAudioWindowStatus,
    pub classifications: Vec<VideoAudioScore>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS, PartialEq)]
#[serde(rename_all = "kebab-case")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum VideoAudioStatus { NoAudio, Decoded }

/// Raw actual-audio evidence, not a calibrated genre or music-presence verdict.
/// Missing ranges and insufficient-context tails remain visibly unclassified.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct VideoAudioAnalysis {
    pub analysis_id: String, pub source: VideoAnalysisSource, pub audio_track_index: u32,
    pub classifier: String, pub os: String, pub preprocessing_version: String,
    pub status: VideoAudioStatus, pub windows: Vec<VideoAudioWindow>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct VideoModel {
    pub id: String, pub name: String, pub role: String,
    #[ts(type = "number")] pub bytes: u64,
    pub ready: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct VideoSource {
    pub key: String, pub path: String, pub duration: f64, pub model: String,
    pub complete: u8, pub available: bool, pub segments: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct VideoHit {
    pub id: u32, pub source_key: String, pub path: String, pub start: f64,
    pub end: f64, pub frames: Vec<f64>, pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct VideoAnswer {
    pub id: u32, pub path: String, pub start: f64, pub end: f64, pub text: String,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct VideoResponse {
    #[serde(default)] pub models: Vec<VideoModel>,
    #[serde(default)] pub sources: Vec<VideoSource>,
    #[serde(default)] pub hits: Vec<VideoHit>,
    #[serde(default)] pub answers: Vec<VideoAnswer>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)] pub analysis_source: Option<VideoAnalysisSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)] pub shot_analysis: Option<VideoShotAnalysis>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)] pub scene_proxy: Option<VideoSceneProxy>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)] pub audio_analysis: Option<VideoAudioAnalysis>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct VideoProgress {
    pub job_id: String, pub phase: String,
    #[ts(type = "number")] pub completed: u64,
    #[ts(type = "number")] pub total: u64,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_scope_bypass_and_unknown_models() {
        assert!(VideoRequest::Search { query: "red car".into(), scope: vec![], rerank: false }.validate().is_err());
        assert!(VideoRequest::Download { model_id: "../../outside".into() }.validate().is_err());
        assert!(VideoRequest::Index { paths: vec!["https://example.com/movie.mp4".into()] }.validate().is_err());
        assert!(serde_json::from_str::<VideoRequest>(r#"{"operation":"models","memory_bytes":999}"#).is_err());
    }
    #[test]
    fn accepts_only_explicit_bounded_analysis() {
        assert!(VideoRequest::Search { query: "red car".into(), scope: vec!["a".repeat(64)], rerank: true }.validate().is_ok());
        assert!(VideoRequest::Reason { query: "What happens?".into(), segments: vec![1,2,3,4,5], transcripts: Default::default() }.validate().is_err());
    }
    #[test]
    fn shot_ranges_preserve_integer_time_and_reject_ambiguous_evidence() {
        let shot = VideoShot { id: 1, start_us: 10, end_us: 41718, transcript: String::new() };
        assert!(valid_shots(std::slice::from_ref(&shot)));
        assert!(!valid_shots(&[]));
        assert!(!valid_shots(&vec![shot.clone(); 65]));
        assert!(!valid_shots(&[shot.clone(), VideoShot { id: 2, start_us: 40000, ..shot.clone() }]));
        assert!(!valid_shots(&[shot.clone(), VideoShot { start_us: 41718, end_us: 83426, ..shot.clone() }]));
        assert!(!valid_shots(&[VideoShot { end_us: MAX_SHOT_TIME_US + 1, ..shot.clone() }]));
        assert!(!valid_shots(&[VideoShot { transcript: "é".repeat(6001), ..shot.clone() }]));
        assert!(serde_json::from_str::<VideoShot>(r#"{"id":1,"start_us":0.5,"end_us":2,"transcript":""}"#).is_err());
        assert!(serde_json::from_str::<VideoShot>(r#"{"id":1,"start_us":0,"end_us":2,"transcript":"","path":"other"}"#).is_err());
    }
    #[test]
    fn shot_analysis_uses_reasoning_budget_and_never_claims_unsaved_work_is_saved() {
        let request = VideoRequest::AnalyzeShots { path: "/not-a-video".into(), source_sha256: "a".repeat(64),
            analysis_id: "b".repeat(64), query: "Describe this shot".into(),
            shots: vec![VideoShot { id: 1, start_us: 0, end_us: 1, transcript: String::new() }] };
        assert!(request.heavy() && request.reasoning() && !request.read_only());
        assert_eq!(request.saved_work_note(), "");
        assert!(request.validate().is_err());
        assert!(!VideoRequest::InspectVideo { path: "/not-a-video".into() }.heavy());
    }
}
