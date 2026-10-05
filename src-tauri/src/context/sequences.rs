//! AAF Audio sequences as a model reads them: tracks in Avid order (A1, then
//! A1's group alternates, then A2), the people on them, whether each mic is
//! transcribed, V1's groups, and the transcript as lines with timecodes.
use super::{pick, string_outs, timecode, Address, Context, Line};
use crate::commands::aaf::model::{AafDocument, AafRate, AafTrack, AafTranscriptStatus};
use crate::AppError;
use serde::Serialize;

/// Lines a page may hold, and the characters it may run to, so a reply stays
/// readable for a model rather than being cut off by its client.
pub const PAGE_LINES: usize = 200;
const PAGE_CHARS: usize = 60_000;
const MAX_PAGE_LINES: usize = 1_000;

#[derive(Serialize)]
pub struct SequenceSummary { pub sequence: String, pub name: String, pub tracks: u32, pub transcribed_tracks: u32 }

pub fn list(ctx: &Context) -> Result<Vec<SequenceSummary>, AppError> {
    if !ctx.roots.multitrack.exists() { return Ok(Vec::new()); }
    Ok(crate::commands::aaf::store::shelf(&ctx.roots.multitrack)?.into_iter().map(|summary| SequenceSummary {
        sequence: Address::Sequence(summary.id).to_string(), name: summary.name, tracks: summary.track_count, transcribed_tracks: summary.transcribed_tracks,
    }).collect())
}

/// A sequence a model named, by address, id or name, as its document id.
pub fn resolve(ctx: &Context, wanted: &str) -> Result<String, AppError> {
    let wanted = wanted.trim();
    if wanted.starts_with(super::address::SCHEME) {
        return match Address::parse(wanted)? {
            Address::Sequence(id) | Address::SequenceAt { sequence: id, .. } | Address::Person { sequence: id, .. } | Address::Line { sequence: id, .. } => Ok(id),
            _ => Err(AppError::invalid(format!("{wanted} is not a sequence."))),
        };
    }
    if wanted.len() == 64 && wanted.bytes().all(|byte| byte.is_ascii_hexdigit()) { return Ok(wanted.to_lowercase()); }
    let all = list(ctx)?;
    let id = |item: &SequenceSummary| item.sequence.rsplit('/').next().unwrap_or_default().to_string();
    let found = pick(&all, wanted, |item| item.sequence.as_str(), |item| item.name.as_str(), "sequence")?;
    Ok(id(found))
}

fn owner(document: &AafDocument, track: &AafTrack) -> String {
    let label = document.labels.iter().find(|label| label.track_id == track.id).map(|label| label.owner_name.trim()).filter(|name| !name.is_empty());
    label.map(str::to_string).or_else(|| Some(track.name.trim().to_string()).filter(|name| !name.is_empty())).unwrap_or_else(|| track.id.clone())
}

/// AAF Audio's person key: a cast member, else the mic owner's name, else the track.
fn person_key(document: &AafDocument, track: &AafTrack) -> String {
    match document.labels.iter().find(|label| label.track_id == track.id) {
        Some(label) if label.cast_member_id.is_some() => format!("cast:{}", label.cast_member_id.as_deref().unwrap_or_default()),
        Some(label) if !label.owner_name.trim().is_empty() => format!("owner:{}", label.owner_name.trim().to_lowercase()),
        _ => format!("track:{}", track.id),
    }
}

fn parent_of<'a>(document: &'a AafDocument, track: &str) -> Option<&'a str> {
    document.manifest.graph.as_ref()?.lanes.iter().find(|lane| lane.track_id == track)?.parent_track_id.as_deref()
}

