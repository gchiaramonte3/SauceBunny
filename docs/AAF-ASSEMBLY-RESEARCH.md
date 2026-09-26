# AAF Audio string-outs: research before building

Research only: nothing here is implemented. It answers three questions from the
brief: what AAF Audio already has, what is missing, and how an assembly
feature could run locally and faster with the Claude API.

Written 2026-09-26 from four parallel research passes: Quickture and the
market, Adobe and academic papers, Avid AAF writing (with an offline
feasibility test), and a codebase inventory. The connector audit was done
directly. The research proxy blocked most vendor and paper sites, so many
external claims come from search extracts. Each section says how well it is
sourced.

## The short version

- **It is buildable, and the risky part has been tested offline.** A new AAF
  can place each soundbite on the speaker's own track, carry the group's video,
  and copy Avid's own clip identities so Media Composer should link it to the
  media it already knows on NEXIS. No audio or video is read or copied. Two
  ways of writing it resolved every frame of every test bite correctly. One of
  them keeps the group structure. **What has not been tested is Media Composer
  itself**; that is step one (see the Mac test plan).
- **Sauce Bunny's per-mic transcripts are a real advantage over Quickture.**
  Quickture uploads one audio stream plus proxies and guesses speakers by voice.
  Sauce Bunny already knows whose mic every line came from. "All the female
  cast" is a lookup, not a guess, once mic bleed is cleaned up.
- **The model should choose lines by number; code should do all the cutting.**
  This is what the Adobe papers converge on. It also makes a small local model
  usable, keeps Claude from inventing a timecode, and makes every answer
  checkable.
- **The first thing to build uses no AI**: pick lines, order them, listen,
  export to Avid. The AI assembly sits on top of that and cannot be trusted
  without it.
- **Local stays the default.** Claude, when the user opts in, reads a whole
  shoot day in one cached pass instead of seven windows, and makes follow-up
  revisions cheap. The existing Claude connector needs streaming, caching and
  structured output before it can carry this.

## What was asked for

Taken from the brief, in the order the work depends on them:

1. From a transcribed multi-mic AAF, ask in plain language: "all the soundbites
   from the female cast, five minutes, every time they say something like
   'let's go, guys, dig in deep'."
2. Get back an **assembly** stored in Sauce Bunny as a sequence you can hear,
   read as a transcript, and change: drop lines, reorder, ask the model again.
3. Export it as an **AAF sequence** (not a transcript) that Media Composer
   imports, relinking to the groups on NEXIS, without Sauce Bunny reading the
   video.
4. Bring **only the speaking person's channel** from a 100-track group, still
   connected to the group, and keep **each person on their own track** where
   possible.
5. Run **locally** (Qwen, or Ollama), and faster or better with the user's own
   **Claude** key.

## What AAF Audio has today

From the codebase inventory, with file references.

**The saved sequence already holds most of what an assembly needs:**

- **Per-mic transcripts** with cue times in sequence samples at 16 kHz
  (`aaf/model.rs:97-109`), saved range coverage and gaps.
- **Cast data**: owner name, cast member and gender per mic
  (`model.rs:68-86`). Gender is set by hand in the Cast dialog; nothing
  guesses it. A person is a mic owner, grouped by cast then name
  (`multitrack-person.ts:9-19`).
- **The original sequence's identity** (`graph.sequence_id`), the root track
  slot IDs, each clip's master or source mob ID, and an exact rational source
  position per clip (`graph.py:336-342`). The arithmetic from a cue to a source
  sample already exists; playback uses it (`linked_audio.rs:42-55`).
- **Group alternates as lanes**, with parent track, group name and branch
  (`graph.py:141-144`).
- **Linked media on NEXIS**: file SourceMob UMID, slot, channel, verified path
  (`model.rs:344-394`).

**It can already:**

- Relink, transcribe per track or per marked range, play all lanes in sync,
  solo and mute.
- Search with a local model: numbered lines in, `{"matches":[ids]}` out,
  validated (`ai-transcript-search.ts`).
- Export TXT, CSV, SRT, PDF, and **Avid marker text** per mic or person, to
  import onto the original sequence (`multitrack-avid-files.ts`).

**It cannot yet** (each gap says where it would plug in):

1. **Write an AAF.** The sidecar is read-only; pyaaf2 writing appears only in
   test fixtures. A new sidecar command beside `inspect` (`reader.py:492-604`),
   called from a new command in `aaf.rs`.
2. **Remember everything an AAF writer needs.** The import drops the group
   CompositionMob ID, the Selector itself, the master mob slot and the mob
   definitions. The document keeps the source path and fingerprint, so the
   writer should re-read the original AAF rather than widen the stored model.
3. **Know where words are.** Cues are caption-sized (up to 84 characters). The
   Parakeet sidecar receives per-token timings and discards them
   (`SrtCore.swift`, `main.swift:487`); Whisper runs `-ml 84`
   (`transcript.rs:1802`).
