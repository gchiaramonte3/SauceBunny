# Ask about a range: narrow on the Mac, then ask the model

**The question this is for:** "every time Donnie and Jillio talk to each other
about sibling rivalry, between 21:10:00:00 and 21:40:00:00", asked of a group
sequence. Today Ask answers it slowly, or not at all. This spec makes it one
or two model rounds over a few thousand tokens.

It builds on `docs/AI-ACCESS-SPEC-2026-10-03.md` and keeps every rule there:
- **Read-only.** The model proposes; the editor applies.
- **Transcript text is data, never instructions.**
- **One tool registry**, shared by Ask and `sauce-bunny --mcp`.
- **Keys stay in Rust**, in the Keychain.
- **Cloud is opt-in.** Local Qwen keeps working.

---

## What happens today (measured October 6 on OPPONENT SELECTION)

The sequence has 104 mics, all transcribed, and 92 people. The numbers come
from the same tools Ask calls, run through `sauce-bunny --mcp`:

| Ask reads | Lines | Characters | ≈ tokens | Model rounds |
|---|---|---|---|---|
| `get_sequence`, to learn names and timecode | — | 71,520 | 18,000 | 1 |
| 30 min, CHASE | 144 | 58,288 | 14,600 | 1 |
| 30 min, KENDALL | 238 | 98,338 | 24,600 | 2 (pages) |
| 30 min, everyone | 7,773 | 3,065,818 | 766,000 | 39 (pages) |

Why it is slow:
1. **Only 18% of a page is words.** The rest is field names and each line's
   address: 64 hex characters of document id plus the track and cue ids,
   about 190 characters a line.
2. **Every page is a model round,** and every round sends everything read
   before it again.
   - `read_transcript` takes one person.
   - Its pages are 200 lines.
   - `MAX_ROUNDS` is 10, so the "everyone" case cannot finish at all.
3. **Bleed is not measured on this sequence** (one line is marked), so the
   same words arrive from several lavs. By a rough rule (lines overlapping in
   time that share at least 60% of their words), 1,955 of the 7,773 lines
   (25%) repeat another mic.
4. **Search is by keyword,** with no timecode range. "Sibling rivalry" finds
   nothing unless somebody says those words.
5. **The loop works one step at a time.**
   - A round's tool calls run one after another.
   - Nothing is cached between rounds.
   - The answer appears only when it is complete.
   - The default OpenAI model is still `gpt-4o`.

Reading all 7,773 lines locally takes 2.7 s, so the Mac is not the
bottleneck. The model is: it reads data it never needed, one round trip at a
time.

## The design in one line

**Resolve, slice, find the conversations and scan them on the Mac and in
parallel; send the model only what is left.**

```
question ─▶ resolve: sequence, timecode range, people     (local, instant)
         ─▶ slice: those people's own lines in the range   (local, instant)
         ─▶ conversations: where they talk to each other   (local, instant)
         ─▶ scan: a fast model checks chunks in parallel   (one request's time)
         ─▶ answer: the main model writes it up, citing lines
```

Each step is a tool the main model can call, and the app can also run them
directly with no main model (section 9).

---

## 1. Rows, not records (the biggest single saving)

A line goes to the model as one row of text:

```
L7k2qm 21:10:53:14-21:11:14:13 CHASE (A3): will now face Dominic Cruz…
L9c0xa 21:11:15:02-21:11:17:20 KENDALL (A5): no way [heard on 3 mics]
```

- **Short id** (`L` + 5 base-36 characters).
  - Taken from the line's BLAKE3 address hash, so the same line always gets
    the same id and a follow-up question can refer to it.
  - The assistant context keeps an id → address map, filled as rows are
    written.
  - On a collision the id grows by one character.
- **What the row keeps:**
  - the bleed marker (`[heard from KENDALL]`);
  - the duplicate count (section 2);
  - the string outs that use the line (`[in: SO_Rosa]`), titles not
    addresses.
