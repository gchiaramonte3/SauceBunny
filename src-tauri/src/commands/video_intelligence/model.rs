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
}
impl VideoRequest {
    pub fn read_only(&self) -> bool { matches!(self, Self::Models {} | Self::Sources {}) }
    pub fn heavy(&self) -> bool { matches!(self, Self::Index { .. } | Self::Search { .. } | Self::Reason { .. }) }
    pub fn validate(&self) -> Result<(), crate::AppError> {
        let valid_query = |q: &str| !q.trim().is_empty() && q.chars().count() <= 1000;
        let valid_key = |key: &str| key.len() == 64 && key.bytes().all(|b| b.is_ascii_hexdigit());
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
        };
        if valid { Ok(()) } else { Err(crate::AppError::invalid("Invalid Video Intelligence request")) }
    }
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
}
