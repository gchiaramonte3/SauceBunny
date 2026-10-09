//! ASR-only chunks. Track ownership is metadata, not diarization or proof of speech identity.
use super::{audio, model::*, process, store};
use crate::{commands::JobRegistry, AppError};
use std::path::Path;
use tauri::{AppHandle, Manager};

struct EngineConfig { engine: AafEngine, model_id: String, model_path: String, language: String, fast: bool, vad_model: Option<String>, parakeet: &'static str,
    /// Names to spell right (accuracy spec, phase 2): Whisper's prompt, Parakeet's vocabulary.
    names: Vec<String> }

/// The people on this AAF's mics, as names a recognizer can be told to spell:
/// each mic owner once, no blanks, at most fifty (a Whisper prompt holds about
/// 224 tokens, and a short list keeps Parakeet's rescorer cautious).
pub fn cast_names(document: &AafDocument) -> Vec<String> {
    let mut names: Vec<String> = Vec::new();
    for label in &document.labels {
        let name = label.owner_name.trim();
        if name.chars().filter(|c| c.is_alphabetic()).count() >= 3 && !names.iter().any(|known| known.eq_ignore_ascii_case(name)) { names.push(name.to_string()); }
    }
    names.truncate(50);
    names
}
// Enforce the limit natively too: a second window or overlapping IPC must not
// turn a group expansion into dozens of recognizer processes.
static RECOGNIZER: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

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
            let model = crate::commands::transcript::parakeet_model(Some(model_id))?;
            if !crate::commands::transcript::parakeet_ready(app, model) {
                return Err(AppError::not_found(format!("Download {} before transcribing", model.label)));
            }
            let models = app.path().app_data_dir().map_err(|e| AppError::internal(e.to_string()))?.join("models").join("parakeet");
            (model.id.into(), models.to_string_lossy().into_owned())
        }
    };
    let parakeet = crate::commands::transcript::parakeet_model(matches!(engine, AafEngine::Parakeet).then_some(model_id.as_str())).map(|model| model.arg).unwrap_or("v3");
    Ok(EngineConfig { engine, model_id, model_path, language, fast, vad_model: None, parakeet, names: Vec::new() })
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

/// Whisper's stock inventions on silence or room tone (Barański et al. 2025
/// list the recurring ones). Each is also something a person can really say,
/// so a match is a label to check, never a deletion.
const INVENTED: &[&str] = &["thank you", "thank you so much", "thanks for watching", "thank you for watching", "thank you very much",
    "please subscribe", "subscribe to my channel", "like and subscribe", "subtitles by the amara org community", "you", "bye", "the end",
    "see you next time", "i'll see you next time", "thanks for listening", "transcription by castingwords"];

/// Why a Whisper cue may be invented: a stock phrase, or one short phrase
/// looping four times or more ("I'm sorry. I'm sorry. I'm sorry. I'm sorry.").
pub fn suspect(text: &str) -> Option<String> {
    let words: Vec<String> = text.split_whitespace().map(|word| word.chars().filter(|c| c.is_alphanumeric() || *c == '\'').flat_map(char::to_lowercase).collect::<String>())
        .filter(|word| !word.is_empty()).collect();
    let joined = words.join(" ");
    if INVENTED.contains(&joined.as_str()) { return Some("Whisper often invents this phrase on silence. Check the audio.".into()); }
    for size in 1..=4 {
        if words.len() < size * 4 { break; }
        let looping = words.chunks(size).filter(|chunk| chunk.len() == size).collect::<Vec<_>>();
        let mut run = 1;
        for pair in looping.windows(2) {
            run = if pair[0] == pair[1] { run + 1 } else { 1 };
            if run >= 4 { return Some("This repeats itself, which Whisper does on silence. Check the audio.".into()); }
        }
    }
    None
}

/// One word as the Parakeet sidecar writes it (`--words`): seconds from the
/// start of the window file it was given.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct RawWord { pub text: String, pub start: f64, pub end: f64, pub confidence: f32 }

