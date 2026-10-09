//! The bleed resolver over a whole AAF Audio document
//! (docs/TRANSCRIPT-ACCURACY-SPEC-2026-10-04.md, phase 3). Reads each mic's
//! waveform overview (never the media again, unless asked to measure a mic
//! that has none), places every transcribed word as the speech analysis does,
//! runs `crate::bleed::resolve`, and lays the editor's own calls over the
//! result. The answer is cached in `app_data_dir()/ownership/`, outside
//! iCloud-synced Documents, where String Outs and the assistants read it.
use super::{model::*, peaks, process, store};
use crate::bleed::{self, AafOwnershipLabel, AafWordOwnership, Channel, Word};
use crate::AppError;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AafOwnershipCounts { pub owner: u32, pub bleed: u32, pub overtalk: u32, pub offmic: u32, pub unsure: u32, #[serde(default)] pub other: u32 }

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
pub struct AafOwnership {
    pub document_id: String,
    /// Tracks whose level was compared (their waveform exists).
    pub measured: Vec<String>,
    /// Transcribed tracks with no waveform yet: their words carry no label
    /// until they are measured.
    pub missing: Vec<String>,
    /// Every word that is not plainly its mic owner's, and every word the
    /// editor marked by hand. Words not listed are the owner's.
    pub words: Vec<AafWordOwnership>,
    pub counts: AafOwnershipCounts,
    /// What the answer was computed from; anything newer means compute again.
    pub stamp: String,
    /// From the voice check: a possible mic swap, two voices too alike to tell
    /// apart. Empty until the voices are checked.
    #[serde(default)]
    pub warnings: Vec<String>,
    /// How many mic owners' voices the voice check learned (0 until it runs).
    #[serde(default)]
    pub voices: u32,
    /// How far apart this document's mics are: the median of how much louder
    /// the loudest copy of a shared word is than the next (`bleed::separation`).
    /// Under about 3 dB, levels settle few lines and the reader says so.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub separation_db: Option<f32>,
}

/// Where a document's answer is cached, from the app's support folder. Also
/// read by the context layer, which has a path but no `AppHandle`.
/// A document's waveform overviews that exist in an AAF cache folder, for
/// callers with no `AppHandle`.
pub fn overviews_in(cache: &Path, document: &AafDocument) -> Vec<(String, PathBuf)> {
    document.manifest.tracks.iter().map(|track| (track.id.clone(), peaks::overview_in(cache, document, &track.id))).filter(|(_, path)| path.is_file()).collect()
}

/// The editor's Hide bleed switch (Settings ▸ Transcription ▸ Bleed, and the
/// checkbox under AAF Audio's search box). OFF unless the file says it is on:
/// the thresholds were tuned on one scene, and a line wrongly called bleed
/// would leave All voices, String Outs and an assistant's search with nothing
/// saying it had gone. Off, labels are still made and shown; nothing is left
/// out. Kept here rather than in WebView storage because the MCP server,
/// which answers assistants without the app, has to honour it too.
#[derive(Debug, Default, Serialize, Deserialize)]
struct BleedSettings { #[serde(default)] hide: bool }

pub fn settings_file(app_data: &Path) -> PathBuf { app_data.join("bleed.json") }

pub fn hides_bleed(app_data: &Path) -> bool {
    store::read_json::<BleedSettings>(&settings_file(app_data)).map(|settings| settings.hide).unwrap_or(false)
}

pub fn set_hides_bleed(app_data: &Path, hide: bool) -> Result<(), AppError> {
    std::fs::create_dir_all(app_data)?;
    crate::commands::system::write_bytes_impl(&settings_file(app_data).to_string_lossy(), &serde_json::to_vec(&BleedSettings { hide })?, false, false, true)?;
    Ok(())
}

pub fn cache_file(app_data: &Path, document_id: &str) -> PathBuf {
    app_data.join("ownership").join(format!("{document_id}.json"))
}

fn modified(path: &Path) -> u64 { std::fs::metadata(path).map(|meta| store::modified_ms(&meta)).unwrap_or(0) }

pub async fn resolve(app: &AppHandle, document_id: &str, build: bool, job: &str) -> Result<AafOwnership, AppError> {
    let root = store::root(app)?;
    // The document's time is read BEFORE the document: a save landing in
    // between then makes the stamp older than the answer (computed again next
    // time) rather than newer (an answer about the old words, trusted).
    let document_time = modified(&store::document_file(&root, document_id)?);
    let document = store::read_document(&root, document_id)?;
    let transcribed: HashSet<&str> = document.transcripts.iter().map(|transcript| transcript.track_id.as_str()).collect();
    let wanted: Vec<&AafTrack> = document.manifest.tracks.iter().filter(|track| transcribed.contains(track.id.as_str())).collect();
    let mut overviews = Vec::new();
    for (index, track) in document.manifest.tracks.iter().enumerate() {
        let path = peaks::overview_path(app, &document, &track.id)?;
        // Measuring reads every source a mic uses, minutes a track on a
        // network volume, so it happens only when asked, and only for mics
        // with a transcript (only they can carry a duplicate).
        if build && !path.is_file() && transcribed.contains(track.id.as_str()) {
            process::check_cancelled(app, job)?;
            process::progress(app, job, Some(&track.id), "measuring", index as i64, document.manifest.tracks.len() as i64);
            peaks::waveform(app, &document, &track.id, 0, document.manifest.duration_frames, true, job).await?;
        }
        if path.is_file() { overviews.push((track.id.clone(), path)); }
    }
    let missing: Vec<String> = wanted.iter().filter(|track| !overviews.iter().any(|(id, _)| id == &track.id)).map(|track| track.id.clone()).collect();
    let app_data = app.path().app_data_dir().map_err(|e| AppError::internal(e.to_string()))?;
    let voiceprints = super::voices::file(&app_data, document_id);
    // The document's time comes FIRST: the context layer trusts a cache only
    // when that part matches the document as it is now.
    let stamp = format!("{document_time}:{}:voices={}",
        overviews.iter().map(|(id, path)| format!("{id}={}", modified(path))).collect::<Vec<_>>().join(","), modified(&voiceprints));
    once(&cache_file(&app_data, document_id), stamp, || process::check_cancelled(app, job), move |stamp| {
        let voices = store::read_json::<super::voices::Voiceprints>(&voiceprints).ok();
        compute(&document, &overviews, missing, stamp, voices.as_ref())
    }).await
}

/// The cached answer when it describes `stamp`, or a new one, written for the
/// next caller. One caller per document at a time: a transcription run used
/// to start two passes at once (its change event and its own result each
/// re-read the document), both missed the cache the commit had just outdated,
/// and each spent ~600 ms computing the same answer. The second now waits,
/// cancellably, and reads what the first wrote.
async fn once(cached: &Path, stamp: String, check: impl Fn() -> Result<(), AppError>,
    work: impl FnOnce(String) -> Result<AafOwnership, AppError> + Send + 'static) -> Result<AafOwnership, AppError> {
    let _claim = process::claim_until(cached, check).await?;
    if let Ok(previous) = store::read_json::<AafOwnership>(cached) {
        if previous.stamp == stamp { return Ok(previous); }
    }
    let answer = tauri::async_runtime::spawn_blocking(move || work(stamp)).await
        .map_err(|e| AppError::internal(e.to_string()))??;
    if let Some(dir) = cached.parent() { std::fs::create_dir_all(dir)?; }
    crate::commands::system::write_bytes_impl(&cached.to_string_lossy(), &serde_json::to_vec(&answer)?, false, false, true)?;
    Ok(answer)
}

/// The answer as a page is sent it (AAF Audio's reader, String Outs): words
/// the resolver was unsure of are left out, because neither draws them, and
/// their count stays (it is what offers the voice check). The cache keeps
/// every word, for the assistants. The editor's own calls always go.
pub fn for_page(mut answer: AafOwnership) -> AafOwnership {
    answer.words.retain(|word| word.label != AafOwnershipLabel::Unsure || word.manual);
    answer
}

/// What the resolver saw and said: every channel's level, every placed word,
/// and a label for each word it could compare. The voice check starts here.
pub struct Analysis {
    pub channels: Vec<Channel>,
    pub words: Vec<Word>,
    pub labels: HashMap<(String, String, u32), AafWordOwnership>,
    pub cue_lengths: HashMap<(String, String), u32>,
    pub measured: Vec<String>,
}

pub fn analyse(document: &AafDocument, overviews: &[(String, PathBuf)]) -> Analysis {
    let mut channels = Vec::new();
    let mut words = Vec::new();
    let mut cue_lengths: HashMap<(String, String), u32> = HashMap::new();
    let overview_of: HashMap<&str, &PathBuf> = overviews.iter().map(|(id, path)| (id.as_str(), path)).collect();
    let mut measured = Vec::new();
    for (track, path) in overviews {
        let Ok((pairs, hz, bucket)) = peaks::read_base(path) else { continue };
        let levels = bleed::frames(&pairs, hz, bucket);
        let floors = bleed::floors(&levels);
        channels.push(Channel { track_id: track.clone(), levels, floors });
        measured.push(track.clone());
    }
    for transcript in &document.transcripts {
        let cues: Vec<crate::speech::CueInput> = transcript.cues.iter().map(|cue| crate::speech::CueInput {
            id: &cue.id, start_sample: cue.start_sample, end_sample: cue.end_sample, text: &cue.text, words: cue.words.as_deref() }).collect();
        // Placed exactly as the reader and String Outs place them, so a label
        // lands on the word the editor sees.
        let placed = match overview_of.get(transcript.track_id.as_str()).and_then(|path| peaks::read_base(path).ok()) {
            Some((pairs, hz, bucket)) => crate::speech::analyse(&transcript.track_id, &pairs, hz, bucket, &cues).words,
            None => crate::speech::unmeasured(&transcript.track_id, &cues).words,
        };
        let mut index: HashMap<String, u32> = HashMap::new();
        for word in placed {
            let at = index.entry(word.cue_id.clone()).or_insert(0);
            words.push(Word { track_id: transcript.track_id.clone(), cue_id: word.cue_id.clone(), index: *at, text: word.text, start: word.start_sample, end: word.end_sample });
            *at += 1;
            cue_lengths.insert((transcript.track_id.clone(), word.cue_id), *at);
        }
    }
    let labels = bleed::resolve(&channels, &words).into_iter().map(|word| ((word.track_id.clone(), word.cue_id.clone(), word.index), word)).collect();
    Analysis { channels, words, labels, cue_lengths, measured }
}

/// Everything after the reads: the resolver, then the voice check's calls on
/// words the resolver was unsure of, then the editor's calls, which win.
pub fn compute(document: &AafDocument, overviews: &[(String, PathBuf)], missing: Vec<String>, stamp: String, voices: Option<&super::voices::Voiceprints>) -> Result<AafOwnership, AppError> {
    let Analysis { mut labels, cue_lengths, measured, channels, words } = analyse(document, overviews);
    let separation_db = bleed::separation(&channels, &words).map(|gap| (gap * 10.0).round() / 10.0);
    for decision in voices.iter().flat_map(|voices| voices.decisions.iter()) {
        let key = (decision.track_id.clone(), decision.cue_id.clone(), decision.index);
        if labels.get(&key).is_some_and(|word| word.label == AafOwnershipLabel::Unsure) { labels.insert(key, decision.clone()); }
    }
    for call in document.ownership.iter().flatten() {
        let Some(&count) = cue_lengths.get(&(call.track_id.clone(), call.cue_id.clone())) else { continue };
        for index in 0..count {
            labels.insert((call.track_id.clone(), call.cue_id.clone(), index), AafWordOwnership { track_id: call.track_id.clone(), cue_id: call.cue_id.clone(),
                index, label: call.label, heard_on: call.heard_on.clone(), delta_db: 0.0, manual: true });
        }
    }
    let mut counts = AafOwnershipCounts::default();
    for word in labels.values() {
        match word.label {
            AafOwnershipLabel::Owner => counts.owner += 1,
            AafOwnershipLabel::Bleed => counts.bleed += 1,
            AafOwnershipLabel::Overtalk => counts.overtalk += 1,
            AafOwnershipLabel::Offmic => counts.offmic += 1,
            AafOwnershipLabel::Unsure => counts.unsure += 1,
            AafOwnershipLabel::Other => counts.other += 1,
        }
    }
    let mut listed: Vec<AafWordOwnership> = labels.into_values().filter(|word| word.label != AafOwnershipLabel::Owner || word.manual).collect();
    listed.sort_by(|a, b| (&a.track_id, &a.cue_id, a.index).cmp(&(&b.track_id, &b.cue_id, b.index)));
    Ok(AafOwnership { document_id: document.id.clone(), measured, missing, words: listed, counts, stamp,
        warnings: voices.map(|voices| voices.warnings.clone()).unwrap_or_default(), voices: voices.map_or(0, |voices| voices.voices.len() as u32), separation_db })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECONDS: u64 = 60;
    const HZ: u32 = 48_000;

    /// An overview at a -60 dB floor with one loud stretch, 10.0 to 10.5 s.
    fn overview(dir: &Path, track: &str, speech_db: f64) -> PathBuf {
        let samples = SECONDS * u64::from(HZ);
        let peak = |db: f64| (10f64.powf(db / 20.0) * 32767.0) as i16;
        let count = samples.div_ceil(peaks::BASE) as usize;
        let bucket_seconds = peaks::BASE as f64 / f64::from(HZ);
        let pairs: Vec<[i16; 2]> = (0..count).map(|index| {
            let at = index as f64 * bucket_seconds;
            let level = peak(if (10.0..10.5).contains(&at) { speech_db } else { -60.0 });
            [-level, level]
        }).collect();
        let path = dir.join(format!("{track}.bin"));
        peaks::write_pyramid(pairs, samples, HZ, &path, || Ok(())).unwrap();
        path
    }

    fn document(ownership: Option<Vec<AafCueOwnership>>) -> AafDocument {
        let cue = |track: &str| serde_json::json!({ "id": format!("{track}-1"), "start_sample": 160_000, "end_sample": 168_000, "text": "kitchen", "boundary_review": false });
        let transcript = |track: &str| serde_json::json!({ "track_id": track, "start_frame": 0, "duration_frames": 1440, "engine": "parakeet", "model_id": "parakeet-ultra",
            "status": "completed", "sample_rate": 16000, "cues": [cue(track)], "timing_issues": [], "warnings": [] });
        let track = |id: &str| serde_json::json!({ "id": id, "name": id, "clips": [], "warnings": [] });
        let mut document: AafDocument = serde_json::from_value(serde_json::json!({
            "schema_version": 2, "id": "d".repeat(64), "source_path": "/fixtures/kitchen.aaf", "source_size": 1, "source_modified_ms": 1,
            "manifest": { "schema_version": 1, "name": "Kitchen", "source_fingerprint": "e".repeat(64), "edit_rate": { "numerator": 24, "denominator": 1 },
                "start_frame": 0, "duration_frames": 1440, "timecode_fps": 24, "drop_frame": false, "tracks": [track("rosa"), track("dev")], "warnings": [] },
            "labels": [], "transcripts": [transcript("rosa"), transcript("dev")],
        })).unwrap();
        document.ownership = ownership;
        document
    }

    #[test]
    fn a_whole_document_labels_the_quiet_copy_as_bleed_from_the_loud_mic() {
        let dir = std::env::temp_dir().join(format!("ownership-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let overviews = vec![("rosa".to_string(), overview(&dir, "rosa", -20.0)), ("dev".to_string(), overview(&dir, "dev", -38.0))];
        let answer = compute(&document(None), &overviews, vec![], "s".into(), None).unwrap();
        assert_eq!(answer.measured, ["rosa", "dev"]);
        let bleed: Vec<_> = answer.words.iter().filter(|word| word.label == AafOwnershipLabel::Bleed).collect();
        assert_eq!(bleed.len(), 1, "{:?}", answer.words);
        assert_eq!((bleed[0].track_id.as_str(), bleed[0].heard_on.as_deref()), ("dev", Some("rosa")));
        // Owner words are counted, not listed: the list is what needs attention.
        assert_eq!((answer.counts.owner, answer.counts.bleed), (1, 1));
        assert!(answer.words.iter().all(|word| word.label != AafOwnershipLabel::Owner));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_editors_call_wins_for_every_word_of_its_cue_and_is_marked_as_theirs() {
        let dir = std::env::temp_dir().join(format!("ownership-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let overviews = vec![("rosa".to_string(), overview(&dir, "rosa", -20.0)), ("dev".to_string(), overview(&dir, "dev", -38.0))];
        let call = AafCueOwnership { track_id: "dev".into(), cue_id: "dev-1".into(), label: AafOwnershipLabel::Owner, heard_on: None };
        let answer = compute(&document(Some(vec![call])), &overviews, vec!["x".into()], "s".into(), None).unwrap();
        let dev = answer.words.iter().find(|word| word.track_id == "dev").unwrap();
        assert_eq!((dev.label, dev.manual), (AafOwnershipLabel::Owner, true));
        assert_eq!(answer.counts.bleed, 0);
        assert_eq!(answer.missing, ["x"]);
        std::fs::remove_dir_all(&dir).ok();
    }

    fn answer(stamp: String, words: Vec<AafWordOwnership>) -> AafOwnership {
        AafOwnership { document_id: "d".repeat(64), measured: vec!["rosa".into(), "dev".into()], missing: vec![], words, counts: AafOwnershipCounts::default(),
            stamp, warnings: vec![], voices: 0, separation_db: None }
    }

    #[test]
    fn the_page_is_not_sent_unsure_words_but_is_still_told_how_many_there_are() {
        let word = |index: u32, label: AafOwnershipLabel, manual: bool| AafWordOwnership { track_id: "dev".into(), cue_id: "dev-1".into(), index, label,
            heard_on: None, delta_db: 0.0, manual };
        let mut full = answer("s".into(), vec![word(0, AafOwnershipLabel::Bleed, false), word(1, AafOwnershipLabel::Unsure, false),
            word(2, AafOwnershipLabel::Unsure, true), word(3, AafOwnershipLabel::Overtalk, false)]);
        full.counts.unsure = 2;
        let page = for_page(full);
        // The editor's own call stays whatever it says.
        assert_eq!(page.words.iter().map(|word| (word.index, word.label)).collect::<Vec<_>>(),
            [(0, AafOwnershipLabel::Bleed), (2, AafOwnershipLabel::Unsure), (3, AafOwnershipLabel::Overtalk)]);
        assert_eq!(page.counts.unsure, 2, "the count is what offers the voice check");
    }

    #[tokio::test]
    async fn two_passes_over_one_document_compute_once_and_a_changed_document_computes_again() {
        let dir = std::env::temp_dir().join(format!("ownership-{}", uuid::Uuid::new_v4()));
        let cached = dir.join("ownership").join("d.json");
        let runs = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let pass = |stamp: &str| {
            let runs = runs.clone();
            once(&cached, stamp.to_string(), || Ok(()), move |stamp| {
                runs.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                // Long enough that the second caller arrives while this one computes.
                std::thread::sleep(std::time::Duration::from_millis(250));
                Ok(answer(stamp, vec![]))
            })
        };
        let (first, second) = tokio::join!(pass("1:a=1:voices=0"), pass("1:a=1:voices=0"));
        assert_eq!((first.unwrap().stamp, second.unwrap().stamp), ("1:a=1:voices=0".to_string(), "1:a=1:voices=0".to_string()));
        assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), 1, "the second caller computed the same answer again");
        assert_eq!(pass("2:a=1:voices=0").await.unwrap().stamp, "2:a=1:voices=0");
        assert_eq!(runs.load(std::sync::atomic::Ordering::SeqCst), 2, "a changed document read the old answer");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn bleed_is_shown_until_the_editor_hides_it_and_a_damaged_setting_shows_it() {
        let dir = std::env::temp_dir().join(format!("ownership-{}", uuid::Uuid::new_v4()));
        assert!(!hides_bleed(&dir), "a fresh install hid bleed");
        set_hides_bleed(&dir, true).unwrap();
        assert!(hides_bleed(&dir));
        set_hides_bleed(&dir, false).unwrap();
        assert!(!hides_bleed(&dir));
        std::fs::write(settings_file(&dir), b"{not json").unwrap();
        assert!(!hides_bleed(&dir), "a damaged setting hid bleed");
        std::fs::remove_dir_all(&dir).ok();
    }
}
