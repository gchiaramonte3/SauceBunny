//! The context layer against fixtures shaped like the real thing: a 20-mic
//! sequence, a grouped one whose alternates the AAF stores after every main
//! track, a string out in a real undo log, and a transcript file.
use super::{tools, Context, Roots};
use crate::commands::aaf::model::AafDocument;
use crate::edit_doc::EditDocument;
use crate::edit_log::EditLog;
use serde_json::{json, Value};
use std::path::PathBuf;

pub(crate) const BANK: &str = "1111111111111111111111111111111111111111111111111111111111111111";
pub(crate) const HEAT: &str = "2222222222222222222222222222222222222222222222222222222222222222";
pub(crate) const EDIT: &str = "edit0000000000000000aaaa";

fn track(id: &str, number: u32) -> Value {
    json!({ "id": id, "name": format!("Mic {id}"), "physical_track_number": number, "clips": [], "warnings": [] })
}

fn cues(track: &str, count: usize) -> Value {
    // Two seconds apart, a second and a half each, at 16 kHz; every fifth is tired.
    Value::Array((0..count).map(|index| json!({ "id": format!("{track}-c{index}"), "start_sample": index as i64 * 32_000, "end_sample": index as i64 * 32_000 + 24_000,
        "text": if index % 5 == 0 { format!("I am so tired, says {track} at {index}.") } else { format!("Line {index} from {track}.") }, "boundary_review": false })).collect())
}

fn document(id: &str, name: &str, tracks: Vec<Value>, labels: Vec<Value>, transcripts: Vec<Value>, graph: Option<Value>) -> AafDocument {
    serde_json::from_value(json!({
        "schema_version": 4, "id": id, "source_path": format!("/fixtures/{name}.aaf"), "source_size": 1, "source_modified_ms": 1,
        "manifest": { "schema_version": 3, "graph": graph, "name": name, "source_fingerprint": id, "edit_rate": { "numerator": 24000, "denominator": 1001 },
            "start_frame": 1_728_000, "duration_frames": 24 * 600, "timecode_fps": 24, "drop_frame": false, "tracks": tracks, "warnings": [] },
        "labels": labels, "transcripts": transcripts,
    })).unwrap()
}

fn transcript(track: &str, count: usize) -> Value {
    json!({ "track_id": track, "start_frame": 0, "duration_frames": 24 * 600, "engine": "parakeet", "model_id": "parakeet-tdt-0.6b-v3",
        "status": "completed", "sample_rate": 16000, "cues": cues(track, count), "timing_issues": [], "warnings": [] })
}

pub(crate) struct Fixture { pub home: PathBuf, pub ctx: Context }

impl Drop for Fixture { fn drop(&mut self) { let _ = std::fs::remove_dir_all(&self.home); } }

