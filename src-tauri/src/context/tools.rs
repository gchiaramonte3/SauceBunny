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
        description: "One sequence: its tracks in Avid order (A1, then A1's group alternates, then A2) with who owns each mic and whether it is transcribed, the people on it, V1's picture groups, and its markers. Timecodes are the sequence's own. brief: just its name, timecodes and people's names, a fraction of the size.",
        input: || object(json!({ "sequence": { "type": "string", "description": SEQUENCE },
            "brief": { "type": "boolean", "description": "Only the name, start and end timecode, and the people's names." } }), &["sequence"]) },
    Tool { name: "list_people", title: "List people",
        description: "The people in one sequence, or in every sequence: their tracks and how much each says.",
        input: || object(json!({ "sequence": { "type": "string", "description": SEQUENCE } }), &[]) },
    Tool { name: "read_transcript", title: "Read a transcript",
        description: "A sequence's transcript as rows, one line (what one mic heard as one sentence) each, in time order: its id, timecode in and out, who said it and their track, the words, and the string outs that use it. Narrow it to some people and a timecode range and it comes in one page; a whole sequence comes in pages. The same words heard on several mics come once, marked \"also on N mics\".",
        input: || object(json!({
            "sequence": { "type": "string", "description": SEQUENCE },
            "people": { "type": "array", "items": { "type": "string" }, "description": "Only these people's mics (names, keys or addresses)." },
            "person": { "type": "string", "description": PERSON },
            "from": { "type": "string", "description": "Start timecode, HH:MM:SS:FF in the sequence's own timecode." },
            "to": { "type": "string", "description": "End timecode, HH:MM:SS:FF." },
            "include_bleed": { "type": "boolean", "description": "Whether to keep lines a mic only picked up from someone else's mic (marked heard from). Defaults to true, or to false when the editor hides bleed." },
            "keep_copies": { "type": "boolean", "description": "Keep every mic's copy of the same words instead of one (default false)." },
            "cursor": { "type": "integer", "minimum": 0, "description": CURSOR },
            "limit": { "type": "integer", "minimum": 1, "maximum": 1000, "description": "Lines per page (default: as many as fit, for a range or people; 200 otherwise)." },
        }), &["sequence"]) },
    Tool { name: "search_transcripts", title: "Search transcripts",
        description: "Lines that contain every word asked for (a word also matches the start of a longer one: \"tire\" finds \"tired\"), or an exact phrase in double quotes, across sequences or within some, optionally only for some people and a timecode range. With any, a line with any of the words counts, most words first: try several wordings of one idea at once. Case-insensitive. Best match first.",
        input: || object(json!({
            "query": { "type": "string", "description": "Words to find, or a \"quoted phrase\"." },
            "any": { "type": "boolean", "description": "Match lines with any of the words, not all of them." },
            "from": { "type": "string", "description": "Start timecode, HH:MM:SS:FF, in the sequence's own timecode (search one sequence with it)." },
            "to": { "type": "string", "description": "End timecode, HH:MM:SS:FF." },
            "people": { "type": "array", "items": { "type": "string" }, "description": "Only these people (names or keys)." },
            "sequences": { "type": "array", "items": { "type": "string" }, "description": "Only these sequences." },
            "limit": { "type": "integer", "minimum": 1, "maximum": 500, "description": "Most matches to return (default 50)." },
            "include_bleed": { "type": "boolean", "description": "Whether to return lines a mic only picked up from someone else's mic (marked bleed_from); those repeat the owner's line. Defaults to true, or to false when the editor hides bleed in Sauce Bunny." },
        }), &["query"]) },
    Tool { name: "find_conversations", title: "Find conversations",
        description: "Where two or more people talk to each other in a sequence: the stretches where they take turns (the speaker changing at least min_turns times) with no pause longer than gap seconds, each with its lines as rows. Anyone else who speaks inside a stretch comes too, marked not asked for. Found on the Mac, instantly: use it before reading or scanning a long range for something two people say to each other.",
        input: || object(json!({
            "sequence": { "type": "string", "description": SEQUENCE },
            "people": { "type": "array", "items": { "type": "string" }, "minItems": 2, "description": "Two or more people (names, keys or addresses)." },
            "from": { "type": "string", "description": "Start timecode, HH:MM:SS:FF in the sequence's own timecode." },
            "to": { "type": "string", "description": "End timecode, HH:MM:SS:FF." },
            "gap": { "type": "number", "minimum": 0, "description": "Seconds of silence that still count as one exchange (default 8)." },
            "min_turns": { "type": "integer", "minimum": 1, "description": "Changes of speaker a stretch needs (default 2)." },
            "with_others": { "type": "boolean", "description": "Whether to include other people's lines inside a stretch (default true)." },
        }), &["sequence", "people"]) },
    Tool { name: "measure_cut", title: "Measure a cut",
        description: "How long a cut built from these lines would run, before anything is built: each beat's lines in play order (row ids, exactly as a tool gave them), timed with String Outs' own layout (a short handle around each stretch, lines close together in one sequence playing as one stretch, a pause between beats). Returns seconds per beat and in all, and warnings: a line used twice, an id that names nothing, a line that was heard on someone else's mic, a missed target. Use it to fit a cut to a running time.",
        input: || object(json!({
            "beats": { "type": "array", "minItems": 1, "items": { "type": "object", "properties": {
                "title": { "type": "string", "description": "What the beat does, in a few words." },
                "lines": { "type": "array", "items": { "type": "string" }, "description": "Line ids in the order they play." },
            }, "required": ["title", "lines"], "additionalProperties": false }, "description": "The beats in order." },
            "target_seconds": { "type": "number", "minimum": 1, "description": "The running time asked for, in seconds." },
        }), &["beats"]) },
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

