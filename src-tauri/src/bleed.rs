//! Owner, bleed or overtalk for every word on every iso mic
//! (docs/TRANSCRIPT-ACCURACY-SPEC-2026-10-04.md, phase 3).
//!
//! Every person is heard loudest on their own lav. A neighbour's lav a metre
//! or two away hears them roughly 15 to 20 dB quieter, and the same words
//! appear on both transcripts. Meeting transcription has classified close
//! mics this way since the 2000s (Pfau, Ellis and Stolcke 2001; Wrigley et al.
//! 2005; Boakye and Stolcke 2006). Following Boakye, a channel's level is
//! measured against its OWN noise floor, so a hot lav and a quiet one compare
//! fairly: gain raises the speech and the hiss together.
//!
//! Pure: levels and words in, labels out. The thresholds are starting points
//! for the owner's hand-checked scenes (phase 0) to set, and every label is a
//! suggestion the editor can overrule.
use crate::speech::OPEN_DB;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// One reading every 20 ms: fine enough for words, coarse enough that twenty
/// three-hour mics fit in memory (about 2 MB each).
pub const FRAME_SECONDS: f64 = 0.020;
/// Louder than every other mic by this much: the owner, no question.
pub const OWNER_DB: f32 = 10.0;
/// Loudest by at least this much, with the mic open: the owner, probably.
pub const PROBABLE_DB: f32 = 3.0;
/// Another mic this much louder carrying the same words: this copy is bleed.
pub const BLEED_DB: f32 = 6.0;
/// How far apart two copies of a word may start and still be the same word.
pub const MATCH_SECONDS: f64 = 0.150;
/// Level is read over the word plus this much either side.
pub const PAD_SECONDS: f64 = 0.100;
const HZ: f64 = 16_000.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "lowercase")]
#[ts(export, export_to = "../../src/bindings/")]
pub enum AafOwnershipLabel { Owner, Bleed, Overtalk, Offmic, Unsure,
    /// Another cast member's voice, spoken into this mic (leaning into a
    /// neighbour's lav): the voice check's call, with `heard_on` naming who.
    Other }

/// One mic's level, dB per 20 ms frame from the start of the sequence, and the
/// floor under each frame.
pub struct Channel { pub track_id: String, pub levels: Vec<f32>, pub floors: Vec<f32> }

/// One transcribed word, in sequence 16 kHz samples.
#[derive(Debug, Clone)]
pub struct Word { pub track_id: String, pub cue_id: String, pub index: u32, pub text: String, pub start: i64, pub end: i64 }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AafWordOwnership {
    pub track_id: String,
    pub cue_id: String,
    /// The word's position in its cue's text, split on spaces.
    pub index: u32,
    pub label: AafOwnershipLabel,
    /// For bleed: the track whose mic the word was really spoken into.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub heard_on: Option<String>,
    /// This mic's level over the word minus the loudest other mic's, against
    /// each one's own floor.
    pub delta_db: f32,
    /// The editor said so; the resolver did not.
    #[serde(default)]
    pub manual: bool,
}

/// dB per 20 ms frame from a waveform pyramid's base level (min/max pairs of
/// `bucket` samples at `hz`): the loudest bucket in each frame.
pub fn frames(pairs: &[[i16; 2]], hz: u32, bucket: u64) -> Vec<f32> {
    let bucket_seconds = bucket as f64 / f64::from(hz.max(1));
    let levels = crate::speech::levels_db(pairs);
    let count = ((levels.len() as f64 * bucket_seconds) / FRAME_SECONDS).ceil() as usize;
    let mut out = vec![f32::NEG_INFINITY; count.max(1)];
    for (index, level) in levels.iter().enumerate() {
        let frame = ((index as f64 * bucket_seconds) / FRAME_SECONDS) as usize;
        if let Some(slot) = out.get_mut(frame) { *slot = slot.max(*level); }
    }
    for slot in &mut out { if !slot.is_finite() { *slot = -96.0; } }
    out
}