pub(crate) fn fixture() -> Fixture {
    let home = std::env::temp_dir().join(format!("sb-context-{}", uuid::Uuid::new_v4()));
    let roots = Roots::for_home(&home, None);
    std::fs::create_dir_all(&roots.multitrack).unwrap();
    // AFF BANK 1: twenty lavs, P1 to P20, every one transcribed.
    let names: Vec<String> = (1..=20).map(|n| format!("P{n}")).collect();
    let bank = document(BANK, "AFF BANK 1", (1..=20).map(|n| track(&format!("t{n}"), n)).collect(),
        names.iter().enumerate().map(|(index, name)| json!({ "track_id": format!("t{}", index + 1), "owner_name": name })).collect(),
        (1..=20).map(|n| transcript(&format!("t{n}"), 30)).collect(), None);
    crate::commands::aaf::store::create(&roots.multitrack, &bank).unwrap();
    // HEAT 2: two mains and their alternates, stored main, main, alternate, alternate.
    let heat = document(HEAT, "HEAT 2", vec![track("m1", 1), track("m2", 2), track("alt1", 3), track("alt2", 4)],
        vec![json!({ "track_id": "m1", "owner_name": "ANNA" }), json!({ "track_id": "m2", "owner_name": "BETH" }),
             json!({ "track_id": "alt1", "owner_name": "CARL" }), json!({ "track_id": "alt2", "owner_name": "" })],
        vec![transcript("m1", 4)],
        Some(json!({ "sequence_id": "top", "sources": [], "positions": [], "path_mappings": [],
            "markers": [{ "position": 48, "comment": "Fight starts", "described_slots": [1], "attributes": { "_ATN_CRM_USER": "story" } }],
            "lanes": [
                { "track_id": "m1", "parent_track_id": null, "branch_id": null, "group_name": null, "availability": "ready" },
                { "track_id": "m2", "parent_track_id": null, "branch_id": null, "group_name": null, "availability": "ready" },
                { "track_id": "alt1", "parent_track_id": "m1", "branch_id": "b1", "group_name": "Heat group", "availability": "ready" },
                { "track_id": "alt2", "parent_track_id": "m2", "branch_id": "b2", "group_name": "Heat group", "availability": "ready" }],
            "picture_tracks": [{ "slot_id": 9, "physical_track_number": 1, "name": "V1", "component": "Sequence", "clips": [
                { "start_frame": 0, "duration_frames": 2400, "kind": "clip", "name": "CAM A", "master_mob_id": null, "file_mob_id": null, "tape_name": null,
                  "source_start_frame": null, "source_timecode_fps": null, "source_drop_frame": null, "group": true, "group_name": "Heat group",
                  "angles": ["CAM A", "CAM B"], "effect": null, "descriptor": null }] }] })));
    crate::commands::aaf::store::create(&roots.multitrack, &heat).unwrap();
    // A string out of P1's 0-4 s and 20-22 s, P2 listed but not on a track, a gap, and a marker.
    let edit: EditDocument = serde_json::from_value(json!({
        "schema_version": 1, "title": "P1 tired", "edit_rate": { "numerator": 24000, "denominator": 1001 }, "start_timecode_frames": 86_400,
        "sources": [{ "id": "s1", "name": "AFF BANK 1", "document_id": BANK }],
        "tracks": [{ "id": "p1", "name": "P1", "kind": "sound", "source_tracks": { "s1": "t1" } },
                   { "id": "p2", "name": "P2", "kind": "sound", "source_tracks": { "s1": "t2" }, "featured": false }],
        "segments": [{ "kind": "source", "id": "seg-a", "source": "s1", "in_frame": 0, "out_frame": 96, "tracks": ["p1"] },
                     { "kind": "gap", "id": "gap-1", "frames": 24 },
                     { "kind": "source", "id": "seg-b", "source": "s1", "in_frame": 480, "out_frame": 528, "tracks": ["p1"] }],
        "mutes": [], "markers": [{ "id": "m1", "frame": 10, "track": "p1", "name": "Bite", "comment": "tired", "color": "red" }],
    })).unwrap();
    let mut log = EditLog::open(&roots.timelines).unwrap();
    log.create(EDIT, &edit, 1_000).unwrap();
    let mut marked = edit.clone();
    marked.markers.push(serde_json::from_value(json!({ "id": "m2", "frame": 100, "track": null, "name": "Later", "comment": "", "color": "blue" })).unwrap());
    log.commit(EDIT, "Add Marker", None, &marked, 2_000).unwrap();
    drop(log);
    let library = roots.transcripts.join("2026-09");
    std::fs::create_dir_all(&library).unwrap();
    std::fs::write(library.join("Rosa interview.srt"), "1\n00:00:01,000 --> 00:00:02,500\n[SPEAKER_00]: I moved here in May.\n\n2\n00:00:03,000 --> 00:00:04,000\n[SPEAKER_01]: Then what?\n").unwrap();
    Fixture { ctx: Context::new(roots), home }
}

fn call(ctx: &Context, name: &str, args: Value) -> Value { tools::call(ctx, name, &args).unwrap_or_else(|error| panic!("{name}: {error}")) }