/// Every mic in Avid track order: main tracks by track number, each followed
/// at once by its group's alternates (micOrder in multitrack-person.ts).
fn ordered(document: &AafDocument) -> Vec<&AafTrack> {
    let tracks = &document.manifest.tracks;
    let number = |index: usize| tracks[index].physical_track_number.map(i64::from).unwrap_or(index as i64 + 1);
    let mut mains: Vec<usize> = (0..tracks.len()).filter(|index| parent_of(document, &tracks[*index].id).is_none()).collect();
    mains.sort_by_key(|index| (number(*index), *index));
    let mut out: Vec<&AafTrack> = mains.iter().flat_map(|index| std::iter::once(&tracks[*index])
        .chain(tracks.iter().filter(move |child| parent_of(document, &child.id) == Some(tracks[*index].id.as_str())))).collect();
    for track in tracks { if !out.iter().any(|kept| kept.id == track.id) { out.push(track); } }
    out
}

/// "A3" for a track, its group's track for an alternate.
fn track_label(document: &AafDocument, track: &AafTrack) -> String {
    let tracks = &document.manifest.tracks;
    let main = parent_of(document, &track.id).and_then(|parent| tracks.iter().find(|item| item.id == parent)).unwrap_or(track);
    let index = tracks.iter().position(|item| item.id == main.id).unwrap_or(0);
    format!("A{}", main.physical_track_number.unwrap_or(index as u32 + 1))
}

pub(crate) fn frame_of(sample: i64, sample_rate: u32, rate: &AafRate) -> i64 {
    (i128::from(sample) * i128::from(rate.numerator) / (i128::from(sample_rate.max(1)) * i128::from(rate.denominator.max(1)))) as i64
}

pub(crate) fn tc(document: &AafDocument, frame: i64) -> String {
    timecode::format(document.manifest.start_frame + frame, document.manifest.timecode_fps, document.manifest.drop_frame)
}

#[derive(Serialize)]
struct TrackInfo {
    track: String, id: String, person: String,
    #[serde(skip_serializing_if = "Option::is_none")] alternate_of: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] group: Option<String>,
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")] engine: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")] transcribed: Option<[String; 2]>,
    lines: usize,
}

#[derive(Serialize)]
pub struct Person { pub person: String, pub name: String, pub key: String, pub tracks: Vec<String>, pub lines: usize, pub words: usize }

#[derive(Serialize)]
struct PictureGroup { name: String, angles: Vec<String>, tc_in: String, tc_out: String }

#[derive(Serialize)]
struct Picture { track: String, clips: usize, groups: Vec<PictureGroup> }

