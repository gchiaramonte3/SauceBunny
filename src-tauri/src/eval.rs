//! The phase 0 scorer (docs/TRANSCRIPT-ACCURACY-SPEC-2026-10-04.md): hand-
//! checked scenes in, numbers out, so no default changes on anyone's say-so.
//!
//! `sauce-bunny --eval <dir>` scores every scene in `dir` (default
//! `~/Documents/Sauce Bunny Eval/`, outside the repo: real footage and real
//! transcripts are never committed). A scene is `<name>.csv`, one row per word
//! as a person heard it:
//!
//! ```text
//! track,start,end,text,speaker,role
//! t3,61.42,61.80,Xiomara,t3,owner
//! t5,61.44,61.79,Xiomara,t3,bleed
//! ```
//!
//! seconds from the sequence start, the mic the word is ON, who said it, and
//! `owner` / `bleed` / `offmic`. Beside it, `<name>.json`:
//! `{ "document": "<id>", "from": 60, "to": 300, "fps": 23.976, "names": ["Xiomara"] }`.
//! The app's current transcript and bleed labels are the hypothesis, or a
//! words file from another engine with `--hyp <file>` (phase 5).
//!
//! `sauce-bunny --eval-template <document> <from> <to> <out.csv> [t1,t2]` writes
//! the current transcript (of those mics only, when named) as a CSV to correct
//! by hand: the quickest way to label. A scene's `"tracks"` limits scoring too.
use crate::bleed::AafOwnershipLabel;
use crate::context::{Context, Roots};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role { Owner, Bleed, Offmic }