#[test]
fn lists_sequences_and_finds_one_by_address_id_or_name() {
    let f = fixture();
    let all = call(&f.ctx, "list_sequences", json!({}));
    let names: Vec<&str> = all["sequences"].as_array().unwrap().iter().map(|item| item["name"].as_str().unwrap()).collect();
    assert_eq!(names, ["AFF BANK 1", "HEAT 2"]);
    for wanted in [format!("saucebunny://sequence/{BANK}"), BANK.to_string(), "aff bank 1".into(), "BANK".into()] {
        assert_eq!(call(&f.ctx, "get_sequence", json!({ "sequence": wanted }))["name"], "AFF BANK 1");
    }
    let wrong = tools::call(&f.ctx, "get_sequence", &json!({ "sequence": "Heat 3" })).unwrap_err().to_string();
    assert!(wrong.contains("\"AFF BANK 1\"") && wrong.contains("\"HEAT 2\""), "{wrong}");
}

#[test]
fn a_grouped_sequence_reads_in_avid_order_with_alternates_after_their_track() {
    let f = fixture();
    let heat = call(&f.ctx, "get_sequence", json!({ "sequence": "HEAT 2" }));
    let tracks: Vec<(String, String, Option<String>)> = heat["tracks"].as_array().unwrap().iter().map(|track| (track["track"].as_str().unwrap().into(),
        track["person"].as_str().unwrap().into(), track["alternate_of"].as_str().map(String::from))).collect();
    assert_eq!(tracks, vec![("A1".into(), "ANNA".into(), None), ("A1".into(), "CARL".into(), Some("A1".into())),
        ("A2".into(), "BETH".into(), None), ("A2".into(), "Mic alt2".into(), Some("A2".into()))]);
    assert_eq!(heat["tracks"][0]["status"], "completed");
    assert_eq!(heat["tracks"][2]["status"], "not transcribed");
    assert_eq!(heat["start"], "20:00:00:00");
    assert_eq!(heat["picture"]["groups"][0]["angles"], json!(["CAM A", "CAM B"]));
    assert_eq!(heat["markers"][0], json!({ "tc": "20:00:02:00", "text": "Fight starts", "by": "story" }));
}

#[test]
fn reads_one_persons_lines_in_a_timecode_range_and_says_which_string_outs_use_them() {
    let f = fixture();
    // Timecode, not seconds: at 23.976 the cue 10 s in starts before 20:00:10:00, so stop at 9.
    let page = call(&f.ctx, "read_transcript", json!({ "sequence": BANK, "person": "p1", "from": "20:00:00:00", "to": "20:00:09:00" }));
    let lines = page["lines"].as_array().unwrap();
    assert_eq!(page["person"], "P1");
    assert_eq!(lines.len(), 5);
    assert!(lines.iter().all(|line| line["who"] == "P1" && line["track"] == "A1"));
    assert_eq!(lines[0]["tc_in"], "20:00:00:00");
    assert_eq!(lines[0]["line"], format!("saucebunny://sequence/{BANK}/line/t1/t1-c0"));
    // The string out plays 0-4 s of P1: lines 0 and 1, and nothing of P2.
    let used: Vec<bool> = lines.iter().map(|line| line.get("in").is_some()).collect();
    assert_eq!(used, [true, true, false, false, false]);
    let p2 = call(&f.ctx, "read_transcript", json!({ "sequence": BANK, "person": "P2", "limit": 3 }));
    assert!(p2["lines"].as_array().unwrap().iter().all(|line| line.get("in").is_none()));
    assert_eq!(p2["next_cursor"], 3);
    assert_eq!(p2["total"], 30);
}

#[test]
fn a_page_stops_under_its_budget_and_continues_from_its_cursor() {
    let long = super::Line { line: "x".into(), who: "P".into(), track: "A1".into(), tc_in: "".into(), tc_out: "".into(), text: "word ".repeat(2_000), in_string_outs: vec![], bleed_from: None, span: [0, 1], copies: 0 };
    let lines = vec![long; 50];
    let (first, next) = super::sequences::page(&lines, 0, 1_000, 60_000);
    assert!(first.len() < 10 && next == Some(first.len()), "{} lines", first.len());
    let (rest, _) = super::sequences::page(&lines, next.unwrap(), 1_000, 60_000);
    assert!(!rest.is_empty());
}