fn read_page(ctx: &Context, args: &Value) -> Result<sequences::Page, AppError> {
    let people = strings(args, "people");
    let mut wanted: Vec<&str> = people.iter().map(String::as_str).collect();
    if let Some(one) = text(args, "person") { wanted.push(one); }
    sequences::read(ctx, required(args, "sequence")?, sequences::Read {
        people: wanted, from: text(args, "from"), to: text(args, "to"), cursor: number(args, "cursor", 0),
        limit: args.get("limit").and_then(Value::as_u64).map(|value| value as usize),
        include_bleed: args.get("include_bleed").and_then(Value::as_bool).unwrap_or_else(|| !ctx.hides_bleed()),
        keep_copies: args.get("keep_copies").and_then(Value::as_bool).unwrap_or(false),
    })
}

fn conversations(ctx: &Context, args: &Value) -> Result<super::conversations::Conversations, AppError> {
    let people = strings(args, "people");
    super::conversations::find(ctx, required(args, "sequence")?, super::conversations::Ask {
        people: people.iter().map(String::as_str).collect(), from: text(args, "from"), to: text(args, "to"),
        gap: args.get("gap").and_then(Value::as_f64).unwrap_or(super::conversations::DEFAULT_GAP_SECONDS),
        min_turns: number(args, "min_turns", super::conversations::DEFAULT_MIN_TURNS),
        with_others: args.get("with_others").and_then(Value::as_bool).unwrap_or(true),
        include_bleed: args.get("include_bleed").and_then(Value::as_bool).unwrap_or_else(|| !ctx.hides_bleed()),
    })
}

fn search(ctx: &Context, args: &Value) -> Result<sequences::Search, AppError> {
    sequences::search(ctx, required(args, "query")?, &strings(args, "people"), &strings(args, "sequences"), number(args, "limit", 50),
        args.get("include_bleed").and_then(Value::as_bool).unwrap_or_else(|| !ctx.hides_bleed()),
        sequences::Within { from: text(args, "from"), to: text(args, "to"), any: args.get("any").and_then(Value::as_bool).unwrap_or(false) })
}

/// A tool's result as a model reads it: rows for the line-heavy tools (rows.rs), compact JSON for the rest.
pub enum Output { Rows(String), Json(Value) }

impl Output {
    pub fn text(&self) -> String { match self { Output::Rows(text) => text.clone(), Output::Json(value) => value.to_string() } }
}

