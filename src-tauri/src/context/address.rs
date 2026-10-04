//! One address for every thing an assistant can name, under the app's own
//! scheme: `saucebunny://sequence/{id}/line/{track}/{cue}` and the rest
//! (docs/AI-ACCESS-SPEC-2026-10-03.md, "Addresses"). Tools return these and
//! accept them, so a citation means the same line on every turn. The review
//! link parser ignores every host but `review` by design
//! (`commands/review_link.rs`), so none of these reads as a review link.
use crate::AppError;
use std::fmt;

pub const SCHEME: &str = "saucebunny://";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Address {
    Sequences,
    Sequence(String),
    Person { sequence: String, person: String },
    Line { sequence: String, track: String, cue: String },
    SequenceAt { sequence: String, tc: String },
    StringOuts,
    StringOut(String),
    Clip { string_out: String, clip: String },
    StringOutAt { string_out: String, tc: String },
    History(String),
    Transcripts,
    Transcript(String),
}

/// A path segment, percent-encoded: ids are plain, but a person key holds a
/// name and a transcript is named by its file path.
fn encode(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~:!$&'()*+,=".contains(&byte) { out.push(byte as char); } else { out.push_str(&format!("%{byte:02X}")); }
    }
    out
}

fn decode(text: &str) -> Result<String, AppError> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = text.get(index + 1..index + 3).and_then(|pair| u8::from_str_radix(pair, 16).ok())
                .ok_or_else(|| AppError::invalid(format!("Bad escape in the address segment \"{text}\".")))?;
            out.push(hex);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).map_err(|_| AppError::invalid("An address segment is not UTF-8."))
}

impl fmt::Display for Address {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let e = encode;
        match self {
            Self::Sequences => write!(f, "{SCHEME}sequences"),
            Self::Sequence(id) => write!(f, "{SCHEME}sequence/{}", e(id)),
            Self::Person { sequence, person } => write!(f, "{SCHEME}sequence/{}/person/{}", e(sequence), e(person)),
            Self::Line { sequence, track, cue } => write!(f, "{SCHEME}sequence/{}/line/{}/{}", e(sequence), e(track), e(cue)),
            Self::SequenceAt { sequence, tc } => write!(f, "{SCHEME}sequence/{}@{tc}", e(sequence)),
            Self::StringOuts => write!(f, "{SCHEME}string-outs"),
            Self::StringOut(id) => write!(f, "{SCHEME}string-out/{}", e(id)),
            Self::Clip { string_out, clip } => write!(f, "{SCHEME}string-out/{}/clip/{}", e(string_out), e(clip)),
            Self::StringOutAt { string_out, tc } => write!(f, "{SCHEME}string-out/{}@{tc}", e(string_out)),
            Self::History(id) => write!(f, "{SCHEME}string-out/{}/history", e(id)),
            Self::Transcripts => write!(f, "{SCHEME}transcripts"),
            Self::Transcript(path) => write!(f, "{SCHEME}transcript/{}", e(path)),
        }
    }
}

impl Address {
    pub fn parse(text: &str) -> Result<Self, AppError> {
        let rest = text.trim().strip_prefix(SCHEME)
            .ok_or_else(|| AppError::invalid(format!("\"{text}\" is not a Sauce Bunny address; they start with {SCHEME}.")))?;
        let parts: Vec<&str> = rest.trim_end_matches('/').split('/').collect();
        let at = |segment: &str| -> Result<(String, Option<String>), AppError> {
            match segment.split_once('@') {
                Some((id, tc)) => Ok((decode(id)?, Some(tc.to_string()))),
                None => Ok((decode(segment)?, None)),
            }
        };
        let unknown = || AppError::invalid(format!("Sauce Bunny has no address \"{text}\"."));
        Ok(match parts.as_slice() {
            ["sequences"] => Self::Sequences,
            ["string-outs"] => Self::StringOuts,
            ["transcripts"] => Self::Transcripts,
            ["sequence", id] => match at(id)? { (sequence, Some(tc)) => Self::SequenceAt { sequence, tc }, (sequence, None) => Self::Sequence(sequence) },
            ["sequence", id, "person", person] => Self::Person { sequence: decode(id)?, person: decode(person)? },
            ["sequence", id, "line", track, cue] => Self::Line { sequence: decode(id)?, track: decode(track)?, cue: decode(cue)? },
            ["string-out", id] => match at(id)? { (string_out, Some(tc)) => Self::StringOutAt { string_out, tc }, (string_out, None) => Self::StringOut(string_out) },
            ["string-out", id, "clip", clip] => Self::Clip { string_out: decode(id)?, clip: decode(clip)? },
            ["string-out", id, "history"] => Self::History(decode(id)?),
            ["transcript", path] => Self::Transcript(decode(path)?),
            _ => return Err(unknown()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_address_round_trips() {
        let all = [
            Address::Sequences, Address::Sequence("9f".repeat(32)),
            Address::Person { sequence: "ab".into(), person: "owner:rosa maría".into() },
            Address::Line { sequence: "ab".into(), track: "track-3".into(), cue: "c 12".into() },
            Address::SequenceAt { sequence: "ab".into(), tc: "01:02:03;04".into() },
            Address::StringOuts, Address::StringOut("7a7a".into()), Address::Clip { string_out: "7a".into(), clip: "seg-1f".into() },
            Address::StringOutAt { string_out: "7a".into(), tc: "01:00:10:00".into() }, Address::History("7a".into()),
            Address::Transcripts, Address::Transcript("/Users/me/Documents/Sauce Bunny/Transcripts/2026-09/Rosa interview.srt".into()),
        ];
        for address in all {
            let text = address.to_string();
            assert!(text.starts_with(SCHEME), "{text}");
            assert!(!text[SCHEME.len()..].contains(' '), "{text}");
            assert_eq!(Address::parse(&text).unwrap(), address, "{text}");
        }
    }

    #[test]
    fn spells_addresses_as_the_app_does() {
        // The same three cases are pinned in src/lib/edit-ask-tools.test.ts, so the two sides cannot drift.
        let line = |track: &str, cue: &str| Address::Line { sequence: "ab".into(), track: track.into(), cue: cue.into() }.to_string();
        assert_eq!(line("track-3", "c 12"), "saucebunny://sequence/ab/line/track-3/c%2012");
        assert_eq!(line("t", "é:1"), "saucebunny://sequence/ab/line/t/%C3%A9:1");
        assert_eq!(line("a/b", "x"), "saucebunny://sequence/ab/line/a%2Fb/x");
    }

    #[test]
    fn refuses_what_it_does_not_know() {
        assert!(Address::parse("https://example.com").is_err());
        assert!(Address::parse("saucebunny://review/abc").is_err());
        assert!(Address::parse("saucebunny://sequence/ab/nope").is_err());
    }
}
