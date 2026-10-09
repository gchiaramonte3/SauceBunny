# Story cuts from an idea (2026-10-08)

The owner asked to "build a cut based on a story line or idea" and send it to
Avid. Ask in String Outs could already find lines and lay them out as a
**string out**: selects, a second of filler between bites, long handles. A
**story cut** plays: beats that tell the idea, lines butted together inside a
beat, the fillers taken out, fitted to a running time.

Owner decisions (2026-10-08):

1. **Ask in Sauce Bunny first.** Built into String Outs Ask, with the model
   already configured (Claude, OpenAI, or the local model on the tools path).
2. **Outside agents propose only** (phase 3, specified, not built). Claude or ChatGPT
   desktop may build and measure a cut that lands in an inbox; the editor
   applies it. Assistants still never change a string out (AI-ACCESS-SPEC).
3. **Fillers may come out of a line**, each removal marked and restorable,
   never joining words from two moments.

## How a cut is made

The model proposes, code builds. The model never writes a timecode or a word;
it names lines by id, as Ask always has.

1. **Outline.** 3 to 7 beats, each with what it does and about how long.
2. **Gather.** `search_transcripts`, `scan`, `find_conversations` per beat.
3. **Choose.** The strongest take of anything said twice; the owner's line,
   never a bleed copy; a conversation whole; lines ordered to tell the story.
   Never a split line or a frankenbite.
4. **Measure.** `measure_cut` (context layer, read-only) times the beats with
   the layout's own rules and warns: a line twice, an unknown id, a bleed
   copy, a missed target (more than a tenth off). The model fits the cut.
5. **Critique.** One read-back as a critic (setup, build, payoff, repetition,
   missing context), then measure again.
6. **Propose.** `{"kind":"cut","title","target_seconds","beats":[{"title","purpose","lines"}]}`.

A note on a cut ("shorter", "open on Donny") revises it: the last cut is
replayed whole in the history. A cut request, or a note on one, may take 20
rounds of tool calls instead of 10 (`cut` in `assistant_chat`).

## Layout rules

`src/lib/edit-story.ts` (`layoutStoryCut`), timed identically by
`src-tauri/src/context/cuts.rs` and pinned by `duplicated-tables-contract`:

| Rule | Value |
|---|---|
| Handle before a stretch | 0.25 s |
| Handle after a stretch | 0.5 s |
| Lines joined into one stretch | same source, within 2 s |
| Pause between beats | 1 s of filler |
| Between stretches inside a beat | none: they butt |

- Exchanges join only within a beat; a conversation plays as one clip with
  everyone in it on their own track (`exchangesOf`, `placeExchange`).
- Every line gets a marker; a beat's first marker reads `Beat N · Title: …`.
- Tracks are patched from nothing (`giveTracks`), then the cut is focused on
  the people its markers name (`focusOnMarkers`).

## Tightening

`tightenCut` takes out of the cited lines only:

- **fillers**: um, umm, uh, uhh, uhm, erm, er;
- **a stammer's first word**: two of the same small word in a row within half
  a second (I, the, a, and, to, it, we, you, and similar). "Go, go, go" and
  "no, no" are said on purpose and stay.

Only within one line of one person. A filler someone else talks under stays
(cut it and their words go too; mute it and Avid gets a tiny muted clip).
Each removal closes up like a delete and shows as a Removed line that
Restore puts back.

## Editing the string out that is open (phase 2)

Owner request (2026-10-08): "There should be a lot better bites from @EMILY,
add to the string out without repeating lines. I want to also be able to ask
the application to add to the string out or to manipulate a current string
out timeline, so that the timeline isn't just creating new timelines, but
things could be reordered, added, or reorganized."

Today Ask can only make a new string out (build, cut), replace the whole
one that is open, or remove lines from it. An editor's real notes are about
the cut in front of them: add Emily's better lines, move the payoff earlier,
swap a weak bite for a stronger take, regroup by person, lose a clip.

### What the model can already see

- **Every clip by address.** `get_string_out` lists the clips in order, each
  as `saucebunny://string-out/{id}/clip/{clip}` (the segment id), with record
  and source timecode, who plays and the words.
- **What is already used.** Every transcript row carries `[in: …]` naming the
  string outs that play it, so "without repeating lines" is visible to the
  model before it chooses.
- **What is on screen.** `get_app_state` gives the selection, playhead and
  marks, for "after this" and "here".

### The proposal: an edit, as operations

A new action, applied to the open string out in order as ONE undo step:

    {"kind":"edit","title":"a label for the undo step","ops":[ … ]}

