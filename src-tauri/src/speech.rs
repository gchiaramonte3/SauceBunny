//! Per-microphone speech analysis for the Transcript Editor, from the waveform
//! pyramid AAF Audio already caches (min/max per ~5 ms bucket). No second pass
//! over the audio, no model, nothing leaves the Mac.
//!
//! What it answers, per track:
//! * the mic's own noise floor, which moves as a lav walks between rooms, so it
//!   is the 15th percentile of each minute rather than one number;
//! * where the mic is OPEN (someone is audible on it), with hysteresis so a
//!   word's tail does not flicker the state: it opens 12 dB over the floor and
//!   closes under 8 dB over it, must stay open 60 ms to count, and closes
//!   shorter than 250 ms are bridged;
//! * REACTIONS: bursts at least 18 dB over the floor that no transcribed word
//!   covers. A laugh, a gasp, a door. In a reality scene those are content,
//!   and dead-space removal must keep them;
//! * word boundaries inside a transcript cue. When the recognizer measured its
//!   words (Parakeet), those times are used and each boundary moves to the
//!   quietest point within 40 ms. Otherwise words are spread across the cue by
//!   length and each boundary moves to the quietest point within 80 ms, which
//!   is where a cut between them does least harm.
//!
//! Levels are peak dBFS per bucket, as Auto-Editor and most silence removers
//! use: a peak is what a listener hears as "something there".
use serde::{Deserialize, Serialize};

pub const OPEN_DB: f32 = 12.0;
pub const CLOSE_DB: f32 = 8.0;
pub const REACTION_DB: f32 = 18.0;
pub const MIN_OPEN_SECONDS: f64 = 0.060;
pub const BRIDGE_SECONDS: f64 = 0.250;
pub const FLOOR_BLOCK_SECONDS: f64 = 60.0;
pub const FLOOR_PERCENTILE: f64 = 0.15;
pub const WORD_SNAP_SECONDS: f64 = 0.080;
/// Half the reach for words the recognizer timed itself: they start close to
/// right, so the snap only finds the gap, it does not go looking for one.
pub const MEASURED_SNAP_SECONDS: f64 = 0.040;
/// Silence is not -inf: this is below any real mic's self-noise.
const SILENT_DB: f32 = -96.0;

/// A range in buckets, end exclusive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

/// Peak dBFS of each bucket from its min/max pair.
pub fn levels_db(pairs: &[[i16; 2]]) -> Vec<f32> {
    pairs
        .iter()
        .map(|pair| {
            let peak = (i32::from(pair[0]).abs()).max(i32::from(pair[1]).abs()) as f32 / 32768.0;
            if peak <= 0.0 { SILENT_DB } else { (20.0 * peak.log10()).max(SILENT_DB) }
        })
        .collect()
}

/// The noise floor under each bucket: the 15th percentile of its minute.
pub fn floors_db(levels: &[f32], bucket_seconds: f64) -> Vec<f32> {
    if levels.is_empty() {
        return vec![];
    }
    let block = ((FLOOR_BLOCK_SECONDS / bucket_seconds).round() as usize).max(1);
    let mut out = Vec::with_capacity(levels.len());
    for chunk in levels.chunks(block) {
        let mut sorted = chunk.to_vec();
        sorted.sort_by(f32::total_cmp);
        let floor = sorted[((sorted.len() - 1) as f64 * FLOOR_PERCENTILE).round() as usize];
        out.extend(std::iter::repeat_n(floor, chunk.len()));
    }
    out
}

/// Where the mic is open, with hysteresis, minimum length and bridging.
pub fn activity(levels: &[f32], floors: &[f32], bucket_seconds: f64) -> Vec<Span> {
    let min_open = (MIN_OPEN_SECONDS / bucket_seconds).ceil() as usize;
    let bridge = (BRIDGE_SECONDS / bucket_seconds).floor() as usize;
    let mut raw: Vec<Span> = Vec::new();
    let mut open: Option<usize> = None;
    for (index, (level, floor)) in levels.iter().zip(floors).enumerate() {
        match open {
            None if *level >= floor + OPEN_DB => open = Some(index),
            Some(start) if *level < floor + CLOSE_DB => {
                raw.push(Span { start, end: index });
                open = None;
            }
            _ => {}
        }
    }
    if let Some(start) = open {
        raw.push(Span { start, end: levels.len() });
    }
    let mut bridged: Vec<Span> = Vec::new();
    for span in raw {
        match bridged.last_mut() {
            Some(last) if span.start - last.end < bridge => last.end = span.end,
            _ => bridged.push(span),
        }
    }
    bridged.retain(|span| span.end - span.start >= min_open.max(1));
    bridged
}