/// The measured words inside one cue, in sequence samples, or None when they
/// do not spell the cue exactly (a word the engine timed but a cue that says
/// something else would put text on the wrong sound). Each word is clipped to
/// the cue, and an empty or reversed one makes the whole set untrustworthy.
fn cue_words(words: &[RawWord], offset: i64, start: i64, end: i64, text: &str) -> Option<Vec<AafCueWord>> {
    let sample = |seconds: f64| seconds.is_finite().then(|| offset + (seconds * ASR_RATE as f64).round() as i64);
    let mut out = Vec::new();
    for word in words {
        let (Some(from), Some(to)) = (sample(word.start), sample(word.end)) else { return None };
        let middle = (from + to) / 2;
        if middle < start || middle >= end { continue; }
        let (from, to) = (from.clamp(start, end), to.clamp(start, end));
        if to <= from { return None; }
        out.push(AafCueWord { text: word.text.clone(), start_sample: from, end_sample: to, confidence: word.confidence.clamp(0.0, 1.0) });
    }
    let spelled = out.iter().map(|word| word.text.as_str()).collect::<Vec<_>>().join(" ");
    (!out.is_empty() && spelled == text.split_whitespace().collect::<Vec<_>>().join(" ")).then_some(out)
}

pub fn parse_cues(text: &str, chunk: &Chunk, rate: &AafRate, track: &str, words: Option<&[RawWord]>) -> Result<ParsedCues, AppError> {
    let text = text.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    if text.trim().is_empty() { return Ok(ParsedCues { cues: Vec::new(), timing_issues: Vec::new() }); }
    let offset = frame_samples(chunk.extract_start, rate)?;
    let available = frame_samples(chunk.extract_end - chunk.extract_start, rate)?;
    let owner_start = frame_samples(chunk.start, rate)?;
    let owner_end = frame_samples(chunk.end, rate)?;
    let mut cues = Vec::new();
    let mut timing_issues = Vec::new();
    // A blank line inside a cue's text ("♪\n\n♪") splits one SRT block into
    // two, and the second has no timing line. That used to fail the whole run
    // with "Speech cue has no timestamp", discarding every finished chunk. It
    // is the previous cue's text, so it is folded back into it; with no cue
    // before it, it is kept as untimed text rather than dropped.
    let mut blocks: Vec<(Option<String>, String)> = Vec::new();
    for block in text.split("\n\n").filter(|block| !block.trim().is_empty()) {
        let lines: Vec<&str> = block.trim().lines().collect();
        let at = lines.iter().take(2).position(|line| line.contains("-->"));
        match at {
            Some(at) => blocks.push((Some(lines[at].trim().to_owned()), lines[at + 1..].join(" ").trim().to_owned())),
            None => match blocks.last_mut() {
                Some((_, text)) => { text.push(' '); text.push_str(lines.join(" ").trim()); }
                None => blocks.push((None, lines.join(" ").trim().to_owned())),
            },
        }
    }
    // Output with no time range anywhere is not a transcript at all.
    if blocks.iter().all(|(timing, _)| timing.is_none()) { return Err(AppError::invalid("Speech cue has no timestamp")); }
    for (index, (timing, text)) in blocks.into_iter().enumerate() {
        let text = text.trim().to_owned();
        if text.is_empty() { continue; }
        let Some((timing, (start, end))) = timing.as_deref().and_then(|timing| Some((timing, timing.split_once("-->")?))) else {
            timing_issues.push(AafTimingIssue { id: format!("{track}-{}-{index}", chunk.start), text,
                reported_timing: String::new(), chunk_start_frame: chunk.extract_start,
                reason: "The engine returned text without a time range.".into() });
            continue;
        };
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
        let words = words.and_then(|words| cue_words(words, offset, absolute_start, absolute_end, &text));
        cues.push(AafCue { id: format!("{track}-{}-{index}", chunk.start),
            start_sample: absolute_start, end_sample: absolute_end, text,
            boundary_review: absolute_start < owner_start || absolute_end > owner_end, words, suspect: None });
    }
    Ok(ParsedCues { cues, timing_issues })
}

// Reuse the shipped CLI's model across four independent files. Never concatenate
// their audio: each SRT retains its own origin and the existing boundary context.
// Four windows bound scratch space and cancellation latency without a new server.
const WHISPER_BATCH_SIZE: usize = 4;
// Parakeet loads its model once per batch (`--batch`), so a batch is sixteen
// minutes of audio for one load instead of one load per two-minute window.
// Bounded for the same reasons: scratch space and how long Stop waits.
const PARAKEET_BATCH_SIZE: usize = 8;