| Op | Says | Done by |
|---|---|---|
| `{"op":"add","lines":[ids],"at":POS}` | Put these lines in, in this order, at POS | Laid out with the string out's own style (a string out's handles and filler between bites, or a cut's tight rules), then spliced in as whole clips |
| `{"op":"replace","clip":CLIP,"lines":[ids]}` | A better take for one clip | `add` after the clip, then `remove_clips` it |
| `{"op":"move","clips":[CLIP…],"at":POS}` | Move these clips, in this order | Whole clips move with the filler after them and their markers; nothing is re-cut |
| `{"op":"order","clips":[every CLIP]}` | Reorganize the whole string out | Must name every clip exactly once; dropping one is a `remove_clips`, never a side effect of a reorder |
| `{"op":"remove_clips","clips":[CLIP…]}` | Lose these clips | The clip and the filler after it go; its markers go with it |
| `{"op":"remove","lines":[ids]}` | Lose these lines | Today's remove (`removeWithoutCuttingOvertalk`) |

POS is `"start"`, `"end"`, `{"before":CLIP}`, `{"after":CLIP}` or
`"playhead"` (where the record playhead is, snapped to the nearest boundary
between clips). CLIP is a clip address as `get_string_out` gives it.

Clips are the unit on purpose: a string out is a run of clips, and moving or
dropping whole clips can never split a word, open a gap in someone's line, or
make a frankenbite. Finer changes (trims, splitting a clip) stay with the
editor and the timeline tools.

### No repeated lines, three times over

1. **The model is told.** The system prompt says an added line must not be
   one the string out already plays, and every row says where it is used.
2. **The model is warned.** `measure_cut` takes an optional `string_out`; a
   line already in it is a warning ("already in this string out"), so the
   model can swap it before proposing.
3. **The code refuses it anyway.** When an `add` is applied, any line whose
   words already play in the string out is skipped, and the result says so
   ("Skipped 3 of Emily's lines that are already in it").

### The @EMILY example, end to end

1. The model reads Emily's lines (`read_transcript`, people: EMILY), skipping
   rows marked `[in: <this string out>]`, and searches or scans for her
   strongest moments on the string out's topic.
2. It checks the picks with `measure_cut` (string_out set), drops repeats, and
   proposes `{"kind":"edit","title":"Add Emily's best","ops":[{"op":"add",
   "lines":[…],"at":"end"}]}`, or places each where it belongs (`after` the
   clip it answers) if the string out has a shape.
3. The card shows the change before anything happens: "Add 6 of EMILY's lines
   at the end (+1:12)", each line listed, and the running time before and
   after. **Apply here** is the default for an edit (one undo step, ⌘Z
   undoes it); **Into a copy** leaves this string out alone.

### Safety

- The model proposes and code applies, as everywhere in Ask; the context
  layer stays read-only and nothing is written until Apply.
- **Stale proposals are refused, not guessed.** The proposal records the
  undo step it was made against. If the string out changed since and a clip
  it names is gone, Apply says which and asks for the note again; ops that
  name only clips that still exist apply as written.
- Every op is checked before any is applied (unknown clip, a reorder that is
  not a permutation, a position that is not a boundary). One bad op refuses
  the whole edit, with the reason, so a half-applied note never happens.

### Where it goes

- `src/lib/edit-ops.ts` (new, pure): `applyOps(document, ops, { words,
  lengths })` returning the new document and notes (skipped, refused). Built
  on whole segments: splice, reorder and drop clips with the gap after each,
  lay added lines out with `layoutEditBites` or `layoutStoryCut` and splice
  their segments and markers in, patch new people (`giveTracks`), focus the
  new clips (`focusOnMarkers`), ripple markers.
- `src/lib/edit-ask-tools.ts`: the `edit` action in the prompt, the parser
  (clip addresses kept like line addresses) and `resolveProposal`.
- `src-tauri/src/commands/assistant_chat.rs`: `expand` resolves the line ids
  inside each op, as it does for a cut's beats.
- `src-tauri/src/context/cuts.rs`: `measure_cut` gains `string_out`, warning
  on lines already in it.
- `src/components/EditAskEdit.tsx` (new): the diff card, one row per op, the
  running time before and after.
- `src/components/EditSidePanel.tsx`: Apply here or into a copy, one commit.
- Tests, each break-tested: every op on its own; a reorder that drops a clip
  refused; an add of a line already in it skipped; a stale clip refused; one
  bad op refusing the whole edit; the card; `expand` resolving op lines.

## Claude and ChatGPT desktop, propose only (phase 3)

Owner decision 2 (2026-10-08): an outside agent may build and check a cut or
an edit, which waits in an inbox; the editor applies it. Assistants still
never change a string out, and the MCP server still has no channel into the
running app (docs/AI-ACCESS-SPEC-2026-10-03.md, decisions 1 and 2).

### What an outside agent can do