#[derive(Serialize)]
struct Marker { tc: String, text: String, #[serde(skip_serializing_if = "Option::is_none")] by: Option<String> }

#[derive(Serialize)]
pub struct SequenceDetail {
    sequence: String, name: String, fps: f64, timecode_fps: u32, drop_frame: bool, start: String, end: String, seconds: f64,
    tracks: Vec<TrackInfo>, people: Vec<Person>,
    #[serde(skip_serializing_if = "Option::is_none")] picture: Option<Picture>,
    markers: Vec<Marker>,
}

pub fn people(document: &AafDocument) -> Vec<Person> {
    let mut out: Vec<Person> = Vec::new();
    for track in ordered(document) {
        let key = person_key(document, track);
        let cues = document.transcripts.iter().find(|item| item.track_id == track.id).map(|item| item.cues.as_slice()).unwrap_or_default();
        let words: usize = cues.iter().map(|cue| cue.text.split_whitespace().count()).sum();
        let label = track_label(document, track);
        match out.iter_mut().find(|person| person.key == key) {
            Some(person) => { if !person.tracks.contains(&label) { person.tracks.push(label); } person.lines += cues.len(); person.words += words; }
            None => out.push(Person { person: Address::Person { sequence: document.id.clone(), person: key.clone() }.to_string(),
                name: owner(document, track), key, tracks: vec![label], lines: cues.len(), words }),
        }
    }
    out
}

pub fn detail(ctx: &Context, wanted: &str) -> Result<SequenceDetail, AppError> {
    let document = ctx.document(&resolve(ctx, wanted)?)?;
    let manifest = &document.manifest;
    let tracks = ordered(&document).into_iter().map(|track| {
        let transcript = document.transcripts.iter().find(|item| item.track_id == track.id);
        let lane = manifest.graph.as_ref().and_then(|graph| graph.lanes.iter().find(|lane| lane.track_id == track.id));
        TrackInfo {
            track: track_label(&document, track), id: track.id.clone(), person: owner(&document, track),
            alternate_of: lane.and(parent_of(&document, &track.id)).map(|_| track_label(&document, track)),
            group: lane.filter(|lane| lane.parent_track_id.is_some()).and_then(|lane| lane.group_name.clone()),
            status: match transcript.map(|item| &item.status) {
                None => "not transcribed", Some(AafTranscriptStatus::Completed) => "completed", Some(AafTranscriptStatus::Empty) => "empty", Some(AafTranscriptStatus::Review) => "review",
            },
            engine: transcript.map(|item| format!("{:?}", item.engine).to_lowercase()), model: transcript.map(|item| item.model_id.clone()),
            transcribed: transcript.map(|item| [tc(&document, item.start_frame), tc(&document, item.start_frame + item.duration_frames)]),
            lines: transcript.map(|item| item.cues.len()).unwrap_or(0),
        }
    }).collect();
    let picture = manifest.graph.as_ref().and_then(|graph| graph.picture_tracks.iter()
        .find(|track| track.physical_track_number == Some(1) && !track.clips.is_empty()).or_else(|| graph.picture_tracks.iter().find(|track| !track.clips.is_empty())))
        .map(|track| Picture {
            track: format!("V{}", track.physical_track_number.unwrap_or(1)), clips: track.clips.len(),
            groups: track.clips.iter().filter(|clip| clip.group).take(50).map(|clip| PictureGroup {
                name: clip.group_name.clone().or_else(|| clip.name.clone()).unwrap_or_else(|| "Group".into()), angles: clip.angles.clone().unwrap_or_default(),
                tc_in: tc(&document, clip.start_frame), tc_out: tc(&document, clip.start_frame + clip.duration_frames),
            }).collect(),
        });
    let markers = manifest.graph.as_ref().map(|graph| graph.markers.iter().take(500).map(|marker| Marker {
        tc: tc(&document, marker.position), text: marker.comment.clone(), by: marker.attributes.get("_ATN_CRM_USER").cloned().filter(|name| !name.is_empty()),
    }).collect()).unwrap_or_default();
    let rate = f64::from(manifest.edit_rate.numerator) / f64::from(manifest.edit_rate.denominator.max(1));
    Ok(SequenceDetail {
        sequence: Address::Sequence(document.id.clone()).to_string(), name: manifest.name.clone(), fps: (rate * 1000.0).round() / 1000.0,
        timecode_fps: manifest.timecode_fps, drop_frame: manifest.drop_frame, start: tc(&document, 0), end: tc(&document, manifest.duration_frames),
        seconds: (manifest.duration_frames as f64 / rate * 10.0).round() / 10.0, tracks, people: people(&document), picture, markers,
    })
}

/// A cue's bleed words, and how many came from each source mic.
type BleedTally<'a> = (usize, std::collections::HashMap<&'a str, usize>);