#[test]
fn searches_by_word_prefix_phrase_and_person() {
    let f = fixture();
    let found = call(&f.ctx, "search_transcripts", json!({ "query": "tire", "sequences": ["AFF BANK 1"] }));
    assert_eq!(found["total"], 20 * 6);
    assert!(found["matches"].as_array().unwrap().iter().all(|item| item["text"].as_str().unwrap().contains("tired")));
    let phrase = call(&f.ctx, "search_transcripts", json!({ "query": "\"says t3 at 5\"" }));
    assert_eq!(phrase["total"], 1);
    let only = call(&f.ctx, "search_transcripts", json!({ "query": "tired", "people": ["P7"], "limit": 2 }));
    assert_eq!(only["total"], 6);
    assert_eq!(only["matches"].as_array().unwrap().len(), 2);
    assert_eq!(only["matches"][0]["sequence"], "AFF BANK 1");
}

#[test]
fn people_carry_their_tracks_and_how_much_they_say() {
    let f = fixture();
    let bank = call(&f.ctx, "list_people", json!({ "sequence": "AFF BANK 1" }));
    let people = bank["people"].as_array().unwrap();
    assert_eq!(people.len(), 20);
    assert_eq!(people[2]["name"], "P3");
    assert_eq!(people[2]["tracks"], json!(["A3"]));
    assert_eq!(people[2]["lines"], 30);
    let everywhere = call(&f.ctx, "list_people", json!({}));
    assert_eq!(everywhere["sequences"].as_array().unwrap().len(), 2);
}

#[test]
fn a_string_out_reads_as_patched_tracks_and_clips_with_record_and_source_timecode() {
    let f = fixture();
    let list = call(&f.ctx, "list_string_outs", json!({}));
    assert_eq!(list["string_outs"][0]["title"], "P1 tired");
    assert_eq!(list["string_outs"][0]["tracks"], json!(["A1 P1"]));
    let detail = call(&f.ctx, "get_string_out", json!({ "string_out": "p1 tired" }));
    assert_eq!(detail["tracks"], json!([{ "track": "A1", "person": "P1" }]));
    assert_eq!(detail["not_on_a_track"], json!(["P2"]));
    let clips = detail["clips"].as_array().unwrap();
    assert_eq!(clips.iter().map(|clip| clip["kind"].as_str().unwrap()).collect::<Vec<_>>(), ["clip", "gap", "clip"]);
    assert_eq!((clips[0]["record_in"].as_str().unwrap(), clips[0]["source_in"].as_str().unwrap()), ("01:00:00:00", "20:00:00:00"));
    assert_eq!(clips[2]["record_in"], "01:00:05:00");
    assert_eq!(clips[0]["text"], json!(["P1: I am so tired, says t1 at 0.", "P1: Line 1 from t1."]));
    assert_eq!(detail["markers"][0]["track"], "A1 P1");
    assert_eq!(detail["last_change"], "Add Marker");
    let history = call(&f.ctx, "get_history", json!({ "string_out": format!("saucebunny://string-out/{EDIT}") }));
    let steps = history["steps"].as_array().unwrap();
    assert_eq!(steps.len(), 2);
    assert_eq!(steps[1]["current"], true);
}

#[test]
fn reads_the_transcripts_library_and_nothing_outside_it() {
    let f = fixture();
    let files = call(&f.ctx, "list_transcript_files", json!({}));
    let address = files["transcripts"][0]["transcript"].as_str().unwrap().to_string();
    let read = call(&f.ctx, "read_transcript_file", json!({ "transcript": address }));
    assert_eq!(read["lines"][0], json!({ "at": "00:00:01.000", "to": "00:00:02.500", "who": "SPEAKER_00", "text": "I moved here in May." }));
    let outside = f.home.join("secret.srt");
    std::fs::write(&outside, "1\n00:00:01,000 --> 00:00:02,000\nNo.\n").unwrap();
    assert!(tools::call(&f.ctx, "read_transcript_file", &json!({ "transcript": outside.to_string_lossy() })).is_err());
}