- **Read and measure**, as today: the eleven read tools plus `measure_cut`.
- **Propose**, with two new tools that write only into the inbox:
  `propose_cut` and `propose_edit`. Neither opens an AAF Audio document, a
  string out or the undo log for writing. Applying is the editor's click, in
  the app, through the same code as Ask's Apply.

Why this keeps the October 3 decisions: the MCP process writes its own
files in its own folder, and the app reads that folder itself, as it reads
any store. Nothing in the app listens to the MCP server and nothing is
applied without the editor.

### The two tools

| Tool | Takes | Checks before it writes | Returns |
|---|---|---|---|
| `propose_cut` | `title`, `brief`, `target_seconds?`, `beats[{title, purpose, lines}]` | Every line resolves (unknown ids refused, by id); `measure_cut`'s warnings (a line twice, a bleed copy, a missed target) | The proposal's id, its running time and warnings, and where it waits: Sauce Bunny ▸ String Outs ▸ Proposals |
| `propose_edit` | `string_out`, `title`, `brief`, `ops` (phase 2's ops) | The string out exists; every clip it names exists in it now; every line resolves; lines already in it warned | The same, plus the undo step it was made against |

- **Addresses, not row ids.** Row ids (`L…`) belong to one process's
  session, so a proposal stores each line as its full address and each clip
  as its clip address.
- **MCP annotations:** `readOnlyHint: false`, `destructiveHint: false`,
  `idempotentHint: false`, `openWorldHint: false`. Claude Desktop asks before
  a tool that writes, and so does Codex with `default_tools_approval_mode =
  "writes"`, so the editor sees each proposal being sent.
- **MCP only.** In-app Ask already proposes through its own answer, so the
  two tools are listed by `mcp.rs` and not by `assistant_chat`.
- **Bounded:** at most 12 beats, 400 lines, 200 ops, a 2,000-character brief,
  and 50 proposals waiting (a 51st is refused: "Fifty proposals are waiting;
  dismiss some in Sauce Bunny first").
- **Off switch:** Settings ▸ Assistant access ▸ "Let assistants send
  proposals", on by default (decision 2). Off, the two tools are not listed
  and a call is refused. Kept in `app_data_dir()/assistant.json`, which the
  MCP server reads as it reads `bleed.json`.

### The inbox

- **Store:** `app_data_dir()/proposals/<uuid>.json`, one file per proposal,
  written atomically, `schema_version` 1 (the store-version contract: a file
  from a newer build is refused, not misread). Not under `~/Documents`: it
  holds addresses and short text, and iCloud eviction has bitten every live
  store kept there.
- **A proposal:** `{schema_version, id, kind: "cut" | "edit", title, brief,
  client, created_ms, target_seconds?, beats? | {string_out, made_against,
  ops}?, measured: {seconds, warnings}}`. `client` is the name the MCP client
  gave when it connected ("Claude Desktop", "codex").
- **When the app reads it:** when String Outs opens and whenever the window
  comes forward (you switch back from Claude or ChatGPT). No polling: idle
  traffic stays at zero.
- **Where it shows:** a **Proposals (N)** button in String Outs' top bar
  when any wait. Each opens on the card Ask uses: the cut card (beats,
  purposes, running time against the target) or phase 2's diff card. The
  brief is labelled with who sent it ("From Claude Desktop: …") and shown as
  text, never acted on.
- **Applying:**
  - A cut: **Make new string out**. Its sequences become the new string
    out's sources, it opens in a tab, and the cut is laid out once their
    words have loaded (from the words cache, usually at once).
  - An edit: **Apply here** on the string out it names, or **Into a copy**.
    Phase 2's stale rule applies: a clip gone since `made_against` refuses,
    naming it.
  - Either way it is one undo step labelled with the client ("Claude: Add
    Emily's best"), and the same function Ask's Apply uses, moved out of
    `EditSidePanel` into a shared hook so the two cannot drift.
  - **Dismiss** removes a proposal; applying removes it too. The undo
    history keeps what was applied.

### The skill: `sauce-bunny-story-cut`

One folder, kept in the repo at `assistant-skills/sauce-bunny-story-cut/`
and bundled with the app (`skills/sauce-bunny-story-cut/` in its resources):

- `SKILL.md`: frontmatter `name: sauce-bunny-story-cut` and a `description`
  saying when to use it (building, cutting or revising a story, string out
  or edit from Sauce Bunny's transcripts) and when not to (general video
  questions). The body is the method above (outline, gather, choose,
  measure, critique), the rules (cite lines, never write text or timecodes;
  owner lines, not bleed copies; no frankenbites; fit with `measure_cut`),
  phase 2's ops for revising a string out, and the ending: call
  `propose_cut` or `propose_edit`, then tell the editor it waits in
  Proposals. It says plainly that the agent cannot change a string out.
- `agents/openai.yaml`: implicit invocation allowed, so Codex and ChatGPT
  pick it up when a request matches.

**Installing it**, from Settings ▸ Assistant access, beside the Claude
routes the app already offers (`claude mcp add`, the Claude Desktop config,
the `.mcpb` extension):

| Where you ask | The skill | The tools |
|---|---|---|
| Claude Code | Install to `~/.claude/skills/sauce-bunny-story-cut/` | `claude mcp add sauce-bunny -- '<app>' --mcp` (today) |
| Claude Desktop | **Save skill…** as a zip, to add in Claude's settings | The `.mcpb` extension (today) |
| ChatGPT desktop and Codex | Install to `~/.agents/skills/sauce-bunny-story-cut/` | `codex mcp add sauce-bunny -- '<app>' --mcp`, shown with the `config.toml` snippet (`[mcp_servers.sauce-bunny]`, `default_tools_approval_mode = "writes"`). ChatGPT desktop and Codex share `~/.codex/config.toml` |
| ChatGPT on the web | Not supported | It cannot reach an app on this Mac without OpenAI's tunnel, and its write access depends on the plan |

The app writes only the skill folder, on a click, and shows the Codex
command to copy rather than editing another app's config file.

### Safety

- **Proposals are data from outside the app,** never instructions: shown as
  text, bounded in size, every address resolved again at Apply, nothing
  applied without a click. One bad op refuses the whole edit (phase 2).
- **The MCP server writes one thing:** its own `<uuid>.json` files in the
  proposals folder, atomically, only while proposals are switched on.
- **The skill and the app cannot drift:** a contract test checks that every
  tool the skill names is one the MCP server lists, and that its numbered
  method matches Ask's.

### Where it goes

- `src-tauri/src/context/proposals.rs` (new): validate and write a
  proposal, using `cuts::measure` and the string-out reader for clip checks.
- `src-tauri/src/context/tools.rs` and `src-tauri/src/mcp.rs`: the two
  tools, listed only when proposals are on, with write annotations; the
  client's name taken from `initialize`.
- `src-tauri/src/commands/proposals.rs` (new): `proposals_list` and
  `proposal_dismiss`, both async (main-thread contract), registered in
  `lib.rs`, with ts-rs bindings; build ID bumped.
- `src/hooks/use-proposals.ts` and `src/components/EditProposals.tsx` (new):
  the inbox, read on open and on window focus.
- The apply step moved from `EditSidePanel.tsx` into a shared hook used by
  Ask and the inbox.
- `assistant-skills/sauce-bunny-story-cut/` (new), bundled by a distinct
  `bundle.resources` path; `src-tauri/src/commands/assistant.rs` and
  `src/components/AssistantAccess.tsx`: install, save and the Codex route.
- Docs: AI-ACCESS-SPEC (decision 2 amended: proposals allowed, applying
  stays with the editor), DATA-MODEL and CLAUDE.md's storage table (the new
  store), CHANGELOG.

### Tests and checks

- Each break-tested:
  - MCP lists the two tools only when proposals are on, annotated as writes.
  - `propose_cut` refuses an unknown line and stores addresses.
  - `propose_edit` records the undo step and refuses an unknown clip.
  - A newer `schema_version` is refused.
  - A cut proposal applied gives the same document as Ask's Apply of the same beats.
  - A stale edit is refused, naming the clip.
  - The skill contract holds.
- **End to end against the bundled app:**
  1. Over stdio: `initialize`, `tools/list`, `propose_cut` on fixtures; the file appears and the app lists it.
  2. Claude Code with the skill: "a three-minute cut of Emily's best", then Apply, then an AAF export that passes its self-check.
  3. Codex with the `writes` approval mode: the proposal is asked for before it is sent.

## Phases

- **Phase 1 (built):** the cut action, `measure_cut`, the layout and
  tightening, the cut card in Ask (running time against the target, each
  beat's purpose, time and lines), applied as a new string out or in place,
  one undo step.
- **Phase 2:** Ask edits the open string out (above): add, replace, move,
  reorder and remove whole clips, no repeated lines, a diff card, Apply
  here as one undo step. A note on a cut becomes these ops too, rather than
  a whole new cut; shortening a beat is removes the model chooses with
  `measure_cut`. Also: false starts the model flags by quoting the head of a
  line, removed only from a line's head, marked and restorable.
- **Phase 3:** Claude and ChatGPT desktop propose only (above):
  `propose_cut` and `propose_edit` over MCP into a proposals inbox in String
  Outs, the `sauce-bunny-story-cut` skill, and install routes for Claude
  Code, Claude Desktop, ChatGPT desktop and Codex. Builds on phase 2, whose
  ops `propose_edit` carries.
- **Later, each behind a verified Avid sample:** the speaker's camera angle on
  picture, J/L cuts, dissolves and fades, B-roll, music.
