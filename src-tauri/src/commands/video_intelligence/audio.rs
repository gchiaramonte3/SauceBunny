//! Validate source-bound audio evidence before adopting any streamed result.
use base64::{engine::general_purpose::STANDARD, Engine};
use super::model::*;
use crate::AppError;
use serde::Deserialize;
use std::collections::HashSet;

const CLASSIFIER: &str = "apple-soundanalysis-version1";
const PREPROCESSING: &str = "pcm48k-mono-3s-nonoverlap-v1";
const WINDOW_US: u64 = 3_000_000;
const WINDOW_SAMPLES: u64 = 48_000 * 3;
const MUSIC_CLASSIFIER: &str = "ast-audioset@f826b80d28226b62986cc218e5cec390b1096902";
const MUSIC_PREPROCESSING: &str = "pyav-swr16k-mono-10s-kaldi-ast-v1";
const MUSIC_WINDOW_US: u64 = 10_000_000;
const MUSIC_WINDOW_SAMPLES: u64 = 16_000 * 10;
const MUSIC_FRAME_US: u64 = 25_000; // One AST/Kaldi spectrogram frame.
const MUSIC_LABELS: usize = 527; // Pinned AudioSet checkpoint output dimension.

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Completion {
    analysis_id: String, source_sha256: String, origin_us: i64, duration_us: u64,
    audio_track_index: u32, classifier: String, os: String, preprocessing_version: String,
    status: VideoAudioStatus, windows: usize,
    #[serde(default)] maximum_retained_frames: u64,
    #[serde(default)] labels: Vec<String>,
}

pub struct Collector {
    analysis_id: String, source: VideoAnalysisSource, audio_track_index: u32,
    windows: Vec<VideoAudioWindow>, terminal: Option<Completion>,
    music_scores: Option<Vec<Vec<f32>>>,
}

fn invalid() -> AppError { AppError::invalid("The audio worker returned incomplete or mismatched source evidence") }

impl Collector {
    pub fn new(request: &VideoRequest) -> Option<Self> {
        let (VideoRequest::AnalyzeAudio { path, source_sha256, analysis_id, origin_us, duration_us, audio_track_index }
            | VideoRequest::AnalyzeMusic { path, source_sha256, analysis_id, origin_us, duration_us, audio_track_index }) = request else { return None };
        Some(Self { analysis_id: analysis_id.clone(), source: VideoAnalysisSource { path: path.clone(), sha256: source_sha256.clone(),
            origin_us: *origin_us, duration_us: *duration_us }, audio_track_index: *audio_track_index,
            windows: Vec::new(), terminal: None,
            music_scores: matches!(request, VideoRequest::AnalyzeMusic { .. }).then(Vec::new) })
    }