/// Loud bursts no word covers: kept by dead-space removal, flagged to the editor.
pub fn reactions(levels: &[f32], floors: &[f32], words: &[Span], bucket_seconds: f64) -> Vec<Span> {
    let loud: Vec<Span> = {
        let mut spans = Vec::new();
        let mut open: Option<usize> = None;
        for (index, (level, floor)) in levels.iter().zip(floors).enumerate() {
            let hot = *level >= floor + REACTION_DB;
            match (open, hot) {
                (None, true) => open = Some(index),
                (Some(start), false) => {
                    spans.push(Span { start, end: index });
                    open = None;
                }
                _ => {}
            }
        }
        if let Some(start) = open {
            spans.push(Span { start, end: levels.len() });
        }
        spans
    };
    let min = (MIN_OPEN_SECONDS / bucket_seconds).ceil() as usize;
    loud.into_iter()
        .filter(|span| span.end - span.start >= min.max(1))
        .filter(|span| !words.iter().any(|word| word.start < span.end && span.start < word.end))
        .collect()
}

/// Split a cue's text into words and place them inside [start, end) buckets.
/// Returns one span per word, in order, contiguous and covering the cue. With
/// more words than buckets some spans are empty; order is still kept.
pub fn place_words(text: &str, start: usize, end: usize, levels: &[f32], bucket_seconds: f64) -> Vec<(String, Span)> {
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.is_empty() || end <= start {
        return vec![];
    }
    let weights: Vec<usize> = words.iter().map(|word| word.chars().filter(|c| c.is_alphanumeric()).count().max(1) + 1).collect();
    let total: usize = weights.iter().sum();
    let length = end - start;
    let mut bounds = vec![start];
    let mut sum = 0;
    for weight in &weights[..weights.len() - 1] {
        sum += weight;
        bounds.push(start + length * sum / total);
    }
    bounds.push(end);
    snap(&mut bounds, levels, (WORD_SNAP_SECONDS / bucket_seconds).round() as usize);
    words.iter().enumerate().map(|(index, word)| (word.to_string(), Span { start: bounds[index], end: bounds[index + 1] })).collect()
}

/// Place words the recognizer timed: each inner boundary starts in the gap
/// between two measured words (or where they meet) and snaps to the quietest
/// bucket within 40 ms. Spans stay contiguous and cover the cue, as estimated
/// ones do, so everything downstream treats both alike.
pub fn place_measured(words: &[(String, usize, usize)], start: usize, end: usize, levels: &[f32], bucket_seconds: f64) -> Vec<(String, Span)> {
    if words.is_empty() || end <= start {
        return vec![];
    }
    let mut bounds = vec![start];
    for pair in words.windows(2) {
        let (gap_from, gap_to) = (pair[0].2.min(pair[1].1), pair[1].1);
        let inner = (gap_from + gap_to) / 2;
        let floor = bounds.last().copied().unwrap_or(start);
        bounds.push(inner.clamp(floor, end));
    }
    bounds.push(end);
    snap(&mut bounds, levels, (MEASURED_SNAP_SECONDS / bucket_seconds).round() as usize);
    words.iter().enumerate().map(|(index, (text, _, _))| (text.clone(), Span { start: bounds[index], end: bounds[index + 1] })).collect()
}

/// Move each inner boundary to the quietest bucket within reach, never past
/// its neighbours, so words stay in order and non-empty.
fn snap(bounds: &mut [usize], levels: &[f32], reach: usize) {
    for index in 1..bounds.len() - 1 {
        let low = bounds[index - 1] + 1;
        let high = bounds[index + 1].saturating_sub(1);
        if low > high {
            continue;
        }
        let from = bounds[index].saturating_sub(reach).max(low);
        let to = (bounds[index] + reach).min(high).min(levels.len().saturating_sub(1));
        if from > to {
            continue;
        }
        let mut best = bounds[index].clamp(from, to);
        for candidate in from..=to {
            if levels[candidate] < levels[best] {
                best = candidate;
            }
        }
        bounds[index] = best;
    }
}

