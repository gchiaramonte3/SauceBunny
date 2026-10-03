# String Outs, October 3: assembly, UI/UX and export speed

**Source:** this session's measurements and audit. Export timings come from
the bundled `saucebunny-aaf` writing a 3-bite, 23-track string out from
`HEAT 2_New Group.aaf` (99 mics, one V1 multigroup). Screens were captured in
the Playwright harness (`e2e/transcript-editor.spec.ts`'s fixture: Alex, Sam
and the room, V1 as one group clip). The control inventory was read from
`src/components/Edit*.tsx`, `src/hooks/use-edit-*.ts` and the AAF Audio
components.

**Status (2026-10-03):** phases 1, 2, 3 and 5 are built and tested; phase 4
is below. Each phase's own Status line says what was built, what was not,
and why. The owner's decisions in the list below are still open and nothing
that depends on them was built. Each phase stands alone and has a way to
tell it's done.

**Rules that hold in every phase:**
- **The bar is locked.** No people, names or speaker chips in the transport or
  timeline tool row, and the row does not change unless the owner says so.
  Every item below that touches the row is marked **(bar: needs the owner's
  OK)** and is not built until that OK is given.
- **Names belong on the source side.** The record side is A1, A2 and so on,
  patched top-down.
- The CLAUDE.md contracts (component under 150 lines, `cp-` classes,
  segmented-choice, select, hit-target, voice, green) and `npm run verify`.

| Phase | Goal | Depends on |
|---|---|---|
| 1 | The record side assembles like an editing timeline | — |
| 2 | Marks set, show and clear the same way on both sides and in AAF Audio | 1 |
| 3 | Layout, naming and tab-order corrections from the audit | — |
| 4 | Faster export | — |
| 5 | Hand tests in Media Composer | 4 for the timings |
| Later | Send to Avid panel | Avid Panel SDK access, an owner decision |

**Decisions only the owner can make** (nothing below is built until
answered; everything else in this spec can run as written):

1. A Clear button in the timeline tool row, or only the × on the ruler's
   marked range (phase 2.2). The ruler × does not touch the bar.
2. "Room tone in lifts": build it or remove it (phase 3a.5).
3. Air between bites on a manual Append (phase 1.5).
4. Independent tracks instead of the single storyline (phase 1, end).
5. The Send to Avid panel and Avid's developer program (Later).

---

## Phase 1: the record side assembles like an editing timeline

**Status:** built (d975dee). Items 1 to 4 as written; 5 (air between bites)
waits on the owner. Splice points land on frames before anything is
computed, so an Overwrite cannot drift a frame on save. Escape on a warning
now only closes it (3a.2, done here).

**What was found.** The record side is a single storyline: each clip spans
every record track, and only the people it was cut with sound on it (the
other tracks are filler under it). Splice-in, Lift, Extract, Add Edit, Mark
Clip and markers that ripple all behave as in Avid. Three things do not:

- **Insert lands at the text caret, not the playhead.** `insert` in
  `src/hooks/use-edit-workspace.ts` places the clip at
  `insertionPoint(range ? range[0] : caret)`, a word index in the record
  text. The caret starts at word 0 and moving the playhead on the timeline
  never moves it. So scrubbing to 01:00:40:00 and pressing V puts the clip at
  the **start** of the string out. In Avid, V splices at the record In mark,
  or at the position indicator when there is none.