/// The floor under each frame: the 15th percentile of its minute, as the
/// per-mic analysis computes it.
pub fn floors(levels: &[f32]) -> Vec<f32> { crate::speech::floors_db(levels, FRAME_SECONDS) }

fn frame_of(sample: i64) -> usize { ((sample.max(0) as f64 / HZ) / FRAME_SECONDS) as usize }

/// A channel's level over a span against its floor: the 80th percentile of
/// the frames (a click does not count, a syllable does) minus the median floor.
pub fn snr(channel: &Channel, start: i64, end: i64) -> Option<f32> {
    let pad = (PAD_SECONDS * HZ) as i64;
    let (from, to) = (frame_of(start - pad), frame_of(end + pad).max(frame_of(start - pad) + 1));
    let to = to.min(channel.levels.len());
    if from >= to { return None; }
    let mut levels = channel.levels[from..to].to_vec();
    levels.sort_by(f32::total_cmp);
    let mut floors = channel.floors[from..to].to_vec();
    floors.sort_by(f32::total_cmp);
    Some(levels[((levels.len() - 1) as f64 * 0.8).round() as usize] - floors[floors.len() / 2])
}

/// Lowercase letters, digits and apostrophes: "Rosa," and "rosa" are one word.
pub fn normal(text: &str) -> String {
    text.chars().filter(|c| c.is_alphanumeric() || *c == '\'').flat_map(char::to_lowercase).collect()
}

fn distance(a: &str, b: &str) -> usize {
    let b: Vec<char> = b.chars().collect();
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.chars().enumerate() {
        let mut previous = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let next = (row[j + 1] + 1).min(row[j] + 1).min(previous + usize::from(ca != *cb));
            previous = row[j + 1];
            row[j + 1] = next;
        }
    }
    row[b.len()]
}

/// Two recognizers hearing one word through two mics rarely spell it
/// identically: one letter apart counts for words of four letters or more.
pub fn same_word(a: &str, b: &str) -> bool {
    !a.is_empty() && (a == b || (a.chars().count().min(b.chars().count()) >= 4 && distance(a, b) <= 1))
}