#[derive(Debug, Clone)]
pub struct RefWord { pub track: String, pub start: f64, pub end: f64, pub text: String, pub speaker: String, pub role: Role }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HypWord {
    pub track: String,
    pub start: f64,
    pub end: f64,
    pub text: String,
    /// The app's bleed label, when it has one.
    #[serde(default)]
    pub label: Option<AafOwnershipLabel>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct Scores {
    /// Owner words in the reference.
    pub words: usize,
    pub substitutions: usize,
    pub deletions: usize,
    pub insertions: usize,
    pub wer: f64,
    /// Cast names the reference has, and how many the hypothesis got exactly.
    pub names: usize,
    pub names_right: usize,
    /// A name the hypothesis wrote where the reference has another word.
    pub false_swaps: usize,
    /// Start-time error over words both got right, in ms.
    pub timing_mean_ms: f64,
    pub timing_p90_ms: f64,
    pub within_one_frame: f64,
    /// The headline for bleed: a real line hidden is worse than a duplicate shown.
    pub owner_words: usize,
    pub owner_hidden: usize,
    pub bleed_words: usize,
    pub bleed_left: usize,
    pub offmic_words: usize,
    pub offmic_flagged: usize,
}

pub fn normal(text: &str) -> String { crate::bleed::normal(text) }

pub fn parse_csv(text: &str) -> Result<Vec<RefWord>, String> {
    let mut out = Vec::new();
    for (index, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || (index == 0 && line.starts_with("track,")) { continue; }
        let parts: Vec<&str> = line.splitn(6, ',').map(str::trim).collect();
        let [track, start, end, text, speaker, role] = parts.as_slice() else { return Err(format!("line {}: needs track,start,end,text,speaker,role", index + 1)) };
        let number = |value: &str| value.parse::<f64>().map_err(|_| format!("line {}: \"{value}\" is not seconds", index + 1));
        let role = match role.to_ascii_lowercase().as_str() { "owner" => Role::Owner, "bleed" => Role::Bleed, "offmic" | "off-mic" => Role::Offmic,
            other => return Err(format!("line {}: role \"{other}\" is not owner, bleed or offmic", index + 1)) };
        out.push(RefWord { track: track.to_string(), start: number(start)?, end: number(end)?, text: text.to_string(), speaker: speaker.to_string(), role });
    }
    Ok(out)
}

/// The cheapest edit script between two word lists: pairs of (reference,
/// hypothesis) positions, None where one side has no word.
pub fn align(a: &[String], b: &[String]) -> Vec<(Option<usize>, Option<usize>)> {
    let (n, m) = (a.len(), b.len());
    let mut cost = vec![vec![0usize; m + 1]; n + 1];
    for (i, row) in cost.iter_mut().enumerate() { row[0] = i; }
    for (j, slot) in cost[0].iter_mut().enumerate() { *slot = j; }
    for i in 1..=n { for j in 1..=m {
        cost[i][j] = (cost[i - 1][j] + 1).min(cost[i][j - 1] + 1).min(cost[i - 1][j - 1] + usize::from(a[i - 1] != b[j - 1]));
    } }
    let (mut i, mut j, mut out) = (n, m, Vec::new());
    while i > 0 || j > 0 {
        if i > 0 && j > 0 && cost[i][j] == cost[i - 1][j - 1] + usize::from(a[i - 1] != b[j - 1]) { out.push((Some(i - 1), Some(j - 1))); i -= 1; j -= 1; }
        else if i > 0 && cost[i][j] == cost[i - 1][j] + 1 { out.push((Some(i - 1), None)); i -= 1; }
        else { out.push((None, Some(j - 1))); j -= 1; }
    }
    out.reverse();
    out
}

pub fn score(references: &[RefWord], hypotheses: &[HypWord], names: &[String], fps: f64) -> Scores {
    let names: Vec<String> = names.iter().map(|name| normal(name)).collect();
    let mut tracks: Vec<&str> = references.iter().map(|word| word.track.as_str()).chain(hypotheses.iter().map(|word| word.track.as_str())).collect();
    tracks.sort_unstable();
    tracks.dedup();
    let mut s = Scores::default();
    let mut timing = Vec::new();
    for track in tracks {
        let mut refs: Vec<&RefWord> = references.iter().filter(|word| word.track == track).collect();
        refs.sort_by(|a, b| a.start.total_cmp(&b.start));
        let mut hyps: Vec<&HypWord> = hypotheses.iter().filter(|word| word.track == track).collect();
        hyps.sort_by(|a, b| a.start.total_cmp(&b.start));
        // Accuracy: the mic owner's words against what the hypothesis shows.
        let owner: Vec<&RefWord> = refs.iter().copied().filter(|word| word.role == Role::Owner).collect();
        let shown: Vec<&HypWord> = hyps.iter().copied().filter(|word| word.label != Some(AafOwnershipLabel::Bleed)).collect();
        let (a, b): (Vec<String>, Vec<String>) = (owner.iter().map(|w| normal(&w.text)).collect(), shown.iter().map(|w| normal(&w.text)).collect());
        s.words += a.len();
        for (r, h) in align(&a, &b) {
            match (r, h) {
                (Some(r), Some(h)) if a[r] == b[h] => {
                    timing.push(((shown[h].start - owner[r].start) * 1000.0).abs());
                    if names.contains(&a[r]) { s.names += 1; s.names_right += 1; }
                }
                (Some(r), Some(h)) => {
                    s.substitutions += 1;
                    if names.contains(&a[r]) { s.names += 1; }
                    if names.contains(&b[h]) { s.false_swaps += 1; }
                }
                (Some(r), None) => { s.deletions += 1; if names.contains(&a[r]) { s.names += 1; } }
                (None, Some(h)) => { s.insertions += 1; if names.contains(&b[h]) { s.false_swaps += 1; } }
                (None, None) => {}
            }
        }
        // Ownership: every word on the mic, hidden or not, against its role.
        let (a, b): (Vec<String>, Vec<String>) = (refs.iter().map(|w| normal(&w.text)).collect(), hyps.iter().map(|w| normal(&w.text)).collect());
        for word in &refs { match word.role { Role::Owner => s.owner_words += 1, Role::Bleed => s.bleed_words += 1, Role::Offmic => s.offmic_words += 1 } }
        for (r, h) in align(&a, &b) {
            let (Some(r), Some(h)) = (r, h) else { continue };
            let label = hyps[h].label;
            match refs[r].role {
                Role::Owner if label == Some(AafOwnershipLabel::Bleed) => s.owner_hidden += 1,
                Role::Bleed if label != Some(AafOwnershipLabel::Bleed) => s.bleed_left += 1,
                Role::Offmic if label == Some(AafOwnershipLabel::Offmic) => s.offmic_flagged += 1,
                _ => {}
            }
        }
    }
    s.wer = if s.words == 0 { 0.0 } else { (s.substitutions + s.deletions + s.insertions) as f64 / s.words as f64 };
    if !timing.is_empty() {
        timing.sort_by(f64::total_cmp);
        s.timing_mean_ms = timing.iter().sum::<f64>() / timing.len() as f64;
        s.timing_p90_ms = timing[((timing.len() - 1) as f64 * 0.9).round() as usize];
        let frame = 1000.0 / fps.max(1.0);
        s.within_one_frame = timing.iter().filter(|ms| **ms <= frame).count() as f64 / timing.len() as f64;
    }
    s
}

/// The app's current words for a document, with their bleed labels: the
/// hypothesis a scene is scored against.
pub fn document_words(ctx: &Context, document_id: &str) -> Result<Vec<HypWord>, crate::AppError> {
    let document = ctx.document(document_id)?;
    let labels: HashMap<(String, String, u32), AafOwnershipLabel> = ctx.ownership(document_id).map(|answer| answer.words.into_iter()
        .map(|word| ((word.track_id, word.cue_id, word.index), word.label)).collect()).unwrap_or_default();
    let mut out = Vec::new();
    for transcript in &document.transcripts {
        let cues: Vec<crate::speech::CueInput> = transcript.cues.iter().map(|cue| crate::speech::CueInput {
            id: &cue.id, start_sample: cue.start_sample, end_sample: cue.end_sample, text: &cue.text, words: cue.words.as_deref() }).collect();
        let mut index: HashMap<String, u32> = HashMap::new();
        for word in crate::speech::unmeasured(&transcript.track_id, &cues).words {
            let at = index.entry(word.cue_id.clone()).or_insert(0);
            let label = labels.get(&(transcript.track_id.clone(), word.cue_id.clone(), *at)).copied();
            *at += 1;
            out.push(HypWord { track: transcript.track_id.clone(), start: word.start_sample as f64 / 16_000.0, end: word.end_sample as f64 / 16_000.0, text: word.text, label });
        }
    }
    Ok(out)
}

#[derive(Debug, Deserialize)]
struct Scene { document: String, #[serde(default)] from: Option<f64>, #[serde(default)] to: Option<f64>, #[serde(default = "film")] fps: f64, #[serde(default)] names: Vec<String>,
    /// Only these mics: a minute of twenty lavs is about 1,500 rows to check, mostly bleed.
    #[serde(default)] tracks: Vec<String> }
fn film() -> f64 { 24_000.0 / 1001.0 }

fn report(name: &str, s: &Scores) -> String {
    let pct = |part: usize, of: usize| if of == 0 { "n/a".to_string() } else { format!("{:.1}%", part as f64 / of as f64 * 100.0) };
    format!("{name}\n  WER {:.1}% over {} owner words (S {} D {} I {})\n  names {} right of {} · false swaps {}\n  word start error mean {:.0} ms · p90 {:.0} ms · within a frame {:.0}%\n  owner words wrongly hidden {} ({}) · bleed left showing {} of {} ({}) · off-mic flagged {} of {}\n",
        s.wer * 100.0, s.words, s.substitutions, s.deletions, s.insertions, s.names_right, s.names, s.false_swaps,
        s.timing_mean_ms, s.timing_p90_ms, s.within_one_frame * 100.0, s.owner_hidden, pct(s.owner_hidden, s.owner_words),
        s.bleed_left, s.bleed_words, pct(s.bleed_left, s.bleed_words), s.offmic_flagged, s.offmic_words)
}

fn home() -> PathBuf { std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default() }

/// One mic for `--eval-bleed`: a 16 kHz mono WAV and the words a recognizer
/// heard on it (the diarize sidecar's `--words` file), both from time zero.
#[derive(Debug, Deserialize)]
struct BleedMic { track: String, wav: PathBuf, words: PathBuf }

#[derive(Debug, Deserialize)]
struct BleedRun { mics: Vec<BleedMic>, #[serde(default)] truth: Option<PathBuf>, #[serde(default)] out: Option<PathBuf>, #[serde(default = "film")] fps: f64 }

#[derive(Deserialize)]
struct SidecarWord { text: String, start: f64, end: f64 }

/// dB per 20 ms frame straight from 16 kHz samples (the loudest sample in each
/// frame), the same reading `bleed::frames` takes from a waveform overview.
pub fn frames_from_samples(samples: &[f32]) -> Vec<f32> {
    let per = (crate::bleed::FRAME_SECONDS * 16_000.0) as usize;
    samples.chunks(per).map(|frame| {
        let peak = frame.iter().fold(0f32, |most, value| most.max(value.abs()));
        if peak <= 0.0 { -96.0 } else { (20.0 * peak.log10()).max(-96.0) }
    }).collect()
}

fn read_wav_16k(path: &Path) -> Result<Vec<f32>, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut at = 12;
    while at + 8 <= bytes.len() {
        let size = u32::from_le_bytes([bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]]) as usize;
        if &bytes[at..at + 4] == b"data" {
            let end = (at + 8 + size).min(bytes.len());
            return Ok(bytes[at + 8..end].chunks_exact(2).map(|pair| f32::from(i16::from_le_bytes([pair[0], pair[1]])) / 32768.0).collect());
        }
        at += 8 + size + size % 2;
    }
    Err(format!("{}: no audio data", path.display()))
}

/// `--eval-bleed <run.json>`: the real resolver on real audio, levels measured
/// from the WAVs themselves. Prints the labels' spread, writes every label to
/// `out`, and scores against `truth` (the scene CSV format) when given: how
/// the bleed resolver does on mixes whose answer is known.
fn bleed_run(path: &str) -> i32 {
    let run: BleedRun = match std::fs::read(path).map_err(|e| e.to_string()).and_then(|b| serde_json::from_slice(&b).map_err(|e| e.to_string())) {
        Ok(run) => run, Err(error) => { eprintln!("{path}: {error}"); return 2; }
    };
    let mut channels = Vec::new();
    let mut words = Vec::new();
    for mic in &run.mics {
        let samples = match read_wav_16k(&mic.wav) { Ok(samples) => samples, Err(error) => { eprintln!("{error}"); return 2; } };
        let levels = frames_from_samples(&samples);
        let floors = crate::bleed::floors(&levels);
        channels.push(crate::bleed::Channel { track_id: mic.track.clone(), levels, floors });
        let heard: Vec<SidecarWord> = match std::fs::read(&mic.words).map_err(|e| e.to_string()).and_then(|b| serde_json::from_slice(&b).map_err(|e| e.to_string())) {
            Ok(heard) => heard, Err(error) => { eprintln!("{}: {error}", mic.words.display()); return 2; }
        };
        for (index, word) in heard.into_iter().enumerate() {
            words.push(crate::bleed::Word { track_id: mic.track.clone(), cue_id: format!("w{index}"), index: 0, text: word.text,
                start: (word.start * 16_000.0) as i64, end: (word.end * 16_000.0) as i64 });
        }
    }
    let labels = crate::bleed::resolve(&channels, &words);
    if let Some(gap) = crate::bleed::separation(&channels, &words) { println!("separation: the loudest copy of a shared word is {gap:.1} dB above the next (median)"); }
    let by_word: HashMap<(String, String), &crate::bleed::AafWordOwnership> = labels.iter().map(|label| ((label.track_id.clone(), label.cue_id.clone()), label)).collect();
    let mut spread: std::collections::BTreeMap<String, usize> = std::collections::BTreeMap::new();
    let hyps: Vec<HypWord> = words.iter().map(|word| {
        let label = by_word.get(&(word.track_id.clone(), word.cue_id.clone())).map(|label| label.label);
        *spread.entry(label.map_or("unlabelled".to_string(), |label| format!("{label:?}").to_lowercase())).or_default() += 1;
        HypWord { track: word.track_id.clone(), start: word.start as f64 / 16_000.0, end: word.end as f64 / 16_000.0, text: word.text.clone(), label }
    }).collect();
    println!("labels: {}", spread.iter().map(|(label, count)| format!("{label} {count}")).collect::<Vec<_>>().join(" · "));
    if let Some(out) = &run.out {
        let rows: Vec<serde_json::Value> = words.iter().map(|word| {
            let label = by_word.get(&(word.track_id.clone(), word.cue_id.clone()));
            serde_json::json!({ "track": word.track_id, "start": word.start as f64 / 16_000.0, "end": word.end as f64 / 16_000.0, "text": word.text,
                "label": label.map(|l| format!("{:?}", l.label).to_lowercase()), "heard_on": label.and_then(|l| l.heard_on.clone()), "delta_db": label.map(|l| l.delta_db) })
        }).collect();
        if let Err(error) = std::fs::write(out, serde_json::to_vec(&rows).unwrap_or_default()) { eprintln!("{}: {error}", out.display()); return 2; }
    }
    if let Some(truth) = &run.truth {
        let references = match std::fs::read_to_string(truth).map_err(|e| e.to_string()).and_then(|text| parse_csv(&text)) { Ok(refs) => refs, Err(error) => { eprintln!("{error}"); return 2; } };
        print!("{}", report(&truth.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(), &score(&references, &hyps, &[], run.fps)));
    }
    0
}

/// `--eval-ownership <document>`: the app's own bleed labels for a whole AAF
/// Audio document, from its cached waveform overviews, with no window. What
/// Measure mics computes, printed: the spread of labels, the mics' separation,
/// and how many cue lines All voices would hide.
fn ownership_run(id: &str) -> i32 {
    let roots = Roots::for_home(&home(), None);
    let document = match crate::commands::aaf::store::load(&roots.multitrack, id) { Ok(document) => document, Err(error) => { eprintln!("{error}"); return 2; } };
    let cache = home().join("Library").join("Caches").join("com.saucebunny.desktop").join("media").join("aaf");
    let overviews = crate::commands::aaf::ownership::overviews_in(&cache, &document);
    println!("{}: {} mics, {} with a waveform overview", document.manifest.name, document.manifest.tracks.len(), overviews.len());
    let started = std::time::Instant::now();
    let answer = match crate::commands::aaf::ownership::compute(&document, &overviews, vec![], String::new(), None) { Ok(answer) => answer, Err(error) => { eprintln!("{error}"); return 2; } };
    let c = &answer.counts;
    let total = (c.owner + c.bleed + c.overtalk + c.offmic + c.unsure + c.other).max(1);
    let pct = |n: u32| n as f64 / total as f64 * 100.0;
    println!("{total} words in {:.1} s: owner {:.1}% · bleed {:.1}% · overtalk {:.1}% · off-mic {:.1}% · unsure {:.1}%",
        started.elapsed().as_secs_f64(), pct(c.owner), pct(c.bleed), pct(c.overtalk), pct(c.offmic), pct(c.unsure));
    if let Some(gap) = answer.separation_db { println!("separation: the loudest copy of a shared word is {gap:.1} dB above the next (median)"); }
    let mut per_cue: HashMap<(String, String), (u32, u32)> = HashMap::new();
    for word in &answer.words { let entry = per_cue.entry((word.track_id.clone(), word.cue_id.clone())).or_default(); entry.0 += u32::from(word.label == AafOwnershipLabel::Bleed); }
    let cues: Vec<(String, String, usize)> = document.transcripts.iter().flat_map(|t| t.cues.iter().map(move |cue| (t.track_id.clone(), cue.id.clone(), cue.text.split_whitespace().count()))).collect();
    let hidden = cues.iter().filter(|(track, cue, count)| per_cue.get(&(track.clone(), cue.clone())).is_some_and(|(bleed, _)| *count > 0 && f64::from(*bleed) / *count as f64 >= 0.6)).count();
    println!("All voices would hide {hidden} of {} cue lines as bleed", cues.len());
    0
}

/// `--eval [dir] [--hyp file]`: score every scene; exit 0 with a report.
pub fn run(args: &[String]) -> i32 {
    let value = |flag: &str| args.iter().position(|arg| arg == flag).and_then(|at| args.get(at + 1)).filter(|value| !value.starts_with("--")).cloned();
    if args.iter().any(|arg| arg == "--eval-template") { return template(args); }
    if let Some(path) = value("--eval-bleed") { return bleed_run(&path); }
    if let Some(id) = value("--eval-ownership") { return ownership_run(&id); }
    let dir = value("--eval").map(PathBuf::from).unwrap_or_else(|| home().join("Documents").join("Sauce Bunny Eval"));
    let ctx = Context::new(Roots::for_home(&home(), None));
    let hyp: Option<Vec<HypWord>> = match value("--hyp") {
        Some(path) => match std::fs::read(&path).map_err(|e| e.to_string()).and_then(|bytes| serde_json::from_slice(&bytes).map_err(|e| e.to_string())) {
            Ok(words) => Some(words), Err(error) => { eprintln!("--hyp {path}: {error}"); return 2; }
        },
        None => None,
    };
    let Ok(entries) = std::fs::read_dir(&dir) else { eprintln!("No scenes in {} (see src-tauri/src/eval.rs for the format).", dir.display()); return 2 };
    let mut scenes: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).filter(|path| path.extension().is_some_and(|ext| ext == "csv")).collect();
    scenes.sort();
    if scenes.is_empty() { eprintln!("No scene CSVs in {}.", dir.display()); return 2; }
    let mut status = 0;
    for csv in scenes {
        let name = csv.file_stem().map(|stem| stem.to_string_lossy().into_owned()).unwrap_or_default();
        match score_scene(&ctx, &csv, hyp.as_deref()) {
            Ok(scores) => print!("{}", report(&name, &scores)),
            Err(error) => { eprintln!("{name}: {error}"); status = 1; }
        }
    }
    status
}