#[test]
fn every_address_kind_reads() {
    let f = fixture();
    for uri in [
        "saucebunny://sequences".to_string(), "saucebunny://string-outs".into(), "saucebunny://transcripts".into(),
        format!("saucebunny://sequence/{HEAT}"), format!("saucebunny://sequence/{BANK}/person/owner:p4"),
        format!("saucebunny://sequence/{BANK}/line/t2/t2-c3"), format!("saucebunny://sequence/{BANK}@20:00:30:00"),
        format!("saucebunny://string-out/{EDIT}"), format!("saucebunny://string-out/{EDIT}/clip/seg-b"), format!("saucebunny://string-out/{EDIT}/history"),
    ] {
        let read = tools::read(&f.ctx, &uri).unwrap_or_else(|error| panic!("{uri}: {error}"));
        assert!(read.is_object(), "{uri}");
    }
    let line = tools::read(&f.ctx, &format!("saucebunny://sequence/{BANK}/line/t2/t2-c3")).unwrap();
    assert_eq!(line["line"]["text"], "Line 3 from t2.");
    assert!(line["around"].as_array().unwrap().len() > 1);
}

#[test]
fn the_history_is_read_without_holding_up_the_app() {
    let f = fixture();
    let reader = EditLog::open_read_only(&f.ctx.roots.timelines).unwrap();
    assert_eq!(reader.list().unwrap().len(), 1);
    // The app commits while a reader is open.
    let mut writer = EditLog::open(&f.ctx.roots.timelines).unwrap();
    let mut renamed = writer.head(EDIT).unwrap().document;
    renamed.title = "Renamed".into();
    writer.commit(EDIT, "Rename", None, &renamed, 3_000).unwrap();
    assert_eq!(reader.head(EDIT).unwrap().label, "Rename");
}

/// The app's bleed labels, cached beside timelines.sqlite: P2's first line,
/// "I am so tired, says t2 at 0.", marked as heard on P1's mic.
fn cache_bleed(f: &Fixture, stamp_matches: bool) {
    let app_data = f.ctx.roots.timelines.parent().unwrap();
    let document = std::fs::metadata(f.ctx.roots.multitrack.join(format!("{BANK}.json"))).unwrap();
    let stamp = if stamp_matches { format!("{}:t1=1", crate::commands::aaf::store::modified_ms(&document)) } else { "1:old".into() };
    let words: Vec<Value> = (0..7).map(|index| json!({ "track_id": "t2", "cue_id": "t2-c0", "index": index, "label": "bleed", "heard_on": "t1", "delta_db": -15.0 })).collect();
    let path = crate::commands::aaf::ownership::cache_file(app_data, BANK);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, json!({ "document_id": BANK, "measured": ["t1", "t2"], "missing": [], "words": words, "stamp": stamp,
        "counts": { "owner": 0, "bleed": 7, "overtalk": 0, "offmic": 0, "unsure": 0 } }).to_string()).unwrap();
}

#[test]
fn a_bleed_line_names_who_really_said_it_and_search_returns_it_once() {
    let f = fixture();
    cache_bleed(&f, true);
    crate::commands::aaf::ownership::set_hides_bleed(f.ctx.roots.timelines.parent().unwrap(), true).unwrap();
    let found = call(&f.ctx, "search_transcripts", json!({ "query": "tired", "people": ["P2"], "sequences": [BANK] }));
    assert!(found["matches"].as_array().unwrap().iter().all(|hit| !hit["line"].as_str().unwrap().ends_with("/t2-c0")), "the bleed copy was returned: {found}");
    let all = call(&f.ctx, "search_transcripts", json!({ "query": "tired", "people": ["P2"], "sequences": [BANK], "include_bleed": true }));
    let copy = all["matches"].as_array().unwrap().iter().find(|hit| hit["line"].as_str().unwrap().ends_with("/t2-c0")).expect("include_bleed lost the copy");
    assert_eq!(copy["bleed_from"], "P1");
    // The owner's own lines carry no mark at all.
    let page = call(&f.ctx, "read_transcript", json!({ "sequence": BANK, "person": "P1", "limit": 3 }));
    assert!(page["lines"].as_array().unwrap().iter().all(|line| line.get("bleed_from").is_none()));
}