/// The Parakeet sidecar's arguments for a batch: one manifest of
/// {input, output, words}, one model load, words written beside each SRT.
fn parakeet_batch_args(config: &EngineConfig, files: &[(&Path, &Path)]) -> Result<(Vec<String>, std::path::PathBuf, String), AppError> {
    let Some((_, first)) = files.first() else { return Err(AppError::invalid("No audio chunks to transcribe")); };
    if files.len() > PARAKEET_BATCH_SIZE { return Err(AppError::invalid("Too many recognition chunks")); }
    let items: Vec<serde_json::Value> = files.iter().map(|(wav, output)| serde_json::json!({
        "input": wav.to_string_lossy(), "output": output.with_extension("srt").to_string_lossy(),
        "words": output.with_extension("words.json").to_string_lossy() })).collect();
    let manifest = first.with_extension("batch.json");
    let mut args = vec!["--asr".into(), "--asr-model".into(), config.parakeet.into(), "--batch".into(), manifest.to_string_lossy().into_owned(),
        "--models-dir".into(), config.model_path.clone(), "--emit-progress".into()];
    if !config.names.is_empty() {
        let vocabulary = first.with_extension("names.json");
        std::fs::write(&vocabulary, serde_json::to_vec(&config.names)?)?;
        args.extend(["--vocabulary".into(), vocabulary.to_string_lossy().into_owned()]);
    }
    Ok((args, manifest, serde_json::to_string(&items)?))
}

fn whisper_batch_args(config: &EngineConfig, files: &[(&Path, &Path)]) -> Result<Vec<String>, AppError> {
    let Some((wav, output)) = files.first() else { return Err(AppError::invalid("No audio chunks to transcribe")); };
    if files.len() > WHISPER_BATCH_SIZE { return Err(AppError::invalid("Too many recognition chunks")); }
    let mut args = crate::commands::transcript::whisper_cli_args(&config.model_path,
        &wav.to_string_lossy(), &output.to_string_lossy(), &config.language, config.vad_model.as_deref(), config.fast);
    for (wav, output) in &files[1..] {
        args.extend(["-f".into(), wav.to_string_lossy().into_owned(), "-of".into(), output.to_string_lossy().into_owned()]);
    }
    if !config.names.is_empty() {
        args.extend(["--prompt".into(), format!("Names: {}.", config.names.join(", "))]);
    }
    if config.vad_model.is_some() {
        // Retain short/quiet utterances and pad boundaries. Still opt-in: no VAD
        // threshold can guarantee retaining every faint or overlapping voice.
        args.extend(["-vt", "0.35", "-vspd", "100", "-vp", "250"].map(str::to_owned));
    }
    Ok(args)
}

async fn run_batch(app: &AppHandle, job: &str, config: &EngineConfig, files: &[(&Path, &Path)]) -> Result<Vec<(String, Option<Vec<RawWord>>)>, AppError> {
    let _permit = loop {
        process::check_cancelled(app, job)?;
        tokio::select! {
            permit = RECOGNIZER.acquire() => break permit.map_err(|_| AppError::internal("Speech recognition unavailable"))?,
            _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {},
        }
    };
    process::check_cancelled(app, job)?;
    let (name, args) = match config.engine {
        AafEngine::Whisper => ("whisper-cli", whisper_batch_args(config, files)?),
        AafEngine::Parakeet => {
            let (args, manifest, items) = parakeet_batch_args(config, files)?;
            std::fs::write(manifest, items)?;
            ("saucebunny-diarize", args)
        },
    };
    // Keep the existing per-window budget on slower Macs. Batching must not
    // turn four individually valid windows into a premature timeout.
    let timeout = std::time::Duration::from_secs(15 * 60 * files.len() as u64);
    let result = process::run_with_timeout(app, job, "asr", name, args, timeout).await?;
    // Only engine counters, never recognized text or arbitrary stderr, enter
    // shareable diagnostics. Separate initialization cost from recognition.
    for line in result.stderr.lines().filter(|line| line.starts_with("whisper_print_timings:") || line.starts_with("ggml_metal_device_init: GPU name:")) {
        super::diagnostics::log(app, job, "info", "asr-timing", line);
    }
    files.iter().map(|(_, output)| {
        let path = output.with_extension("srt");
        let text = if path.is_file() {
            if std::fs::metadata(&path)?.len() > 8 * 1024 * 1024 { return Err(AppError::invalid("Speech output exceeded its safety limit")); }
            Some(std::fs::read_to_string(path)?)
        } else { None };
        let text = output_text(&config.engine, result.code, &result.stderr, text)?;
        // Words are a refinement: a missing or unreadable file costs the
        // measured times, never the transcript, which falls back to estimates.
        let words = output.with_extension("words.json");
        let words = (matches!(config.engine, AafEngine::Parakeet) && words.is_file()
            && std::fs::metadata(&words).is_ok_and(|meta| meta.len() <= 32 * 1024 * 1024))
            .then(|| std::fs::read(&words).ok().and_then(|bytes| serde_json::from_slice::<Vec<RawWord>>(&bytes).ok())).flatten();
        Ok((text, words))
    }).collect()
}