/// One track's analysis, in the 16 kHz sample units transcript cues use.
#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AafSpeech {
    pub track_id: String,
    /// Median noise floor, dBFS: context for the editor, not used for decisions.
    pub floor_db: f32,
    #[ts(type = "Array<[number, number]>")]
    pub activity: Vec<(i64, i64)>,
    #[ts(type = "Array<[number, number]>")]
    pub reactions: Vec<(i64, i64)>,
    pub words: Vec<AafWord>,
    /// False when the track's waveform was never built. Words are then placed
    /// by length alone, and `activity` and `reactions` are empty because
    /// nobody measured them, not because the mic was quiet. Anything that
    /// would treat empty as silence (dead-space removal) must check this.
    pub measured: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AafWord {
    pub cue_id: String,
    pub text: String,
    #[ts(type = "number")]
    pub start_sample: i64,
    #[ts(type = "number")]
    pub end_sample: i64,
    /// The recognizer's confidence, 0 to 1, when it measured this word. Absent
    /// for words placed by length.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub confidence: Option<f32>,
}

/// A cue as the analysis needs it: id, 16 kHz start and end, text, and the
/// words the recognizer timed, if it did.
pub struct CueInput<'a> {
    pub id: &'a str,
    pub start_sample: i64,
    pub end_sample: i64,
    pub text: &'a str,
    pub words: Option<&'a [crate::commands::aaf::model::AafCueWord]>,
}

/// The cue's measured words when they still spell its text; None sends it to
/// the length estimate (a cue edited after recognition, or a Whisper run).
fn measured<'a>(cue: &CueInput<'a>) -> Option<&'a [crate::commands::aaf::model::AafCueWord]> {
    let words = cue.words.filter(|words| !words.is_empty())?;
    let spelled = words.iter().map(|word| word.text.as_str()).collect::<Vec<_>>().join(" ");
    (spelled == cue.text.split_whitespace().collect::<Vec<_>>().join(" ")).then_some(words)
}

const ASR_HZ: f64 = 16_000.0;

/// Analyse one track's pyramid base level (`bucket` source samples at `hz`).
pub fn analyse(track_id: &str, pairs: &[[i16; 2]], hz: u32, bucket: u64, cues: &[CueInput]) -> AafSpeech {
    let bucket_seconds = bucket as f64 / f64::from(hz.max(1));
    let levels = levels_db(pairs);
    let floors = floors_db(&levels, bucket_seconds);
    let to_bucket = |sample: i64| (((sample.max(0) as f64) / ASR_HZ / bucket_seconds).round() as usize).min(levels.len());
    let to_sample = |index: usize| (index as f64 * bucket_seconds * ASR_HZ).round() as i64;
    let mut words = Vec::new();
    let mut spans = Vec::new();
    for cue in cues {
        let (start, end) = (to_bucket(cue.start_sample), to_bucket(cue.end_sample));
        let (placed, confidences): (Vec<(String, Span)>, Vec<Option<f32>>) = match measured(cue) {
            Some(timed) => {
                let input: Vec<(String, usize, usize)> = timed.iter().map(|word| (word.text.clone(), to_bucket(word.start_sample), to_bucket(word.end_sample))).collect();
                (place_measured(&input, start, end, &levels, bucket_seconds), timed.iter().map(|word| Some(word.confidence)).collect())
            }
            None => {
                let placed = place_words(cue.text, start, end, &levels, bucket_seconds);
                let none = vec![None; placed.len()];
                (placed, none)
            }
        };
        for ((text, span), confidence) in placed.into_iter().zip(confidences) {
            spans.push(span);
            words.push(AafWord { cue_id: cue.id.to_string(), text, start_sample: to_sample(span.start), end_sample: to_sample(span.end), confidence });
        }
    }
    let pair = |span: &Span| (to_sample(span.start), to_sample(span.end));
    let mut sorted = floors.clone();
    sorted.sort_by(f32::total_cmp);
    AafSpeech {
        track_id: track_id.to_string(),
        floor_db: sorted.get(sorted.len() / 2).copied().unwrap_or(SILENT_DB),
        activity: activity(&levels, &floors, bucket_seconds).iter().map(pair).collect(),
        reactions: reactions(&levels, &floors, &spans, bucket_seconds).iter().map(pair).collect(),
        words,
        measured: true,
    }
}

