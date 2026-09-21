//! ASR-only chunks. Track ownership is metadata, not diarization or proof of speech identity.
use super::{audio, model::*, process, store};
use crate::{commands::JobRegistry, AppError};
use std::path::Path;
use tauri::{AppHandle, Manager};

struct EngineConfig { engine: AafEngine, model_id: String, model_path: String, language: String, fast: bool }

fn engine_config(app: &AppHandle, engine: AafEngine, model_id: &str, language: &str, fast: bool) -> Result<EngineConfig, AppError> {
    let language = language.trim().to_ascii_lowercase();
    if language != "auto" && (!(2..=8).contains(&language.len()) || !language.bytes().all(|b| b.is_ascii_alphabetic())) {
        return Err(AppError::invalid("Choose a valid transcription language"));
    }
    let (model_id, model_path) = match engine {
        AafEngine::Whisper => {
            let model = crate::commands::transcript::list_whisper_models(app.clone())?.into_iter()
                .find(|model| model.id == model_id && model.downloaded)
                .ok_or_else(|| AppError::not_found("Download the selected Whisper model in Settings before transcribing"))?;
            (model.id, model.path.ok_or_else(|| AppError::not_found("Whisper model path is unavailable"))?)
        }
        AafEngine::Parakeet => {
            if !crate::commands::transcript::parakeet_model_downloaded(app.clone()) {
                return Err(AppError::not_found("Download Parakeet in Settings before transcribing"));
            }
            let models = app.path().app_data_dir().map_err(|e| AppError::internal(e.to_string()))?.join("models").join("parakeet");
            ("parakeet-tdt-0.6b-v3".into(), models.to_string_lossy().into_owned())
        }
    };
    Ok(EngineConfig { engine, model_id, model_path, language, fast })
}

#[derive(Debug)]
pub struct Chunk { pub start: i64, pub end: i64, pub extract_start: i64, pub extract_end: i64 }

pub fn chunks(duration: i64, rate: &AafRate) -> Result<Vec<Chunk>, AppError> {
    frame_samples(duration, rate)?;
    if duration <= 0 { return Err(AppError::invalid("Cannot transcribe an empty AAF sequence")); }
    let span = ((u64::from(rate.numerator) * 120) / u64::from(rate.denominator)).max(1) as i64;
    let context = u64::from(rate.numerator).div_ceil(u64::from(rate.denominator)) as i64;
    let mut result = Vec::new();
    let mut start = 0;
    while start < duration {
        let end = (start + span).min(duration);
        result.push(Chunk { start, end, extract_start: (start - context).max(0), extract_end: (end + context).min(duration) });
        start = end;
    }
    Ok(result)
}

/// Empty output is a recognizer result, not proof of silence. Exit code alone
/// is deliberately insufficient: Parakeet uses 3 for both empty and decoder errors.
pub fn output_text(engine: &AafEngine, code: Option<i32>, stderr: &str, srt: Option<String>) -> Result<String, AppError> {
    let lower = stderr.to_ascii_lowercase();
    let input_error = ["failed to read audio", "failed to open", "could not open", "error: failed", "error opening", "audio-open", "unsupported audio"]
        .iter().any(|needle| lower.contains(needle));
    if input_error {
        return Err(AppError::invalid("The speech engine could not decode its prepared audio"));
    }
    let explicit_empty = matches!(engine, AafEngine::Parakeet) && code == Some(3)
        && stderr.lines().any(|line| line.trim() == "error: Parakeet produced no transcript (no token timings)");
    if explicit_empty { return Ok(String::new()); }
    if code != Some(0) {
        return Err(AppError::SidecarFailed { name: match engine { AafEngine::Whisper => "whisper-cli", AafEngine::Parakeet => "saucebunny-diarize --asr" }.into(),
            exit_code: code, tail: crate::commands::truncate_utf8_bytes(stderr.trim(), 2_000).into() });
    }
    srt.ok_or_else(|| AppError::invalid("Speech engine exited without producing a transcript file"))
}