#[allow(clippy::too_many_arguments)]
pub async fn transcribe(app: &AppHandle, document: &AafDocument, track: &str, start: i64, duration: i64,
    engine: AafEngine, model_id: &str, language: &str, fast: bool, speech_only: bool, names: bool, job: &str) -> Result<AafTrackTranscript, AppError>
{
    let lane = store::track(document, track)?;
    store::audio_source_ready(document)?;
    super::linked::check_sources(app, job, document, store::track(document, track)?).await?;
    let end = start.checked_add(duration).ok_or_else(|| AppError::invalid("AAF transcription range overflow"))?;
    if start < 0 || duration <= 0 || end > document.manifest.duration_frames {
        return Err(AppError::invalid("Choose a transcription range within the sequence"));
    }
    let mut config = engine_config(app, engine, model_id, language, fast)?;
    if names { config.names = cast_names(document); }
    let whisper = matches!(config.engine, AafEngine::Whisper);
    if whisper && speech_only {
        config.vad_model = crate::commands::transcript::cached_vad_model(app).map(|path| path.to_string_lossy().into_owned());
    }
    let speech_note = if config.vad_model.is_some() { "Speech filter enabled. Quiet or overlapping speech may be missed. Original audio timestamps are retained." }
        else if whisper && speech_only { "Speech detector unavailable. Full audio was used; no download was started." }
        else { "Full audio used. Only timeline gaps and digital silence are skipped." };
    super::diagnostics::log(app, job, if whisper && speech_only && config.vad_model.is_none() { "warn" } else { "info" }, "asr-options", speech_note);
    let batch_size = if whisper { WHISPER_BATCH_SIZE } else { PARAKEET_BATCH_SIZE };
    let chunks = chunks(duration, &document.manifest.edit_rate)?;
    super::diagnostics::log(app, job, "info", "asr-options", &format!("{} windows · up to {batch_size} per model load · one recognizer · {} decoding", chunks.len(), if fast && whisper { "fast" } else { "accurate" }));
    let mut cues = Vec::new();
    let mut timing_issues = Vec::new();
    for batch in chunks.chunks(batch_size) {
        let mut prepared = Vec::new();
        for relative in batch {
            let chunk = Chunk { start: relative.start + start, end: relative.end + start,
                extract_start: relative.extract_start + start, extract_end: relative.extract_end + start };
            process::check_cancelled(app, job)?;
            // Gaps can be skipped without ever asking a model to invent speech in them.
            if !lane.clips.iter().any(|clip| clip.kind == "audio" && clip.start_frame < chunk.extract_end && clip.start_frame + clip.duration_frames > chunk.extract_start) { continue; }
            let work = audio::WorkDir::new(app, job)?;
            process::progress(app, job, Some(track), "preparing-audio", batch[0].start, duration);
            let (wav, info) = audio::extract_16k(app, document, track, chunk.extract_start,
                chunk.extract_end - chunk.extract_start, job, &work.0).await?;
            if !info.digital_silence {
                let output = work.0.join("transcript");
                prepared.push((chunk, work, wav, output));
            }
        }
        if !prepared.is_empty() {
            process::progress(app, job, Some(track), "transcribing", batch[0].start, duration);
            super::diagnostics::log(app, job, "info", "asr-batch", &format!("{} audio windows · sequence frames {} to {}", prepared.len(), start + batch[0].start, start + batch[batch.len()-1].end));
            let files = prepared.iter().map(|(_, _, wav, output)| (wav.as_path(), output.as_path())).collect::<Vec<_>>();
            let texts = run_batch(app, job, &config, &files).await?;
            for ((chunk, _, _, _), (text, words)) in prepared.iter().zip(texts) {
                process::check_cancelled(app, job)?;
                let mut parsed = parse_cues(&text, chunk, &document.manifest.edit_rate, track, words.as_deref())?;
                if whisper { for cue in &mut parsed.cues { cue.suspect = suspect(&cue.text); } }
                cues.extend(parsed.cues);
                timing_issues.extend(parsed.timing_issues);
            }
        }
        process::progress(app, job, Some(track), "transcribing", batch[batch.len()-1].end, duration);
    }
    cues.sort_by_key(|cue| (cue.start_sample, cue.end_sample));
    store::audio_source_ready(document)?;
    super::linked::check_sources(app, job, document, lane).await?;
    let transcript = AafTrackTranscript { track_id: track.into(), start_frame: start, duration_frames: duration, engine: config.engine,
        model_id: config.model_id, status: if !timing_issues.is_empty() { AafTranscriptStatus::Review } else if cues.is_empty() { AafTranscriptStatus::Empty } else { AafTranscriptStatus::Completed },
        sample_rate: ASR_RATE as u32, cues, timing_issues,
        warnings: vec!["Names identify microphone owners. Nearby voices and recognition mistakes may appear on any track.".into(),
            if whisper { "Cue times are machine estimates, not verified word boundaries. No diarization or cross-track deletion was performed.".into() }
            else { "Word times are the recognizer's own measurements, accurate to about 80 ms. No diarization or cross-track deletion was performed.".into() },
            "Cues marked for boundary review can repeat across processing chunks. Both are kept so differing segmentation cannot silently remove words.".into(),
            "Recognition uses bounded audio chunks with one second of context.".into(),
            speech_note.into(), format!("Decoding: {}. Model reuse: up to {batch_size} windows per load.", if fast && whisper { "Fast" } else { "Accurate" })], gaps: None };
    let root = store::root(app)?;
    let registry = app.state::<JobRegistry>();
    let saved = store::save_transcript_gated(&root, document, transcript, &|commit| registry.while_active(job, commit))?;
    let _ = tauri::Emitter::emit(app, "saucebunny:multitrack-changed", &document.id);
    Ok(saved)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn config(fast: bool, vad: bool) -> EngineConfig {
        EngineConfig { engine: AafEngine::Whisper, model_id: "medium.en".into(), model_path: "model with spaces.bin".into(),
            language: "en".into(), fast, vad_model: vad.then(|| "installed-vad.bin".into()), parakeet: "v3", names: vec![] }
    }
    #[test]
    fn batch_reuses_one_model_and_keeps_each_input_output_pair_separate() {
        let files = [(Path::new("one.wav"), Path::new("one")), (Path::new("mic é two.wav"), Path::new("two"))];
        let args = whisper_batch_args(&config(false, false), &files).unwrap();
        assert_eq!(args.iter().filter(|arg| arg.as_str() == "-m").count(), 1);
        assert_eq!(args.iter().filter(|arg| arg.as_str() == "-f").count(), 2);
        assert_eq!(args.iter().filter(|arg| arg.as_str() == "-of").count(), 2);
        assert!(args.windows(2).any(|p| p == ["-bs", "5"]));
        assert!(args.windows(2).any(|p| p == ["-f", "mic é two.wav"]));
        assert!(!args.contains(&"--vad".into()));
        assert!(whisper_batch_args(&config(false, false), &[]).is_err());
        assert!(whisper_batch_args(&config(false, false), &[files[0]; WHISPER_BATCH_SIZE+1]).is_err());
    }
    #[test]
    fn fast_and_speech_filter_are_independent_opt_ins() {
        let files = [(Path::new("one.wav"), Path::new("one"))];
        let fast = whisper_batch_args(&config(true, false), &files).unwrap();
        assert!(fast.windows(2).any(|p| p == ["-bs", "1"]));
        assert!(fast.windows(2).any(|p| p == ["-bo", "1"]));
        assert!(!fast.contains(&"--vad".into()));
        let filtered = whisper_batch_args(&config(false, true), &files).unwrap();
        assert!(filtered.windows(2).any(|p| p == ["-bs", "5"]));
        assert!(filtered.windows(2).any(|p| p == ["-vm", "installed-vad.bin"]));
        assert!(filtered.windows(2).any(|p| p == ["-vp", "250"]));
    }
    #[test]
    #[ignore = "requires bundled Whisper and SB_AAF_ASR_TEST_WAV / SB_AAF_ASR_TEST_MODEL"]
    fn real_batch_retains_independent_srt_origins_and_one_model_load() {
        let wav = std::path::PathBuf::from(std::env::var("SB_AAF_ASR_TEST_WAV").unwrap());
        let mut config = config(false, false);
        config.model_path = std::env::var("SB_AAF_ASR_TEST_MODEL").unwrap();
        config.vad_model = std::env::var("SB_AAF_ASR_TEST_VAD").ok();
        let root = audio::WorkDir(std::env::temp_dir().join(format!("aaf-batch-test-{}", uuid::Uuid::new_v4())));
        std::fs::create_dir(&root.0).unwrap();
        let outputs: Vec<_> = (0..WHISPER_BATCH_SIZE).map(|i| root.0.join(format!("mic é {i}"))).collect();
        let files: Vec<_> = outputs.iter().map(|out| (wav.as_path(), out.as_path())).collect();
        let result = std::process::Command::new(crate::commands::sidecar_path("whisper-cli").unwrap())
            .args(whisper_batch_args(&config, &files).unwrap()).output().unwrap();
        assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
        let stderr = String::from_utf8_lossy(&result.stderr);
        assert_eq!(stderr.lines().filter(|line| line.starts_with("whisper_init_from_file") && line.contains("loading model")).count(), 1);
        let rate = AafRate { numerator: 24000, denominator: 1001 };
        for (index, out) in outputs.iter().enumerate() {
            let text = output_text(&AafEngine::Whisper, result.status.code(), &stderr, Some(std::fs::read_to_string(out.with_extension("srt")).unwrap())).unwrap();
            let chunk = Chunk { start: index as i64 * 2880, end: (index as i64 + 1) * 2880, extract_start: index as i64 * 2880, extract_end: (index as i64 + 1) * 2880 };
            let parsed = parse_cues(&text, &chunk, &rate, "test-mic", None).unwrap();
            // Model timing mistakes remain review items, not manufactured cues.
            assert!(parsed.timing_issues.iter().all(|issue| issue.chunk_start_frame == chunk.extract_start));
            assert!(!parsed.cues.is_empty());
            assert!(parsed.cues.iter().all(|cue| cue.start_sample >= frame_samples(chunk.start, &rate).unwrap()
                && cue.end_sample <= frame_samples(chunk.end, &rate).unwrap()));
            // Fixture has speech at 5, 45 and 95 seconds, not packed together.
            assert!(parsed.cues.iter().any(|cue| cue.start_sample >= frame_samples(chunk.start, &rate).unwrap() + 40 * ASR_RATE));
        }
    }
    #[test]
    fn one_invalid_cue_cannot_discard_valid_text_or_invent_a_timeline_position() {
        let rate = AafRate { numerator: 24000, denominator: 1001 };
        let chunk = Chunk { start: 0, end: 240, extract_start: 0, extract_end: 240 };
        let output = "1\n00:00:01,000 --> 00:00:02,000\nValid first\n\n2\n00:00:03,000 --> 00:00:03,000\nZero length\n\n3\n00:00:04,000 --> 00:00:03,000\nReversed\n\n4\n00:00:09,000 --> 00:00:30,000\nPast end\n\n5\n00:00:06,000 --> 00:00:07,000\nValid last\n\n6\n00:60:00,000 --> 00:61:00,000\nMalformed clock\n";
        let parsed = parse_cues(output, &chunk, &rate, "10", None).unwrap();
        assert_eq!(parsed.cues.iter().map(|c|c.text.as_str()).collect::<Vec<_>>(), ["Valid first", "Valid last"]);
        assert_eq!(parsed.timing_issues.len(), 4);
        assert_eq!(parsed.timing_issues[0].reported_timing, "00:00:03,000 --> 00:00:03,000");
        assert!(parsed.cues.iter().all(|c| c.start_sample < c.end_sample && c.end_sample <= 160160));
        let empty = parse_cues("1\n00:00:10,010 --> 00:00:12,000\nUnplaced words\n", &chunk, &rate, "10", None).unwrap();
        assert!(empty.cues.is_empty()); assert_eq!(empty.timing_issues[0].text, "Unplaced words");
        let rounded = parse_cues("1\n00:00:09,900 --> 00:00:10,100\nSmall endpoint rounding\n", &chunk, &rate, "10", None).unwrap();
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
        let cues = parse_cues("1\n00:00:05,000 --> 00:00:06,000\nFirst\n\n2\n00:00:30,000 --> 00:00:31,000\nSecond\n", &chunk, &rate, "12", None).unwrap().cues;
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].start_sample, 16_096_000);
        assert_eq!(cues[1].start_sample - cues[0].start_sample, 25 * ASR_RATE);
        assert!(parse_cues("not a transcript", &chunk, &rate, "12", None).is_err());
    }
    #[test]
    fn a_blank_line_inside_a_cue_keeps_the_run_and_the_text() {
        let rate = AafRate { numerator: 24_000, denominator: 1001 };
        let chunk = Chunk { start: 0, end: 240, extract_start: 0, extract_end: 240 };
        let parsed = parse_cues("1\n00:00:01,000 --> 00:00:02,000\n♪\n\n♪\n\n2\n00:00:03,000 --> 00:00:04,000\nNext\n", &chunk, &rate, "10", None).unwrap();
        assert_eq!(parsed.cues.iter().map(|c| c.text.as_str()).collect::<Vec<_>>(), ["♪ ♪", "Next"]);
        assert!(parsed.timing_issues.is_empty());
        let leading = parse_cues("Stray words\n\n1\n00:00:01,000 --> 00:00:02,000\nTimed\n", &chunk, &rate, "10", None).unwrap();
        assert_eq!(leading.cues[0].text, "Timed");
        assert_eq!(leading.timing_issues[0].text, "Stray words");
    }
    fn raw(text: &str, start: f64, end: f64) -> RawWord { RawWord { text: text.into(), start, end, confidence: 0.9 } }

    #[test]
    fn measured_words_travel_with_their_cue_in_sequence_samples() {
        let rate = AafRate { numerator: 24, denominator: 1 };
        // A window that starts 10 s into the sequence: words are relative to it.
        let chunk = Chunk { start: 240, end: 480, extract_start: 240, extract_end: 480 };
        let srt = "1\n00:00:01,000 --> 00:00:02,000\nHello there.\n\n2\n00:00:03,000 --> 00:00:04,000\nBye now\n";
        let words = [raw("Hello", 1.0, 1.4), raw("there.", 1.4, 2.0), raw("Bye", 3.0, 3.3), raw("now", 3.3, 4.0)];
        let cues = parse_cues(srt, &chunk, &rate, "10", Some(&words)).unwrap().cues;
        let first = cues[0].words.as_ref().unwrap();
        assert_eq!(first.iter().map(|w| w.text.as_str()).collect::<Vec<_>>(), ["Hello", "there."]);
        assert_eq!((first[0].start_sample, first[0].end_sample), (16_000 * 11, 16_000 * 11 + 6_400));
        assert_eq!(first[1].end_sample, cues[0].end_sample);
        assert_eq!(cues[1].words.as_ref().unwrap().len(), 2);
        assert!((first[0].confidence - 0.9).abs() < 1e-6);
        // Without a words file the cue is unchanged and estimated later.
        assert!(parse_cues(srt, &chunk, &rate, "10", None).unwrap().cues[0].words.is_none());
    }

    #[test]
    fn words_that_do_not_spell_the_cue_are_not_trusted() {
        let rate = AafRate { numerator: 24, denominator: 1 };
        let chunk = Chunk { start: 0, end: 240, extract_start: 0, extract_end: 240 };
        let srt = "1\n00:00:01,000 --> 00:00:02,000\nHello there\n";
        let wrong = [raw("Hello", 1.0, 1.4), raw("where", 1.4, 2.0)];
        assert!(parse_cues(srt, &chunk, &rate, "10", Some(&wrong)).unwrap().cues[0].words.is_none());
        let reversed = [raw("Hello", 1.0, 1.4), raw("there", 1.9, 1.5)];
        assert!(parse_cues(srt, &chunk, &rate, "10", Some(&reversed)).unwrap().cues[0].words.is_none());
        let broken = [raw("Hello", f64::NAN, 1.4), raw("there", 1.4, 2.0)];
        assert!(parse_cues(srt, &chunk, &rate, "10", Some(&broken)).unwrap().cues[0].words.is_none());
    }

    #[test]
    fn parakeet_batches_windows_into_one_model_load_and_writes_words_beside_each_srt() {
        let mut config = config(false, false);
        config.engine = AafEngine::Parakeet;
        config.parakeet = "ultra";
        let files = [(Path::new("/w/one.wav"), Path::new("/w/one/transcript")), (Path::new("/w/two.wav"), Path::new("/w/two/transcript"))];
        let (args, manifest, items) = parakeet_batch_args(&config, &files).unwrap();
        assert!(args.windows(2).any(|pair| pair == ["--asr-model", "ultra"]));
        assert!(args.windows(2).any(|pair| pair[0] == "--batch" && pair[1] == manifest.to_string_lossy()));
        let items: Vec<serde_json::Value> = serde_json::from_str(&items).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[1]["output"], "/w/two/transcript.srt");
        assert_eq!(items[1]["words"], "/w/two/transcript.words.json");
        assert!(parakeet_batch_args(&config, &[files[0]; PARAKEET_BATCH_SIZE + 1]).is_err());
        assert!(parakeet_batch_args(&config, &[]).is_err());
    }

    #[test]
    fn cast_names_reach_whisper_as_a_prompt_and_parakeet_as_a_vocabulary_file() {
        let mut whisper = config(false, false);
        whisper.names = vec!["Rosa".into(), "Xiomara".into()];
        let args = whisper_batch_args(&whisper, &[(Path::new("one.wav"), Path::new("one"))]).unwrap();
        assert!(args.windows(2).any(|pair| pair == ["--prompt", "Names: Rosa, Xiomara."]));
        assert!(!whisper_batch_args(&config(false, false), &[(Path::new("one.wav"), Path::new("one"))]).unwrap().contains(&"--prompt".to_string()));
        let dir = std::env::temp_dir().join(format!("names-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut parakeet = whisper;
        parakeet.engine = AafEngine::Parakeet;
        let out = dir.join("transcript");
        let (args, _, _) = parakeet_batch_args(&parakeet, &[(Path::new("one.wav"), out.as_path())]).unwrap();
        let at = args.iter().position(|arg| arg == "--vocabulary").unwrap();
        assert_eq!(std::fs::read_to_string(&args[at + 1]).unwrap(), r#"["Rosa","Xiomara"]"#);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn cast_names_are_each_mic_owner_once_without_blanks() {
        let mut document: AafDocument = serde_json::from_value(serde_json::json!({
            "schema_version": 2, "id": "d".repeat(64), "source_path": "/x.aaf", "source_size": 1, "source_modified_ms": 1,
            "manifest": { "schema_version": 1, "name": "X", "source_fingerprint": "e".repeat(64), "edit_rate": { "numerator": 24, "denominator": 1 },
                "start_frame": 0, "duration_frames": 24, "timecode_fps": 24, "drop_frame": false, "tracks": [{ "id": "1", "name": "1", "clips": [], "warnings": [] }], "warnings": [] },
            "labels": [], "transcripts": [] })).unwrap();
        for name in ["Rosa", " rosa ", "", "Al", "Xiomara", "12"] {
            document.labels.push(AafTrackLabel { track_id: "1".into(), owner_name: name.into(), cast_member_id: None, color: None, gender: None, marker_color: None });
        }
        assert_eq!(cast_names(&document), ["Rosa", "Xiomara"]);
    }

    #[test]
    fn whispers_stock_inventions_and_loops_are_labelled_and_real_lines_are_not() {
        assert!(suspect("Thank you for watching!").is_some());
        assert!(suspect("  you. ").is_some());
        assert!(suspect("I'm sorry. I'm sorry. I'm sorry. I'm sorry.").is_some());
        assert!(suspect("no no no no").is_some());
        // A real line that only CONTAINS a stock phrase, or repeats a little, is left alone.
        assert!(suspect("Thank you for watching my kids last night.").is_none());
        assert!(suspect("I'm sorry, I'm sorry, I didn't mean it.").is_none());
        assert!(suspect("").is_none());
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
        let a = parse_cues("1\n00:01:59,800 --> 00:02:00,600\nBoundary phrase\n", &first, &rate, "10", None).unwrap().cues;
        let b = parse_cues("1\n00:00:00,400 --> 00:00:01,200\nBoundary phrase\n", &second, &rate, "10", None).unwrap().cues;
        assert_eq!(a.len(), 1); assert_eq!(b.len(), 1);
        assert!(a[0].boundary_review && b[0].boundary_review);
    }
}