fn score_scene(ctx: &Context, csv: &Path, hyp: Option<&[HypWord]>) -> Result<Scores, String> {
    let scene: Scene = serde_json::from_slice(&std::fs::read(csv.with_extension("json")).map_err(|e| format!("needs {}: {e}", csv.with_extension("json").display()))?).map_err(|e| e.to_string())?;
    let references = parse_csv(&std::fs::read_to_string(csv).map_err(|e| e.to_string())?)?;
    let words = match hyp { Some(words) => words.to_vec(), None => document_words(ctx, &scene.document).map_err(|e| e.to_string())? };
    let inside = |start: f64| scene.from.is_none_or(|from| start >= from) && scene.to.is_none_or(|to| start < to);
    let chosen = |track: &str| scene.tracks.is_empty() || scene.tracks.iter().any(|wanted| wanted == track);
    let words: Vec<HypWord> = words.into_iter().filter(|word| inside(word.start) && chosen(&word.track)).collect();
    let references: Vec<RefWord> = references.into_iter().filter(|word| chosen(&word.track)).collect();
    Ok(score(&references, &words, &scene.names, scene.fps))
}

fn template(args: &[String]) -> i32 {
    let at = args.iter().position(|arg| arg == "--eval-template").unwrap_or(0);
    let [document, from, to, out] = [1, 2, 3, 4].map(|offset| args.get(at + offset).cloned().unwrap_or_default());
    let (Ok(from), Ok(to)) = (from.parse::<f64>(), to.parse::<f64>()) else { eprintln!("--eval-template <document> <from seconds> <to seconds> <out.csv> [track,track,...]"); return 2 };
    let tracks: Vec<String> = args.get(at + 5).filter(|value| !value.starts_with("--")).map(|value| value.split(',').map(str::trim).filter(|t| !t.is_empty()).map(str::to_string).collect()).unwrap_or_default();
    let ctx = Context::new(Roots::for_home(&home(), None));
    let words = match document_words(&ctx, &document) { Ok(words) => words, Err(error) => { eprintln!("{error}"); return 2; } };
    let mut csv = String::from("track,start,end,text,speaker,role\n");
    for word in words.iter().filter(|word| word.start >= from && word.start < to && (tracks.is_empty() || tracks.contains(&word.track))) {
        let role = if word.label == Some(AafOwnershipLabel::Bleed) { "bleed" } else { "owner" };
        csv.push_str(&format!("{},{:.3},{:.3},{},{},{role}\n", word.track, word.start, word.end, word.text.replace(',', ""), word.track));
    }
    if let Err(error) = std::fs::write(&out, csv) { eprintln!("{out}: {error}"); return 2; }
    let meta = PathBuf::from(&out).with_extension("json");
    if !meta.exists() { let _ = std::fs::write(&meta, serde_json::json!({ "document": document, "from": from, "to": to, "fps": film(), "names": [], "tracks": tracks }).to_string()); }
    println!("Wrote {out}. Correct each row's text, speaker and role by listening, then run --eval.");
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(track: &str, start: f64, text: &str, role: Role) -> RefWord { RefWord { track: track.into(), start, end: start + 0.3, text: text.into(), speaker: track.into(), role } }
    fn h(track: &str, start: f64, text: &str, label: Option<AafOwnershipLabel>) -> HypWord { HypWord { track: track.into(), start, end: start + 0.3, text: text.into(), label } }

    #[test]
    fn word_error_rate_counts_substitutions_deletions_and_insertions_on_owner_words() {
        let refs = [r("a", 1.0, "I", Role::Owner), r("a", 1.4, "moved", Role::Owner), r("a", 1.8, "here", Role::Owner), r("a", 2.2, "in", Role::Owner), r("a", 2.6, "May", Role::Owner)];
        let hyps = [h("a", 1.02, "I", None), h("a", 1.4, "moved", None), h("a", 1.85, "hear", None), h("a", 2.6, "may", None), h("a", 3.0, "okay", None)];
        let s = score(&refs, &hyps, &[], 24.0);
        // Two alignments cost three edits here; either way the rate is 3 of 5.
        assert_eq!((s.words, s.substitutions + s.deletions + s.insertions), (5, 3));
        assert!((s.wer - 0.6).abs() < 1e-9);
        assert!(s.timing_mean_ms < 20.0 && s.within_one_frame > 0.99, "{s:?}");
        // Unambiguous ones, each kind on its own.
        let words = |list: &[&str]| list.iter().enumerate().map(|(i, t)| r("a", i as f64, t, Role::Owner)).collect::<Vec<_>>();
        let heard = |list: &[&str]| list.iter().enumerate().map(|(i, t)| h("a", i as f64, t, None)).collect::<Vec<_>>();
        let dropped = score(&words(&["a", "b", "c"]), &heard(&["a", "c"]), &[], 24.0);
        assert_eq!((dropped.substitutions, dropped.deletions, dropped.insertions), (0, 1, 0));
        let added = score(&words(&["a", "b"]), &heard(&["a", "x", "b"]), &[], 24.0);
        assert_eq!((added.substitutions, added.deletions, added.insertions), (0, 0, 1));
        let swapped = score(&words(&["a", "b"]), &heard(&["a", "c"]), &[], 24.0);
        assert_eq!((swapped.substitutions, swapped.deletions, swapped.insertions), (1, 0, 0));
    }

    #[test]
    fn names_and_false_swaps_are_counted_apart() {
        let refs = [r("a", 1.0, "Xiomara", Role::Owner), r("a", 1.5, "was", Role::Owner), r("a", 1.8, "funny", Role::Owner)];
        let hyps = [h("a", 1.0, "Xiomara", None), h("a", 1.5, "Saoirse", None)];
        let s = score(&refs, &hyps, &["Xiomara".into(), "Saoirse".into()], 24.0);
        assert_eq!((s.names, s.names_right, s.false_swaps), (1, 1, 1));
    }

    #[test]
    fn a_hidden_owner_word_is_the_headline_and_a_shown_bleed_word_is_a_leftover() {
        let refs = [r("a", 1.0, "kitchen", Role::Owner), r("b", 1.0, "kitchen", Role::Bleed), r("b", 3.0, "again", Role::Offmic), r("c", 5.0, "stop", Role::Owner)];
        let hyps = [h("a", 1.0, "kitchen", None), h("b", 1.0, "kitchen", None), h("b", 3.0, "again", Some(AafOwnershipLabel::Offmic)), h("c", 5.0, "stop", Some(AafOwnershipLabel::Bleed))];
        let s = score(&refs, &hyps, &[], 24.0);
        assert_eq!((s.owner_words, s.owner_hidden), (2, 1));
        assert_eq!((s.bleed_words, s.bleed_left), (1, 1));
        assert_eq!((s.offmic_words, s.offmic_flagged), (1, 1));
        // The hidden owner word also counts as missed in the accuracy score.
        assert_eq!(s.deletions, 1);
    }

    #[test]
    fn levels_from_samples_take_the_loudest_sample_of_each_twenty_milliseconds() {
        let mut samples = vec![0.001f32; 16_000];
        samples[400] = 0.5;
        let frames = frames_from_samples(&samples);
        assert_eq!(frames.len(), 50);
        assert!((frames[1] - (-6.02)).abs() < 0.05, "{}", frames[1]);
        assert!((frames[0] - (-60.0)).abs() < 0.05);
        assert_eq!(frames_from_samples(&[0.0; 320])[0], -96.0);
    }

    #[test]
    fn a_scene_csv_reads_with_or_without_its_header_and_says_what_is_wrong() {
        let words = parse_csv("track,start,end,text,speaker,role\nt3,61.42,61.80,Xiomara,t3,owner\nt5,61.44,61.79,Xiomara,t3,BLEED\n").unwrap();
        assert_eq!((words.len(), words[1].role, words[1].speaker.as_str()), (2, Role::Bleed, "t3"));
        assert!(parse_csv("t3,1,2,hi,t3,maybe").unwrap_err().contains("role"));
        assert!(parse_csv("t3,one,2,hi,t3,owner").unwrap_err().contains("seconds"));
    }
}