- **In the answer** the model cites short ids. Before returning, Rust expands
  every id in the reply's `lines` and `action.lines` into its full address,
  so the frontend's `parseToolsAnswer` and `citeAddress` are unchanged.
  - A full address (from replayed history) is still accepted.
  - An unknown id is dropped and logged, never guessed.
- **Where rows are used:** in Ask's loop and in `sauce-bunny --mcp`
  (decision 2).
- **Measured target:** CHASE plus KENDALL over 30 minutes drops from about
  39,000 tokens to about 10,000.

## 2. Read exactly the slice asked for

`read_transcript` gains:
- **`people`:** an array, so both people in one call. `person` stays for MCP
  callers.
- **`include_bleed`:** defaults to the editor's Hide bleed setting, as
  `search_transcripts` already does.
- **Copies dropped where bleed was never measured.** A line overlapping in
  time with another person's line, sharing at least 60% of its words, is
  read as a copy. One row is kept, with "heard on N mics":
  - the copy on the mic of someone in `people`, if there is one;
  - else the longest.
  - This is the measured rule, 25% on OPPONENT SELECTION. It stops once the
    sequence's bleed is measured, because the resolver's labels are better.
- **A token budget instead of 200 lines.** When the call names a range or
  people, a page holds up to about 12,000 tokens of rows. A two-person,
  30-minute slice comes back in one page.

`search_transcripts` gains:
- **`from` and `to`,** a timecode range.
- **`any`:** match any of the words rather than all of them, ranked by how
  many match, so one call can try "brother sister sibling jealous compete
  favourite".

## 3. Start where the editor is: the context card

The first message carries a short card, so the model does not spend rounds,
or 18,000 tokens of `get_sequence`, finding its bearings:

```
Sequence: OPPONENT SELECTION (S1), 20:49:16:22 to 22:03:10:05, 23.976 fps
People: ALEX, BRIANNA, CHASE, … (92)
On screen: In 21:10:00:00, Out 21:40:00:00; checked mics: DONNIE, JILLIO
```

- **String Outs:** the sequences the string out cuts from.
- **AAF Audio** (section 9): the open sequence, its In and Out, and the
  checked mics or person tab.
- `get_sequence` gains `brief: true` (name, timecodes, people, track count)
  for when the model needs another sequence.
- A card of 92 names is about 400 tokens.

## 4. Names that find people

Every `person` or `people` parameter resolves through one matcher:
- exact name or key;
- then case- and accent-insensitive;
- then a prefix match;
- then a close spelling (edit distance up to 2, so "Jillio" finds JILLIO
  and "Donny" finds DONNIE).

A miss answers "No one called Jilio. Closest: JILLIO, JULIA, JILL" rather than
an error the model has to recover from with another round.

## 5. Conversations: where two people talk to each other

A new tool, `find_conversations`:
- **Inputs:** `sequence`, `people` (two or more), `from`/`to`, `gap` (seconds
  of silence that still counts as one exchange, default 8) and `min_turns`
  (default 2).
- **Run:** locally over the slice from section 2 (own lines, copies dropped),
  in time order.
- **What counts as a conversation:** a stretch where at least two of the
  people take turns, a change of speaker at least `min_turns` times, with no
  gap longer than `gap`.
- **What comes back:** each stretch's timecode, who spoke and how many lines,
  plus its rows. Anyone else who speaks inside a stretch comes too, marked
  as not asked for, so the model can see a third person join in.
- **Measured target,** set from the first real run: what share of a 30-minute
  range is left once the stretches are found.

This is "talk to each other" with no model at all. It is also what the
scan in section 6 reads, so the scan never pays for minutes where they are
apart.

## 6. Scan by meaning, in parallel