fn timestamp_samples(value: &str) -> Result<i64, AppError> {
    let parts: Vec<_> = value.trim().split([':', ',']).collect();
    if parts.len() != 4 { return Err(AppError::invalid("Invalid speech cue timestamp")); }
    let parsed: Vec<i64> = parts.iter().map(|part| part.parse::<i64>())
        .collect::<Result<_, _>>().map_err(|_| AppError::invalid("Invalid speech cue timestamp"))?;
    if parsed[0] < 0 || !(0..60).contains(&parsed[1]) || !(0..60).contains(&parsed[2]) || !(0..1000).contains(&parsed[3]) {
        return Err(AppError::invalid("Speech cue timestamp is out of range"));
    }
    parsed[0].checked_mul(3_600_000).and_then(|v| v.checked_add(parsed[1] * 60_000 + parsed[2] * 1_000 + parsed[3]))
        .and_then(|v| v.checked_mul(16)).ok_or_else(|| AppError::invalid("Speech cue timestamp overflow"))
}

pub struct ParsedCues { pub cues: Vec<AafCue>, pub timing_issues: Vec<AafTimingIssue> }

fn cue_range(start: &str, end: &str, available: i64) -> Result<(i64, i64), String> {
    let start = timestamp_samples(start).map_err(|e| e.to_string())?;
    let end = timestamp_samples(end).map_err(|e| e.to_string())?;
    if end <= start { return Err("The engine returned an empty or reversed time range.".into()); }
    if start >= available || end > available + ASR_RATE / 4 {
        return Err("The engine returned a time outside the audio segment it received.".into());
    }
    Ok((start, end.min(available)))
}

pub fn parse_cues(text: &str, chunk: &Chunk, rate: &AafRate, track: &str) -> Result<ParsedCues, AppError> {
    let text = text.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    if text.trim().is_empty() { return Ok(ParsedCues { cues: Vec::new(), timing_issues: Vec::new() }); }
    let offset = frame_samples(chunk.extract_start, rate)?;
    let available = frame_samples(chunk.extract_end - chunk.extract_start, rate)?;
    let owner_start = frame_samples(chunk.start, rate)?;
    let owner_end = frame_samples(chunk.end, rate)?;
    let mut cues = Vec::new();
    let mut timing_issues = Vec::new();
    for (index, block) in text.split("\n\n").filter(|block| !block.trim().is_empty()).enumerate() {
        let mut lines = block.trim().lines();
        let first = lines.next().ok_or_else(|| AppError::invalid("Invalid speech cue"))?;
        let timing = if first.contains("-->") { first } else { lines.next().ok_or_else(|| AppError::invalid("Speech cue has no timestamp"))? };
        let (start, end) = timing.split_once("-->").ok_or_else(|| AppError::invalid("Speech cue has no timestamp"))?;
        let text = lines.collect::<Vec<_>>().join(" ").trim().to_owned();
        if text.is_empty() { continue; }
        let (start, end) = match cue_range(start, end, available) {
            Ok(range) => range,
            Err(reason) => {
                timing_issues.push(AafTimingIssue { id: format!("{track}-{}-{index}", chunk.start), text,
                    reported_timing: timing.trim().into(), chunk_start_frame: chunk.extract_start, reason });
                continue;
            }
        };
        let absolute_start = offset + start;
        let absolute_end = offset + end;
        // Engines may segment the same boundary phrase differently in adjacent
        // chunks. Midpoint ownership can discard BOTH versions. Preserve an
        // intersecting cue and flag it, rather than silently deleting words.
        if absolute_end <= owner_start || absolute_start >= owner_end { continue; }
        cues.push(AafCue { id: format!("{track}-{}-{index}", chunk.start),
            start_sample: absolute_start, end_sample: absolute_end, text,
            boundary_review: absolute_start < owner_start || absolute_end > owner_end });
    }
    Ok(ParsedCues { cues, timing_issues })
}

async fn run_chunk(app: &AppHandle, job: &str, config: &EngineConfig, wav: &Path, output: &Path) -> Result<String, AppError> {
    let (name, args) = match config.engine {
        AafEngine::Whisper => ("whisper-cli", crate::commands::transcript::whisper_cli_args(
            &config.model_path, &wav.to_string_lossy(), &output.to_string_lossy(), &config.language, None, config.fast)),
        AafEngine::Parakeet => ("saucebunny-diarize", vec!["--asr".into(), "--input".into(), wav.to_string_lossy().into_owned(),
            "--output".into(), output.with_extension("srt").to_string_lossy().into_owned(),
            "--models-dir".into(), config.model_path.clone(), "--emit-progress".into()]),
    };
    let result = process::run(app, job, "asr", name, args).await?;
    let path = output.with_extension("srt");
    let text = if path.is_file() {
        if std::fs::metadata(&path)?.len() > 8 * 1024 * 1024 { return Err(AppError::invalid("Speech output exceeded its safety limit")); }
        Some(std::fs::read_to_string(path)?)
    } else { None };
    output_text(&config.engine, result.code, &result.stderr, text)
}