/// One track's words without its waveform: each cue split across its words by
/// length, with no snapping to quiet points. Building a waveform means reading
/// every source the track uses, which on a network volume takes minutes a
/// track, so the transcript is readable first and measured when asked.
pub fn unmeasured(track_id: &str, cues: &[CueInput]) -> AafSpeech {
    let mut words = Vec::new();
    for cue in cues {
        // One bucket per 16 kHz sample, and no levels, so nothing moves.
        let (start, end) = (cue.start_sample.max(0) as usize, cue.end_sample.max(0) as usize);
        if let Some(timed) = measured(cue) {
            // Measured times need no waveform: they are used as they came.
            let input: Vec<(String, usize, usize)> = timed.iter().map(|word| (word.text.clone(), word.start_sample.max(0) as usize, word.end_sample.max(0) as usize)).collect();
            for ((text, span), word) in place_measured(&input, start, end, &[], 1.0 / ASR_HZ).into_iter().zip(timed) {
                words.push(AafWord { cue_id: cue.id.to_string(), text, start_sample: span.start as i64, end_sample: span.end as i64, confidence: Some(word.confidence) });
            }
            continue;
        }
        for (text, span) in place_words(cue.text, start, end, &[], 1.0 / ASR_HZ) {
            words.push(AafWord { cue_id: cue.id.to_string(), text, start_sample: span.start as i64, end_sample: span.end as i64, confidence: None });
        }
    }
    AafSpeech { track_id: track_id.to_string(), floor_db: SILENT_DB, activity: vec![], reactions: vec![], words, measured: false }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BUCKET: f64 = 0.005; // 256 samples at ~48 kHz

    /// Floor at about -60 dBFS, speech at about -20 dBFS.
    fn signal(pattern: &[(usize, i16)]) -> Vec<[i16; 2]> {
        pattern.iter().flat_map(|(count, peak)| std::iter::repeat_n([-*peak, *peak], *count)).collect()
    }

    #[test]
    fn levels_are_peak_dbfs() {
        let levels = levels_db(&[[0, 0], [-16384, 100], [-10, 32767]]);
        assert_eq!(levels[0], SILENT_DB);
        assert!((levels[1] - -6.02).abs() < 0.05);
        assert!(levels[2].abs() < 0.01);
    }

    #[test]
    fn the_floor_follows_each_minute() {
        let mut levels = vec![-60.0_f32; 12_000];
        levels.extend(vec![-40.0_f32; 12_000]);
        let floors = floors_db(&levels, BUCKET);
        assert_eq!(floors[0], -60.0);
        assert_eq!(floors[20_000], -40.0);
    }

    #[test]
    fn a_mic_opens_on_speech_bridges_short_gaps_and_ignores_clicks() {
        // quiet, 0.5 s speech, 0.1 s pause, 0.5 s speech, quiet, 10 ms click, quiet
        let pairs = signal(&[(400, 33), (100, 3276), (20, 33), (100, 3276), (400, 33), (2, 3276), (400, 33)]);
        let levels = levels_db(&pairs);
        let floors = floors_db(&levels, BUCKET);
        let spans = activity(&levels, &floors, BUCKET);
        assert_eq!(spans, vec![Span { start: 400, end: 620 }]);
    }

    #[test]
    fn a_long_pause_is_two_openings() {
        let pairs = signal(&[(400, 33), (100, 3276), (200, 33), (100, 3276), (400, 33)]);
        let levels = levels_db(&pairs);
        let spans = activity(&levels, &floors_db(&levels, BUCKET), BUCKET);
        assert_eq!(spans.len(), 2);
    }

    #[test]
    fn a_loud_burst_with_no_word_is_a_reaction_and_a_worded_one_is_not() {
        let pairs = signal(&[(400, 33), (60, 16000), (400, 33), (60, 16000), (400, 33)]);
        let levels = levels_db(&pairs);
        let floors = floors_db(&levels, BUCKET);
        let words = [Span { start: 860, end: 930 }];
        assert_eq!(reactions(&levels, &floors, &words, BUCKET), vec![Span { start: 400, end: 460 }]);
    }

    #[test]
    fn words_cover_the_cue_in_order_and_boundaries_move_into_the_gap_between_them() {
        // "Okay everybody": a loud 60-bucket word, a 10-bucket dip, another word.
        let mut pairs = signal(&[(60, 16000), (10, 40), (80, 16000)]);
        pairs.extend(signal(&[(10, 33)]));
        let levels = levels_db(&pairs);
        let words = place_words("Okay everybody", 0, 150, &levels, BUCKET);
        assert_eq!(words.len(), 2);
        assert_eq!(words[0].1.start, 0);
        assert_eq!(words[1].1.end, 150);
        assert_eq!(words[0].1.end, words[1].1.start);
        // Snapped into the dip (buckets 60..70), not left at the length split.
        assert!((60..70).contains(&words[0].1.end), "boundary at {}", words[0].1.end);
    }

    #[test]
    fn analyse_reports_in_asr_samples_and_keeps_worded_speech_out_of_reactions() {
        // 48 kHz, 256-sample buckets: 0.4 s quiet, 0.3 s loud (a word), 0.4 s quiet, 0.3 s loud (a laugh).
        let pairs = signal(&[(75, 33), (56, 16000), (75, 33), (56, 16000), (75, 33)]);
        let cue = CueInput { id: "c1", start_sample: 6_400, end_sample: 11_200, text: "Hi", words: None };
        let speech = analyse("t", &pairs, 48_000, 256, &[cue]);
        assert_eq!(speech.words.len(), 1);
        assert!((speech.words[0].start_sample - 6_400).abs() <= 90);
        assert_eq!(speech.activity.len(), 2);
        assert_eq!(speech.reactions.len(), 1);
        assert!(speech.reactions[0].0 > 11_000);
        assert!(speech.floor_db < -50.0);
    }

    #[test]
    fn unmeasured_words_split_each_cue_by_length_and_claim_no_activity() {
        let cues = [
            CueInput { id: "c1", start_sample: 16_000, end_sample: 32_000, text: "Okay everybody", words: None },
            CueInput { id: "c2", start_sample: 40_000, end_sample: 48_000, text: "go", words: None },
        ];
        let speech = unmeasured("t", &cues);
        assert!(!speech.measured);
        assert!(speech.activity.is_empty() && speech.reactions.is_empty());
        let words: Vec<_> = speech.words.iter().map(|w| (w.cue_id.as_str(), w.text.as_str(), w.start_sample, w.end_sample)).collect();
        // "Okay" weighs 5 and "everybody" 10: the split sits a third of the way in.
        assert_eq!(words, vec![("c1", "Okay", 16_000, 21_333), ("c1", "everybody", 21_333, 32_000), ("c2", "go", 40_000, 48_000)]);
        assert!(analyse("t", &signal(&[(10, 33)]), 48_000, 256, &[]).measured);
    }

    #[test]
    fn place_words_handles_edges() {
        assert!(place_words("", 0, 10, &[0.0; 10], BUCKET).is_empty());
        assert!(place_words("one", 5, 5, &[0.0; 10], BUCKET).is_empty());
        let one = place_words("one", 2, 9, &[0.0; 10], BUCKET);
        assert_eq!(one[0].1, Span { start: 2, end: 9 });
        // More words than buckets still yields ordered, non-overlapping spans.
        let many = place_words("a b c d e f", 0, 3, &[0.0; 3], BUCKET);
        assert_eq!(many.len(), 6);
        assert!(many.windows(2).all(|pair| pair[0].1.end <= pair[1].1.start || pair[0].1.end == pair[1].1.start));
    }

    fn timed(text: &str, start: i64, end: i64) -> crate::commands::aaf::model::AafCueWord {
        crate::commands::aaf::model::AafCueWord { text: text.into(), start_sample: start, end_sample: end, confidence: 0.75 }
    }

    #[test]
    fn measured_words_are_used_as_timed_not_spread_by_length() {
        // "a" is short and "wonderful" long: by length "a" would get a sliver;
        // measured, it got a whole second.
        let words = [timed("a", 0, 16_000), timed("wonderful", 16_000, 20_000)];
        let cue = CueInput { id: "c", start_sample: 0, end_sample: 20_000, text: "a wonderful", words: Some(&words) };
        let out = unmeasured("t", &[cue]);
        assert_eq!(out.words.iter().map(|w| (w.start_sample, w.end_sample)).collect::<Vec<_>>(), [(0, 16_000), (16_000, 20_000)]);
        assert_eq!(out.words[0].confidence, Some(0.75));
        // An edited cue no longer matches its words: back to the estimate.
        let edited = CueInput { id: "c", start_sample: 0, end_sample: 20_000, text: "a marvellous", words: Some(&words) };
        let out = unmeasured("t", &[edited]);
        assert_ne!(out.words[0].end_sample, 16_000);
        assert_eq!(out.words[0].confidence, None);
    }

    #[test]
    fn a_measured_boundary_snaps_to_the_quiet_gap_within_forty_milliseconds() {
        // 5 ms buckets: speech, a 20 ms dip at buckets 103..107, speech again.
        let mut levels = vec![-20.0f32; 300];
        for level in &mut levels[103..107] { *level = -70.0; }
        let words = vec![("one".to_string(), 0, 100), ("two".to_string(), 100, 300)];
        let placed = place_measured(&words, 0, 300, &levels, BUCKET);
        assert!((103..107).contains(&placed[0].1.end), "{placed:?}");
        assert_eq!(placed[0].1.end, placed[1].1.start);
        // A dip 100 ms away is out of reach: the measured boundary stands.
        let mut far = vec![-20.0f32; 300];
        for level in &mut far[120..124] { *level = -70.0; }
        assert_eq!(place_measured(&words, 0, 300, &far, BUCKET)[0].1.end, 100);
    }
}