/// Run one tool for a model: the line-heavy tools answer in rows with short
/// ids (each id kept in `ctx.ids`, so a citation can be turned back into an
/// address); every other tool answers as `call` does.
pub fn answer(ctx: &Context, name: &str, args: &Value) -> Result<Output, AppError> {
    match name {
        "read_transcript" => {
            let page = read_page(ctx, args)?;
            let titles = string_out_titles(ctx, &page.lines);
            let shown = if page.lines.is_empty() { "no lines".to_string() } else { format!("lines {}-{} of {}", page.cursor + 1, page.cursor + page.lines.len(), page.total) };
            let mut head = format!("{} ({}){} · {shown}", page.name, page.sequence, page.person.as_ref().map(|who| format!(" · {who}")).unwrap_or_default());
            if let Some(next) = page.next_cursor { head.push_str(&format!(" · more: cursor {next}")); }
            Ok(Output::Rows(format!("{head}\n{}", super::rows::rows(&page.lines, &ctx.ids, &titles))))
        }
        "search_transcripts" => {
            let found = search(ctx, args)?;
            let lines: Vec<&super::Line> = found.matches.iter().map(|item| &item.line).collect();
            let titles = string_out_titles(ctx, lines.iter().copied());
            let several = found.matches.iter().any(|item| item.sequence != found.matches[0].sequence);
            let body: Vec<String> = found.matches.iter().map(|item| {
                let row = super::rows::row(&item.line, &ctx.ids, &titles);
                if several { format!("[{}] {row}", item.sequence) } else { row }
            }).collect();
            let place = if several || found.matches.is_empty() { String::new() } else { format!(" in {}", found.matches[0].sequence) };
            Ok(Output::Rows(format!("Search \"{}\"{place}: {} of {} matches, best first\n{}", found.query, found.matches.len(), found.total, body.join("\n"))))
        }
        "find_conversations" => Ok(Output::Rows(super::conversations::rows(ctx, &conversations(ctx, args)?))),
        _ => call(ctx, name, args).map(Output::Json),
    }
}

/**
 * What a scan reads (docs/ASK-RANGE-SPEC-2026-10-06.md, section 6), as rows
 * in groups that should stay together in one chunk: with two or more people,
 * and unless `conversations_only` is false, each conversation between them
 * (others in it marked); otherwise each line of the slice on its own.
 */
pub fn scan_groups(ctx: &Context, args: &Value) -> Result<Vec<Vec<String>>, AppError> {
    let people = strings(args, "people");
    let named: Vec<&str> = people.iter().map(String::as_str).collect();
    let include_bleed = args.get("include_bleed").and_then(Value::as_bool).unwrap_or_else(|| !ctx.hides_bleed());
    let sequence = required(args, "sequence")?;
    if args.get("conversations_only").and_then(Value::as_bool).unwrap_or(named.len() >= 2) {
        let found = conversations(ctx, args)?;
        let all: Vec<&super::Line> = found.stretches.iter().flat_map(|stretch| stretch.lines.iter()).collect();
        let titles = string_out_titles(ctx, all.iter().copied());
        return Ok(found.stretches.iter().map(|stretch| stretch.lines.iter().zip(&stretch.asked).map(|(line, asked)| {
            let row = super::rows::row(line, &ctx.ids, &titles);
            if *asked { row } else { format!("{row} [not asked for]") }
        }).collect()).collect());
    }
    let document = ctx.document(&sequences::resolve(ctx, sequence)?)?;
    let (_, lines) = sequences::slice(ctx, &document, &sequences::Read { people: named, from: text(args, "from"), to: text(args, "to"), cursor: 0, limit: None, include_bleed, keep_copies: false })?;
    let titles = string_out_titles(ctx, &lines);
    Ok(lines.iter().map(|line| vec![super::rows::row(line, &ctx.ids, &titles)]).collect())
}

/// The titles of the string outs these lines are in, read only when one is.
fn string_out_titles<'a>(ctx: &Context, lines: impl IntoIterator<Item = &'a super::Line>) -> std::collections::HashMap<String, String> {
    if lines.into_iter().any(|line| !line.in_string_outs.is_empty()) { string_outs::titles(ctx) } else { Default::default() }
}

/// Run one tool. Results are objects, so every door can hand them over as structured data.
pub fn call(ctx: &Context, name: &str, args: &Value) -> Result<Value, AppError> {
    match name {
        "list_sequences" => value(json!({ "sequences": sequences::list(ctx)? })),
        "get_sequence" => if args.get("brief").and_then(Value::as_bool).unwrap_or(false) { value(sequences::brief(ctx, required(args, "sequence")?)?) }
            else { value(sequences::detail(ctx, required(args, "sequence")?)?) },
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
        "read_transcript" => value(read_page(ctx, args)?),
        "search_transcripts" => value(search(ctx, args)?),
        "find_conversations" => value(conversations(ctx, args)?),
        "measure_cut" => {
            let beats: Vec<super::cuts::Beat> = args.get("beats").and_then(Value::as_array).map(|items| items.iter().map(|beat| super::cuts::Beat {
                title: beat.get("title").and_then(Value::as_str).unwrap_or_default().to_string(), lines: strings(beat, "lines") }).collect()).unwrap_or_default();
            value(super::cuts::measure(ctx, &beats, args.get("target_seconds").and_then(Value::as_f64))?)
        }
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