A new tool, `scan`:
- **Inputs:** `question` (the topic, in the editor's words), `sequence`,
  `people`, `from`/`to` and `conversations_only` (default true when two or
  more people are named).
- **Chunks.** Rust gathers the rows (sections 2 and 5) and cuts them into
  chunks of about 4,000 tokens. Chunks overlap by two rows, and a
  conversation is never split unless it alone is longer than a chunk.
- **The scan model** is a small, fast model on the editor's provider:
  - OpenAI: the scan model chosen in Settings (decision 1);
  - Claude: Haiku 4.5;
  - Local: the same Qwen. It runs one chunk at a time, with progress.
- **Requests.** Cloud chunks go out together, at most 8 at a time.
  - Every chunk gets the same fixed system text.
  - Each answers structured JSON, `{"hits":[{"id":"L7k2qm","why":"…"}]}`:
    OpenAI's JSON schema output, or a forced tool call for Claude.
- **Merge.**
  - An id that was not in that chunk is dropped, so a hit is never invented.
  - Hits are merged in time order, each with its reason and its rows.
- **No size limit** (the owner, October 6). A whole transcript can be
  scanned. It reports the chunk count and the rows sent in the Pipeline.
- **Stopping.** It uses the same cancel registry as Ask, so Stop ends every
  chunk in flight.
- **Local model.** A local scan sends the same system prefix as every other
  local feature (`prompt-prefix-contract`), and nothing variable rides in
  front of the rows.

**Privacy.** What leaves the Mac is what leaves today when the model reads a
transcript page: rows of the chosen range and people, to the provider the
editor chose. Nothing new is stored there (`store: false` on OpenAI, as now).

## 7. The loop

- **Same-round tool calls run together.** `assistant_chat` runs a round's calls
  concurrently: `join_all` over `spawn_blocking`, results kept in call order.
- **Prompt caching.**
  - The system text and the tool definitions stay byte-identical between
    rounds and questions.
  - OpenAI: `prompt_cache_key` set to the Ask thread's id.
  - Claude: `cache_control` on the system block and the last tool.
  - Rounds 2 and on then send the earlier text at the cached price and speed.
- **Effort.** On reasoning models, tool rounds go at low effort, which makes
  the tool-choosing rounds much quicker:
  - Chat Completions: `reasoning_effort: "low"`;
  - Responses: `reasoning.effort`.
- **Streaming the answer** (phase 3). The final round streams; the reply goes
  out as Tauri events and the Ask pane shows the words as they come.
  Citations resolve when it ends.
- **The OpenAI model** is whichever the editor picks from the list in
  Settings (decision 1). `gpt-4o` stays only as the fallback before a list
  has been fetched.
  `MAX_ROUNDS` stays 10. Most questions should now need two.

## 8. Tool descriptions and the system prompt

The prompt tells the model the fast path, in order:
1. Use the card.
2. `find_conversations` when the editor names two or more people "talking".
3. `scan` for a topic over more than a few minutes.
4. `read_transcript` only for a short stretch.
5. Cite the ids.

The `search_transcripts` description mentions `any` and the range.

## 9. AAF Audio: ask about In to Out

AAF Audio gets Ask, in the transcript panel, beside Search:
- **Find** (no main model). With In and Out marked and mics checked (or a
  person tab), type a topic and Find runs `find_conversations` and `scan`
  directly. The matching lines light up in the list, and a click seeks to
  one, as Search does now. This replaces "Search with AI".
  - Today that searches every line of the person or of everyone, one
    section at a time, on the local model only.
  - It becomes range-, people- and conversation-aware.
  - It runs in parallel on a cloud provider when one is chosen.
- **Ask** (main model). The same box with "Ask": an answer in words citing
  lines, built on the card from section 3. It can propose "Open these in
  String Outs" or "Build a string out", applied by the editor, as in String
  Outs.

---

## Phases

Each phase's acceptance runs on fixtures in tests, and on OPPONENT SELECTION
by hand with the Pipeline's timings.

| Phase | What | Accepted when |
|---|---|---|
| 1 | The model menus in Settings, from each provider's `/v1/models` (decision 1); rows and short ids, in Ask and in MCP (1); `people`, copies dropped, token pages (2); `from`/`to`/`any` on search (2); name matcher (4); context card in String Outs (3); same-round tools together and prompt caching (7) | Rows round-trip to addresses and cite back unchanged; an unknown id is dropped; the copies rule matches the October 6 measurement's 25% (±2) on a fixture built like it; "Jillio" resolves; a two-call round runs both at once (stand-in server sees them overlap); the cache key and `cache_control` are in the request. On OPPONENT SELECTION, CHASE plus KENDALL over 30 min is one call of no more than 12,000 tokens |
| 2 | `find_conversations` (5) and `scan` (6) | Fixture conversations found and split exactly by `gap` and `min_turns`; scan cuts chunks as specified, runs up to 8 at once against a stand-in server, drops invented ids, stops on Stop; the local scan keeps the prompt prefix contract |
| 3 | Streaming the answer; low effort on tool rounds; new default model (7); AAF Audio Find and Ask (9) | Words appear before the answer ends; the example question over 30 minutes and two people answers in no more than 2 main rounds with no more than 15,000 main-model input tokens; Find lights the lines it found, and a click seeks |

**Baseline first.** Before phase 1, run the example question on OPPONENT
SELECTION as it is today and record the rounds, tokens and seconds from the
Pipeline. Every later phase is measured against that, not against guesses.

## Progress (October 7)

**Built.** All tested; gates green: vitest 5035, cargo 1029, clippy, eslint.
- **Model menus.** Settings ▸ AI APIs lists every model the key can call,
  from each provider (`cloud_models`). It has an Ask model, a scan model
  and Refresh, and still takes a typed id.
- **Rows and short ids,** in Ask and in `sauce-bunny --mcp` (`context/rows.rs`).
  Cited ids come back as line addresses.
- **`read_transcript`:**
  - takes several people;
  - drops bleed by the Hide bleed setting;
  - folds copies, one person's two mics included;
  - sends a slice in one page.
- **`search_transcripts`** takes `from`/`to` and `any`.
- **`get_sequence`** has `brief`.
- **Names match without case or accents, and through a small misspelling,**
  never across a different number.
- **The context card** goes in front of every String Outs question.
- **The loop.** A round's tool calls run together. The OpenAI cache key and
  Claude's cache markers are sent.
- **`find_conversations`** (5).
- **`scan`** (6). Parallel, any size, invented ids dropped, Stop ends every
  request.
- **AAF Audio's Search with AI** scans in the cloud when a cloud provider is
  chosen (`transcript_scan`). It reads the person tab's lines inside In to
  Out.

**Measured again on OPPONENT SELECTION** through `sauce-bunny --mcp`:

| Read | Before | After |
|---|---|---|
| The sequence (brief) | 71,520 characters | 1,592 characters (about 400 tokens) |
| CHASE and KENDALL, 30 minutes | about 39,000 tokens in 3 calls | about 11,700 tokens in 1 call |
| Everyone, 30 minutes | 7,773 lines, about 766,000 tokens | 5,031 lines, about 157,000 tokens |

**Not built yet:**
- streaming the answer;
- low effort on tool rounds, which needs to know which models reason;
- an Ask box (with an Ask model) in AAF Audio;
- the timed baseline of a real question in the app, which needs your key and
  the app open.

## Decisions (the owner, October 6)

1. **Models: every one the API offers, chosen in Settings.**
   - Settings ▸ AI APIs lists the models the editor's key can reach. Rust
     fetches them from the provider's own `/v1/models`.
   - Two choices per provider, each a menu with a Refresh:
     - the Ask model;
     - the scan model.
   - A typed model id still works for anything the list does not show.
2. **Rows for MCP clients too.** `sauce-bunny --mcp` returns the same compact
   rows, so Claude Desktop and Claude Code read the smaller format.
3. **`gap` defaults to 8 seconds.** Any call can still pass its own.
4. **No ceiling.** A scan may send a whole transcript. The 60-chunk refusal in
   section 6 is dropped. A scan reports how many chunks and rows it sent, so
   the size is visible in the Pipeline rather than refused.
5. **AAF Audio's search may use the cloud** when the editor has chosen a cloud
   provider in Settings, and stays on the local model otherwise.