    /// Returns the last decoded source time for the existing progress channel.
    /// Window packets remain private until a matching terminal packet AND clean
    /// child exit. Stop/failure drops this entire collector, never a partial save.
    pub fn push(&mut self, mut packet: serde_json::Value) -> Result<(u64, u64), AppError> {
        if self.terminal.is_some() { return Err(invalid()); }
        let kind = packet.as_object_mut().ok_or_else(invalid)?.remove("type").ok_or_else(invalid)?;
        let music = self.music_scores.is_some();
        let max_window = if music { MUSIC_WINDOW_US } else { WINDOW_US };
        let min_classified = if music { MUSIC_FRAME_US } else { WINDOW_US };
        let max_samples = if music { MUSIC_WINDOW_SAMPLES } else { WINDOW_SAMPLES };
        match kind.as_str() {
            Some("window") => {
                let mut scores = Vec::new();
                if music {
                    let fields = packet.as_object_mut().ok_or_else(invalid)?;
                    if fields.contains_key("classifications") { return Err(invalid()); }
                    let encoded = fields.remove("scores_f32le").ok_or_else(invalid)?;
                    let encoded = encoded.as_str().ok_or_else(invalid)?;
                    if !encoded.is_empty() && encoded.len() != (MUSIC_LABELS * 4).div_ceil(3) * 4 { return Err(invalid()); }
                    let bytes = STANDARD.decode(encoded).map_err(|_| invalid())?;
                    if !bytes.is_empty() && bytes.len() != MUSIC_LABELS * 4 { return Err(invalid()); }
                    for chunk in bytes.as_chunks::<4>().0 {
                        let score = f32::from_le_bytes(*chunk);
                        if !score.is_finite() || !(0.0..=1.0).contains(&score) { return Err(invalid()); }
                        scores.push(score);
                    }
                    fields.insert("classifications".into(), serde_json::json!([]));
                }
                let row: VideoAudioWindow = serde_json::from_value(packet)?;
                let previous_end = self.windows.last().map_or(0, |row| row.end_us);
                // RMS sums up to WINDOW_SAMPLES squared values in f64. Permit
                // floating-point reduction error, not physically louder RMS.
                let rms_ceiling = row.peak * (1.0 + max_samples as f64 * f64::EPSILON);
                if row.start_us < previous_end || row.start_us >= row.end_us || row.end_us > self.source.duration_us
                    || !row.rms.is_finite() || !row.peak.is_finite() || row.rms < 0.0 || row.peak < 0.0 || rms_ceiling < row.rms {
                    return Err(invalid());
                }
                let classified = if music { scores.len() == MUSIC_LABELS } else { !row.classifications.is_empty() };
                let unclassified = row.classifications.is_empty() && scores.is_empty();
                let duration = row.end_us - row.start_us;
                let valid = match row.status {
                    VideoAudioWindowStatus::Classified => (min_classified..=max_window).contains(&duration)
                        && row.peak > 0.0 && row.rms > 0.0 && classified,
                    VideoAudioWindowStatus::DigitalSilence => row.peak == 0.0 && row.rms == 0.0
                        && unclassified && duration <= max_window,
                    VideoAudioWindowStatus::InsufficientContext => row.peak > 0.0 && row.rms > 0.0
                        && unclassified && duration < min_classified,
                };
                let mut labels = HashSet::new();
                if !valid || row.classifications.iter().any(|score| !score.score.is_finite() || !(0.0..=1.0).contains(&score.score)
                    || score.identifier.is_empty() || score.identifier.len() > 128
                    || !score.identifier.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
                    || !labels.insert(&score.identifier)) { return Err(invalid()); }
                self.windows.push(row);
                if let Some(windows) = self.music_scores.as_mut() { windows.push(scores); }
            },
            Some("complete") => {
                let terminal: Completion = serde_json::from_value(packet)?;
                if terminal.analysis_id != self.analysis_id || terminal.source_sha256 != self.source.sha256
                    || terminal.origin_us != self.source.origin_us || terminal.duration_us != self.source.duration_us
                    || terminal.audio_track_index != self.audio_track_index || terminal.classifier != if music { MUSIC_CLASSIFIER } else { CLASSIFIER }
                    || terminal.preprocessing_version != if music { MUSIC_PREPROCESSING } else { PREPROCESSING }
                    || terminal.os.trim().is_empty() || terminal.os.len() > 256
                    || terminal.windows != self.windows.len() || terminal.maximum_retained_frames > max_samples
                    || (terminal.status == VideoAudioStatus::NoAudio && !self.windows.is_empty()) {
                    return Err(invalid());
                }
                let has_classified = self.windows.iter().any(|row| row.status == VideoAudioWindowStatus::Classified);
                let mut labels = HashSet::new();
                if (music && has_classified && terminal.labels.len() != MUSIC_LABELS)
                    || ((!music || !has_classified) && !terminal.labels.is_empty())
                    || terminal.labels.iter().any(|label| label.trim().is_empty() || label.len() > 128
                        || label.chars().any(char::is_control) || !labels.insert(label)) { return Err(invalid()); }
                self.terminal = Some(terminal);
            },
            _ => return Err(invalid()),
        }
        Ok((self.windows.last().map_or(0, |row| row.end_us), self.source.duration_us))
    }