/// Label every word. Words on a mic with no measured level, or with no other
/// measured mic to compare against, are left out: unknown, and shown as they
/// always were.
pub fn resolve(channels: &[Channel], words: &[Word]) -> Vec<AafWordOwnership> {
    let index: HashMap<&str, usize> = channels.iter().enumerate().map(|(i, c)| (c.track_id.as_str(), i)).collect();
    // Each track's words by start, normalised once, for the duplicate search.
    let mut by_track: HashMap<&str, Vec<(i64, i64, String)>> = HashMap::new();
    for word in words { by_track.entry(word.track_id.as_str()).or_default().push((word.start, word.end, normal(&word.text))); }
    for list in by_track.values_mut() { list.sort_by_key(|(start, _, _)| *start); }
    let reach = (MATCH_SECONDS * HZ) as i64;
    let carries = |track: &str, start: i64, text: &str| -> bool {
        let Some(list) = by_track.get(track) else { return false };
        let first = list.partition_point(|(s, _, _)| *s < start - reach);
        list[first..].iter().take_while(|(s, _, _)| *s <= start + reach).any(|(_, _, other)| same_word(text, other))
    };
    let tracks: Vec<&str> = by_track.keys().copied().collect();
    let copies_of = |track: &str, start: i64, text: &str| -> Vec<&str> { tracks.iter().copied().filter(|other| *other != track && carries(other, start, text)).collect() };
    // Words no other mic heard, by track: someone speaking on their own lav.
    // Measured on AFF BANK 1: 55% of spoken words were heard on one mic only.
    let mut unique: HashMap<&str, Vec<(i64, i64)>> = HashMap::new();
    for (track, list) in &by_track {
        for (start, end, text) in list {
            if !text.is_empty() && copies_of(track, *start, text).is_empty() { unique.entry(track).or_default().push((*start, *end)); }
        }
    }
    let speaking = |track: &str, start: i64, end: i64| unique.get(track).is_some_and(|spans| spans.iter().any(|(s, e)| *s < end && start < *e));
    let mut out = Vec::new();
    for word in words {
        let Some(&mine) = index.get(word.track_id.as_str()) else { continue };
        let Some(own) = snr(&channels[mine], word.start, word.end) else { continue };
        let others: Vec<(&str, f32)> = channels.iter().enumerate().filter(|(i, _)| *i != mine)
            .filter_map(|(_, channel)| snr(channel, word.start, word.end).map(|level| (channel.track_id.as_str(), level))).collect();
        let Some(&(_, loudest)) = others.iter().max_by(|a, b| a.1.total_cmp(&b.1)) else { continue };
        let delta = own - loudest;
        let text = normal(&word.text);
        let label = |label, heard_on: Option<&str>| AafWordOwnership { track_id: word.track_id.clone(), cue_id: word.cue_id.clone(),
            index: word.index, label, heard_on: heard_on.map(str::to_string), delta_db: (delta * 10.0).round() / 10.0, manual: false };
        if delta >= OWNER_DB { out.push(label(AafOwnershipLabel::Owner, None)); continue; }
        let copies = copies_of(&word.track_id, word.start, &text);
        if copies.is_empty() {
            // Only this mic heard it, so no other mic owns it. Ten dB or more
            // under the loudest mic it is more likely that mic's line misheard
            // than this owner speaking, so it stays unsure. Otherwise it is the
            // owner's, and someone else speaking their own words at the same
            // moment makes it overtalk: two people, each on their own lav.
            let talking = others.iter().any(|(track, level)| *level >= OPEN_DB && speaking(track, word.start, word.end));
            out.push(label(if delta <= -OWNER_DB { AafOwnershipLabel::Unsure }
                else if talking && own >= OPEN_DB { AafOwnershipLabel::Overtalk } else { AafOwnershipLabel::Owner }, None));
            continue;
        }
        let source = others.iter().filter(|(track, level)| level - own >= BLEED_DB && copies.contains(track))
            .max_by(|a, b| a.1.total_cmp(&b.1));
        if let Some((track, _)) = source { out.push(label(AafOwnershipLabel::Bleed, Some(track))); continue; }
        // Faint on every mic that heard it, and heard on three or more: someone
        // with no lav (crew, a producer). Faint means under OPEN_DB - 4, since
        // quiet lavs put ordinary speech just under OPEN_DB (AFF BANK 1's own
        // words sit at about 11 dB over the floor).
        let faint = OPEN_DB - 4.0;
        let everywhere = own < faint && copies.iter().all(|track| others.iter().any(|(other, level)| other == track && *level < faint));
        if copies.len() >= 2 && everywhere { out.push(label(AafOwnershipLabel::Offmic, None)); continue; }
        out.push(label(if delta >= PROBABLE_DB && own >= OPEN_DB { AafOwnershipLabel::Owner } else { AafOwnershipLabel::Unsure }, None));
    }
    out
}

/// The words no other mic heard, by (track, cue, index): someone speaking on
/// their own lav. The voice check learns voices from these when no mic
/// clearly dominates (AFF BANK 1: no stretch was 15 dB louder than the rest).
pub fn unique_words(words: &[Word]) -> std::collections::HashSet<(String, String, u32)> {
    let reach = (MATCH_SECONDS * HZ) as i64;
    let mut sorted: Vec<&Word> = words.iter().collect();
    sorted.sort_by_key(|word| word.start);
    let mut out = std::collections::HashSet::new();
    for (i, word) in sorted.iter().enumerate() {
        let text = normal(&word.text);
        if text.is_empty() { continue; }
        let first = sorted.partition_point(|other| other.start < word.start - reach);
        let shared = sorted[first..].iter().take_while(|other| other.start <= word.start + reach).enumerate()
            .any(|(j, other)| first + j != i && other.track_id != word.track_id && same_word(&text, &normal(&other.text)));
        if !shared { out.insert((word.track_id.clone(), word.cue_id.clone(), word.index)); }
    }
    out
}

