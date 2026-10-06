//! The tools a model can call, the resources it can read and the prompts it
//! can start from, as one registry: the MCP server lists and dispatches
//! these, and the in-app assistant will hand the same definitions to Claude,
//! OpenAI or the local model. Every tool is read-only.
use super::{files, sequences, string_outs, Address, Context};
use crate::AppError;
use serde_json::{json, Value};

pub struct Tool { pub name: &'static str, pub title: &'static str, pub description: &'static str, pub input: fn() -> Value }

fn object(properties: Value, required: &[&str]) -> Value {
    json!({ "type": "object", "properties": properties, "required": required, "additionalProperties": false })
}

const SEQUENCE: &str = "A sequence's address (saucebunny://sequence/…), id or name, as list_sequences gives them.";
const STRING_OUT: &str = "A string out's address (saucebunny://string-out/…), id or title, as list_string_outs gives them.";
const PERSON: &str = "A person's name (ROSA), key (owner:rosa) or address, as get_sequence lists them.";
const CURSOR: &str = "Where to continue: the next_cursor of the previous page.";

pub const TOOLS: &[Tool] = &[
    Tool { name: "list_sequences", title: "List sequences",
        description: "Every AAF Audio sequence: multi-mic AAFs from Avid whose mics are transcribed one by one. Start here.",
        input: || object(json!({}), &[]) },
    Tool { name: "get_sequence", title: "Get a sequence",
        description: "One sequence: its tracks in Avid order (A1, then A1's group alternates, then A2) with who owns each mic and whether it is transcribed, the people on it, V1's picture groups, and its markers. Timecodes are the sequence's own.",
        input: || object(json!({ "sequence": { "type": "string", "description": SEQUENCE } }), &["sequence"]) },
    Tool { name: "list_people", title: "List people",
        description: "The people in one sequence, or in every sequence: their tracks and how much each says.",
        input: || object(json!({ "sequence": { "type": "string", "description": SEQUENCE } }), &[]) },
    Tool { name: "read_transcript", title: "Read a transcript",
        description: "A sequence's transcript as lines (what one mic heard as one sentence) in time order, each with who said it, their track, timecode in and out, and the string outs that use it. Narrow it to one person and a timecode range; it comes in pages.",
        input: || object(json!({
            "sequence": { "type": "string", "description": SEQUENCE },
            "person": { "type": "string", "description": PERSON },
            "from": { "type": "string", "description": "Start timecode, HH:MM:SS:FF in the sequence's own timecode." },
            "to": { "type": "string", "description": "End timecode, HH:MM:SS:FF." },
            "cursor": { "type": "integer", "minimum": 0, "description": CURSOR },
            "limit": { "type": "integer", "minimum": 1, "maximum": 1000, "description": "Lines per page (default 200)." },
        }), &["sequence"]) },
    Tool { name: "search_transcripts", title: "Search transcripts",
        description: "Lines that contain every word asked for (a word also matches the start of a longer one: \"tire\" finds \"tired\"), or an exact phrase in double quotes, across sequences or within some, optionally only for some people. Case-insensitive. Best match first.",
        input: || object(json!({
            "query": { "type": "string", "description": "Words to find, or a \"quoted phrase\"." },
            "people": { "type": "array", "items": { "type": "string" }, "description": "Only these people (names or keys)." },
            "sequences": { "type": "array", "items": { "type": "string" }, "description": "Only these sequences." },
            "limit": { "type": "integer", "minimum": 1, "maximum": 500, "description": "Most matches to return (default 50)." },
            "include_bleed": { "type": "boolean", "description": "Whether to return lines a mic only picked up from someone else's mic (marked bleed_from); those repeat the owner's line. Defaults to true, or to false when the editor hides bleed in Sauce Bunny." },
        }), &["query"]) },
    Tool { name: "list_string_outs", title: "List string outs",
        description: "Every string out: a cut built from chunks of sequences, sent back to Avid as an AAF. Title, running time, the sequences it uses and who is on A1 and down.",
        input: || object(json!({}), &[]) },
    Tool { name: "get_string_out", title: "Get a string out",
        description: "One string out in order: who is patched to each record track (A1…), every clip with its record timecode and its source sequence and timecode, who plays in it and what they say, the gaps, the markers, and its last change.",
        input: || object(json!({ "string_out": { "type": "string", "description": STRING_OUT } }), &["string_out"]) },
    Tool { name: "get_history", title: "Get a string out's history",
        description: "A string out's undo history: every step's label and time, which is current, and how many undone branches are kept.",
        input: || object(json!({ "string_out": { "type": "string", "description": STRING_OUT } }), &["string_out"]) },
    Tool { name: "list_transcript_files", title: "List transcript files",
        description: "The Transcripts library: single-file transcripts (SRT or VTT) of clips and interviews, newest first, optionally in one folder.",
        input: || object(json!({ "folder": { "type": "string", "description": "A folder name, such as 2026-09 or a project." } }), &[]) },
    Tool { name: "read_transcript_file", title: "Read a transcript file",
        description: "One file from the Transcripts library as timed lines with the speaker label, in pages.",
        input: || object(json!({
            "transcript": { "type": "string", "description": "Its address (saucebunny://transcript/…) or path, from list_transcript_files." },
            "cursor": { "type": "integer", "minimum": 0, "description": CURSOR },
            "limit": { "type": "integer", "minimum": 1, "maximum": 1000, "description": "Lines per page (default 200)." },
        }), &["transcript"]) },
];

fn text<'a>(args: &'a Value, key: &str) -> Option<&'a str> { args.get(key).and_then(Value::as_str).filter(|value| !value.trim().is_empty()) }
fn required<'a>(args: &'a Value, key: &str) -> Result<&'a str, AppError> { text(args, key).ok_or_else(|| AppError::invalid(format!("\"{key}\" is required."))) }
fn number(args: &Value, key: &str, default: usize) -> usize { args.get(key).and_then(Value::as_u64).map(|value| value as usize).unwrap_or(default) }
fn strings(args: &Value, key: &str) -> Vec<String> {
    args.get(key).and_then(Value::as_array).map(|items| items.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()
}
fn value(result: impl serde::Serialize) -> Result<Value, AppError> { Ok(serde_json::to_value(result)?) }

/// Run one tool. Results are objects, so every door can hand them over as structured data.
pub fn call(ctx: &Context, name: &str, args: &Value) -> Result<Value, AppError> {
    match name {
        "list_sequences" => value(json!({ "sequences": sequences::list(ctx)? })),
        "get_sequence" => value(sequences::detail(ctx, required(args, "sequence")?)?),
        "list_people" => match text(args, "sequence") {
            Some(wanted) => { let id = sequences::resolve(ctx, wanted)?; let document = ctx.document(&id)?;
                value(json!({ "sequence": Address::Sequence(id).to_string(), "name": document.manifest.name, "people": sequences::people(&document) })) }
            None => {
                let mut all = Vec::new();
                for item in sequences::list(ctx)? {
                    let id = sequences::resolve(ctx, &item.sequence)?;
                    all.push(json!({ "sequence": item.sequence, "name": item.name, "people": sequences::people(&*ctx.document(&id)?) }));
                }
                value(json!({ "sequences": all }))
            }
        },
        "read_transcript" => value(sequences::read(ctx, required(args, "sequence")?, sequences::Read {
            person: text(args, "person"), from: text(args, "from"), to: text(args, "to"), cursor: number(args, "cursor", 0), limit: number(args, "limit", sequences::PAGE_LINES),
        })?),
        "search_transcripts" => value(sequences::search(ctx, required(args, "query")?, &strings(args, "people"), &strings(args, "sequences"), number(args, "limit", 50), args.get("include_bleed").and_then(serde_json::Value::as_bool).unwrap_or_else(|| !ctx.hides_bleed()))?),
        "list_string_outs" => value(json!({ "string_outs": string_outs::list(ctx)? })),
        "get_string_out" => value(string_outs::detail(ctx, required(args, "string_out")?)?),
        "get_history" => value(string_outs::history(ctx, required(args, "string_out")?)?),
        "list_transcript_files" => value(json!({ "transcripts": files::list(ctx, text(args, "folder")) })),
        "read_transcript_file" => value(files::read(ctx, required(args, "transcript")?, number(args, "cursor", 0), number(args, "limit", sequences::PAGE_LINES))?),
        _ => Err(AppError::not_found(format!("No tool called {name}."))),
    }
}

/// The fixed resources; every other address is reached through the templates.
pub fn resources() -> Vec<(String, &'static str, &'static str)> {
    vec![
        (Address::Sequences.to_string(), "Sequences", "Every AAF Audio sequence."),
        (Address::StringOuts.to_string(), "String outs", "Every string out."),
        (Address::Transcripts.to_string(), "Transcripts library", "Every single-file transcript."),
    ]
}

pub const TEMPLATES: &[(&str, &str, &str)] = &[
    ("saucebunny://sequence/{sequence}", "Sequence", "One sequence: tracks, people, transcription status, V1, markers."),
    ("saucebunny://sequence/{sequence}/person/{person}", "Person", "One person's lines in a sequence (the first page)."),
    ("saucebunny://sequence/{sequence}/line/{track}/{cue}", "Line", "One transcript line, with the lines around it."),
    ("saucebunny://sequence/{sequence}@{timecode}", "Moment in a sequence", "The lines around a timecode."),
    ("saucebunny://string-out/{string_out}", "String out", "One string out: tracks, clips, markers."),
    ("saucebunny://string-out/{string_out}/clip/{clip}", "Clip", "One clip of a string out."),
    ("saucebunny://string-out/{string_out}/history", "History", "A string out's undo history."),
    ("saucebunny://transcript/{path}", "Transcript file", "A file from the Transcripts library (the first page)."),
];

/// Lines around a frame of a sequence, for a line or a moment.
fn around(ctx: &Context, sequence: &str, matches: impl Fn(i64, &super::Line) -> bool) -> Result<Value, AppError> {
    let document = ctx.document(&sequences::resolve(ctx, sequence)?)?;
    let lines = sequences::all_lines(ctx, &document)?;
    let at = lines.iter().position(|(frame, _, line)| matches(*frame, line)).ok_or_else(|| AppError::not_found("Nothing is transcribed there."))?;
    let near: Vec<_> = lines[at.saturating_sub(3)..(at + 4).min(lines.len())].iter().map(|(_, _, line)| line.clone()).collect();
    value(json!({ "sequence": Address::Sequence(document.id.clone()).to_string(), "name": document.manifest.name, "line": lines[at].2, "around": near }))
}

/// Read any address as the matching tool's result.
pub fn read(ctx: &Context, uri: &str) -> Result<Value, AppError> {
    let none = json!({});
    match Address::parse(uri)? {
        Address::Sequences => call(ctx, "list_sequences", &none),
        Address::Sequence(id) => call(ctx, "get_sequence", &json!({ "sequence": id })),
        Address::Person { sequence, person } => call(ctx, "read_transcript", &json!({ "sequence": sequence, "person": person })),
        Address::Line { .. } => { let wanted = uri.to_string(); let sequence = sequences::resolve(ctx, uri)?; around(ctx, &sequence, |_, line| line.line == wanted) }
        Address::SequenceAt { sequence, tc } => {
            let document = ctx.document(&sequences::resolve(ctx, &sequence)?)?;
            let frame = super::timecode::parse(&tc, document.manifest.timecode_fps, document.manifest.drop_frame).ok_or_else(|| AppError::invalid(format!("\"{tc}\" is not timecode.")))? - document.manifest.start_frame;
            around(ctx, &sequence, |at, _| at >= frame)
        }
        Address::StringOuts => call(ctx, "list_string_outs", &none),
        Address::StringOut(id) | Address::StringOutAt { string_out: id, .. } => call(ctx, "get_string_out", &json!({ "string_out": id })),
        Address::Clip { string_out, clip } => {
            let detail = call(ctx, "get_string_out", &json!({ "string_out": string_out }))?;
            let wanted = Address::Clip { string_out, clip }.to_string();
            detail["clips"].as_array().and_then(|clips| clips.iter().find(|item| item["clip"] == wanted.as_str()).cloned())
                .ok_or_else(|| AppError::not_found("That clip is not in the string out any more."))
        }
        Address::History(id) => call(ctx, "get_history", &json!({ "string_out": id })),
        Address::Transcripts => call(ctx, "list_transcript_files", &none),
        Address::Transcript(path) => call(ctx, "read_transcript_file", &json!({ "transcript": path })),
    }
}

pub struct Prompt { pub name: &'static str, pub title: &'static str, pub description: &'static str, pub arguments: &'static [(&'static str, &'static str, bool)], pub text: fn(&Value) -> String }

pub const PROMPTS: &[Prompt] = &[
    Prompt { name: "find_bites", title: "Find bites", description: "Find every line where someone talks about something, cited by address.",
        arguments: &[("topic", "What to find, in plain words.", true), ("person", "Whose lines (optional).", false), ("sequence", "Which sequence (optional).", false)],
        text: |args| format!("Find every line{} where {} talks about {}. Use search_transcripts with a few different wordings, then read_transcript around the best hits so nothing near them is missed. Answer with each line's who, timecode and text, and its line address, in time order.",
            text(args, "sequence").map(|sequence| format!(" in {sequence}")).unwrap_or_default(), text(args, "person").unwrap_or("anyone"), text(args, "topic").unwrap_or("the topic")) },
    Prompt { name: "summarize_person", title: "Summarize a person", description: "What one person says across a sequence, with their strongest lines.",
        arguments: &[("person", "The person.", true), ("sequence", "The sequence.", true)],
        text: |args| format!("Read every line {} says in {} with read_transcript (all pages), then summarize what they talk about and pick their five strongest lines for a string out, each with its timecode and line address.",
            text(args, "person").unwrap_or("the person"), text(args, "sequence").unwrap_or("the sequence")) },
    Prompt { name: "review_string_out", title: "Review a string out", description: "Read a string out clip by clip and say how it plays.",
        arguments: &[("string_out", "The string out.", true)],
        text: |args| format!("Read {} with get_string_out. Describe how it plays clip by clip, who carries it, where it drags or repeats, and suggest cuts by clip address and record timecode.", text(args, "string_out").unwrap_or("the string out")) },
];