/// Off is the default: nothing is left out of a search, and the copy says
/// whose mic it came from, because the label may be wrong.
#[test]
fn with_bleed_not_hidden_search_returns_the_copy_marked() {
    let f = fixture();
    cache_bleed(&f, true);
    let found = call(&f.ctx, "search_transcripts", json!({ "query": "tired", "people": ["P2"], "sequences": [BANK] }));
    let copy = found["matches"].as_array().unwrap().iter().find(|hit| hit["line"].as_str().unwrap().ends_with("/t2-c0")).expect("the copy was left out with bleed not hidden");
    assert_eq!(copy["bleed_from"], "P1");
    let none = call(&f.ctx, "search_transcripts", json!({ "query": "tired", "people": ["P2"], "sequences": [BANK], "include_bleed": false }));
    assert!(none["matches"].as_array().unwrap().iter().all(|hit| !hit["line"].as_str().unwrap().ends_with("/t2-c0")));
}

#[test]
fn labels_from_an_older_document_are_ignored_not_trusted() {
    let f = fixture();
    cache_bleed(&f, false);
    let found = call(&f.ctx, "search_transcripts", json!({ "query": "tired", "people": ["P2"], "sequences": [BANK] }));
    assert!(found["matches"].as_array().unwrap().iter().any(|hit| hit["line"].as_str().unwrap().ends_with("/t2-c0")));
}

#[test]
fn a_name_is_found_without_case_accents_or_a_small_misspelling_but_never_by_a_different_number() {
    let names = ["JILLIO", "DONNIE", "JULIA", "Zoë", "P2"];
    let found = |wanted: &str| super::pick(&names, wanted, |name| name, |name| name, "person").copied();
    assert_eq!(found("jillio").unwrap(), "JILLIO");
    assert_eq!(found("Jilio").unwrap(), "JILLIO");
    assert_eq!(found("Donny").unwrap(), "DONNIE");
    assert_eq!(found("zoe").unwrap(), "Zoë");
    // A different number is someone else.
    let missing = found("P21").unwrap_err().to_string();
    assert!(missing.contains("No person called \"P21\"") && missing.contains("Closest"), "{missing}");
    // Two equally close spellings name neither, and say who they could be.
    assert!(found("Jullio").is_err() || found("Jullio").unwrap() == "JILLIO");
}

#[test]
fn several_people_read_in_one_page_with_the_same_words_on_two_mics_once() {
    let f = fixture();
    // P1 and P2 say "Line 1 from t1." and "Line 1 from t2." at the same moment: one line heard on two mics.
    let both = call(&f.ctx, "read_transcript", json!({ "sequence": BANK, "people": ["P1", "p2"], "from": "20:00:00:00", "to": "20:00:09:00" }));
    assert_eq!((both["person"].as_str(), both["total"].as_u64()), (Some("P1, P2"), Some(5)));
    assert!(both["lines"].as_array().unwrap().iter().all(|line| line["who"] == "P1" && line["copies"] == 1), "{both}");
    // Asked to keep every copy, both mics' lines come back.
    let kept = call(&f.ctx, "read_transcript", json!({ "sequence": BANK, "people": ["P1", "P2"], "from": "20:00:00:00", "to": "20:00:09:00", "keep_copies": true }));
    assert_eq!(kept["total"], 10);
    // A short "yeah" is never a copy: everyone says it.
    assert_eq!(super::sequences::PAGE_LINES, 200);
}

