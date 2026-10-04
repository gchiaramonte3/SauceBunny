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
    let long = super::Line { line: "x".into(), who: "P".into(), track: "A1".into(), tc_in: "".into(), tc_out: "".into(), text: "word ".repeat(2_000), in_string_outs: vec![] };
    let lines = vec![long; 50];
    let (first, next) = super::sequences::page(&lines, 0, 1_000);
    assert!(first.len() < 10 && next == Some(first.len()), "{} lines", first.len());
    let (rest, _) = super::sequences::page(&lines, next.unwrap(), 1_000);
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