- **There is no Overwrite (B).**
- **A new string out starts with the whole sequence on it** ("Start with the
  whole sequence" is checked by default). The model the owner asked for is
  the opposite: start empty and build from chunks.

**Changes:**

1. **Insert goes where the record playhead is.** V (and the Insert button)
   splice at the record In mark when one is set, else at the record
   playhead, splitting the clip under it, exactly as Avid does. With Snap (N)
   on, the point moves to the nearest gap between words, so a splice never
   lands mid-word. Append stays "at the end". The status line names the
   timecode, as it does now.
2. **One record position.** However the playhead moves (a timeline click,
   a scrub, play, previous or next edit), the record text caret follows it to
   the word under it, and clicking text moves the playhead (it already does). Insert,
   Add Edit and markers then all mean the same place.
3. **Overwrite (B).** Replace record material from the In mark (or
   playhead) for the source duration, with no ripple. In the single-storyline
   model that is: extract that program range, then splice the source clip at
   the same point, as one undo step labelled "Overwrite". If the source is
   longer than the rest of the string out, it extends it.
4. **A new string out starts empty.** Uncheck "Start with the whole sequence"
   by default. The "Add all of ‹sequence›" button on an empty record stays,
   for anyone who wants the old start.
5. **Air between bites (optional, owner's call).** Ask's builder puts 24
   frames of filler and handles between bites; a manual Append butts clips
   together. Offer the same spacing on Append when the clip comes from a
   different moment than the one before it.

**Decision for the owner, not built in this phase:** independent tracks.
Avid lets A1 and A2 carry different material at the same moment (split edits,
J and L cuts, Overwrite on one track). The single storyline cannot, by
design: it keeps the text, the timeline and export in step and makes every
delete safe for overtalk. Recommendation: keep the storyline for string outs,
which are bites end to end, and revisit if cutting scenes is ever in scope.

**Done when:**
- An e2e test parks the playhead in the middle of the second clip by
  clicking the timeline, marks a source range, presses V, and finds the new
  clip at that timecode with the second clip split around it. Break-test it
  by reverting to the caret.
- Overwrite over a range leaves the total length unchanged (unit test in
  `edit-model.test.ts`) and is one undo step (e2e).
- A new string out opens with no clips and no record tracks, and offers
  "Add all of ‹sequence›".

---

## Phase 2: marks set, show and clear the same way everywhere

**Status:** built (e18d1b1), with three differences from the text below.
J steps back one second and repeats while held, K stops and L plays: the
String Outs engine plays forward at 1x only, so there is no reverse or fast
shuttle. Item 5 was not changed: AAF Audio's Out includes its own frame, so
In equal to Out is a real one-frame range there, while String Outs' Out is
exclusive; each view already follows Avid for its own model. String Outs'
tool-row tooltips were left alone (the bar is locked); the ruler's × names
G. Found and fixed on the way: right after String Outs opened, focus sat on
the view around the editor and every letter key was ignored until something
inside was clicked.

**What was found.** Neither view has a visible way to clear marks, and the
two views clear them with different keys:

| | AAF Audio | String Outs record | String Outs source |
|---|---|---|---|
| Mark in / out | I, O (no buttons) | I, O, and Mark in / Mark out buttons | I, O with focus in the source pane, or the same buttons in Source mode |
| Mark clip | — | T, and a button | — |
| Clear both | **G** | **⌥X** (G does nothing) | Escape clears a text selection only |
| Clear In / Out alone (Avid D / F) | — | — | — |
| Go to In / Out (Avid Q / W) | Q, W | — | — |
| A visible Clear | none | none | none |

(`src/hooks/use-multitrack-keyboard.ts:19`, `src/hooks/use-edit-keys.ts:41`,
`src/components/EditTimelineTools.tsx:83`.) The "Transcription range" select
in AAF Audio says "G clears the marks"; nothing in String Outs says ⌥X.
String Outs also has no J, K or L and no arrow-key frame stepping, both of
which AAF Audio has, and "Open in String Outs" drops AAF Audio's marks.

**Changes:**

1. **One key map, Avid's, in both views and on both sides of String Outs:**
   I and O mark, T marks the clip (record), **G** clears both, **D** clears
   In, **F** clears Out, **Q** and **W** go to In and Out. Keep ⌥X as a
   silent alias for one release. Escape keeps its current jobs and does not
   clear marks (Avid's doesn't).
2. **A visible Clear on the marked range itself.** When both marks are set,
   the marked range on the ruler (`RulerMarks`) carries a small × with the
   label "Clear marks (G)". This is in the ruler, not the tool row, so the
   bar is untouched. The same component serves AAF Audio, so both get it.
   A Clear button in the tool row instead is **(bar: needs the owner's OK)**.
3. **String Outs gets AAF Audio's transport keys:** J, K and L, ← and → for
   one frame, ⇧ for ten, and End for the end. Keys only; no new controls.
4. **Marks travel.** "Open in String Outs" from AAF Audio with In and Out
   set opens the source side with that range marked, ready for V.
5. **One crossing rule.** Setting a mark past the other one clears the
   other in both views (String Outs and AAF Audio disagree when they are
   equal today).
6. Tooltips name the keys: Play and Go to start in AAF Audio have none;
   String Outs' tooltips gain G, D, F, Q and W where they apply. Fix the
   docs drift too: `docs/AAF-MULTITRACK.md` still says range transcription
   has no start and end form.

**Done when:**
- A source-scan contract test proves both key maps bind I, O, G, D, F, Q and
  W to the same actions, with a canary that the scan found both files.
  Break-test by unbinding G in one.
- e2e: G clears on the record side, on the source side and in AAF Audio; the
  ruler's × clears and is reachable by keyboard; J/K/L shuttle the record.

---

## Phase 3: layout and naming corrections

**Status:** built (b78d3f1). 3a.5: Crossfade at cuts now drives playback
("Off" keeps a 10 ms de-click); Room tone in lifts is untouched until the
owner decides. 3c.11 needed no change: paragraph moves and the History pin
already show on keyboard focus. 3c.7's claim was a code comment, now
corrected. Everything else as written.

### 3a. Things that do the wrong thing (fix; each gets a break-tested test)

1. **Keys ignore disabled tools.** With the timeline on Source, ⌘B, T, Z, X,
   M, A and S still edit the record while their buttons say "Switch the
   timeline to Record to use it" (`EditEditor.tsx:83-88`). Gate the keys
   exactly as the buttons are gated.
2. **Escape on the extract warning performs a Lift.** The prompt's Escape
   runs `onKeep`, which for that prompt is "Lift selected tracks"
   (`EditOvertalkPrompt.tsx:12`, `EditEditor.tsx:138`). Escape must dismiss
   with no edit.
3. **Home disagrees with its button.** Home always goes to the record start;
   in Source view the "Go to start (Home)" button goes to the source start.
   Home follows the side the timeline shows.
4. **Loop in Source view loops the record.** Its label reads the source
   marks, its playback uses the record's. Loop follows the side shown.
5. **The Audio menu half works.** "Crossfade at cuts" redraws the overlay
   but playback always uses 10 ms (`src/lib/edit-audio.ts:45`); wire it to
   playback. "Room tone in lifts" is never read anywhere: build it or remove
   the item **(bar: needs the owner's OK either way, since the menu lives in
   the tool row)**.
6. **Source marks can be invisible.** I and O set in the source pane while
   the timeline shows Record appear nowhere. Show the source In and Out on
   the source pane's own position rail, and as a bracketed range in the
   source text.
7. **Old marks come back.** Escape in the source text clears the text
   selection, and I/O set earlier reappear (`use-edit-source-side.ts:75`).
   The last thing marked wins; clearing clears everything on that side.
8. **Space after clicking a tool presses the tool again** instead of
   playing (`use-edit-keys.ts:34`). Tool-row buttons should not keep focus
   from a mouse click, so Space plays, as in every NLE. Keyboard focus and
   Tab order stay as they are.
9. **Source view before its sequence has loaded** draws record lanes with
   source-side tool states (`EditLower.tsx:63`). Show "Opening ‹sequence›…"
   in the lanes instead.
10. **Markers can be added (M) but never removed or renamed.** Clicking a
    marker on the ruler selects it; Delete removes it; the Inspector edits
    its name, comment and colour.

### 3b. Which side is active

In the screenshots, a selection in the source text and one in the record
text are the same purple at the same time, and three play buttons are on
screen (source rail, record rail, timeline transport). Avid shows one active
monitor. Mark the side that Space, I, O and V act on: the active pane gets a
lifted outline (a neutral token, never green, per the green contract), and
the inactive side's selection dims. No control is added or moved.

### 3c. Names and copy

1. **"Source" means two things:** the toolbar's show/hide panel toggle and
   the timeline's Source/Record mode. Rename the toolbar toggle "Source text".
2. **The record side has three names:** "Edit" (the pane, "Edit position",
   "Insert at the edit's caret"), "Record" (the timeline corner, the
   transport) and "string out". The side is "Record"; the document is the
   "string out".
3. **Silencing has four names:** "Silence"/"Unsilence", the undo label
   "Remove from X's Track", the tooltip "Removed from X's track only". Use
   "Silence" everywhere.
4. "Ask for a string-out" → "Ask for a string out".
5. **Disabled with no reason:** Insert and Append ("Select words or mark In
   and Out in the source"), Export AAF ("Cut something in first"), "Add all
   of ‹sequence›" ("Reading the sequence's length…") and "Add to…" with
   nothing selected ("Select words in the record first").
6. "Add sequence…" says "Every AAF Audio sequence is already in this edit"
   when there are none at all; say "No AAF Audio sequences yet. Import one in
   AAF Audio."
7. The Inspector says "every button here also has a key"; Restore and Done
   have none. Give them keys or drop the claim.
8. Hidden help says "Return corrects a word", but Return says to correct
   words in AAF Audio. Make the help match.
9. The editor header shows the title and, under it, the sequence name, which
   is the same text twice when a string out is named after its sequence.
   Hide the second line when they match.
10. The Ask model picker truncates its empty state ("No local model
    downloac…"). Shorten the copy so it fits.
11. Paragraph ↑/↓ and the History ★ appear on hover only. Show them on
    keyboard focus too.
12. Docs drift: HAND-TEST says "Close up for everyone" (the button is "Cut
    for everyone") and "Apply" (it is "Remove"); TRANSCRIPT-EDITOR-UX.md
    says "Add to end" (it is "Append"), describes a History clock beside
    undo that does not exist, and says "Ask (⌘K)" (⌘K is the command
    palette).

### 3d. Person tabs in track order, left to right

**Owner's requirement:** the person tabs always read left to right in track
order, A1, A2, A3 and on, never alphabetically and never in the order the
file happens to store them. This applies to AAF Audio's transcript tabs and
String Outs' source tabs, which are the same component
(`MultitrackTranscriptTabs`).

**What was found.** The tabs follow `document.manifest.tracks` as stored
(`multitrackPeople` in `src/lib/multitrack-person.ts`; `sourcePeople` in
`src/lib/edit-source-view.ts` sorts by the same list). In a grouped sequence
the AAF stores every main track first and every group alternate after all of
them. In "Sequence with a Group Clip" that reads A1 CARA, A2 ANICKA … A20 JOE,
then BOMBETTE, STEPHANIE, TREY, JUSTIN (A1's alternates), then NATHANIEL
(A2's), and so on: the alternates land at the far end, away from their own
track. Also, choosing a tab from "N more" pins it into the visible strip,
which can read A1 … A6, A15.

**Changes:**
1. One ordering rule, used by both views: "All voices" first, then people by
   the Avid track number of their mic (`physical_track_number`). A group
   alternate sits immediately after its own track (A1, A1's alternates, A2,
   A2's alternates), the order the AAF Audio timeline shows its lanes in
   (`visibleLanes`). A person with several mics takes the position of their
   lowest track. A tie (same track) keeps the AAF's order.
2. The "N more" menu lists the hidden tabs in the same order.
3. Each tab shows its track before the name ("A1 CARA"; an alternate shows
   its parent track), so the order can be seen at a glance.

**Done when:** a unit test on a grouped fixture gets A1, A1's alternates, A2
in that order from the shared rule, and fails if alternates go back to the
end (break-test it); an e2e test reads the tab labels left to right in AAF
Audio and in String Outs' source pane and finds them in track order.

**Done when (phase 3):** each 3a item has a test that fails without its fix;
3d's tests pass; the voice, control-naming, hit-target, tablist-overflow and
green contracts stay green; the docs in 3c.12 match the buttons.

---

## Phase 4: faster export

**Status: built** (October 3). Changes 1 to 3 are in the sidecar
(`writer.py` group packs, `write-edits`) and in Rust (`aaf_export_edit`
passes `scratch/aaf-packs`; `aaf_export_edits` and `exportEdits` for a
batch). Not built: building a pack in the background when a sequence opens
(the first export builds it), and the One per person button calling
`exportEdits`, which is UI work. Measured on HEAT 2, 3 bites, 23 tracks,
CPython 3.12.14 (the bundle's interpreter), each as its own process, fastest
of 3 on a loaded Mac (load average 10 to 25):

| Export option | Before (bundled) | No pack | First export, builds the pack | After |
|---|---|---|---|---|
| Keep picture groups | 13.9 s | 12.1 s | 10.6 s | 0.9 s |
| Keep all groups | 14.6 s | 11.9 s | 10.8 s | 1.1 s |
| Clip that plays | 2.2 s | 1.2 s | no pack | 1.2 s |

Files and objects copied are unchanged (31 MB and 3,474; 2.1 MB and 154).
A pack-based export holds the same 3,474 MobIDs as a full one, the pack is
exactly the group clip's closure, and V1 plays identically. All three as one
`write-edits` batch: 12.2 s with the pack built once, 2.5 s after.

**What was measured** (bundled sidecar, 3 bites, 23 tracks, HEAT 2):

| Export option | Time | File | Objects copied |
|---|---|---|---|
| Keep picture groups (default) | 14.0 s | 31 MB | 3,474 of 3,476 |
| Keep all groups | 13.8 s | 31 MB | 3,474 |
| Clip that plays | 2.8 s | 2.1 MB | 154 |

Under a profiler: copying mobs (`mob_closure`) is about half, the self-check
about a quarter, and cutting the bites themselves under 1%.

**Why:** HEAT 2's V1 is one group clip, a CompositionMob with 176 slots (99
sound, 77 picture) that refers to every clip in the show. The Edit Protocol
requires every mob a sequence refers to be in the file, whole, with its
original MobID. So keeping V1's group means carrying the entire show on every
export, whatever its length. The size is the spec's; the time is not.

**Changes:**

1. **A group pack per source.** The first time a grouped source is exported
   (or in the background once its sequence opens in String Outs), write the
   closure of each group mob V1 refers to into a cached AAF under `scratch/`,
   keyed by the source's fingerprint (size, mtime, head and tail hash, as
   `local_read.rs` does) and the writer version. An export that refers to a
   group copies the pack, opens it `rw`, and adds only the new
   CompositionMob, its markers and any mobs the pack lacks. Measured: adding
   a sequence to the 31 MB file in `rw` mode takes 0.1 s.
2. **A narrower self-check.** The pack is checked once when it is built. Each
   export then checks references only from the new sequence and the mobs it
   added, and keeps the frame-by-frame comparison unchanged.
3. **Batch export.** "One per person" exports every string out from one run
   of the sidecar, opening the source and the pack once.

**Done when:**
- The HEAT 2 3-bite default export takes under 3 s warm (from 14 s), every
  frame still matches, and the cold pack build is under 12 s.
- A `test_writer.py` case proves a pack-based export is identical, mob for
  mob, to a full one; break-test by dropping a mob from the pack.
- A changed source AAF (new mtime) rebuilds its pack instead of reusing it.

---

## Phase 5: hand tests in Media Composer

**Status:** written as HAND-TEST.md String Outs steps 19 to 23.

Add to `docs/HAND-TEST.md`, String Outs:

- Import a "Keep picture groups" export. Does the bin receive only the
  sequence, or every master clip and group clip in the show? (The file holds
  them all; Media Composer decides what it lists.)
- Phase 1: V at a parked playhead lands there; B overwrites without ripple.
- The open String Outs steps 5, 14, 16, 17 and 17a still stand.

---

## Later

**Send to Avid.** A Media Composer panel (Panel SDK, Media Composer 2024.12
and later) that receives a string out from Sauce Bunny on this Mac and puts
it in a bin as "‹sequence› SB.1", as Quickture's panel does. On 2026.8 and
later its sequence-creation API could make the splices inside Avid itself.
Needs Avid's developer program and an owner decision; Media Composer writes
the bin, so the "never write Avid bins" invariant holds.

**Editor habits not yet there**, each its own piece of work:
- Match Frame and Reverse Match Frame. `docs/TRANSCRIPT-EDITOR-UX.md`
  promises them on F and ⇧F, but the source pane is passed `match={null}`
  (`EditSourceHost.tsx:30`). Note F is also Avid's Clear Out (phase 2), so
  one of them needs another key.
- Ripple and roll trims at an edit point.
- Copy (C) and three-point edits from a record In and Out.