4. **Tell bleed from speech.** Explicitly out of scope today
   (`AAF-MULTITRACK.md:216-220`). A man's line that bled onto a woman's lav
   would count as hers.
5. **Store a sequence of cuts.** No assembly type exists. Cue IDs change when a
   track is regenerated (`transcribe.rs:147`), so an assembly must keep its own
   copy of each line.
6. **Play an edit list.** The native side can prepare any (track, start,
   duration). The player assumes one continuous position shared by every lane
   (`multitrack-audio.ts:152-209`). Linked NEXIS audio costs one ffmpeg per
   clip per window.
7. **Let AI build a selection.** Search is an unordered filter, local only,
   with no duration, ordering, people metadata, schema or cloud route.
8. **Lay out tracks per person.** Exports use the original A-track numbers.
9. **See pictures.** Picture tracks keep only slot, number and name; no angle
   or camera information (`graph.py:153-155`).
10. **Edit the transcript.** AAF Audio's cue rows are seek buttons. The main
    Transcripts view has selection and editing pieces to reuse
    (`components/transcript/cue-selection.ts`, `CueEditor.tsx`).
11. **Cut frame-accurately with handles.** Cue times are floored to frames;
    nothing rounds out or adds handles.

## What Quickture and the others actually do

Sourcing: vendor and trade-press pages seen through search extracts only.
Treat this as "what they say", not as tested.

### Quickture

- Built by reality-TV veterans (Irad Eyal, Matt Hanna). Seed round April 2026;
  users include Paramount Skydance, A+E, Banijay, ITV Studios and RTL.
