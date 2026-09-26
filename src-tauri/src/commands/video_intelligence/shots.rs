//! Validate streamed descriptions before exposing them, then reconcile the final batch.
use super::model::{VideoRequest, VideoShot, VideoShotAnalysis};
use crate::AppError;

pub(super) struct Collector {
    path: String, hash: String, analysis: String, model: String,
    requested: Vec<VideoShot>, updates: Vec<VideoShotAnalysis>,
}
impl Collector {
    pub(super) fn new(request: &VideoRequest) -> Option<Self> {
        let VideoRequest::AnalyzeShots { path, source_sha256, analysis_id, model_id, shots, .. } = request else { return None };
        Some(Self { path: path.clone(), hash: source_sha256.clone(), analysis: analysis_id.clone(),
            model: model_id.clone(), requested: shots.clone(), updates: Vec::new() })
    }
    pub(super) fn push(&mut self, update: &VideoShotAnalysis) -> Result<(u64, u64), AppError> {
        let invalid = || AppError::invalid("The worker returned an inconsistent shot update");
        let expected = self.requested.get(self.updates.len()).ok_or_else(invalid)?;
        if update.analysis_id != self.analysis || update.source.path != self.path || update.source.sha256 != self.hash
            || update.model_id != self.model || update.audio_analyzed || update.shots.len() != 1
            || update.model_revision.is_empty() || update.sampling_version.is_empty() { return Err(invalid()); }
        let shot = &update.shots[0];
        if shot.id != expected.id || shot.start_us != expected.start_us || shot.end_us != expected.end_us
            || shot.end_us > update.source.duration_us || shot.transcript != expected.transcript
            || shot.text.trim().is_empty() || shot.text.len() > 16000
            || shot.picture_description.as_deref() != Some(shot.text.as_str()) || shot.transcript_summary.is_some()
            || shot.frame_pts_us.is_empty() || shot.frame_pts_us.len() > 8
            || shot.frame_pts_us.iter().any(|pts| *pts < shot.start_us || *pts >= shot.end_us)
            || shot.frame_pts_us.windows(2).any(|pts| pts[0] >= pts[1]) { return Err(invalid()); }
        if let Some(first) = self.updates.first() {
            if binding(first)? != binding(update)? { return Err(invalid()); }
        }
        self.updates.push(update.clone());
        Ok((self.updates.len() as u64, self.requested.len() as u64))
    }
    pub(super) fn finish(&self, result: Option<&VideoShotAnalysis>) -> Result<(), AppError> {
        let invalid = || AppError::invalid("The final shot batch does not match its live updates");
        let result = result.ok_or_else(invalid)?;
        if self.updates.len() != self.requested.len() || result.shots.len() != self.updates.len() { return Err(invalid()); }
        for (update, shot) in self.updates.iter().zip(&result.shots) {
            if binding(update)? != binding(result)? || serde_json::to_value(&update.shots[0])? != serde_json::to_value(shot)? {
                return Err(invalid());
            }
        }
        Ok(())
    }
}
fn binding(value: &VideoShotAnalysis) -> Result<serde_json::Value, AppError> {
    let mut value = serde_json::to_value(value)?;
    value.as_object_mut().ok_or_else(|| AppError::internal("Invalid serialized shot binding"))?.remove("shots");
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::model::{VideoAnalysisSource, VideoShotAnswer};
    fn fixture() -> (Collector, VideoShotAnalysis) {
        let request = VideoRequest::AnalyzeShots { path: "/clip.mp4".into(), source_sha256: "a".repeat(64),
            analysis_id: "b".repeat(64), model_id: "qwen3.5-4b-video".into(), query: "Describe".into(),
            shots: vec![VideoShot { id: 1, start_us: 0, end_us: 1000, transcript: "".into() }] };
        let answer = VideoShotAnalysis { analysis_id: "b".repeat(64),
            source: VideoAnalysisSource { path: "/clip.mp4".into(), sha256: "a".repeat(64), origin_us: 400, duration_us: 1000 },
            model_id: "qwen3.5-4b-video".into(), model_revision: "revision".into(), sampling_version: "version".into(), audio_analyzed: false,
            shots: vec![VideoShotAnswer { id: 1, start_us: 0, end_us: 1000, transcript: "".into(), text: "Picture".into(),
                picture_description: Some("Picture".into()), transcript_summary: None, frame_pts_us: vec![0, 500] }] };
        (Collector::new(&request).unwrap(), answer)
    }
    #[test]
    fn accepts_once_and_reconciles_exact_final_result() {
        let (mut collector, result) = fixture();
        assert_eq!(collector.push(&result).unwrap(), (1, 1));
        assert!(collector.push(&result).is_err());
        assert!(collector.finish(Some(&result)).is_ok());
        let mut changed = result.clone(); changed.shots[0].text = "Different".into();
        assert!(collector.finish(Some(&changed)).is_err());
        changed = result; changed.source.origin_us += 1;
        assert!(collector.finish(Some(&changed)).is_err());
        assert!(collector.finish(None).is_err());
    }
    #[test]
    fn rejects_unrelated_invented_oversized_or_missing_results() {
        for mutation in 0..8 {
            let (mut collector, mut result) = fixture();
            match mutation {
                0 => result.source.sha256 = "c".repeat(64),
                1 => result.model_id = "other".into(),
                2 => result.shots[0].id = 2,
                3 => result.shots[0].end_us += 1,
                4 => result.shots[0].transcript = "Invented dialogue".into(),
                5 => result.shots[0].frame_pts_us = vec![1000],
                6 => result.shots[0].text = "x".repeat(16001),
                _ => result.audio_analyzed = true,
            }
            assert!(collector.push(&result).is_err());
            assert!(collector.finish(Some(&result)).is_err());
        }
    }
}
