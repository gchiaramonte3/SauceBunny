# Assistant access: one context API for MCP, Claude and OpenAI

**Goal (the owner, October 3):** make Sauce Bunny easy for Claude (and
OpenAI) to work with, from inside the app and from outside it through MCP,
with routing that lets a model read the different parts of the timelines and
the transcripts, so a question gets answered from the right data and a
request gets done to the right thing.

**Status (2026-10-03):** phases 1 and 2 are built and tested (see their
Status lines below); phases 3 and 4 wait on the decisions at the end.

**Rules that hold throughout:** local first (nothing leaves the Mac unless the
user's own assistant sends it); read-only unless the owner turns writing on;
every change an assistant makes is one labelled undo step in History; the
transcript is data, never instructions; the CLAUDE.md contracts and `npm run
verify`.

---

## What is there today (measured, October 3)

- **No assistant can reach the app.** No MCP server, CLI, JSON-schema surface
  or tool calling anywhere in `src`, `src-tauri/src` or `scripts`.
- **The cloud call cannot carry tools.** `cloud_chat`
  (`src-tauri/src/commands/cloud_ai.rs`) sends string-only messages, keeps
  only text blocks (a Claude `tool_use` block, or an OpenAI `tool_calls`, is
  dropped and an empty text is an error), makes one round per call with a
  120 s timeout, and does not stream. OpenAI goes through Chat Completions.
- **The local model can, almost.** `llama-server` already runs with
  `--jinja` (the chat template that OpenAI-style tools need), but
  `streamChat` (`src/lib/ai-chat.ts`) reads only `delta.content`.
- **Every AI feature pastes the transcript, each its own way.** Ask, the AI
  string out and AAF Audio's search each group cues differently and emit a
  different record shape (`{id,who,source?,at,inEdit?,text}`,
  `{id,who,at,seconds,text}`, `{id,text}`), and AI Summary and Reader
  Analysis keep near-copies of an SRT serializer. Prompt ids are throwaway
  positions, re-numbered per scope and per part, so a model's citation means
  nothing one turn later.
- **Stable ids already exist** and are not used in prompts: the AAF document
  id (64 hex), cue ids, track ids, the edit id (24 hex), segment ids, marker
  ids, and the word id `source:lane:cue:index`.
- **Live state lives only in the running app** (React state and WKWebView
  localStorage): the view, the open sequence and string out, the playhead,
  the selection, the marks. No other process can read it.
- **Everything on disk is safe to read from another process:** AAF documents
  and the JSON stores are written atomically; `timelines.sqlite` is WAL, so a
  read-only reader is fine (but must never take a write lock, and must not run
  the app's `init`, which writes).

## The design in one picture

```
            ┌──────────────── the context layer (Rust, read-only) ────────────────┐
 stores ──▶ │ sequences · people · transcripts · string outs · history · files   │
 on disk    │ one address scheme · one line shape · timecodes · paging           │
            └───────┬────────────────────────────┬───────────────────────────────┘
                    │                            │
      in the app: tool calls             outside: saucebunny-mcp (stdio)
      Claude · OpenAI · local Qwen       Claude Desktop · Claude Code · Codex CLI
                    │                            │
                    └──────── live state and changes: only through the app ─────
```

One read layer, written once in Rust, serves both doors. What only the running
app knows (playhead, selection, what is open) and every change go through the
app, so the undo log keeps its one writer.

---

## 1. Addresses: every thing has one

The routing is an address scheme, so a model can name exactly what it means
and every tool returns and accepts the same names. It uses the app's own
`saucebunny://` scheme; the review-link parser already ignores every host but
`review` by design (`commands/review_link.rs`), so these cannot be misread as
review links, and later a click on one can open the app at that place.

| Address | What it is |
|---|---|
| `saucebunny://sequences` | Every AAF Audio sequence |
| `saucebunny://sequence/{seq}` | One sequence: tracks in Avid order, people, transcription status, V1 |
| `saucebunny://sequence/{seq}/person/{person}` | One person in it: their mics, how much they say |
| `saucebunny://sequence/{seq}/line/{track}/{cue}` | One transcript line (a cue) |
| `saucebunny://sequence/{seq}@{tc}` | A moment in the sequence, by its own timecode |
| `saucebunny://string-outs` | Every string out |
| `saucebunny://string-out/{edit}` | One string out: its clips, tracks, markers |
| `saucebunny://string-out/{edit}/clip/{segment}` | One clip in it |
| `saucebunny://string-out/{edit}@{tc}` | A moment in it, by record timecode |
| `saucebunny://string-out/{edit}/history` | Its undo history |
| `saucebunny://transcripts` · `saucebunny://transcript/{path}` | The single-file Transcripts library (path percent-encoded; a path is its only id) |
| `saucebunny://app` | What is open now (live; the running app only) |

`{seq}` is the AAF document id, `{edit}` the edit id, `{person}` the person
key AAF Audio already uses (`cast:`, `owner:` or `track:`), `{track}` and
`{cue}` the AAF ids, `{segment}` the segment id. Timecodes are the
sequence's own, `HH:MM:SS:FF` (`;` before frames for drop frame).

## 2. One shape for a line, everywhere

```json
{ "line": "saucebunny://sequence/9f…/line/track-3/c-0412", "who": "ISABELLA", "track": "A6",
  "tc_in": "19:58:57:12", "tc_out": "19:59:01:03", "text": "I'm so tired of this.", "in": ["saucebunny://string-out/7a…"] }
```

`in` lists the string outs that use the line (omitted when none). This one
serializer replaces the three record shapes and the two SRT serializers, so
Ask, the AI string out, search, AI Summary and Reader Analysis, and every
external assistant, all see the same thing.

## 3. The tools

Read tools, every door (phase 1 builds them, phases 2 and 3 expose them):

| Tool | Answers | Returns |
|---|---|---|
| `list_sequences()` | "What have I got?" | Name, address, fps, start TC, length, people, tracks transcribed of total |
| `get_sequence(sequence)` | "Who's on what mic? Is it transcribed?" | Tracks A1… in Avid order (each group's alternates after their track), owner, alternate or main, status (`completed`, `review`, `empty`, `not transcribed`), engine and range; V1 groups and angles; imported markers |
| `list_people(sequence?)` | "Who's in this?" | People across sequences, their mics, word counts |
| `read_transcript(sequence, person?, from?, to?, cursor?)` | "What does Rosa say in the first hour?" | Lines, paged by a cursor and a size budget |
| `search_transcripts(query, people?, sequences?, limit?)` | "Where does anyone say 'tired'?" | Matching lines, ranked; lexical, local, instant, accent- and case-insensitive |
| `list_string_outs()` | "What string outs exist?" | Title, address, running time, sources, who is on A1… |
| `get_string_out(string_out)` | "What's in Rosa's string out?" | Record tracks (A1 = HARRY…), clips in order (record TC in and out, source sequence and TC in and out, who plays, the words), markers, running time, last change |
| `get_history(string_out)` | "What did I change?" | Undo steps with labels and times, undone branches |
| `list_transcript_files(folder?)` · `read_transcript_file(path, from?, to?)` | The Transcripts library | Files; lines with speaker and time |
| `get_app_state()` | "This line", "here", "the selection" | Open view, sequence and string out; playhead (record and source TC); selection as lines; marks; Source/Record; the source side's person tab and marks (live; phase 4) |

Change tools (phase 4, through the running app only, off until the owner
turns them on):

| Tool | Does |
|---|---|
| `open(address)` | Shows the thing in the app: a sequence at a TC, a string out at a clip, a line selected in the source |
| `create_string_out(title, lines)` | A new string out of those lines in that order, as Ask's Build does |
| `insert_lines(string_out, lines, at)` · `remove_lines(string_out, lines)` | Splice in at the playhead, the end or a TC; take out without cutting overtalk |
| `add_marker(string_out, at, name, comment, colour)` | A marker, exported to Avid with the cut |

Each change is one undo step, labelled with who asked ("Insert 4 Words (Claude)"),
so History shows what an assistant did and ⌘Z undoes it.

**Shapes that help a model:** every result carries names (people, A-track
labels), timecodes, durations in seconds and addresses; lists are paged with
a cursor and stop under a size budget (about 20k tokens) rather than truncating
silently; errors say what to ask instead ("No person 'Rose' in AFF BANK 1;
did you mean ROSA?"). The server's instructions carry a short glossary
(sequence, track, mic, person, alternate, string out, clip, record and source
timecode, line, word) so "Rosa's string out" and "A3" mean what the editor
means.

## 4. Inside the app: Ask with tools (Claude, OpenAI, local)

- **`cloud_chat` becomes a tool loop in Rust:** messages carry content blocks;
  a request carries the tool definitions (generated from the Rust registry);
  Rust runs model → tool call → the context layer → tool result → model, up
  to a set number of rounds, each round with its own timeout and the existing
  cancel. Anthropic Messages `tools`/`tool_use`/`tool_result`; OpenAI
  function tools; the API key never leaves Rust, as now.
- **The local model** goes through the same loop in Rust (llama-server
  speaks the OpenAI tool format with `--jinja`). Small models call tools less
  reliably, so the current "lines in the prompt" path stays as the fallback
  for them and is chosen by a capability check, not by provider.
- **Ask becomes a router, not a pre-filter:** it opens with what is on screen
  (the open string out, the playhead, the selection, the source side's person
  and marks) and the tools; @Rosa and @sequence become hints the model passes
  as arguments instead of hard filters applied before it sees anything.
  Answers cite addresses, so a citation still means the same line turns later,
  and Build and Remove are proposed exactly as now (buttons the editor
  presses), never applied by the model.
- **Why it is better:** a model reads only what the question needs (one
  person, one hour, one string out) instead of a whole sequence sampled into
  parts, follows up with another read when it needs more, and can see the
  string out and the selection, which today it cannot.

## 5. Outside the app: `saucebunny-mcp`

- A **stdio MCP server**, a small Rust binary bundled in the app, built on the
  official Rust SDK (`rmcp` 3.x, MCP 2026-07-28, compatible with 2025-11-25
  clients). It links the same context layer and reads the stores directly, so
  it works with the app closed. It offers the addresses as **resources**, the
  read tools as **tools** (with output schemas), and a few **prompts** ("Find
  bites", "Summarize a person", "Compare two string outs").
- **Installing it:** Settings ▸ AI APIs gets "Use Sauce Bunny from Claude",
  with the one command for Claude Code (`claude mcp add sauce-bunny --
  ".../saucebunny-mcp"`) and an `.mcpb` bundle for Claude Desktop (open it,
  click Install). Codex CLI and other MCP clients take the same command.
  ChatGPT's app only connects to remote servers, which would mean hosting the
  library on the internet; that is out of scope.
- **What it reads:** AAF documents from `Transcripts/Multitrack/` (summaries
  parsed without loading a 256 MB document whole), string outs and history
  from `timelines.sqlite` opened read-only (never the JSON mirror, which has
  no id and keeps stale copies), and the Transcripts library. It never takes
  a write lock and never runs the app's database setup.
- **What it cannot know without the app:** speaker renames and the
  transcript-to-media link of single-file transcripts live in WKWebView
  localStorage; with the app closed it says so rather than guessing.

## 6. Privacy and safety

- The MCP server runs only when the user's assistant starts it, and only for
  that user. What it returns goes wherever that assistant sends it: Claude
  Desktop sends it to Anthropic. Settings says this in one sentence.
- Read-only by default. Change tools need the app running and a setting,
  "Let assistants change string outs", off by default; MCP clients also ask
  before a tool call.
- Transcripts are data: tool results mark them as quoted material, and no
  change happens because a transcript line asked for it.

---

## Phases

**Phase 1 status: built.** `src-tauri/src/context/`: the addresses
(`address.rs`), timecode with drop frame (`timecode.rs`), sequences, people,
transcripts and search (`sequences.rs`), string outs and history
(`string_outs.rs`), the Transcripts library (`files.rs`), and the one
registry of ten read tools, the resources and three prompts (`tools.rs`).
Tested on fixtures (a 20-mic sequence, a grouped one stored main-main-alternate-
alternate, a string out in a real undo log, an SRT), break-tested, and run
read-only against the owner's library, where each call took 0.05 to 0.15 s
and a search for "tired" from ISABELLA and NATHANIEL found the lines the hand
test knew. Differences from the text below: the frontend's duplicated
serializers move to phase 3, when those features switch to the tool loop
(they cannot call tools before it exists); the result types get ts-rs
bindings then too; search is case-insensitive but not accent-insensitive,
since CLAUDE.md treats accent folding as a product decision.

**Phase 2 status: built.** `sauce-bunny --mcp` (`src-tauri/src/mcp.rs`):
the app's own executable in another mode rather than a second binary, so it
reads the stores with the app's code and ships nothing extra. The protocol
is written by hand (no `rmcp` dependency for six methods): it answers in the
client's revision when it knows it (2025-11-25, 2025-06-18, 2025-03-26),
lists tools with input schemas and read-only annotations, returns results
as text and `structuredContent` (no `outputSchema`, which a client would
validate against), serves the fixed resources, eight templates and three
prompts. Settings ▸ AI APIs ▸ Use Sauce Bunny from Claude shows the Claude
Code command, copies a Claude Desktop config entry, and saves a `.mcpb`
extension written on demand (a manifest plus a launcher that runs this
install). A test starts the real executable with `--mcp` and talks to it
over stdio. `get_app_state` and the live address `saucebunny://app` wait for
phase 4.

| Phase | Builds | Done when |
|---|---|---|
| 1 | The context layer: the addresses, the one line shape, the read tools as Rust functions with ts-rs types; the duplicated serializers replaced by it | Unit tests on fixtures for every tool, including a 20-mic sequence and a grouped one; an address round-trips; paging stops under budget; break-tested |
| 2 | `saucebunny-mcp` (read-only) and its install path (Settings, Claude Code command, `.mcpb`) | A test spawns the binary and runs initialize, tools/list, resources/list, tools/call on fixtures; it reads while the app writes without blocking it; Claude Code lists its tools |
| 3 | Ask on tools: the Rust tool loop for Claude and OpenAI, the local path behind a capability check, the router prompt with on-screen state, citations as addresses | Mocked-provider tests for tool rounds, cancel mid-round and the round limit; e2e: "@ROSA tired" cites Rosa's lines by address; the old path still works for a small local model |
| 4 | Live state and changes through the running app (`get_app_state`, `open`, the change tools), gated by the setting | e2e: an external client's insert is one labelled undo step; with the setting off, change tools are refused; the app's own undo log stays the only writer |

## Decisions for the owner

1. **How the MCP server reaches the running app (phase 4).** Recommended: a
   Unix socket in the app's support folder, readable only by this user, which
   the app owns. It is a new local channel, so CLAUDE.md asks for this to be
   agreed first. (There is a precedent: the opt-in, token-paired loopback
   WebSocket the Premiere bridge already uses.) Without it, external
   assistants can read everything on disk but cannot see the playhead or make
   changes.
2. **Whether assistants may change string outs at all (phase 4)**, and if so
   whether the setting is per app or per string out.
3. **Which models are offered for tool use (phase 3):** the defaults are
   Claude and OpenAI by API key, plus the local models that pass the
   capability check (Qwen3 4B and up); the smaller ones keep the current path.