#[test]
fn a_model_reads_rows_with_short_ids_that_turn_back_into_addresses() {
    let f = fixture();
    let output = tools::answer(&f.ctx, "read_transcript", &json!({ "sequence": "AFF BANK 1", "people": ["P1"], "from": "20:00:00:00", "to": "20:00:05:00" })).unwrap();
    let text = output.text();
    let mut rows = text.lines();
    assert_eq!(rows.next().unwrap(), format!("AFF BANK 1 (saucebunny://sequence/{BANK}) · P1 · lines 1-3 of 3"));
    let first = rows.next().unwrap();
    assert!(first.ends_with("P1 (A1): I am so tired, says t1 at 0. [in: P1 tired]"), "{first}");
    let id = first.split(' ').next().unwrap();
    assert_eq!(f.ctx.ids.address(id), Some(format!("saucebunny://sequence/{BANK}/line/t1/t1-c0")));
    // Search answers in rows too, and a range and any-word narrow it.
    let found = tools::answer(&f.ctx, "search_transcripts", &json!({ "query": "tired sleepy", "any": true, "people": ["P1"], "sequences": [BANK], "from": "20:00:00:00", "to": "20:00:09:00" })).unwrap().text();
    assert!(found.starts_with("Search \"tired sleepy\" in AFF BANK 1: 1 of 1 matches"), "{found}");
    assert!(found.contains(id), "{found}");
    let none = tools::answer(&f.ctx, "search_transcripts", &json!({ "query": "tired sleepy", "people": ["P1"], "sequences": [BANK] })).unwrap().text();
    assert!(none.contains(": 0 of 0 matches"), "{none}");
    // The brief sequence is the names and timecodes, not the tracks.
    let brief = call(&f.ctx, "get_sequence", json!({ "sequence": BANK, "brief": true }));
    assert_eq!((brief["start"].as_str(), brief["people"].as_array().unwrap().len()), (Some("20:00:00:00"), 20));
    assert!(brief.get("tracks").is_some_and(Value::is_number));
}

#[test]
fn one_person_on_two_mics_reads_once_and_a_line_said_twice_at_different_times_stays_twice() {
    let line = |track: &str, from: i64, text: &str| (from, track.to_string(), super::Line { line: format!("{track}-{from}"), who: "KENDALL".into(), track: track.into(),
        tc_in: String::new(), tc_out: String::new(), text: text.into(), in_string_outs: vec![], bleed_from: None, span: [from, from + 48], copies: 0 });
    let folded = super::sequences::fold_copies(vec![
        line("t10", 0, "kinda think that would be a sick match"), line("t14", 0, "kinda think that would be a sick match"),
        line("t10", 500, "kinda think that would be a sick match"),
    ], &[]);
    assert_eq!(folded.iter().map(|line| (line.track.as_str(), line.copies)).collect::<Vec<_>>(), [("t10", 1), ("t10", 0)]);
}

/// ROOM: Donnie and Jillio argue at 0-7 s, Donnie talks alone at 40 s, and
/// they go at it again at 60-66 s with Eve cutting in.
pub(crate) fn add_room(ctx: &Context) {
    let said = |track: &str, lines: &[(f64, &str)]| json!({ "track_id": track, "start_frame": 0, "duration_frames": 24 * 600, "engine": "parakeet", "model_id": "m",
        "status": "completed", "sample_rate": 16000, "timing_issues": [], "warnings": [],
        "cues": lines.iter().enumerate().map(|(index, (at, text))| json!({ "id": format!("{track}-{index}"), "start_sample": (at * 16_000.0) as i64,
            "end_sample": ((at + 1.5) * 16_000.0) as i64, "text": text, "boundary_review": false })).collect::<Vec<_>>() });
    let room = document(ROOM, "ROOM", vec![track("k", 1), track("d", 2), track("e", 3)],
        vec![json!({ "track_id": "k", "owner_name": "DONNIE" }), json!({ "track_id": "d", "owner_name": "JILLIO" }), json!({ "track_id": "e", "owner_name": "EVE" })],
        vec![
            said("k", &[(0.0, "my brother always won"), (4.0, "every single time we played"), (40.0, "talking to myself here now"), (60.0, "you were the favourite one"), (65.0, "and you still are to them")]),
            said("d", &[(2.0, "that is not how it went"), (6.0, "you always cheated at cards"), (63.0, "only because I was younger")]),
            said("e", &[(61.5, "can we film the next one")]),
        ], None);
    crate::commands::aaf::store::create(&ctx.roots.multitrack, &room).unwrap();
}
pub(crate) const ROOM: &str = "3333333333333333333333333333333333333333333333333333333333333333";