    pub fn finish(self) -> Result<VideoResponse, AppError> {
        let terminal = self.terminal.ok_or_else(invalid)?;
        if let Some(scores) = self.music_scores {
            let windows = self.windows.into_iter().zip(scores).map(|(row, scores)| VideoMusicWindow {
                start_us: row.start_us, end_us: row.end_us, rms: row.rms, peak: row.peak, status: row.status, scores }).collect();
            return Ok(VideoResponse { music_analysis: Some(VideoMusicAnalysis { analysis_id: self.analysis_id,
                source: self.source, audio_track_index: self.audio_track_index, classifier: terminal.classifier,
                os: terminal.os, preprocessing_version: terminal.preprocessing_version, status: terminal.status,
                labels: terminal.labels, windows }), ..Default::default() });
        }
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

    fn music_collector() -> Collector {
        Collector::new(&VideoRequest::AnalyzeMusic { path: "/fixture.mov".into(), source_sha256: "a".repeat(64),
            analysis_id: "b".repeat(64), origin_us: 3_000_000, duration_us: 8_000_000, audio_track_index: 1 }).unwrap()
    }
    fn music_window() -> Value {
        let mut packet = window();
        packet.as_object_mut().unwrap().remove("classifications");
        packet["scores_f32le"] = json!(STANDARD.encode([0.5_f32.to_le_bytes(); MUSIC_LABELS].concat()));
        packet
    }
    fn music_complete() -> Value {
        let mut packet = complete();
        packet["classifier"] = json!(MUSIC_CLASSIFIER); packet["preprocessing_version"] = json!(MUSIC_PREPROCESSING);
        packet["maximum_retained_frames"] = json!(MUSIC_WINDOW_SAMPLES);
        packet["labels"] = json!((0..MUSIC_LABELS).map(|index| format!("Audio label ({index})")).collect::<Vec<_>>());
        packet
    }
    #[test]
    fn music_preserves_every_float_and_vocabulary_without_repeating_labels() {
        let mut job = music_collector();
        job.push(music_window()).unwrap(); job.push(music_complete()).unwrap();
        assert!(job.push(music_window()).is_err());
        let response = job.finish().unwrap(); assert!(response.audio_analysis.is_none());
        let music = response.music_analysis.unwrap();
        assert_eq!(music.labels.len(), MUSIC_LABELS);
        assert_eq!(music.windows[0].scores, vec![0.5; MUSIC_LABELS]);
        assert_eq!((music.windows[0].start_us, music.windows[0].end_us), (1_000_000, 4_000_000));
        // One compact frame plus its metadata stays under 4 KiB. A 24-hour
        // contiguous source fits the existing 64 MiB pipe budget, with room
        // for progress and the one shared vocabulary (no evidence trimming).
        let window_bytes = serde_json::to_vec(&music_window()).unwrap().len();
        let completion_bytes = serde_json::to_vec(&music_complete()).unwrap().len();
        assert!(window_bytes < 4096);
        assert!(8640 * window_bytes + completion_bytes < 64 * 1024 * 1024);
    }
    #[test]
    fn music_rejects_malformed_vectors_ambiguous_labels_and_wrong_classifier() {
        for encoded in ["invalid".into(), STANDARD.encode([0u8; 4]),
            STANDARD.encode([f32::NAN.to_le_bytes(); MUSIC_LABELS].concat()),
            STANDARD.encode([1.1_f32.to_le_bytes(); MUSIC_LABELS].concat())] {
            let mut packet = music_window(); packet["scores_f32le"] = json!(encoded);
            assert!(music_collector().push(packet).is_err());
        }
        for (field, value) in [("labels",json!([])), ("labels",json!(vec!["duplicate"; MUSIC_LABELS])),
            ("classifier",json!(CLASSIFIER)), ("preprocessing_version",json!(PREPROCESSING)),
            ("maximum_retained_frames",json!(MUSIC_WINDOW_SAMPLES + 1))] {
            let mut job = music_collector(); job.push(music_window()).unwrap();
            let mut done = music_complete(); done[field] = value;
            assert!(job.push(done).is_err());
        }
        let mut packet = music_window(); packet["classifications"] = json!([]);
        assert!(music_collector().push(packet).is_err());
    }
    #[test]
    fn music_requires_completion_and_preserves_short_context_and_silence() {
        let mut job = music_collector(); job.push(music_window()).unwrap(); assert!(job.finish().is_err());
        for (status, duration, peak) in [("insufficient-context",24_999,0.3),("digital-silence",3_000_000,0.0)] {
            let mut job = music_collector(); let mut packet = music_window();
            packet["end_us"] = json!(1_000_000 + duration); packet["status"] = json!(status);
            packet["scores_f32le"] = json!(""); packet["peak"] = json!(peak); packet["rms"] = json!(peak);
            job.push(packet).unwrap(); let mut done = music_complete(); done["labels"] = json!([]);
            job.push(done).unwrap(); assert!(job.finish().unwrap().music_analysis.unwrap().windows[0].scores.is_empty());
        }
    }

    #[test]
    #[ignore = "requires the real worker report from scripts/music-analysis/verify_worker.py"]
    fn real_music_worker_protocol_is_adopted_only_after_complete() {
        let path = std::env::var("SAUCE_MUSIC_WORKER_REPORT").expect("Set SAUCE_MUSIC_WORKER_REPORT");
        let report: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        assert_eq!(report["schema"], "sauce.music-worker-smoke.v1");
        assert_eq!(report["network"], "sandbox-denied");
        let request: VideoRequest = serde_json::from_value(report["request"].clone()).unwrap();
        request.validate().unwrap();
        for kind in ["completed", "restarted"] {
            assert_eq!(report[kind]["exit_code"], 0);
            let mut job = Collector::new(&request).unwrap();
            for packet in report[kind]["packets"].as_array().unwrap() {
                if packet["type"] == "progress" { continue; }
                job.push(packet.clone()).unwrap();
            }
            let evidence = job.finish().unwrap().music_analysis.unwrap();
            assert_eq!(evidence.labels.len(), MUSIC_LABELS);
            assert_eq!(evidence.windows.iter().map(|w| (w.start_us, w.end_us)).collect::<Vec<_>>(),
                [(0, 10_000_000), (10_000_000, 20_000_000), (20_000_000, 23_500_000)]);
            assert!(evidence.windows.iter().all(|w| w.scores.len() == MUSIC_LABELS));
        }
        for stopped in report["stopped"].as_object().unwrap().values() {
            assert_ne!(stopped["exit_code"], 0);
            let mut job = Collector::new(&request).unwrap();
            for packet in stopped["packets"].as_array().unwrap() {
                if packet["type"] == "progress" { continue; }
                job.push(packet.clone()).unwrap();
            }
            assert!(job.finish().is_err(), "Stop must not adopt partial evidence");
        }
    }
}
