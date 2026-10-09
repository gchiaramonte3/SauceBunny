//! Lines as a model reads them best: one row of text each, with a short id.
//!
//! A line went to the model as a JSON record, and on a 104-mic sequence only
//! 18% of a page was words (docs/ASK-RANGE-SPEC-2026-10-06.md): the rest was
//! field names and each line's address, 64 hex characters of document id plus
//! the track and the cue. A row says the same thing in about a fifth of it:
//!
//! `L7k2qm3a 21:10:53:14-21:11:14:13 CHASE (A3): will now face … [heard from KENDALL]`
//!
//! The id is the first characters of the address's BLAKE3 hash, so one line
//! always gets the same id and a follow-up question can name it again. The
//! context keeps every id it hands out (`LineIds`) and turns one back into
//! its address when the model cites it; an id it never handed out names
//! nothing, and is dropped rather than guessed.
use super::Line;
use std::collections::HashMap;
use std::sync::Mutex;

/// How many characters of hash an id starts with: one line in a sequence of
/// 100,000 is unlikely to share them (a clash takes one more character).
const ID_CHARS: usize = 7;
const ALPHABET: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";

/// The ids handed out so far, both ways.
#[derive(Default)]
pub struct LineIds { inner: Mutex<(HashMap<String, String>, HashMap<String, String>)> }

impl LineIds {
    /// The id for a line's address, minted the first time it is asked for.
    pub fn id(&self, address: &str) -> String {
        let Ok(mut held) = self.inner.lock() else { return address.to_string() };
        if let Some(id) = held.1.get(address) { return id.clone(); }
        let hash = blake3::hash(address.as_bytes());
        let digits: String = hash.as_bytes().iter().map(|byte| ALPHABET[usize::from(*byte) % 36] as char).collect();
        let mut length = ID_CHARS;
        let id = loop {
            let id = format!("L{}", &digits[..length.min(digits.len())]);
            match held.0.get(&id) { Some(other) if other != address && length < digits.len() => length += 1, _ => break id }
        };
        held.0.insert(id.clone(), address.to_string());
        held.1.insert(address.to_string(), id.clone());
        id
    }

    /// The address an id was handed out for, or the text itself when it is already an address.
    pub fn address(&self, cited: &str) -> Option<String> {
        let cited = cited.trim();
        if cited.starts_with(super::address::SCHEME) { return Some(cited.to_string()); }
        self.inner.lock().ok()?.0.get(cited).cloned()
    }
}

/// One line as a row.
pub fn row(line: &Line, ids: &LineIds, string_outs: &HashMap<String, String>) -> String {
    let mut out = format!("{} {}-{} {} ({}): {}", ids.id(&line.line), line.tc_in, line.tc_out, line.who, line.track, line.text);
    if let Some(owner) = &line.bleed_from { out.push_str(&format!(" [heard from {owner}]")); }
    if line.copies > 0 { out.push_str(&format!(" [also on {} {}]", line.copies, if line.copies == 1 { "mic" } else { "mics" })); }
    if !line.in_string_outs.is_empty() {
        let titles: Vec<&str> = line.in_string_outs.iter().map(|address| string_outs.get(address).map(String::as_str).unwrap_or(address.as_str())).collect();
        out.push_str(&format!(" [in: {}]", titles.join("; ")));
    }
    out
}

/// Rows for many lines, one per line of text.
pub fn rows<'a>(lines: impl IntoIterator<Item = &'a Line>, ids: &LineIds, string_outs: &HashMap<String, String>) -> String {
    lines.into_iter().map(|line| row(line, ids, string_outs)).collect::<Vec<_>>().join("\n")
}

/// What a row costs in characters, for page budgets.
pub fn row_chars(line: &Line) -> usize { line.text.len() + line.who.len() + 48 }

#[cfg(test)]
mod tests {
    use super::*;

    fn line(cue: &str, text: &str) -> Line {
        Line { line: format!("saucebunny://sequence/{}/line/branch-39b05686ae40efa2016e5a305c52234e/{cue}", "9a".repeat(32)), who: "KARA".into(), track: "A1".into(), tc_in: "01:00:00:00".into(),
            tc_out: "01:00:02:00".into(), text: text.into(), in_string_outs: vec!["saucebunny://string-out/e1".into()], bleed_from: None, span: [0, 48], copies: 2 }
    }

    #[test]
    fn a_row_says_who_when_and_what_with_an_id_that_comes_back_as_the_address() {
        let ids = LineIds::default();
        let titles = HashMap::from([("saucebunny://string-out/e1".to_string(), "SO Kara".to_string())]);
        let text = row(&line("c1", "I moved here in May."), &ids, &titles);
        let id = text.split(' ').next().unwrap().to_string();
        assert_eq!(text, format!("{id} 01:00:00:00-01:00:02:00 KARA (A1): I moved here in May. [also on 2 mics] [in: SO Kara]"));
        assert!(id.starts_with('L') && id.len() == 1 + ID_CHARS);
        let address = line("c1", "").line;
        assert_eq!(ids.address(&id), Some(address.clone()));
        // The same line gets the same id; a full address is taken as it is; an unknown id names nothing.
        assert_eq!(ids.id(&address), id);
        assert_eq!(ids.address("saucebunny://sequence/x/line/t/c").as_deref(), Some("saucebunny://sequence/x/line/t/c"));
        assert_eq!(ids.address("Lzzzzzzz"), None);
        // A row is a fraction of the record it replaces.
        let record = serde_json::to_string(&line("c1", "I moved here in May.")).unwrap();
        assert!(text.len() * 2 < record.len(), "{} vs {}", text.len(), record.len());
    }
}
