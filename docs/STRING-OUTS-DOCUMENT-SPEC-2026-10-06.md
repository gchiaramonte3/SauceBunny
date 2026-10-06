# String Outs as a document: a spec for a pick

Item 20 of the October 5 corrections ([UI-CORRECTIONS-2026-10-05.md](UI-CORRECTIONS-2026-10-05.md)).
The owner asked: "We need to make this more user-friendly, mainly like Descript."
Items 9, 13, 15 and 19 already made the editor quieter and faster. This spec
covers the larger direction and asks for a decision. It changes no code.

## Where String Outs is today

String Outs is the production build of the Transcript Editor plan's Phase 5
([TRANSCRIPT-EDITOR-PLAN.md](TRANSCRIPT-EDITOR-PLAN.md)). After the October 5
work (#22 to #25) it looks like this:

- **Two transcripts side by side.** The source sequence is on the left
  (`EditSourcePane`, with its own play button, scrub rail, timecode, person
  tabs and marks) and the string out is on the right (`EditRecordPane`). The
  pair is Avid's Source and Record. The owner asked for it on September 30
  ("Source and Record, as Avid does it" in the plan).
- **The record transcript already edits by text.**
  - Delete cuts the time on every track; Shift-Delete silences one speaker.
  - A removed line stays in place, struck through, until it is restored or
    the removed lines are hidden (#25).
  - A paragraph moves with ↑ and ↓ beside it, or ⌥↑ and ⌥↓. There is no drag.
- **A full magnetic timeline sits under both panes** (`EditLower`). It has a
  tool row, a Record/Source switch in its corner, every patched track with
  S/M/T and the patch panel, and it takes about a third of the height.
- **Ask, the Inspector and History** sit in a side panel.
- **The status line** sits under the record pane (#22).

**What does not change in any option here:**
- the edit model: segments on every track, mutes, gaps (`lib/edit-model`)
- the undo log
- AAF export
- the overtalk guard
- Ask
- Avid's marking keys (I, O, G, D, F, Q, W; `mark-keys-contract`)
- the patch panel's meaning

This spec is about layout and how you work, not the data.

## What "like Descript" means here

The idea taken is the general one, not anyone's screens: **the document is
the edit.** You read and edit one continuous text, and the media follows it.
Material is added by searching and inserting, not by working a second editor.
The timeline is there for timing and trims, below the text and smaller.

## The four changes, each on its own

Each change can be taken or left on its own. For each one: what it means,
what it costs and what could go wrong.

### 1. The record transcript is the editor

- **Mostly built already.** Text editing, struck-through removals and
  paragraph moves all exist.
- **What is new:**
  - Drag a paragraph, or a selected run of words, to reorder it. A drop line
    shows between paragraphs, and Escape cancels.
  - The ↑/↓ buttons stay as the keyboard and screen-reader route.
  - The `pointer drag` idiom already used for library rows applies (no
    HTML5 `draggable`; `native-drag-contract`).
  - Removed text can be shown struck through or hidden, as today.
- **Cost:** small. `moveParagraph` exists and keeps the running time exactly;
  this adds the gesture, and a word-run move built on the same model.
- **Risk:** a drag across a long document needs auto-scroll and must not
  start on a text selection. A word-run move is a new model operation and
  needs the unit tests that `moveParagraph` has.

### 2. The source is a library, not a second editor

- **What changes.** The left pane becomes a library:
  - the string out's sequences, with one search across all of them
  - results as lines (who, when, what was said)
  - the person tabs become filter chips over the results
  - click a result to hear it in place
  - V inserts it at the record caret, B adds it at the end (Avid's
    three-point keys: a line, or I/O on a line, is the source range)
- **What goes or shrinks:**
  - the source pane's transport, scrub rail and marks
  - the timeline's Source mode, which would move behind an Open sequence
    action in the library
- **Cost:** medium. Search, filtering and playback by line exist (Ask and
  the source pane use them). The new parts are the library panel and its
  insert actions; `spliceIn` and three-point insert already exist.
- **Risk: the biggest one in this spec.** It reverses the September 30
  choice. An editor who wants to scrub through a sequence end to end, the
  Avid way, loses the side-by-side view. Keeping a whole-sequence view one
  click away (Open sequence) is the mitigation, and only the owner can say
  whether that is enough.

### 3. The timeline follows the document

- **What changes.**
  - Collapsed by default to a short strip under the text, showing only the
    lanes that have sound in the string out, for timing and trims.
  - Expanding it brings back every track and the patch panel. Its height is
    remembered, as the dividers already are (#22).
- **Cost:** small. `EditSplits` and `usePaneWidth` already hold the
  height, so this is a default and a filter over lanes.
- **Risk:** the patch panel is how people are put on tracks. It has to stay
  reachable when the strip is collapsed (an Expand button in the strip's
  header).

### 4. One transport, one readout per monitor, no status prose

- **What changes.**
  - One play button and one timecode for whatever has focus: the string out,
    or a library result being heard.
  - The status line under the record moves into the Inspector, as a chip
    that opens it.
- **Cost:** small to medium. Playback already has one store (`frames`,
  #25), so this is mostly removing the source pane's copy, and it follows
  from change 2.
- **Risk:** with change 2 left out, two panes still play different things.
  The source pane would then keep its own button, and only the status prose
  goes.

## What to decide

1. **Which changes to take.** All four, or some of them.
2. **Whether the Avid Source/Record pair stays as a layout to switch to,**
   or goes for good.
3. **What the library searches.** The string out's own sequences, or every
   AAF Audio sequence (larger, slower, and it pulls in material nobody added).

**Recommendation:**
- **Take 1, 3 and 4.** They reshape what exists, cost little, and make the
  document the centre without taking anything away.
- **Prototype 2 before deciding on it,** with the Source/Record pair kept as
  a layout to switch to, because it undoes a choice made a week ago.
- **For question 3,** start with the string out's own sequences.

## The prototype

- **Where:** a whole-window design-catalog prototype,
  `/design-system.html?prototype=string-outs-document`, beside the Transcript
  Editor and Review full screen prototypes.
- **What it reuses:** the Transcript Editor prototype's tested model
  (`transcript-editor-model`: segments, cuts, moves) and its fixture.
- **What it shows:**
  - the document with drag to reorder
  - the library with search, person chips, hearing a line, and V or B to
    insert
  - the collapsed timeline strip
  - one transport
  - a switch to the Source/Record layout for comparison
- **Tests:** browser checks in `catalog.browser.ts`, each broken once to see
  it fail.
- **Size:** about one working session.

## Production, once picked

Each phase ships on its own, with component tests, an e2e spec and a
HAND-TEST entry:

1. **Reorder by dragging.** Paragraphs and word runs, auto-scroll, Escape
   cancels, ⌥↑/⌥↓ kept.
2. **The timeline strip.** Collapsed by default, lanes with sound, Expand,
   height remembered.
3. **One transport.** The status line moves into the Inspector.
4. **The library panel**, if picked. It sits behind a layout switch for one
   release, then becomes the default if it holds up in the owner's hands.

## Sources

- [TRANSCRIPT-EDITOR-UX.md](TRANSCRIPT-EDITOR-UX.md): the model, editing in
  the text, the approved layout.
- [TRANSCRIPT-EDITOR-PLAN.md](TRANSCRIPT-EDITOR-PLAN.md): "Source and Record,
  as Avid does it" (September 30) and Phase 5.
- [STRING-OUTS-SPEC-2026-10-03.md](STRING-OUTS-SPEC-2026-10-03.md): assembly,
  marks and naming.