/// Whether another mic heard the same word at about the same moment.
pub fn heard_on(words: &[Word], track: &str, start: i64, text: &str) -> bool {
    let reach = (MATCH_SECONDS * HZ) as i64;
    let text = normal(text);
    words.iter().any(|other| other.track_id == track && (other.start - start).abs() <= reach && same_word(&text, &normal(&other.text)))
}

/// How far apart a document's mics are, from the words heard on more than
/// one: the median of how much louder the loudest copy is than the next.
/// Measured on AFF BANK 1 at 0.8 dB: levels there settle very few lines, and
/// the reader says so rather than implying the labels are sure.
pub fn separation(channels: &[Channel], words: &[Word]) -> Option<f32> {
    let index: HashMap<&str, &Channel> = channels.iter().map(|channel| (channel.track_id.as_str(), channel)).collect();
    let reach = (MATCH_SECONDS * HZ) as i64;
    let mut sorted: Vec<&Word> = words.iter().filter(|word| index.contains_key(word.track_id.as_str())).collect();
    sorted.sort_by_key(|word| word.start);
    let mut used = vec![false; sorted.len()];
    let mut gaps = Vec::new();
    for i in 0..sorted.len() {
        if used[i] { continue; }
        let text = normal(&sorted[i].text);
        if text.is_empty() { continue; }
        let mut levels = vec![];
        let mut seen: Vec<&str> = vec![];
        for j in i..sorted.len() {
            if sorted[j].start - sorted[i].start > reach { break; }
            let word = sorted[j];
            if used[j] || seen.contains(&word.track_id.as_str()) || !same_word(&text, &normal(&word.text)) { continue; }
            used[j] = true;
            seen.push(word.track_id.as_str());
            if let Some(level) = snr(index[word.track_id.as_str()], word.start, word.end) { levels.push(level); }
        }
        if levels.len() >= 2 {
            levels.sort_by(|a, b| b.total_cmp(a));
            gaps.push(levels[0] - levels[1]);
        }
    }
    if gaps.is_empty() { return None; }
    gaps.sort_by(f32::total_cmp);
    Some(gaps[gaps.len() / 2])
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A channel at a -60 dB floor with speech at the given (from, to, dB)
    /// stretches, in seconds, over `seconds` of sequence.
    fn channel(track: &str, seconds: f64, speech: &[(f64, f64, f32)]) -> Channel {
        let count = (seconds / FRAME_SECONDS) as usize;
        let mut levels = vec![-60.0f32; count];
        for &(from, to, db) in speech {
            let (first, last) = ((from / FRAME_SECONDS) as usize, ((to / FRAME_SECONDS) as usize).min(count));
            for level in levels.iter_mut().take(last).skip(first) { *level = db; }
        }
        let floors = floors(&levels);
        Channel { track_id: track.into(), levels, floors }
    }
    fn word(track: &str, text: &str, from: f64, to: f64) -> Word {
        Word { track_id: track.into(), cue_id: format!("{track}-c"), index: 0, text: text.into(), start: (from * HZ) as i64, end: (to * HZ) as i64 }
    }
    fn label_of(out: &[AafWordOwnership], track: &str) -> Option<AafOwnershipLabel> { out.iter().find(|w| w.track_id == track).map(|w| w.label) }

    #[test]
    fn the_loud_copy_is_the_owner_and_the_quiet_copy_with_the_same_word_is_bleed() {
        // Rosa says "kitchen" at 10 s: -20 dB on her lav, -38 dB on Dev's.
        let rosa = channel("rosa", 60.0, &[(10.0, 10.5, -20.0)]);
        let dev = channel("dev", 60.0, &[(10.0, 10.5, -38.0)]);
        let words = [word("rosa", "kitchen", 10.0, 10.5), word("dev", "Kitchen.", 10.02, 10.5)];
        let out = resolve(&[rosa, dev], &words);
        assert_eq!(label_of(&out, "rosa"), Some(AafOwnershipLabel::Owner));
        let dev = out.iter().find(|w| w.track_id == "dev").unwrap();
        assert_eq!((dev.label, dev.heard_on.as_deref()), (AafOwnershipLabel::Bleed, Some("rosa")));
        assert!(dev.delta_db <= -BLEED_DB);
    }

    #[test]
    fn gain_does_not_decide_ownership_the_floor_does() {
        // Dev's lav is set 12 dB hot: his floor AND his bleed are both higher.
        // Against its own floor Rosa's mic still hears her 18 dB louder.
        let rosa = channel("rosa", 60.0, &[(10.0, 10.5, -20.0)]);
        let mut dev = channel("dev", 60.0, &[(10.0, 10.5, -38.0)]);
        for level in &mut dev.levels { *level += 12.0; }
        dev.floors = floors(&dev.levels);
        let out = resolve(&[rosa, dev], &[word("rosa", "kitchen", 10.0, 10.5), word("dev", "kitchen", 10.0, 10.5)]);
        assert_eq!(label_of(&out, "dev"), Some(AafOwnershipLabel::Bleed));
    }

    #[test]
    fn two_people_talking_at_once_on_their_own_lavs_are_both_kept() {
        // Overtalk: each mic hears its own wearer loudly, and the words differ.
        let rosa = channel("rosa", 60.0, &[(10.0, 11.0, -22.0)]);
        let dev = channel("dev", 60.0, &[(10.0, 11.0, -24.0)]);
        let out = resolve(&[rosa, dev], &[word("rosa", "stop", 10.2, 10.6), word("dev", "listen", 10.3, 10.7)]);
        assert_eq!(label_of(&out, "rosa"), Some(AafOwnershipLabel::Overtalk));
        assert_eq!(label_of(&out, "dev"), Some(AafOwnershipLabel::Overtalk));
    }

    #[test]
    fn a_quiet_copy_without_the_same_words_is_never_called_bleed() {
        // Hiding a real line is worse than showing a duplicate: no other mic
        // heard "whisper", so it is never bleed. 20 dB under Rosa's mic it is
        // more likely her line misheard than Dev talking, so it stays unsure;
        // a few dB under, it is Dev's own.
        let rosa = channel("rosa", 60.0, &[(10.0, 10.5, -20.0)]);
        let dev = channel("dev", 60.0, &[(10.0, 10.5, -40.0)]);
        let out = resolve(&[rosa, dev], &[word("rosa", "kitchen", 10.0, 10.5), word("dev", "whisper", 10.0, 10.5)]);
        assert_eq!(label_of(&out, "dev"), Some(AafOwnershipLabel::Unsure));
        let rosa = channel("rosa", 60.0, &[(20.0, 20.5, -30.0)]);
        let dev = channel("dev", 60.0, &[(10.0, 10.5, -33.0)]);
        let out = resolve(&[rosa, dev], &[word("dev", "whisper", 10.0, 10.5)]);
        assert_eq!(label_of(&out, "dev"), Some(AafOwnershipLabel::Owner));
    }

    #[test]
    fn copies_at_almost_the_same_level_stay_visible_as_unsure() {
        // AFF BANK 1's reality: the same word on two mics about 1 dB apart.
        // Level cannot say whose it is, so neither copy is hidden.
        let a = channel("a", 60.0, &[(10.0, 10.5, -40.0)]);
        let b = channel("b", 60.0, &[(10.0, 10.5, -41.0)]);
        let out = resolve(&[a, b], &[word("a", "kitchen", 10.0, 10.5), word("b", "kitchen", 10.02, 10.5)]);
        assert!(out.iter().all(|w| w.label == AafOwnershipLabel::Unsure), "{out:?}");
    }

    #[test]
    fn a_word_only_one_mic_heard_is_unique_and_a_shared_one_is_not() {
        let words = [word("rosa", "kitchen", 10.0, 10.5), word("dev", "Kitchen,", 10.05, 10.5), word("rosa", "alone", 20.0, 20.5), word("dev", "alone", 25.0, 25.5)];
        let unique = unique_words(&words);
        assert_eq!(unique.len(), 2, "only the two far-apart 'alone's are unique: {unique:?}");
        assert!(heard_on(&words, "dev", (10.0 * HZ) as i64, "kitchen"));
        assert!(!heard_on(&words, "dev", (20.0 * HZ) as i64, "alone"), "five seconds apart is not the same moment");
    }

    #[test]
    fn separation_is_how_far_the_loudest_copy_sits_above_the_next() {
        let rosa = channel("rosa", 60.0, &[(10.0, 10.5, -20.0), (20.0, 20.5, -30.0)]);
        let dev = channel("dev", 60.0, &[(10.0, 10.5, -38.0), (20.0, 20.5, -32.0)]);
        let words = [word("rosa", "kitchen", 10.0, 10.5), word("dev", "kitchen", 10.0, 10.5), word("rosa", "door", 20.0, 20.5), word("dev", "door", 20.0, 20.5), word("rosa", "alone", 30.0, 30.5)];
        // Two shared words: 18 dB apart and 2 dB apart; the word only Rosa heard does not count.
        let gap = separation(&[rosa, dev], &words).unwrap();
        assert!((gap - 18.0).abs() < 0.5 || (gap - 2.0).abs() < 0.5, "{gap}");
        assert!(separation(&[], &words).is_none());
    }

    #[test]
    fn someone_on_no_lav_is_off_mic() {
        // A producer off camera: faint on three lavs (6 dB over the floor), the same word on each.
        let quiet = |track| channel(track, 60.0, &[(10.0, 10.5, -54.0)]);
        let words = [word("a", "again", 10.0, 10.5), word("b", "again", 10.0, 10.5), word("c", "again", 10.0, 10.5)];
        let out = resolve(&[quiet("a"), quiet("b"), quiet("c")], &words);
        assert!(out.iter().all(|w| w.label == AafOwnershipLabel::Offmic), "{out:?}");
    }

    #[test]
    fn a_word_with_nothing_to_compare_against_gets_no_label() {
        let rosa = channel("rosa", 60.0, &[(10.0, 10.5, -20.0)]);
        assert!(resolve(&[rosa], &[word("rosa", "kitchen", 10.0, 10.5)]).is_empty());
        // A track that was never measured is not compared, and its words are left alone.
        let rosa = channel("rosa", 60.0, &[(10.0, 10.5, -20.0)]);
        let dev = channel("dev", 60.0, &[]);
        let out = resolve(&[rosa, dev], &[word("ghost", "kitchen", 10.0, 10.5)]);
        assert!(out.is_empty());
    }

    #[test]
    fn spelling_differences_between_two_recognizers_still_match() {
        assert!(same_word(&normal("Kitchen,"), &normal("kitchen")));
        assert!(same_word("kitchen", "kitchens"));
        assert!(!same_word("cat", "car"), "short words must match exactly");
        assert!(!same_word("", ""));
    }

    #[test]
    fn frames_keep_the_loudest_bucket_and_cover_the_sequence() {
        // 48 kHz, 240-sample buckets (5 ms): four buckets a frame.
        let mut pairs = vec![[-30i16, 30]; 400];
        pairs[5] = [-16384, 16384];
        let out = frames(&pairs, 48_000, 240);
        assert_eq!(out.len(), 100);
        assert!((out[1] - (-6.0)).abs() < 0.1, "{}", out[1]);
        assert!(out[2] < -60.0);
    }
}