/// Every transcribed line of a sequence, in time order (then track order),
/// with the string outs that play each.
pub(crate) fn all_lines(ctx: &Context, document: &AafDocument) -> Result<Vec<(i64, String, Line)>, AppError> {
    let uses = string_outs::uses(ctx, &document.id)?;
    // A cue is bleed when most of its words are, the rule the app's reader uses.
    let mut bleed: std::collections::HashMap<(&str, &str), BleedTally> = std::collections::HashMap::new();
    let ownership = ctx.ownership(&document.id);
    for word in ownership.iter().flat_map(|answer| answer.words.iter()) {
        if word.label != crate::bleed::AafOwnershipLabel::Bleed { continue; }
        let entry = bleed.entry((word.track_id.as_str(), word.cue_id.as_str())).or_default();
        entry.0 += 1;
        if let Some(source) = &word.heard_on { *entry.1.entry(source.as_str()).or_default() += 1; }
    }
    let mut out = Vec::new();
    for (order, track) in ordered(document).into_iter().enumerate() {
        let Some(transcript) = document.transcripts.iter().find(|item| item.track_id == track.id) else { continue };
        let (who, label) = (owner(document, track), track_label(document, track));
        for cue in &transcript.cues {
            let from = frame_of(cue.start_sample, transcript.sample_rate, &document.manifest.edit_rate);
            let to = frame_of(cue.end_sample, transcript.sample_rate, &document.manifest.edit_rate).max(from + 1);
            let middle = (from + to) / 2;
            let mut in_string_outs: Vec<String> = uses.iter().filter(|item| item.track == track.id && item.from <= middle && middle < item.to).map(|item| item.string_out.clone()).collect();
            in_string_outs.dedup();
            let words = cue.text.split_whitespace().count().max(1);
            let bleed_from = bleed.get(&(track.id.as_str(), cue.id.as_str())).filter(|(count, _)| *count as f64 / words as f64 >= 0.6)
                .map(|(_, sources)| sources.iter().max_by_key(|(_, count)| **count).map(|(source, _)| *source)
                    .and_then(|source| document.manifest.tracks.iter().find(|item| item.id == source)).map(|source| owner(document, source)).unwrap_or_else(|| "another mic".into()));
            out.push(((from, order), track.id.clone(), Line { line: Address::Line { sequence: document.id.clone(), track: track.id.clone(), cue: cue.id.clone() }.to_string(),
                who: who.clone(), track: label.clone(), tc_in: tc(document, from), tc_out: tc(document, to), text: cue.text.trim().to_string(), in_string_outs, bleed_from }));
        }
    }
    out.sort_by_key(|(key, _, _)| *key);
    Ok(out.into_iter().map(|((frame, _), track, line)| (frame, track, line)).collect())
}

/// The tracks a person named by key, address or name speaks on in a sequence.
fn person_tracks(document: &AafDocument, wanted: &str) -> Result<(String, Vec<String>), AppError> {
    let key = match Address::parse(wanted) { Ok(Address::Person { person, .. }) => person, _ => wanted.trim().to_string() };
    let everyone = people(document);
    let found = pick(&everyone, &key, |person| person.key.as_str(), |person| person.name.as_str(), "person")?;
    Ok((found.name.clone(), ordered(document).into_iter().filter(|track| person_key(document, track) == found.key).map(|track| track.id.clone()).collect()))
}

#[derive(Serialize)]
pub struct Page {
    sequence: String, name: String,
    #[serde(skip_serializing_if = "Option::is_none")] person: Option<String>,
    lines: Vec<Line>, total: usize,
    #[serde(skip_serializing_if = "Option::is_none")] next_cursor: Option<usize>,
}

pub struct Read<'a> { pub person: Option<&'a str>, pub from: Option<&'a str>, pub to: Option<&'a str>, pub cursor: usize, pub limit: usize }

pub fn read(ctx: &Context, wanted: &str, query: Read) -> Result<Page, AppError> {
    let document = ctx.document(&resolve(ctx, wanted)?)?;
    let manifest = &document.manifest;
    let bound = |text: Option<&str>| -> Result<Option<i64>, AppError> {
        text.map(|value| timecode::parse(value, manifest.timecode_fps, manifest.drop_frame).map(|frames| frames - manifest.start_frame)
            .ok_or_else(|| AppError::invalid(format!("\"{value}\" is not timecode for {} (HH:MM:SS:FF, from {}).", manifest.name, tc(&document, 0))))).transpose()
    };
    let (from, to) = (bound(query.from)?, bound(query.to)?);
    let (person, tracks) = match query.person { Some(wanted) => { let (name, tracks) = person_tracks(&document, wanted)?; (Some(name), Some(tracks)) } None => (None, None) };
    let chosen: Vec<Line> = all_lines(ctx, &document)?.into_iter()
        .filter(|(frame, track, _)| from.is_none_or(|start| *frame >= start) && to.is_none_or(|end| *frame < end) && tracks.as_ref().is_none_or(|ids| ids.contains(track)))
        .map(|(_, _, line)| line).collect();
    let (lines, next_cursor) = page(&chosen, query.cursor, query.limit);
    Ok(Page { sequence: Address::Sequence(document.id.clone()).to_string(), name: manifest.name.clone(), person, total: chosen.len(), lines, next_cursor })
}

