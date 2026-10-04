//! The Transcripts library: single-file transcripts (SRT or VTT) of clips,
//! interviews and web videos, as files a model can list and read by line.
//! A file's path is its only id. Speaker renames and the link to the source
//! media live in the app's WebView storage, so a reader outside the app sees
//! the diarizer's labels (SPEAKER_00) and no media.
use super::{sequences, Address, Context};
use crate::AppError;
use serde::Serialize;
use std::path::{Path, PathBuf};

const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Serialize)]
pub struct File { transcript: String, name: String, folder: String, modified_ms: u64, speakers: bool, format: String }

pub fn list(ctx: &Context, folder: Option<&str>) -> Vec<File> {
    let root = ctx.roots.transcripts.to_string_lossy().into_owned();
    crate::commands::library::scan_transcript_root(&root).into_iter()
        .filter(|file| folder.is_none_or(|wanted| file.folder.eq_ignore_ascii_case(wanted.trim())))
        .map(|file| File { transcript: Address::Transcript(file.path).to_string(), name: file.name, folder: file.folder, modified_ms: file.modified_ms, speakers: file.has_diarization, format: file.format })
        .collect()
}

/// A transcript a model named, by address or path, kept inside the library.
fn resolve(ctx: &Context, wanted: &str) -> Result<PathBuf, AppError> {
    let path = match Address::parse(wanted) { Ok(Address::Transcript(path)) => path, _ => wanted.trim().to_string() };
    let path = PathBuf::from(path);
    let root = std::fs::canonicalize(&ctx.roots.transcripts).map_err(|_| AppError::not_found("The Transcripts library folder is missing."))?;
    let found = std::fs::canonicalize(&path).map_err(|_| AppError::not_found(format!("No transcript at {}. list_transcript_files names them.", path.display())))?;
    if !found.starts_with(&root) { return Err(AppError::invalid("Only transcripts in the Transcripts library can be read.")); }
    match found.extension().and_then(|ext| ext.to_str()).map(str::to_ascii_lowercase).as_deref() {
        Some("srt") | Some("vtt") => Ok(found),
        _ => Err(AppError::invalid("A transcript is an .srt or .vtt file.")),
    }
}

/// One cue of a subtitle file.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Cue { pub at: String, pub to: String, #[serde(skip_serializing_if = "Option::is_none")] pub who: Option<String>, pub text: String }

fn clock(text: &str) -> Option<String> {
    let text = text.trim().replace(',', ".");
    let parts: Vec<&str> = text.split(':').collect();
    let (hours, minutes, rest) = match parts.as_slice() { [h, m, s] => (*h, *m, *s), [m, s] => ("0", *m, *s), _ => return None };
    let seconds: f64 = rest.parse().ok()?;
    Some(format!("{:02}:{:02}:{:06.3}", hours.parse::<u32>().ok()?, minutes.parse::<u32>().ok()?, seconds))
}

/// SRT or VTT cues, with the speaker the app writes (`[SPEAKER_00]: …` or a
/// VTT `<v Name>` voice) taken out of the text.
pub fn parse(text: &str) -> Vec<Cue> {
    let mut out = Vec::new();
    for block in text.replace("\r\n", "\n").split("\n\n") {
        let mut lines = block.lines().map(str::trim).filter(|line| !line.is_empty()).skip_while(|line| !line.contains("-->"));
        let Some(timing) = lines.next() else { continue };
        let Some((from, to)) = timing.split_once("-->") else { continue };
        let (Some(at), Some(to)) = (clock(from), clock(to.split_whitespace().next().unwrap_or_default())) else { continue };
        let mut body = lines.collect::<Vec<_>>().join(" ");
        let mut who = None;
        if let Some(rest) = body.strip_prefix("<v ") {
            if let Some((name, said)) = rest.split_once('>') { who = Some(name.trim().to_string()); body = said.replace("</v>", "").trim().to_string(); }
        } else if let Some(rest) = body.strip_prefix('[') {
            if let Some((name, said)) = rest.split_once(']') { who = Some(name.trim().to_string()); body = said.trim_start_matches(':').trim().to_string(); }
        }
        if !body.is_empty() { out.push(Cue { at, to, who, text: body }); }
    }
    out
}

#[derive(Serialize)]
pub struct Read { transcript: String, name: String, lines: Vec<Cue>, total: usize, #[serde(skip_serializing_if = "Option::is_none")] next_cursor: Option<usize> }

pub fn read(ctx: &Context, wanted: &str, cursor: usize, limit: usize) -> Result<Read, AppError> {
    let path = resolve(ctx, wanted)?;
    if std::fs::metadata(&path)?.len() > MAX_FILE_BYTES { return Err(AppError::invalid("That transcript is too large to read.")); }
    let cues = parse(&std::fs::read_to_string(&path)?);
    let limit = limit.clamp(1, sequences::PAGE_LINES * 5);
    let lines: Vec<Cue> = cues.iter().skip(cursor).take(limit).cloned().collect();
    let next = cursor + lines.len();
    Ok(Read {
        transcript: Address::Transcript(path.to_string_lossy().into_owned()).to_string(), name: stem(&path),
        total: cues.len(), next_cursor: (next < cues.len()).then_some(next), lines,
    })
}

fn stem(path: &Path) -> String { path.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default() }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_srt_and_vtt_with_their_speakers() {
        let srt = "1\n00:00:01,000 --> 00:00:03,500\n[SPEAKER_00]: Hello there.\n\n2\n00:00:04,000 --> 00:00:05,000\nNo speaker here.\n";
        assert_eq!(parse(srt), vec![
            Cue { at: "00:00:01.000".into(), to: "00:00:03.500".into(), who: Some("SPEAKER_00".into()), text: "Hello there.".into() },
            Cue { at: "00:00:04.000".into(), to: "00:00:05.000".into(), who: None, text: "No speaker here.".into() },
        ]);
        let vtt = "WEBVTT\n\n00:01.000 --> 00:02.000 align:start\n<v Rosa>I moved here in May.</v>\n";
        assert_eq!(parse(vtt), vec![Cue { at: "00:00:01.000".into(), to: "00:00:02.000".into(), who: Some("Rosa".into()), text: "I moved here in May.".into() }]);
    }
}
