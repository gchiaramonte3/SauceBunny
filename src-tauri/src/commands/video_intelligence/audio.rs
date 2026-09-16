//! Validate the optional native audio worker before adopting any streamed result.
use super::model::*;
use crate::AppError;
use serde::Deserialize;
use std::collections::HashSet;

const CLASSIFIER: &str = "apple-soundanalysis-version1";
const PREPROCESSING: &str = "pcm48k-mono-3s-nonoverlap-v1";
const WINDOW_US: u64 = 3_000_000;
const WINDOW_SAMPLES: u64 = 48_000 * 3;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Completion {
    analysis_id: String, source_sha256: String, origin_us: i64, duration_us: u64,
    audio_track_index: u32, classifier: String, os: String, preprocessing_version: String,
    status: VideoAudioStatus, windows: usize,
    #[serde(default)] maximum_retained_frames: u64,
}

pub struct Collector {
    analysis_id: String, source: VideoAnalysisSource, audio_track_index: u32,
    windows: Vec<VideoAudioWindow>, terminal: Option<Completion>,
}

fn invalid() -> AppError { AppError::invalid("The audio worker returned incomplete or mismatched source evidence") }

impl Collector {
    pub fn new(request: &VideoRequest) -> Option<Self> {
        let VideoRequest::AnalyzeAudio { path, source_sha256, analysis_id, origin_us, duration_us, audio_track_index } = request else { return None };
        Some(Self { analysis_id: analysis_id.clone(), source: VideoAnalysisSource { path: path.clone(), sha256: source_sha256.clone(),
            origin_us: *origin_us, duration_us: *duration_us }, audio_track_index: *audio_track_index,
            windows: Vec::new(), terminal: None })
    }

    /// Returns the last decoded source time for the existing progress channel.
    /// Window packets remain private until a matching terminal packet AND clean
    /// child exit. Stop/failure drops this entire collector, never a partial save.
    pub fn push(&mut self, mut packet: serde_json::Value) -> Result<(u64, u64), AppError> {
        if self.terminal.is_some() { return Err(invalid()); }
        let kind = packet.as_object_mut().ok_or_else(invalid)?.remove("type").ok_or_else(invalid)?;
        match kind.as_str() {
            Some("window") => {
                let row: VideoAudioWindow = serde_json::from_value(packet)?;
                let previous_end = self.windows.last().map_or(0, |row| row.end_us);
                // RMS sums up to WINDOW_SAMPLES squared values in f64. Permit
                // floating-point reduction error, not physically louder RMS.
                let rms_ceiling = row.peak * (1.0 + WINDOW_SAMPLES as f64 * f64::EPSILON);
                if row.start_us < previous_end || row.start_us >= row.end_us || row.end_us > self.source.duration_us
                    || !row.rms.is_finite() || !row.peak.is_finite() || row.rms < 0.0 || row.peak < 0.0 || rms_ceiling < row.rms {
                    return Err(invalid());
                }
                let valid = match row.status {
                    VideoAudioWindowStatus::Classified => row.end_us - row.start_us == WINDOW_US
                        && row.peak > 0.0 && row.rms > 0.0 && !row.classifications.is_empty(),
                    VideoAudioWindowStatus::DigitalSilence => row.peak == 0.0 && row.rms == 0.0
                        && row.classifications.is_empty() && row.end_us - row.start_us <= WINDOW_US,
                    VideoAudioWindowStatus::InsufficientContext => row.peak > 0.0 && row.rms > 0.0
                        && row.classifications.is_empty() && row.end_us - row.start_us < WINDOW_US,
                };
                let mut labels = HashSet::new();
                if !valid || row.classifications.iter().any(|score| !score.score.is_finite() || !(0.0..=1.0).contains(&score.score)
                    || score.identifier.is_empty() || score.identifier.len() > 128
                    || !score.identifier.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
                    || !labels.insert(&score.identifier)) { return Err(invalid()); }
                self.windows.push(row);
            },
            Some("complete") => {
                let terminal: Completion = serde_json::from_value(packet)?;
                if terminal.analysis_id != self.analysis_id || terminal.source_sha256 != self.source.sha256
                    || terminal.origin_us != self.source.origin_us || terminal.duration_us != self.source.duration_us
                    || terminal.audio_track_index != self.audio_track_index || terminal.classifier != CLASSIFIER
                    || terminal.preprocessing_version != PREPROCESSING || terminal.os.trim().is_empty() || terminal.os.len() > 256
                    || terminal.windows != self.windows.len() || terminal.maximum_retained_frames > WINDOW_SAMPLES
                    || (terminal.status == VideoAudioStatus::NoAudio && !self.windows.is_empty()) {
                    return Err(invalid());
                }
                self.terminal = Some(terminal);
            },
            _ => return Err(invalid()),
        }
        Ok((self.windows.last().map_or(0, |row| row.end_us), self.source.duration_us))
    }