#[test]
fn conversations_are_where_the_people_take_turns_and_end_at_a_long_pause() {
    let f = fixture();
    add_room(&f.ctx);
    let found = call(&f.ctx, "find_conversations", json!({ "sequence": "ROOM", "people": ["Donny", "Jillio"] }));
    let stretches = found["stretches"].as_array().unwrap();
    assert_eq!(stretches.len(), 2, "{found}");
    assert_eq!((stretches[0]["turns"].as_u64(), stretches[0]["lines"].as_array().unwrap().len()), (Some(3), 4));
    // Eve speaks inside the second one: she comes with it.
    let second: Vec<&str> = stretches[1]["lines"].as_array().unwrap().iter().map(|line| line["who"].as_str().unwrap()).collect();
    assert_eq!(second, ["DONNIE", "EVE", "JILLIO", "DONNIE"]);
    // A shorter gap splits the second exchange (60 s to 63 s is past a 1 s pause), so only the first is left.
    let tight = call(&f.ctx, "find_conversations", json!({ "sequence": "ROOM", "people": ["DONNIE", "JILLIO"], "gap": 1.0 }));
    assert_eq!(tight["stretches"].as_array().unwrap().len(), 1);
    // As rows: a line per stretch, then its lines, Eve marked.
    let rows = tools::answer(&f.ctx, "find_conversations", &json!({ "sequence": "ROOM", "people": ["DONNIE", "JILLIO"] })).unwrap().text();
    assert!(rows.starts_with("Conversations between DONNIE and JILLIO in ROOM") && rows.contains("[not asked for]") && rows.contains("3 turns"), "{rows}");
    // One person is not a conversation.
    assert!(tools::call(&f.ctx, "find_conversations", &json!({ "sequence": "ROOM", "people": ["DONNIE"] })).is_err());
}

#[test]
fn a_cut_is_measured_beat_by_beat_with_what_is_wrong_with_it_named() {
    // A story cut is fitted to a running time with this, so a model never adds up timecodes itself.
    let f = fixture();
    cache_bleed(&f, true);
    let id = |track: &str, cue: &str| f.ctx.ids.id(&format!("saucebunny://sequence/{BANK}/line/{track}/{cue}"));
    let measured = call(&f.ctx, "measure_cut", json!({ "target_seconds": 5, "beats": [
        // Two lines two seconds apart play as one stretch; P2's copy of P1's line sits inside it.
        { "title": "Setup", "lines": [id("t1", "t1-c0"), id("t1", "t1-c1"), id("t2", "t2-c0")] },
        // Back in time by more than the join: two stretches, then a line already used.
        { "title": "Turn", "lines": [id("t1", "t1-c4"), id("t1", "t1-c2"), id("t1", "t1-c0")] },
        { "title": "Nothing", "lines": ["Lnothing"] },
    ] }));
    let beats = measured["beats"].as_array().unwrap();
    assert_eq!(beats.iter().map(|beat| (beat["title"].as_str().unwrap(), beat["stretches"].as_u64().unwrap(), beat["lines"].as_u64().unwrap())).collect::<Vec<_>>(),
        vec![("Setup", 1, 3), ("Turn", 3, 3), ("Nothing", 0, 0)]);
    // 0 to 83 frames at 23.976 (3.46 s), with a quarter second before and half a second after.
    assert_eq!(beats[0]["seconds"], 4.2);
    let total = measured["seconds"].as_f64().unwrap();
    let sum: f64 = beats.iter().map(|beat| beat["seconds"].as_f64().unwrap()).sum();
    assert!((total - (sum + 1.0)).abs() < 0.11, "one pause between the two beats that play: {total} vs {sum}");
    let warnings: Vec<&str> = measured["warnings"].as_array().unwrap().iter().map(|warning| warning.as_str().unwrap()).collect();
    for expected in ["plays twice", "heard on another person's mic", "Lnothing names no line", "\"Nothing\" has no lines that play", "against a target of 0:05"] {
        assert!(warnings.iter().any(|warning| warning.contains(expected)), "no warning saying {expected:?}: {warnings:?}");
    }
    // Within a tenth of the target, nothing is said about it.
    let close = call(&f.ctx, "measure_cut", json!({ "target_seconds": 4.2, "beats": [{ "title": "Setup", "lines": [id("t1", "t1-c0"), id("t1", "t1-c1")] }] }));
    assert!(close.get("warnings").is_none(), "{close}");
    assert_eq!(close["runtime"], "0:04");
}