/// One page of lines from `cursor`, stopping at the line limit or the character budget.
pub(crate) fn page(lines: &[Line], cursor: usize, limit: usize) -> (Vec<Line>, Option<usize>) {
    let limit = limit.clamp(1, MAX_PAGE_LINES);
    let (mut out, mut chars) = (Vec::new(), 0);
    for line in lines.iter().skip(cursor) {
        chars += line.text.len() + 160;
        if out.len() >= limit || (chars > PAGE_CHARS && !out.is_empty()) { break; }
        out.push(line.clone());
    }
    let next = cursor + out.len();
    (out, (next < lines.len()).then_some(next))
}

#[derive(Serialize)]
pub struct Found { sequence: String, #[serde(flatten)] line: Line }

#[derive(Serialize)]
pub struct Search { query: String, matches: Vec<Found>, total: usize }

fn words(text: &str) -> Vec<String> {
    text.to_lowercase().split(|c: char| !(c.is_alphanumeric() || c == '\'')).map(|word| word.trim_matches('\'').to_string()).filter(|word| !word.is_empty()).collect()
}

/// Lines that hold every word of the query (a word also matches the start of
/// a longer one, so "tire" finds "tired"), or the exact phrase when it is in
/// quotes. Case-insensitive; local and instant.
pub fn search(ctx: &Context, query: &str, people_filter: &[String], sequences: &[String], limit: usize, include_bleed: bool) -> Result<Search, AppError> {
    let phrase = query.trim().strip_prefix('"').and_then(|rest| rest.strip_suffix('"')).map(str::to_lowercase);
    let wanted = words(query);
    if wanted.is_empty() { return Err(AppError::invalid("Search needs at least one word.")); }
    let ids = if sequences.is_empty() { list(ctx)?.into_iter().map(|item| item.sequence.rsplit('/').next().unwrap_or_default().to_string()).collect() }
        else { sequences.iter().map(|wanted| resolve(ctx, wanted)).collect::<Result<Vec<_>, _>>()? };
    let mut scored: Vec<(usize, String, i64, Line)> = Vec::new();
    for id in ids {
        let document = ctx.document(&id)?;
        let allowed: Option<Vec<String>> = if people_filter.is_empty() { None } else {
            let everyone = people(&document);
            Some(people_filter.iter().filter_map(|wanted| pick(&everyone, wanted, |person| person.key.as_str(), |person| person.name.as_str(), "person").ok().map(|person| person.name.clone())).collect())
        };
        for (frame, _, line) in all_lines(ctx, &document)? {
            if allowed.as_ref().is_some_and(|names| !names.contains(&line.who)) { continue; }
            // A bleed copy repeats its owner's line: one hit, from the mic it was said into.
            if line.bleed_from.is_some() && !include_bleed { continue; }
            let score = match &phrase {
                Some(phrase) => usize::from(line.text.to_lowercase().contains(phrase.as_str())) * 2 * wanted.len(),
                None => {
                    let have = words(&line.text);
                    let hits: Vec<usize> = wanted.iter().map(|word| if have.contains(word) { 2 } else if have.iter().any(|item| item.starts_with(word.as_str())) { 1 } else { 0 }).collect();
                    if hits.contains(&0) { 0 } else { hits.iter().sum() }
                }
            };
            if score > 0 { scored.push((score, document.manifest.name.clone(), frame, line)); }
        }
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)).then_with(|| a.2.cmp(&b.2)));
    let total = scored.len();
    Ok(Search { query: query.to_string(), total, matches: scored.into_iter().take(limit.clamp(1, 500)).map(|(_, sequence, _, line)| Found { sequence, line }).collect() })
}