#[allow(clippy::too_many_arguments)]
pub async fn transcribe(app: &AppHandle, document: &AafDocument, track: &str, start: i64, duration: i64,
    engine: AafEngine, model_id: &str, language: &str, fast: bool, job: &str) -> Result<AafTrackTranscript, AppError>
{
    let lane = store::track(document, track)?;
    store::source_ready(document)?;
    let end = start.checked_add(duration).ok_or_else(|| AppError::invalid("AAF transcription range overflow"))?;
    if start < 0 || duration <= 0 || end > document.manifest.duration_frames {
        return Err(AppError::invalid("Choose a transcription range within the sequence"));
    }
    let config = engine_config(app, engine, model_id, language, fast)?;
    let chunks = chunks(duration, &document.manifest.edit_rate)?;
    let mut cues = Vec::new();
    let mut timing_issues = Vec::new();
    for relative in chunks {
        let chunk = Chunk { start: relative.start + start, end: relative.end + start,
            extract_start: relative.extract_start + start, extract_end: relative.extract_end + start };
        process::check_cancelled(app, job)?;
        // Gaps can be skipped without ever asking a model to invent speech in them.
        if !lane.clips.iter().any(|clip| clip.kind == "audio" && clip.start_frame < chunk.extract_end && clip.start_frame + clip.duration_frames > chunk.extract_start) { continue; }
        let work = audio::WorkDir::new(app, job)?;
        process::progress(app, job, Some(track), "preparing-audio", chunk.start - start, duration);
        let (wav, info) = audio::extract_16k(app, document, track, chunk.extract_start,
            chunk.extract_end - chunk.extract_start, job, &work.0).await?;
        if !info.digital_silence {
            process::progress(app, job, Some(track), "transcribing", chunk.start - start, duration);
            let text = run_chunk(app, job, &config, &wav, &work.0.join("transcript")).await?;
            process::check_cancelled(app, job)?;
            let parsed = parse_cues(&text, &chunk, &document.manifest.edit_rate, track)?;
            cues.extend(parsed.cues);
            timing_issues.extend(parsed.timing_issues);
        }
        process::progress(app, job, Some(track), "transcribing", chunk.end - start, duration);
    }
    cues.sort_by_key(|cue| (cue.start_sample, cue.end_sample));
    store::source_ready(document)?;
    let transcript = AafTrackTranscript { track_id: track.into(), start_frame: start, duration_frames: duration, engine: config.engine,
        model_id: config.model_id, status: if !timing_issues.is_empty() { AafTranscriptStatus::Review } else if cues.is_empty() { AafTranscriptStatus::Empty } else { AafTranscriptStatus::Completed },
        sample_rate: ASR_RATE as u32, cues, timing_issues,
        warnings: vec!["Names identify microphone owners. Nearby voices and recognition mistakes may appear on any track.".into(),
            "Cue times are machine estimates, not verified word boundaries. No diarization or cross-track deletion was performed.".into(),
            "Cues marked for boundary review can repeat across processing chunks. Both are kept so differing segmentation cannot silently remove words.".into(),
            "Recognition uses bounded audio chunks with one second of context. Whisper VAD is not used in this multitrack path.".into()] };
    let root = store::root(app)?;
    app.state::<JobRegistry>().while_active(job, || store::save_transcript(&root, &document.id, transcript.clone()))?;
    let _ = tauri::Emitter::emit(app, "saucebunny:multitrack-changed", &document.id);
    Ok(transcript)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn one_invalid_cue_cannot_discard_valid_text_or_invent_a_timeline_position() {
        let rate = AafRate { numerator: 24000, denominator: 1001 };
        let chunk = Chunk { start: 0, end: 240, extract_start: 0, extract_end: 240 };
        let output = "1\n00:00:01,000 --> 00:00:02,000\nValid first\n\n2\n00:00:03,000 --> 00:00:03,000\nZero length\n\n3\n00:00:04,000 --> 00:00:03,000\nReversed\n\n4\n00:00:09,000 --> 00:00:30,000\nPast end\n\n5\n00:00:06,000 --> 00:00:07,000\nValid last\n\n6\n00:60:00,000 --> 00:61:00,000\nMalformed clock\n";
        let parsed = parse_cues(output, &chunk, &rate, "10").unwrap();
        assert_eq!(parsed.cues.iter().map(|c|c.text.as_str()).collect::<Vec<_>>(), ["Valid first", "Valid last"]);
        assert_eq!(parsed.timing_issues.len(), 4);
        assert_eq!(parsed.timing_issues[0].reported_timing, "00:00:03,000 --> 00:00:03,000");
        assert!(parsed.cues.iter().all(|c| c.start_sample < c.end_sample && c.end_sample <= 160160));
        let empty = parse_cues("1\n00:00:10,010 --> 00:00:12,000\nUnplaced words\n", &chunk, &rate, "10").unwrap();
        assert!(empty.cues.is_empty()); assert_eq!(empty.timing_issues[0].text, "Unplaced words");
        let rounded = parse_cues("1\n00:00:09,900 --> 00:00:10,100\nSmall endpoint rounding\n", &chunk, &rate, "10").unwrap();
        assert_eq!(rounded.cues[0].end_sample, 160160); assert!(rounded.timing_issues.is_empty());
    }
    #[test]
    fn decoder_errors_and_missing_artifact_are_not_empty_success() {
        assert!(output_text(&AafEngine::Whisper, Some(0), "failed to read audio data", None).is_err());
        assert!(output_text(&AafEngine::Whisper, Some(0), "", None).is_err());
        assert_eq!(output_text(&AafEngine::Whisper, Some(0), "", Some(String::new())).unwrap(), "");
        assert!(output_text(&AafEngine::Parakeet, Some(3), "could not open audio", None).is_err());
        assert!(output_text(&AafEngine::Parakeet, Some(3), "unrecognized failure", None).is_err());
        assert_eq!(output_text(&AafEngine::Parakeet, Some(3), "error: Parakeet produced no transcript (no token timings)", None).unwrap(), "");
    }
    #[test]
    fn cue_times_keep_real_gaps_and_sequence_offset() {
        let rate = AafRate { numerator: 24_000, denominator: 1001 };
        let chunk = Chunk { start: 24_000, end: 25_000, extract_start: 24_000, extract_end: 25_000 };
        let cues = parse_cues("1\n00:00:05,000 --> 00:00:06,000\nFirst\n\n2\n00:00:30,000 --> 00:00:31,000\nSecond\n", &chunk, &rate, "12").unwrap().cues;
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].start_sample, 16_096_000);
        assert_eq!(cues[1].start_sample - cues[0].start_sample, 25 * ASR_RATE);
        assert!(parse_cues("not a transcript", &chunk, &rate, "12").is_err());
    }
    #[test]
    fn bounded_chunks_cover_fractional_rate_without_drifting() {
        let rate = AafRate { numerator: 24_000, denominator: 1001 };
        let items = chunks(146_759, &rate).unwrap();
        assert_eq!(items.first().unwrap().start, 0);
        assert_eq!(items.last().unwrap().end, 146_759);
        assert!(items.windows(2).all(|w| w[0].end == w[1].start));
        assert!(items.iter().all(|c| frame_samples(c.extract_end - c.extract_start, &rate).unwrap() <= 123 * ASR_RATE));
    }
    #[test]
    fn differently_segmented_boundary_phrases_are_preserved_for_review() {
        let rate = AafRate { numerator: 24, denominator: 1 };
        let first = Chunk { start: 0, end: 2880, extract_start: 0, extract_end: 2904 };
        let second = Chunk { start: 2880, end: 5760, extract_start: 2856, extract_end: 5760 };
        // A midpoint policy drops BOTH: first midpoint is after120s, second before120s.
        let a = parse_cues("1\n00:01:59,800 --> 00:02:00,600\nBoundary phrase\n", &first, &rate, "10").unwrap().cues;
        let b = parse_cues("1\n00:00:00,400 --> 00:00:01,200\nBoundary phrase\n", &second, &rate, "10").unwrap().cues;
        assert_eq!(a.len(), 1); assert_eq!(b.len(), 1);
        assert!(a[0].boundary_review && b[0].boundary_review);
    }
}