    pub fn finish(self) -> Result<VideoResponse, AppError> {
        let terminal = self.terminal.ok_or_else(invalid)?;
        Ok(VideoResponse { audio_analysis: Some(VideoAudioAnalysis { analysis_id: self.analysis_id,
            source: self.source, audio_track_index: self.audio_track_index, classifier: terminal.classifier,
            os: terminal.os, preprocessing_version: terminal.preprocessing_version, status: terminal.status,
            windows: self.windows }), ..Default::default() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    fn collector() -> Collector {
        Collector::new(&VideoRequest::AnalyzeAudio { path: "/fixture.mov".into(), source_sha256: "a".repeat(64),
            analysis_id: "b".repeat(64), origin_us: 3_000_000, duration_us: 8_000_000, audio_track_index: 1 }).unwrap()
    }
    fn window() -> Value { json!({"type":"window", "start_us":1_000_000,"end_us":4_000_000,
        "rms":0.1,"peak":0.3,"status":"classified","classifications":[{"identifier":"music","score":0.8}]}) }
    fn complete() -> Value { json!({"type":"complete", "analysis_id":"b".repeat(64),"source_sha256":"a".repeat(64),
        "origin_us":3_000_000,"duration_us":8_000_000,"audio_track_index":1,"classifier":CLASSIFIER,
        "os":"test-os","preprocessing_version":PREPROCESSING,"status":"decoded","windows":1,"maximum_retained_frames":WINDOW_SAMPLES}) }
    #[test]
    fn partial_evidence_is_never_an_adoptable_result() {
        let mut job = collector(); job.push(window()).unwrap(); assert!(job.finish().is_err());
    }
    #[test]
    fn exact_source_identity_and_eof_count_are_required() {
        for (key, value) in [("analysis_id",json!("c".repeat(64))), ("source_sha256",json!("c".repeat(64))),
            ("origin_us",json!(0)), ("duration_us",json!(9_000_000)), ("audio_track_index",json!(0)),
            ("classifier",json!("other")), ("preprocessing_version",json!("other")), ("windows",json!(0)),
            ("maximum_retained_frames",json!(WINDOW_SAMPLES + 1)), ("status",json!("no-audio"))] {
            let mut job = collector(); job.push(window()).unwrap(); let mut packet = complete(); packet[key] = value;
            assert!(job.push(packet).is_err(), "{key}");
        }
    }
    #[test]
    fn ordered_ranges_preserve_gaps_and_no_packet_may_follow_completion() {
        let mut job = collector(); job.push(window()).unwrap();
        let mut tail = window(); tail["start_us"] = json!(6_000_000); tail["end_us"] = json!(7_000_000);
        tail["status"] = json!("insufficient-context"); tail["classifications"] = json!([]);
        job.push(tail).unwrap(); let mut done = complete(); done["windows"] = json!(2);
        job.push(done).unwrap(); assert!(job.push(window()).is_err());
        let result = job.finish().unwrap().audio_analysis.unwrap();
        assert_eq!(result.windows.len(), 2); assert_eq!(result.windows[1].start_us, 6_000_000);
    }
    #[test]
    fn rejects_overlap_bad_scores_and_fabricated_coverage() {
        let mut job = collector(); job.push(window()).unwrap(); assert!(job.push(window()).is_err());
        for (key, value) in [("end_us",json!(9_000_000)),("start_us",json!(-1)),("rms",json!(-0.1)),
            ("peak",json!(0.01)),("status",json!("digital-silence")),("classifications",json!([]))] {
            let mut packet = window(); packet[key] = value; assert!(collector().push(packet).is_err(), "{key}");
        }
        for scores in [json!([{"identifier":"music","score":1.1}]), json!([{"identifier":"music","score":0.1},{"identifier":"music","score":0.2}])] {
            let mut packet = window(); packet["classifications"] = scores; assert!(collector().push(packet).is_err());
        }
    }
    #[test]
    fn no_audio_is_distinct_from_classified_silence() {
        let mut job = collector(); let mut done = complete(); done["windows"] = json!(0); done["status"] = json!("no-audio");
        job.push(done).unwrap(); assert_eq!(job.finish().unwrap().audio_analysis.unwrap().status, VideoAudioStatus::NoAudio);
        let mut packet = window(); packet["status"] = json!("digital-silence"); packet["rms"] = json!(0); packet["peak"] = json!(0); packet["classifications"] = json!([]);
        assert!(collector().push(packet).is_ok());
    }
}