- **Mainly a panel inside Media Composer** (Avid's Panel SDK), and inside
  Premiere. Avid's IBC 2025 release names it for "transcription and sequence
  creation through natural language requests". A stand-alone app covers
  Media Composer versions the panel does not; how it exchanges sequences is not
  documented. **The AAF round trip you use is most likely that app.**
- **Works on your raw sequence.** Results are "normal sequences you can keep
  working on". Because the panel builds them inside Avid, nothing relinks.
  (Inference: it keeps every track of the raw sequence, not only the
  speaker's.)
- **Analyses audio plus proxies or stills, uploaded to the cloud.** "Sends an
  audio file and either selects still images from your video or uploads a
  low-res proxy." Speakers come from voice diarization ("30+ voices" per
  episode). Its newsletter listed "using all available tracks of audio" as a
  **future** item. So your belief holds: it works from one mixed stream and
  guesses who is talking.
- **Modes:**
  - Guided Edit: notes, an outline or a script.
  - Multi Edit: intercut, and pull across a whole season.
  - Discuss Mode: plan the edit in chat.
  - Edit by Example: a finished cut guides a new one.
- **Beats are scored** for emotion, humour and "spiciness". You set a target
  length and revise by chat.
- **Vision** (October 2025) adds objects, places, faces and B-roll matching.
- **Cost and speed:** SOC 2 Type II; about $499 per seat per month, $399 on an
  annual plan. In a vendor case study, rough cuts were ready for review two
  hours after ingesting about four hours of footage.

### Everyone else

| Tool | Builds | Back into Avid | Runs |
|---|---|---|---|
| Media Composer itself | Transcript editing, PhraseFind/ScriptSync AI, **Multicam Auto Cut** (2026.8: cuts a group on speaker changes), Gemini search (NAB 2026), "Ready to Edit" prep agent (IBC 2026) | Native | On-device transcription; Gemini features in the cloud |
| Premiere Pro | Text-based editing (one channel or a mix), Paper Edit, AI Assistant "build a stringout from selected clips" (beta), Firefly Quick Cut | None | Assistant uploads; search on-device |
| DaVinci Resolve 20/21 | IntelliScript (script to timeline, alternates on extra tracks), SmartSwitch angles, an MCP server (21.1) | None | Local |
| Eddie AI | Prompted rough cuts, multicam kept | XML/AAF/OTIO pointing at original files | Cloud |
| **Jumper** | Search across ISOs and faces; a local MCP that reads the Avid timeline and can send changes back | Avid panel, works on NEXIS | **Local** |
| Simon Says | Assemble mode | EDL you relink; its AAF carries markers only | Cloud or on-prem |
| Trint, Rev, Reduct, Descript | Transcript-first selects | EDL, ScriptSync or XML (Descript's AAF is audio-only) | Cloud |
| Selects, PowerCut, ButterCut | Local first drafts | Premiere, FCP, Resolve; not Avid | Local |

**No tool found claims "only the speaker's channel, still connected to the
group."**

### Conventions the feature has to respect

- A **string-out** is a story producer's road map for the editor. One source
  puts a good scene string-out at 15 to 25 minutes.
- It includes entrances, exits, greetings and goodbyes, not only the talking.
- A **frankenbite** splices fragments into something nobody said. An
  automatic tool must never make one on its own.
- A **multigroup** is cameras plus the recorder's ISOs in one switchable clip.
  Each group audio track can map to any member's track.
- Editors' complaints about AI tools:
  - speaker labels that are wrong and cannot be fixed;
  - doing the work twice;
  - uploading confidential footage.

## What the research says

Sourcing: papers mirrored on arXiv were read in full; the rest through
abstracts and excerpts, as marked.

### The Adobe work you remembered: ChunkyEdit (CHI 2024)

**ChunkyEdit: Text-first Video Interview Editing via Chunking**, Mackenzie Leake
and Wilmot Li, Adobe Research
(https://dl.acm.org/doi/10.1145/3613904.3642667). High confidence: Adobe
Research, interviews, and one of its two exports is literally a "video
stringout". Read through excerpts, not the full PDF.

- **The problem:** editors described early interview editing as labelling and
  grouping footage by theme, slowly and by hand. ChunkyEdit automates the
  grouping and leaves storytelling to the editor.
- **The unit** is a question-and-answer pair. Its stated limitation: edits
  happen only at the level of a whole answer.
- **Grouping:** four methods, three using GPT-4 and one local keyword-and-
  embedding method, which is also the fallback for sensitive footage. People
  rated the GPT-4 groupings clearly better.
- **Exports:** a paper edit, and a **video stringout as an EDL**, with each
  theme's clips in turn and 2 seconds between themes. Editors asked for XML.
- **Study:** eight professional editors valued the middle ground between a
  manual timeline and full automation. Two said they would still watch all the
  footage once.

### Other work worth borrowing from

**Adobe and Adobe-affiliated:**

- **ROPE** (UIST 2022, partial): scores sentences and uses **dynamic
  programming to fit a length limit**. The five-minute problem is solved in
  code, not by the language model.
- **PodReels** (DIS 2024, partial):
  - GPT-4 reads a multi-hour transcript and returns **sentence IDs**.
  - The user sets length, speakers, style and keywords.
  - Accuracy: duration 86%, speakers 89%, keywords 88%.
- **VideoDiff** (CHI 2025, full):
  - Makes ten rough cuts side by side.
  - Editors found sentence cut-offs and jump cuts that **reading the
    transcript cannot reveal**.
  - In one case the tool said it had cut material it had not.
- **EditDuet** (SIGGRAPH 2025, partial): an editor agent calls timeline tools
  and a critic agent reviews. It failed 8% of the time, against 35% for a
  baseline, on 24+ hours of documentary footage.
- **Tools for Placing Cuts and Transitions in Interview Video** (SIGGRAPH
  2012) and **Content-Based Tools for Editing Audio Stories** (UIST 2013), both
  abstracts only: cut points where the speaker is quiet, breaths and alternate
  takes marked in the transcript.

**Outside Adobe:**

- **LAVE** (IUI 2024, full):
  - Clips are numbered, and the model returns lists of numbers, never
    timecodes.
  - Experienced editors preferred to order clips themselves.
  - They called the model's story logic "grammatically correct but somewhat
    nonsensical artistically".
- **TalkLess** (UIST 2025): whole-sentence picks keep repetitions and lose
  references ("she presented the results", without saying who "she" is).
- **Rhapsody:** general models are poor at spotting moments people replay;
  delivery needs audio features, not text alone.
- **Long input:** models use the middle of a long prompt least ("Lost in the
  Middle"). Map-reduce patterns beat stuffing everything in when the context is
  small.
- **Strict output formats degrade reasoning** ("Let Me Speak Freely?"): reason
  first, then emit the constrained list.
- **Bleed:** meeting-transcription work (Pfau, Ellis and Stolcke 2001; Wrigley
  et al. 2005) classifies each close mic as local speech, crosstalk or silence,
  using per-channel energy and cross-correlation. Whisper also invents
  recurring phrases on channels that carry only bleed. Nobody has published
  this for reality-TV ISOs.

### Design lessons

1. **Line IDs in, line IDs out.** Code computes every timecode, duration and
   cut point.
2. **Duration is arithmetic.** Have the model rank more than enough material,
   then fit the length in code and report the real running time.
3. **Hard filters before the model.** People, gender, mic and time range are
   lookups.
4. **Retrieve, then select.** Narrow to candidates first, then let one call
   choose and order.
5. **Bites are sentences and turns, not caption cues.** Never splice
   mid-sentence or across speakers automatically.
6. **Cut on pauses, with handles.**
7. **Flag incomplete bites mechanically:** a bite that starts mid-sentence, has
   no ending punctuation, opens on a pronoun, or overlaps someone else.
8. **De-duplicate bleed before selecting.**
9. **Editors own the order.** Suggest one with reasons, and allow drag, delete
   and alternates.
10. **Revisions are operations** (drop, move, insert by ID) that code applies
    and shows as a diff. Never trust the model's own summary of what changed.
11. **Review means listening.** Play the assembly with every join marked.

## Getting the cut back into Avid

Sourcing: the AAF object specification and the Edit Protocol requirement table
(read), genuine Media Composer exports from the OpenTimelineIO and LibAAF test
sets (dumped and compared), pyaaf2 source, and an offline test that wrote and
re-read string-outs. **Media Composer was not available.**

### How Media Composer finds media

- **Identity is the MobID.** A file that refers to another mob identifies it by
  MobID. The Edit Protocol requires that any CompositionMob or MasterMob a
  sequence references be **included in the file**. A file holding only the
  sequence plus bare references breaks the protocol.
- **Media Composer's own "Link to (Don't Export) Media" AAF** is this chain,
  with no essence in the file:
  1. The sequence (CompositionMob).
  2. The MasterMob, with one mono slot per channel. Its PhysicalTrackNumber is
     the channel.
  3. The file SourceMob. Its MobID is the MXF file-package UMID, and its
     locator points into `Avid MediaFiles/MXF/<n>/` on NEXIS.
  4. The tape SourceMob.
- **Media Composer's media database** (`msmMMOB.mdb`, `msmFMID.pmr`) indexes
  those IDs per MXF folder.
- **So a string-out that copies the exact mob chain, with the original IDs,
  should come in online with no relink**, on a Mac with the NEXIS workspace
  mounted and indexed. This is inferred from the specification and Avid's own
  exports, not tested in Avid.
- **Reported fallbacks:**
  - Premiere and Simon Says AAFs arrive offline and need "Relink".
  - Resolve AAFs that reference Avid MXF relink automatically.

### Three ways to point a bite at its source

| | How | Offline test (per-frame check through the repo's reader) | Group behaviour |
|---|---|---|---|
| A | Reference the group clip as a whole | **Fails in principle**: plays the group's default angle, so 560 of 680 frames were wrong | Needs a group mob your AAF may not contain |
| B | Reference the speaker's master clip channel directly | 0 of 680 wrong; 0 of 7,561 at 100 lanes, 60 bites, 52 speakers | Match Frame goes to the master clip; no angle switching |
| C | **Copy the original group Selector for that range, trimmed, with the speaker selected** | 0 of 680 wrong, including a bite across an angle switch and two-level nested alternates; 0 of 7,561 at scale | Keeps every alternate and Avid's own attributes: the best chance of "still connected to the group" |

- **Recommendation:** build C, with B as the fallback per bite. Only Media
  Composer can decide C.
- **Video comes free with C.** The picture track's own component for the same
  range is copied the same way, so the group's video, with its live angle,
  comes along. Sauce Bunny does not need to understand cameras.
- **Integrity of every output:**
  - no essence data;
  - no dangling references;
  - every copied mob identical to the source, property by property;
  - 0.6 to 1.6 MB per file, about 2 seconds to write.
- **Genuine Media Composer exports**, 12 files:
  - 8 wrote cleanly.
  - 3 were refused on purpose: a bite over a dissolve, time-warped audio, and
    multi-layer picture.
  - 1 had no audio.
- **Track layout in the test:** one audio track per person, in order of first
  appearance, a timecode track, V1, 24 frames between bites, and a marker per
  bite with its text.

### Pitfalls the writer has to handle

- **23.976** is edit rate 24000/1001 with a non-drop 24 fps timecode.
  **29.97 DF** is 30000/1001 with drop set.
- **Audio lengths:** in sequences they are in video frames, and sample counts
  live only in descriptors.
- **Sub-frame audio:** some master audio slots run at edit rate 96. Convert
  trims into the referenced slot's rate, and refuse non-integer results.
- **Rounding:** floor the in-point, ceil the out-point, and keep handles inside
  the source clip.
- **Audio Pan and clip gain:** Media Composer wraps tracks in Audio Pan with
  varying values. The writer strips them and warns ("raw mic"), matching the
  reader's existing policy.
- **Dissolves, time-warps and multi-layer picture** are refused. Snap the bite
  away from them, or fall back.
- **Partial files:** pyaaf2 leaves a partial file when a write fails. Write to
  a temporary file and publish it, as the sidecar already does for extracts.
- **Other formats won't do:**
  - The OpenTimelineIO AAF writer mints new source IDs and hard-codes channel
    slots.
  - An EDL relinks by tape name and timecode and has no groups.
- **The audio track ceiling in Media Composer** is believed to be 64. More
  speakers than that must share tracks.
- **The sidecar becomes read-write.** CLAUDE.md and the sidecar table describe
  it as read-only; that changes with this, and needs its own tests.

### Found in the current reader

- **Fixed in this change:**
  - An AAF exported from Media Composer 23.12 with a span marker on the
    timecode track failed the whole graph import as "could not be read
    safely".
  - The marker's DescribedSlots property is present with no data, and
    `graph.py` iterated None.
  - Regression test added: it fails without the fix. The genuine file now
    imports with its 3 markers.
- **To handle when the writer lands:**
  - The reader matches marker tracks by DataDef name, and pyaaf2 names it
    differently from Avid. The writer should use Avid's name, as the test did.
  - The reader counts lanes per Selector instance, so re-reading a 60-bite C
    string-out exceeds its 256-lane cap. Count by branch identity instead.

### Mac test plan (the go/no-go)

With the NEXIS workspace mounted:

1. **Read the group structure.** Run
   `docs/research/aaf-stringout-spike/tools/group_report.py` on
   "Sequence with a Group Clip.aaf". It shows whether the groups are inline
   Selectors or a group mob, and what Avid's private "selected" attribute
   holds. Then switch one audio angle in a copy of the sequence, export again,
   and compare.
2. **Generate test string-outs.** Export the source sequence fresh ("Link to
   (Don't Export) Media"). Make B and C string-outs of 5 to 10 bites,
   including one alternate person and one bite across an angle switch.
3. **Import.** Bring each into a new bin in the same project. Expect:
   - no dialogs;
   - online immediately;
   - no new media;
   - Media Tool pointing at the NEXIS MXF.
4. **Check each bite.** It should play the right person's ISO on their track,
   with the right angle. Confirm with Match Frame against the original.
5. **For C:** does Match Frame load the group, and can MultiCamera mode switch
   angles?
6. **Markers:** check text, track, colour and user, including long and Unicode
   text.
7. **Media going away and coming back.** Unmount the workspace, import (expect
   offline), then mount again (expect online without Relink). Repeat on a
   second NEXIS client.
8. **Other formats.** Repeat on a 29.97 DF project, and on a sequence with
   pan, clip gain and dissolves.

The spike's code is kept in
[`research/aaf-stringout-spike/`](research/aaf-stringout-spike/README.md); it is
a prototype, not shipped. Phase 0 below turns it into a sidecar command.

## The AI side: local, Ollama, and Claude

### Health of the connectors that exist

Settings ▸ AI APIs and `cloud_ai.rs`, read against the current Claude API
reference.

**Sound, and worth keeping:**

- **Keys live in the macOS Keychain.** The webview can set, clear and ask
  whether one exists, but can never read one back.
- **The call is made in Rust**, so the key never crosses IPC, and the browser
  CORS block does not apply.
- **Requests can be stopped**: a stopped run stops billing. There is a timeout.
- **The request headers and model are current:**
  - `anthropic-version: 2023-06-01` is still the version header.
  - The default model `claude-sonnet-5` is a current model ID.
  - The code knows current Claude models reject `temperature`.
- **Truncation and errors are reported honestly.** A `max_tokens` stop is shown
  as truncated, not as a finished answer, and provider errors are reduced to
  the provider's own message.

**Gaps, in the order they would bite this feature:**

1. **Non-streaming with a 120-second timeout.** Current Claude models think by
   default, and a long transcript takes time to read. A request that runs past
   120 seconds fails while Claude is still working. The API guidance is to
   stream anything with long input or output.
2. **No prompt caching.** The transcript goes as a plain `system` string.
   Marked with `cache_control`, every follow-up about the same sequence would
   read it from cache at a tenth of the input price, and sooner.
3. **No structured output.** Current models accept
   `output_config.format` with a JSON schema, which guarantees the reply's
   shape. The IDs inside it still need validating.
4. **Refusals read as "Claude returned an empty response."** A declined request
   returns `stop_reason: "refusal"` with a category. It should say so. For
   `claude-opus-5` the API's `fallbacks` option retries on a fallback model in
   the same call.
5. **No retry.** A 429 or an overloaded response fails the run. Retry with
   backoff, honouring `retry-after`.
6. **The model is free text.** A typo fails only at run time.
   `GET /v1/models` lists usable IDs with each one's context size.
7. **Cloud context is capped at 32k.** AI Summary budgets 32,000 tokens for any
   cloud model (`AiSummary.tsx:405`), though current Claude models accept 1M.
   Fine for one clip; wrong for a shoot day.
8. **AAF Audio's Search with AI is local only**, by design today.

The OpenAI half of the file was not checked against OpenAI's current
documentation. Confirm its default (`gpt-4o`) before relying on it.

### Local: bundled llama-server (Qwen) and Ollama

**What's bundled:**

- **Models:**
  - Qwen3 4B Instruct: 32k context, the recommended one.
  - Llama 3.2 3B: 16k.
  - Qwen3.5 9B, Gemma 4 12B and Qwen3.8 27B: 40k each.
- **Server settings:** one slot, flash attention on, prompt reuse on, thinking
  off.
- **Speed, measured in this repo:** a 77-minute transcript (~17k tokens) took
  55.7 s to the first word, reading at 592 falling to 320 tokens per second.

**Constrained output:**

- llama-server can take a JSON schema in `response_format`.
- Its issue tracker records two gaps:
  - it silently stops enforcing when a schema fails to convert;
  - the grammar is not applied while thinking is on.
- The app already runs with thinking off, and the parser stays either way.

**Ollama** is a local server on the same Mac:

- Its native API takes a JSON schema in `format`. Its OpenAI-style `/v1`
  endpoint has been reported to ignore `response_format: json_schema`, so use
  the native endpoint.
- Supporting it is small: a third local provider at a user-typed loopback
  address, limited to `127.0.0.1` and `localhost` so it stays local.
- It lets users run any model they have already pulled.

**What a local model can carry:**

- **A one-hour multi-mic scene** is roughly 20k to 40k tokens as a line table.
  That is an estimate; measure it on a real document. It fits one 40k window,
  barely.
- **A shoot day** is about 250k tokens or more, so seven or more windows. At
  the measured speed that is roughly 7 to 15 minutes of reading before any
  selecting.
- **Small local models** are good at "is this line about X?" and poor at
  choosing 40 lines out of 3,000 to hit five minutes. Locally, the model scores
  lines in windows, and code fits and counts.

### Claude: where it actually speeds things up

- **One pass instead of seven.** Sonnet 5 and Opus 5 accept 1M input tokens, so
  a whole day's line table goes in one request. The model sees every candidate
  when it chooses and orders.
- **Caching makes revisions cheap.** Put the line table first, mark it for
  caching, and put the request after it. "Shorter", "open with Kacy" and "lose
  the fight" then re-read the table from cache.
  - 5-minute cache writes cost 1.25x the input price; reads cost 0.1x.
  - A 1-hour cache costs 2x to write.
- **Structured output** returns `{picks: [{id, why}]}` in a guaranteed shape.
- **Streaming** avoids the timeout and shows picks as they arrive.
- **Batches** run at 50% of the price, usually within an hour and at most 24.
  They suit tagging a whole season overnight, so interactive queries start from
  tags.
- **Effort** trades depth for speed per step: low for tagging, high for the
  final selection.

**Rough cost** from list prices (per million tokens: Sonnet 5 $2 in and $10
out; Opus 5 $5 and $25; Haiku 4.5 $1 and $5, with a 200k window), for a
250k-token day and a 3k-token answer:

| | First query (cache write + output) | Each cached follow-up |
|---|---|---|
| Sonnet 5 | about $0.66 | about $0.08 |
| Opus 5 | about $1.64 | about $0.20 |

This is arithmetic on list prices, not a measurement. Count a real line table
with the token-counting endpoint first.

**What goes to the cloud when the user opts in:**

- line text, person names, the gender label when the query needs it, and
  timecodes;
- never media.

The consent rule is today's: choosing a cloud provider is the consent, and the
warning under the provider picker says so.

## Proposed design

### The one rule

**The model chooses lines by ID; code does the cutting.** It never writes a
timecode, a duration or a clip boundary. It sees a numbered line table and
returns line IDs with short reasons. Code resolves each ID to a mic, a source
position and frames. Code fits the length, snaps cut points and writes the AAF.

### Pipeline

```
AAF Audio document (per-mic transcripts, cast, groups)
  1. Line table        code     one row per spoken line: id, person, gender,
                                mic, TC in/out, duration, text
  2. Bleed resolver    code     same words on several mics at once: keep the
                                loudest owner, mark the rest
  3. Bites             code     join a person's consecutive lines into complete
                                thoughts, snap to pauses, add handles
  4. Request plan      model    "female cast, 5 min, 'let's go, dig in deep'"
                                -> {people, length, phrase, topic, order}
  5. Candidates        both     exact filters, fuzzy phrase match, relevance
                                (windows locally, one pass on Claude)
  6. Selection         model    choose and order bite IDs, with reasons
  7. Fit               code     hit the length, report the real running time
  8. Assembly          saved    ordered clips, per-person tracks, history
  9. Review            editor   listen, read, drop, reorder, swap, ask again
 10. Export            sidecar  AAF for Media Composer (+ markers, EDL)
```

Steps 1-3, 7 and 10 need no AI, and are useful on their own. They make up the
paper-edit tool, they are what makes AI assembly trustworthy, and they are the
part that must work in Avid.

### Lines, bleed and bites

- **Stable line keys.** Cue IDs change when a track is regenerated. Key each
  line by track, start, end and a text hash, and store a copy in the assembly.
- **Bleed.** For lines on different mics that overlap in time with similar
  words:
  - keep the mic whose owner is loudest over that window (the peak pyramid
    already exists per track);
  - mark the others "heard on Frankie's mic";
  - drop lines that exist only as bleed;
  - show the decision, and let the editor overrule it.

  This is what makes "female cast" correct.
- **Bites.**
  - Join a person's lines separated by a short pause.
  - Flag the incomplete ones.
  - Snap in and out points to pauses, and add handles as a setting, rounded out
    to whole frames.
- **Later:** keep the word timings the Parakeet sidecar already gets, so cuts
  can land between words.

### Asking

The request box carries three structured fields, so the common constraints are
never left to the model:

- **People:** names, or a cast attribute such as gender.
- **Target length.**
- **Order:** as shot, or the model's suggestion.

Free text carries the rest: topic, a phrase "or something like it", a tone.

- **Local (default):** the model scores candidate bites in windows under a JSON
  schema. Code merges, de-duplicates and fits.
- **Claude (opt-in):** one streaming request with the line table cached, then
  the request. Structured output returns the picks in order.
- **Either way:**
  - reason first, then emit the ID list;
  - validate every ID;
  - fit in code;
  - report the result, such as "4:52 of 5:00, 23 bites, 6 people".

### The assembly is a document

```
Assembly
  id, name, source document id, created / edited
  requests: [{ text, people, length, provider, model, at }]
  track layout: { person -> output track }     (default A1.. by first appearance)
  clips: [{ key, person, mic lane, source TC in/out (+ handles), output track,
            text snapshot, reason, flags }]
  version, undo stack
```

- Saved beside the sequence's document in
  `~/Documents/Sauce Bunny/Transcripts/Multitrack/`, under the rules the other
  Documents stores follow: a schema version, refusing a newer file, atomic
  writes and a flush on quit.
- A sequence can hold many assemblies. Each clip already records its source
  document, so a string-out spanning a whole season can come later.

### Review: the "headless edit" you can hear

- **The assembly's transcript:** one row per clip, showing who, source TC,
  duration and text.
  - Drop a row (omit, reversible), reorder by pointer and keyboard, swap for
    an alternate take, or trim a line off either end.
  - Ask again ("shorter", "open with Kacy"). The revision comes back as drop,
    move and insert operations that code applies and shows as a diff.
- **A basic timeline:** the assembly on its output tracks, one lane per person,
  with every join marked.
- **Listen:** play the assembly in order. This needs a new edit-list
  scheduler, and must prepare NEXIS audio ahead of the playhead.

### Where it lives in the UI

No redesign:

- **The transcript pane's header** gets a two-way segmented control:
  **Transcript | String-outs**.
- **String-outs mode** shows the saved string-outs, the request box and the
  assembly's transcript.
- **Its footer** (the row that already lines up with the Generate bar) holds
  **Export to Avid**.
- **While a string-out is open,** the timeline on the left shows it on its
  output tracks, and the transport plays it.
- **Dialogs** reuse the existing modal pattern.

## Build order

Each phase is useful on its own.

- **Phase 0: prove the round trip.**
  1. Turn the spike into a sidecar `write-stringout` command, reached from a
     developer menu item.
  2. Build a 5-to-10-bite string-out from your real group AAF and run the Mac
     test plan.
  3. Measure line-table token counts on real documents.

  Outcome: C or B, and the real costs.
- **Phase 1: manual string-outs, no AI.**
  - The assembly model and store.
  - "Add to string-out" from transcript rows, and the String-outs pane: drop,
    reorder and trim.
  - Per-person tracks.
  - Edit-list playback.
  - Export to Avid: AAF plus marker text.
- **Phase 2: clean bites.**
  - The bleed resolver.
  - The bite builder: turns, pause snapping, handles, completeness flags.
  - Keep word timings.
- **Phase 3: local AI assembly.**
  - The request plan with structured fields.
  - Windowed scoring with a JSON schema.
  - Selection and ordering, length fitting in code.
  - Revisions as operations, with a diff.
- **Phase 4: Claude and Ollama.**
  - Upgrade `cloud_ai.rs`: streaming, caching, structured output, retries,
    refusal handling, the model list, and context by model.
  - Route AAF Audio search and assembly through the chosen provider.
  - Add Ollama as a loopback-only local provider.
- **Later.**
  - Season-wide string-outs across sequences.
  - Overnight batch tagging.
  - Picture awareness, such as preferring the speaker's angle, the way
    Media Composer 2026.8's Multicam Auto Cut does.
  - Word-level trims.

The connector fixes in Phase 4 (streaming, the refusal message, retries, the
model list, the 32k cap) also help AI Summary and Analysis today, and could land
on their own first.

## Questions only you can answer

1. **If the Mac test shows C does not come back as a live group,** is B
   acceptable (each bite pointing straight at the speaker's master clip)?
2. **Track layout:**
   - one track per person (A1 Frankie, A2 Johnny…), or every bite on A1 as a
     radio cut?
   - should the mixer's mix track come along too?
3. **Video:** the group's video at whatever angle was live, or the speaker's
   own camera?
4. **Handles and spacing:**
   - how many frames of handle?
   - a gap between bites (the test used 24 frames; ChunkyEdit put 2 seconds
     between themes)?
5. **Order:** is "as shot" the right default, with the model's order as an
   option?
6. **Cloud:** for this feature, is it acceptable to send line text, names and
   the gender label to Claude when it is chosen?
7. **Test material:**
   - which Media Composer version?
   - can you provide a real multigroup sequence with online media on NEXIS for
     Phase 0?
   - does your Quickture round trip use its stand-alone app (AAF in, AAF out)?
     If so, one of its returned AAFs would show exactly what Media Composer
     accepts.

## Sources

**Quickture and the market** (search extracts):

- quickture.com and its blog:
  - https://www.quickture.com/blog/quickture-raises-seed-round
  - https://www.quickture.com/blog/how-to-make-a-guided-edit
  - https://www.quickture.com/blog/quickture-vision-is-here
  - https://www.quickture.com/newsletter
  - https://trust.quickture.com/
- ProVideo Coalition, NAB 2026:
  https://www.provideocoalition.com/nab-2026-eddie-ai-quickture-selects-the-ai-editing-assistants/
- Avid:
  - IBC 2025: https://www.avid.com/press-room/2025/09/avid-unveils-new-ai-and-automation-breakthroughs-to-accelerate-storytelling-ibc2025
  - Media Composer 2026.8: https://www.avid.com/resource-center/whats-new-avid-media-composer-2026-8
- Adobe:
  - Paper Edit: https://helpx.adobe.com/premiere/desktop/edit-projects/edit-video-using-text-based-editing/create-a-sequence-with-paper-edit.html
  - AI Assistant FAQ: https://helpx.adobe.com/premiere/desktop/premiere-ai-assistant/assistant-faq.html
- Eddie AI: https://www.heyeddie.ai/help/export-to-your-nle
- Jumper:
  - https://getjumper.io/for/reality-tv
  - https://getjumper.io/blog/release_notes_may_19_2026
- Simon Says: https://www.simonsaysai.com/help/5266661-how-to-use-assemble-with-avid-media-composer
- Multigroups in reality editing:
  - http://willblanksblog.blogspot.com/2014/05/how-to-multigroup_15.html
  - https://www.freddylinks.com/how-to-multigroup-in-avid-media-composer-for-reality-television/

**Papers:**

- ChunkyEdit: https://dl.acm.org/doi/10.1145/3613904.3642667
- ROPE: https://dl.acm.org/doi/10.1145/3526113.3545680
- PodReels: arXiv 2311.05867
- VideoDiff: arXiv 2502.10190
- EditDuet: arXiv 2509.10761
- LAVE: arXiv 2402.10294
- TalkLess: arXiv 2507.15202
- Rhapsody: arXiv 2505.19429
- Lost in the Middle: arXiv 2307.03172
- Let Me Speak Freely?: arXiv 2408.02442
- WhisperX: arXiv 2303.00747
- Tools for Placing Cuts and Transitions in Interview Video: https://dl.acm.org/doi/10.1145/2185520.2185563
- Content-Based Tools for Editing Audio Stories: https://dl.acm.org/doi/10.1145/2501988.2501993

**AAF and Avid:**

- AAF Object Specification v1.1: https://aaf.sourceforge.net/docs/aafObjectModel.pdf
- Edit Protocol requirements: https://github.com/dneg/aaf/blob/master/Utilities/AAFAnalyzer/Requirements/AAFRequirements.xml
- pyaaf2, including `examples/aaf_merge.py`: https://github.com/markreidvfx/pyaaf2
- OpenTimelineIO AAF adapter: https://github.com/OpenTimelineIO/otio-aaf-adapter
- OpenTimelineIO issue #827: https://github.com/AcademySoftwareFoundation/OpenTimelineIO/issues/827
- LibAAF test files: https://github.com/agfline/LibAAF
- Avid KB en262645: https://kb.avid.com/pkb/articles/en_US/Knowledge/en262645

**Local models:**

- llama.cpp server README: https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md
- llama.cpp issue #19051: https://github.com/ggml-org/llama.cpp/issues/19051
- llama.cpp issue #20345: https://github.com/ggml-org/llama.cpp/issues/20345
- Ollama structured outputs:
  - https://docs.ollama.com/capabilities/structured-outputs
  - https://ollama.com/blog/structured-outputs
- Ollama issue #10001: https://github.com/ollama/ollama/issues/10001
