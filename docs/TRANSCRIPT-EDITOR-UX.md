# Transcript Editor: UX spec and prototype

A new workspace where an editor cuts a scene by editing its transcript. Deleting
words removes that time from every speaker's track, the timeline closes up, and
the result goes back to Avid as a sequence that relinks to the same mic media.

This document is the design to approve **before** Phase 1 is built. It pairs
with a clickable prototype and with the research in
[AAF-ASSEMBLY-RESEARCH.md](AAF-ASSEMBLY-RESEARCH.md), which covers the AAF
round trip and the AI side.

## Try the prototype

```bash
npm run design:catalog
```

Then follow **Transcript Editor prototype ↗** in the catalog sidebar, or open
`/design-system.html?prototype=transcript-editor`. It is catalog-only: nothing
in it reaches the production build (`scripts/verify-design-catalog-build.mjs`
checks that).

**What is real:** the edit model. Every delete, speaker-only removal, move,
splice, restore, undo and redo changes the timeline exactly as it would in
Phase 1, and the text and the tracks are drawn from the same data.

**What is not:**
- The sources are generated, not recorded. There are three: an invented
  five-person kitchen scene (MG 3), a judges' table (MG 1) and a one-mic
  interview (ITM Rosa). All have computed word timings, drawn waveforms and
  some crosstalk.
- Play moves the playheads on a clock and makes no sound.
- Ask is scripted: a few intents answered in code, not a model.
- Nothing is saved, and Export is disabled.

### Things to try

1. **Double-click** a word in Dev's first line to select that line, then
   press **Delete** (⌫).
   - The time goes from every track and the timeline closes up.
   - The line stays in the text, struck through, marked **Removed**, with a
     **Restore** button.
   - The caret waits at the end of the line above; it does not jump into the
     next one.
2. Turn **Removed lines** off in the toolbar and the struck lines collapse to
   a **¦** mark. Turn it back on to restore any of them.
3. Select Wes's "the grill." and press Delete. Tamsin talks over it, so
   Wes's words are silenced on his track and nothing moves. **Cut for
   everyone** is offered as a second step.
4. **Shift-Delete** silences words on their speaker's track only. Nothing
   moves; the words dim and their waveform goes quiet.
5. **Option-↑ / Option-↓** (or the arrows on a paragraph's header) move a
   paragraph. Its clips move with it on every track.
6. Open **EP104 Judges Table** from the Library. It opens as a second source
   tab. Select a line there and press **V** to splice it into the edit at the
   caret. **F** finds the edit's selection in its source; **Shift-F** goes the
   other way.
7. **Drag a tab** (Ask, Inspector, a source) onto another panel's tabs, or
   use its **⋯** menu to move it or close it.
8. **Scrub:**
   - drag across the timeline ruler or lanes;
   - drag the rail at the top of the Edit or a Source;
   - hold **Option** and drag across the words themselves.
9. Press **Ask** (⌘K) and type `pull every line from @Ro`. Pick **@Rosa**,
   add `in @ITM`, and send. Six lines come back; **Add 6 Lines to the End**
   puts them in the edit, and ⌘Z takes them out.
10. Use the **gear** on the Edit or a Source to change its typeface, size and
    line spacing.
11. Resize the window down to 1100×700. The left panel folds into the Edit's
    tabs rather than vanishing.
12. Press **T** on a timeline track (beside S and M) to see its words over
    the waveform, where they are said. **View ▸ Text on every track** turns
    it on for all of them.
13. Timeline tools, from the keyboard or the icon row over the tracks:
    - **⌘B** cuts every track at the playhead;
    - **I** and **O** mark a range, then **Z** lifts it (the time stays,
      silent) or **X** extracts it (everything closes up);
    - **M** drops a marker, **A** and **S** jump between edit points;
    - **N** snap, **⌘L** loop, **⌘=** / **⌘−** / **⇧Z** zoom;
    - **T** marks the clip under the playhead.
    - Click a track number (A1, A2, …) to turn that track off, as with
      Avid's track selectors. The marked region then highlights only the
      tracks that are on, and Lift silences only those. ⌥-click turns on
      that track alone.
14. Press **Remove dead space** (the waveform icon). Dead air is marked
    across the lanes; click one to keep it, choose **Dead air** or
    **Tighten**, and **Remove** closes the rest up in one undo.
15. **⇧⌘N** (or **New edit** in the Library) starts an empty edit. Select
    lines in a source and press **Append** or **V** to build it.
16. Make three deletions, undo two, then make a different one. Open
    **History** (⌘Y): the two undone steps are still there under
    **2 undone**. Click one to go back to it, and ★ to pin a state with a
    name.

### What to approve

- The layout:
  - four panels of tabs over a full-width timeline;
  - any tab can be moved except the edit;
  - several sources can be open at once.
- Delete means "cut the time on every track"; Shift-Delete means "silence this
  speaker only".
- A deleted line stays visible, struck through, until it is restored or
  removed lines are hidden. The ruler marks the cut, and a line runs through
  every lane.
- Double-click selects a line; the caret stays put after a delete.
- Ask: @ mentions, cited lines, and changes that wait for Apply.
- Overtalk: a delete never cuts through someone else's words by default.
- Source/record: read-only source beside the edit, V to splice, F to match.
- How the timeline looks: one lane per speaker, in the speaker's colour,
  keeping the AAF's track numbers.

## The one model

The edit is an **ordered list of segments**. A segment is a range of source
time, and it plays on **every speaker's track at once**. Program time is the
running sum of segment lengths.

```
source  |---a---|xx|-----b-----|xxx|--c--|
edit    |---a---|-----b-----|--c--|          three segments, two cuts
lanes   A1 Rosa  ▇▇▇▇▇▇▇|▇▇▇▇▇▇▇▇▇▇▇|▇▇▇▇▇
        A2 Dev ▇▇▇▇▇▇|▇▇▇▇▇▇▇▇▇▇▇|▇▇▇▇▇     same boundaries on every lane
```

That is why the timeline is magnetic: removing a range closes up by
construction. A **gap** is a segment too (source `gap`): empty time on every
track, like Final Cut's gap clip or Avid's filler. Lift leaves one, and dead
space removal takes them out.
It is Media Composer's Extract with every sync lock on, Pro Tools' Shuffle
across all tracks, and Final Cut's Blade All on every edit. The failure that
magnetic timelines are criticised for (a connected clip that rides along a
ripple and drifts out of sync) cannot happen, because no track is ever
connected to another; they are all the storyline.

A **speaker-only removal** is the one exception, and it never ripples. It is a
**mute** on one track over a source range: silence on that track, time on
the other tracks untouched. Lift with only some track selectors on is the
same thing, over a marked range.

Rules the model enforces, and the prototype's tests pin
(`design-system/transcript-editor-model.test.ts`):

- A deletion keeps a little air (up to 120 ms) around the words it removes,
  and never reaches into a neighbouring word on any track.
- A word belongs to the segment its midpoint falls in, so an edit can never
  leave half a word showing in the text.
- A cut never breaks a paragraph. Paragraphs break on a change of speaker or a
  pause of more than 1.2 s.
- The same source can be used twice (a line spliced in again). Selections are
  per **appearance**, so deleting one copy leaves the other.
- An edit point is one of three kinds:
  - a **cut** skips source that plays nowhere else, and can be restored;
  - a **through edit** skips nothing;
  - a **jump** goes somewhere on purpose (a move or a splice). What it skips
    still plays elsewhere, so it has nothing to restore. Restoring a jump
    would play those words twice, which is why the prototype refuses.
- Moving a paragraph keeps the running time exactly.

Times are seconds in the prototype. Phase 1 works in frames and samples: every
cut lands on a frame boundary, because Avid cannot represent anything finer
(see "Edit on frames" below).

## Editing in the text

| Action | Keys | What happens |
|---|---|---|
| Place the caret | Click | The caret goes before the word, and the playhead moves to it |
| Select words | Drag, Shift-click, Shift-← → | Selection snaps to whole words |
| Select a line | Double-click | From the last full stop to the next, within the paragraph |
| Select a paragraph | Triple-click | |
| Scrub | ⌥-drag across words | The playhead follows the pointer; nothing is selected |
| Select all | ⌘A | |
| Delete for everyone | ⌫ or fn⌫ | Cuts the time on every track; the timeline closes up; the line stays struck through with Restore |
| Delete for one speaker | ⇧⌫ | Silences only those words on their track; nothing moves. Again restores |
| Correct text | Return, on one word | Edits the words only; the media never moves |
| Move a paragraph | ⌥↑ ⌥↓, or its header arrows | The paragraph's clips move on every track |
| Play / pause | Space | The current word lights up and the text follows it |
| Undo / redo | ⌘Z ⇧⌘Z | Undo names what it undoes ("Undo Delete 8 Words") |

- **The text is not a contenteditable.** The model owns the words, and the
  spans only draw them. Typing cannot change the media by accident, and
  VoiceOver reads a document with speaker headings rather than an editable
  field. An `aria-live` status line reports every edit.
- **A deleted line does not disappear.**
  - Descript and Riverside hide deletions by default, and research on both
    says that is how an editor loses track of what they did.
  - Here a deleted line stays where it was, struck through, labelled
    **Removed**, with a **Restore** button.
  - A cut inside a line shows its words inline with a small ↺.
  - **Restore** brings back exactly that line and nothing either side of it,
    so restoring one of three deleted lines leaves the other two cut.
  - Turning **Removed lines** off collapses them to a **¦** mark, which still
    names the seconds removed. The ruler marks every cut, and a line runs
    through every lane.
- **Deleting does not move you.** After a delete the caret sits at the end
  of the line you were on and the playhead stays at the cut. Nothing scrolls,
  and the next line is not selected; going there is a click (or a
  double-click, for the whole line).
- **Overtalk is never cut through by default.** On a magnetic timeline a
  cut takes the time from every track, so deleting words that someone
  else talks under would take their words down too. Instead the delete
  fills the selected words with silence on their own track and moves
  nothing, then offers **Cut for everyone** as a second, explicit step
  (Return keeps the silence; ⌘Z undoes either). The same rule holds for
  Ask's filler removal (a filler with overtalk under it is silenced, the
  rest close up) and for dead space (a stretch counts only when every mic
  is quiet, selected or not).
- **Pauses show as dots**, scaled to their length: • from 0.35 s, •• from
  0.8 s, ••• from 1.5 s.
- **Speakers come from the mic, not from diarisation.** Each paragraph's rule
  and each lane are drawn in that speaker's colour.

## Source and record

Each source is a tab: open as many as you need from the Library, and they
collect side by side in whichever panel holds sources. A source is
read-only. The edit is the record, and it can draw on several sources at
once. A paragraph from a different source than the one before it carries a
small badge naming it.

- **Every source has its own playhead**, with a play button, a scrub rail and
  its timecode. Clicking a word parks the source there. Space plays the panel
  that has focus, and only one thing plays at a time.
- Words already in the edit read at full strength; the rest are dimmed, so
  what the cut left out is visible at a glance. The footer counts them.
- **V** splices the source selection into the edit at the caret. **Add to
  end** appends it. Both are Avid's verbs, on Avid's key.
- **F** is Match Frame: it finds the edit's selection in the source.
  **⇧F** is Reverse Match Frame: it finds a source word in the edit, or says
  it is not used.
- Overwrite (B), Lift (Z) and Extract (X) on marked ranges are Phase 1 work,
  not in the prototype.

## Ask

A chat panel for talking to the footage. Its answers cite the lines they
come from, and anything that would change the edit waits for you to apply
it.

- **@ mentions choose what it reads.** Type @ for a menu of every source, every
  person and the edit itself (@Kitchen, @Judges, @ITM, @Rosa, @edit). Arrow
  keys and Return pick one; in a sent message the mentions show as chips.
- **Answers cite lines.** Every line in an answer shows its source and
  timecode. Clicking one opens that source's tab with the line selected.
- **Changes are proposals.** "Add 6 lines to the end" or "Remove 3 filler
  words" is a button. Applying it is one undo step, named after the request
  ("Undo Ask: Add 6 Lines to the End").
- **In this prototype** it answers four scripted intents: find a phrase, pull
  every line from a person, remove filler words, and summarize a source.
- **In the app** it sends the mentioned transcripts to local Qwen by default,
  or to Claude with the user's own key through the r135 opt-in path. The key
  stays in the Keychain and the call is made in Rust. Only what is mentioned
  is sent.

## Text settings

A gear on the Edit and on each Source sets that pane's typeface (Nunito
Sans, the app's face, by default; or Serif, which is macOS's own New York,
not a web font), size (11 to 24 pt) and line spacing (tight, normal or loose). It
shows a sample line as you change it. The panes are set separately, so the
source can stay compact while the edit reads large.

## The timeline

- One lane per speaker, keeping the imported AAF's **track numbers** (A1, A2,
  …). A lane is a track, not a view: that is what Avid will get back. Where a
  source has no mic for someone, their lane is empty (filler) for that clip.
- **Scrubbing follows the pointer.** Press anywhere on the ruler or a lane and
  drag. The playhead, the timecode, the lit word in the text and the "speaking
  now" names all move on every pointer move, not on release. Playback pauses
  while you hold and resumes where you let go. The Edit's scrub rail and
  ⌥-drag in the text do the same.
- Each clip is a segment, and each lane wears its speaker's colour: the same
  hue the text gives that person, so who is talking reads across the whole
  scene at a glance. A soloed lane lifts and the others go grey while
  anything is soloed. **View ▸ Speaker colours** off draws every lane the way
  AAF Audio does, in one violet. A lifted range draws flat, or as a low bed
  when **Audio ▸ Room tone in lifts** is on.
- **S, M and T** sit together on each track head at 18×16, one size down from
  AAF Audio's. **T** puts that track's words over its waveform where they are
  said, using AAF Audio's own layout (`src/lib/multitrack-text-layout.ts`):
  timed lines when they fit, passage counts when they do not. One change for
  the edit: a column holding a single line shows the line, not "1 passage".
- Every edit point has a marker on the ruler (a button that names it: "Cut at
  01:00:06:05, 4.79 s removed") and a line through every lane. A dashed line
  is a through edit. An amber tick on a lane means the cut clips one of that
  speaker's words, usually crosstalk.
- The selection shows as a band across every lane; a marked In to Out shows
  on the ruler and as a faint band across the lanes.
- Solo and Mute per lane are for listening only. They do not edit.
- **It never scrolls sideways on its own.** Zoom in, then pan with the slider.
  A Mac with a mouse attached always shows classic scroll bars, and a sideways
  bar across the tracks eats height and looks broken.
- Timecode is counted in frames from the start timecode. At 23.976, a second
  of media is not a second of timecode: adding 3,600 seconds and formatting
  lands 3.6 seconds short of 01:00:00:00, which is the bug the prototype's
  first draft had.

### Tools

One row of icons over the ruler. No heading and no sentence: it is obviously
a timeline, and an instruction in a toolbar is the thing no pro editor puts
there (research below). Each icon's tooltip names it and its key.

| Group | Tool | Key | Precedent |
|---|---|---|---|
| Actions | Add edit at playhead | ⌘B | FCP ⌘B, Premiere ⌘K (⌘K is the app's command palette) |
| | Mark in / Mark out | I / O | Every NLE |
| | Lift in to out, leave the gap | Z | Avid Z |
| | Extract in to out, close the gap | X | Avid X |
| | Add marker | M | Premiere, FCP, Resolve |
| Modes | Snap (edit points, markers, marks, word edges, within 8 px) | N | FCP, Resolve |
| | Follow playhead (turns the page when it runs off) | none | Premiere's page scroll |
| | Loop (in to out, else the whole edit) | ⌘L | Premiere, FCP |
| Navigate | Previous / next edit | A / S | Avid |
| View ▾ | Waveforms, Speaker colours, Text on every track, Track height S/M/L | | Resolve's View Options, FCP's Clip Appearance |
| Audio ▾ | Crossfade at cuts (off, 1, 2, 4 frames), Room tone in lifts | | Descript's room tone |
| | Zoom out / Fit / in | ⌘− / ⇧Z / ⌘= | FCP |

Cuts, lifts, extracts and markers are edits and go through the undo log;
marks, snap, follow, loop and zoom are view state. Left out on purpose: a
tool palette (one select-and-scrub mode is enough when the text does the
editing), linked selection (every clip already spans every lane) and
position lock.

### Edit on frames, fade in preview

- Avid edits audio on frame boundaries in a sequence, and AAF cannot express a
  subframe cut. So every cut snaps to a frame, and preview plays exactly what
  Avid will get.
- Where a cut lands (Phase 2): start from the word timings, search the pause
  between words (about ±60 ms) for the lowest energy across all tracks, then
  snap to the nearest frame that does not enter a word on any track.
- Preview puts a 10 ms equal-power crossfade on every join. Descript's 5 ms
  reads as abrupt; above 50 ms it blurs speech.
- The AAF gets hard cuts by default. An option writes 2-frame audio dissolves,
  but only where every track has a pause at least that long.

## Undo log

Every state the edit has been in is kept. That is the "massive undo log",
and it is deliberately more than any NLE does:

| | Levels | Survives quit | History list | Branches |
|---|---|---|---|---|
| Premiere | 32 by default | no | yes | no |
| Final Cut Pro | unlimited in a session | no (15-minute library backups) | no | no |
| Resolve | about 20 shown | no (live save + timed backups) | yes | no |
| Pro Tools, Logic | 32 / session | no | yes | no |
| Descript | version history | yes, in the cloud | yes | no |
| vim | 1000, `undofile` | yes | `:undolist` | yes (a tree) |
| **Sauce Bunny** | **every step** | **yes, on disk** | **yes** | **yes** |

(From search summaries of each vendor's docs; the vendors' own pages could
not be fetched from this session.)

**How it behaves.** It is a tree, like vim's, not a stack:

- Undo moves to the parent state, redo to the child you came from.
- A change after an undo starts a new branch. The undone steps are **not**
  thrown away: History shows them as "N undone" under the step they left
  from, and clicking one goes there.
- Jumping to any state records nothing and loses nothing; redo then retraces
  the path you jumped along.
- Rapid repeats of one action coalesce into one step (a paragraph nudged
  five times within 500 ms is one undo), as Yjs's UndoManager does.
- Any state can be pinned with a name ("Client cut v2"); a pinned state is
  never coalesced into.

The prototype holds this in memory (`design-system/transcript-editor-history.ts`,
pure and tested), because the catalog may not write to disk. The panel is
**History**, a dockable tab (⌘Y, or the clock beside undo and redo).

**In the app: a database.** SQLite through `rusqlite` (MIT, `bundled`, so no
system library), written only from Rust:

```sql
CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT);          -- schema_version
CREATE TABLE timelines(
  id TEXT PRIMARY KEY, title TEXT, source_key TEXT,            -- NFC path / fingerprint
  created_at INTEGER, head_state_id INTEGER);
CREATE TABLE states(                                           -- one row per step
  id INTEGER PRIMARY KEY, timeline_id TEXT NOT NULL REFERENCES timelines(id),
  parent_id INTEGER REFERENCES states(id),                     -- the tree
  created_at INTEGER NOT NULL, label TEXT NOT NULL,            -- "Delete 3 Words"
  op_json TEXT NOT NULL, inverse_json TEXT NOT NULL,
  origin TEXT NOT NULL DEFAULT 'local',                        -- local | peer:<id>
  session_id TEXT, pinned_name TEXT);
CREATE INDEX states_tl ON states(timeline_id, id);
CREATE INDEX states_parent ON states(parent_id);
CREATE TABLE checkpoints(                                      -- every 100 steps
  state_id INTEGER PRIMARY KEY REFERENCES states(id),
  doc_json TEXT NOT NULL, doc_hash TEXT NOT NULL);
```

- **Ops plus checkpoints, not a snapshot per step.** An op is about 200 bytes
  and an edit about 5 KB, so 100,000 steps come to roughly 25 MB, and
  reaching any state is "load the nearest checkpoint, replay at most 99 ops",
  well under a millisecond. A snapshot per step would be 500 MB.
- **Where: `app_data_dir()`, not `~/Documents`.** Documents is iCloud-synced
  for many users, a live SQLite file has `-wal` and `-shm` side files that
  iCloud can evict separately, and this project has already lost a git
  packfile, a DMG and the transcript scan to that eviction. The readable
  deliverable stays in Documents: a debounced atomic JSON of the current
  state, which is what a user copies or backs up.
- **Crash safety:** one writer connection, WAL, `synchronous=FULL` (edit
  rates make its cost invisible), `integrity_check` on open, a store-version
  guard like every other store (`store-version-contract`), and a flush on
  `pagehide` (`quit-flush-contract`).
- **Retention:** keep everything. Past about 200 MB, offer Compact History,
  which keeps every checkpoint and pinned state and thins old ops; it never
  runs on its own.
- **Co-review:** each step records its origin, so undo can mean "my last
  step" in a shared session, and redo follows Figma's rule (undo, copy, redo
  back leaves the document unchanged). This is the same problem
  `undo-redo-fidelity-contract` already pins for review notes.

## Panels

Four columns of tabs over a full-width timeline:

```
┌ toolbar ────────────────────────────────────────────────────────────┐
│ Library │ MG 3 · MG 1 │        Edit (record)        │ Inspector · Ask │
│         │             │                             │                 │
├─────────┴─────────────┴──── transport ──────────────┴─────────────────┤
│ timeline: ruler + one lane per speaker                                │
└───────────────────────────────────────────────────────────────────────┘
```

| Column | Min | Ideal | Max | Starts with |
|---|---|---|---|---|
| Left | 180 | 220 | 320 | Library |
| Source | 280 | 320 | 480 | MG 3 Kitchen (more sources open beside it) |
| Edit | 440 | fills | | Edit. Never collapses |
| Right | 240 | 270 | 360 | Inspector, Ask |
| Timeline | 160 | 264, or 30% of the window | 50% | Transport plus a ruler and one lane per speaker |

- **Panels are tabs, and tabs move.**
  - Drag a tab onto another column's tabs, or onto its body, and it moves
    there. A white bar shows where it will land.
  - Columns that are hidden show a drop target at the window edge while you
    drag.
  - Every tab also has a **⋯** menu: *Move to Left panel / Source panel /
    Edit panel / Right panel*, and *Close* for sources and Ask. With the
    keyboard, ⌥⌘← and ⌥⌘→ move the active tab and ⌘W closes it.
  - The one fixed tab is **Edit**, because its column is the one that fills
    the window.
  - The drag is pointer-based on purpose: an HTML5 drag starts a macOS drag
    session, which the app window would treat as a file being dropped
    (`native-drag-contract`).
- **Tab strips never scroll sideways.** What does not fit goes behind "N
  more". This reuses the production `TabOverflowMenu` and the fitting rule in
  `lib/tab-overflow`.
- **When space runs out, columns leave; they do not shrink into
  uselessness.**
  - The left column goes first, then the right, then the source.
  - A column that leaves **folds**: its tabs join the Edit's strip, in italics,
    so nothing it held becomes unreachable.
  - The edit's reading width never drops below about sixty characters.
- **The column you opened last wins.** Asking for one always shows it, and
  something else steps aside. The rules are pure functions with tests: the
  layout is `design-system/transcript-editor-layout.ts`, and the tabs are
  `design-system/transcript-editor-dock.ts`.
- **Dividers** are 1 px hairlines with a 10 px grab area. Drag them, or focus
  one and use the arrow keys (Shift for bigger steps, Home and End for the
  limits); double-click resets. They say so in their tooltip.
- **Toolbar:**
  - The left-panel toggle and the title lead; the right-panel toggle trails.
  - Undo and redo name what they will do.
  - ⌃⌘S toggles the left panel and ⌃⌘I the right, matching SwiftUI's
    `SidebarCommands` and `InspectorCommands`. ⌘K opens Ask.
- Nothing critical lives only in the timeline or at the bottom of the window,
  because people drag windows past the bottom of the screen. Every timeline
  action also has a key or an inspector button.

### SwiftUI-ready, and fine on older Macs

"SwiftUI compliant" here means two things. The window follows the macOS HIG
split-view conventions. And every pane maps onto a SwiftUI or AppKit container,
so a native version later is a port, not a redesign.

| Pane | SwiftUI | AppKit |
|---|---|---|
| Window | `WindowGroup.defaultSize`, `.windowResizability(.contentMinSize)` | `NSWindow.minSize` |
| Sidebar | `NavigationSplitView` sidebar with `List(selection:)` | Sidebar split item |
| A column's tabs | A custom tab strip over the active panel; which panel lives in which column is app state (the dock model ports as is) | A tabless `NSTabView` under a custom strip |
| Ask | `ScrollView` of messages over a `TextField(axis: .vertical)`, with the @ menu as a popover | `NSTableView` plus an `NSTextView` with completion |
| Top row over timeline | `VSplitView` | Vertical `NSSplitViewController` |
| Source and edit | `HSplitView` children, each an `NSTextView` representable | `NSTextView`, the edit one with a delegate that vetoes typing |
| Inspector | `.inspector` with `inspectorColumnWidth(min:ideal:max:)` | Inspector split item (270) |
| Timeline | A custom `Canvas` | A custom `NSView` |
| Toolbar | `.toolbar` with navigation and primary-action placements | `NSToolbar` |

The editable text has to be `NSTextView`. On macOS 14, SwiftUI's `TextEditor`
edits a plain string only: selection binding needs 15, and styled text needs
26.

**Older Macs.** The app's floor is macOS 14, which means WKWebView could be
anything from Safari 17.0 to 26.x. The prototype is built for 17.0, and was
audited against MDN's browser-compat-data rather than from memory:

| Used by | Feature | Safari since |
|---|---|---|
| Tab drag | Pointer capture | 13 |
| Tab drop target | `document.elementsFromPoint` | 11.1 |
| Tab strip overflow, timeline width | `ResizeObserver` | 13.1 |
| Tab strip | `Array.prototype.at` | 15.4 |
| Tab lookup | `CSS.escape` | 10.1 |
| Clip and selection tints | `color-mix()` | 16.2 |
| Focus rings | `:focus-visible` | 15.4 |
| Track rows | `display: contents` in grid | 11.1 |

The audit found one real break, and it was not in the tabs:
`text-decoration: line-through dotted var(--fg-4)` (a shorthand carrying a
style and a colour) is only supported from **Safari 26.2**. Before that
WebKit drops the whole declaration, so a removed word lost its strike-through
on every Mac short of the newest. Production had the same bug on one rule in
`ai.css`. Both now use the longhands, and `text-decoration-contract` fails
the build if a shorthand carries anything but the line again.

- No anchor positioning, `scrollbar-gutter`, View Transitions, `field-sizing`
  or `content-visibility`.
- `color-mix`, `:focus-within`, `display: contents` and grid are all in 17.0.
- The default window is 1680×1020 and the minimum 1100×700, matching
  `tauri.conf.json`. The prototype's browser test fits 1100×700 with no
  sideways overflow anywhere.
- An M1 Air at its default 1440×900 leaves about 800 px of height, and at
  "Larger Text" (1280×800) about 700. So the timeline defaults to 30% of the
  window rather than a fixed height.
- Scroll bars can always be visible (a mouse attached, or System Settings ▸
  Appearance). The text panes scroll vertically only, and the timeline never
  scrolls sideways.

## Design system

It follows [DESIGN.md](DESIGN.md) and the production stylesheet rules:

- **Colour:** tokens only.
  - Selection is the violet `--sel-fill`.
  - Emphasis, pressed toggles and the current word are brightness, not hue.
  - Green appears nowhere, because nothing here is a positive outcome or a
    live feed.
  - Warnings (a clipped word, crosstalk) use `--warning`.
  - Speaker colours are seven hues from `SPEAKER_SOLIDS`, in the text and on
    the timeline lanes. AAF Audio's single violet is a View option.
  - Menus reuse production's `cp-view-popover` / `cp-popover-item` (the
    monitor's View menu), opening upward over the timeline.
- **Type:** Nunito Sans everywhere, at the `--text-*` scale, including the
  edit's prose by default. An earlier draft set the prose in a serif web font
  the app never loads, so it fell back to Georgia; Serif is now a choice in
  the gear and uses the system's New York.
- **Copy:** labels are verbs or nouns, tooltips name the control and its key
  and nothing else (Apple HIG: "Be brief", 60 to 75 characters at most,
  "avoid repeating a control's name"), status messages report the result in
  one clause ("Deleted 3 words, 1.20 s."), and no row exists to explain
  another row. The timeline's "No edits yet. Delete words in the transcript
  and every track closes up." was the example that started this pass.
- **Controls:** buttons are the catalog's 26 px compact recipe, icon buttons
  are the transport's `cp-icon-btn`, and the Source | Edit switch is
  `cp-segmented`. Every class carries the `cp-` prefix. There are no inline
  styles except computed positions and colours.
- **Motion:** only the caret blinks, and it stops under Reduce Motion.

## Where it lives in the app

- **A new workspace: "Transcript Editor"**, in the nav rail after AAF Audio.
- **It opens from:**
  - an AAF Audio sequence ("Open in Transcript Editor" once its mics are
    transcribed);
  - a Library transcript (single-track, one speaker per diarised voice);
  - its own sidebar of saved edits.
- **String-outs are edits.** [AAF-ASSEMBLY-RESEARCH.md](AAF-ASSEMBLY-RESEARCH.md)
  proposed a "Transcript | String-outs" switch inside AAF Audio. This design
  replaces it: an edit that starts empty and is filled with **V** from the
  source *is* a string-out. And when AI assembly arrives, a request produces an
  edit to review here rather than a separate list.
- **The document** is the edit model plus its source reference, stored
  beside the sequence's transcripts under
  `~/Documents/Sauce Bunny/Transcripts/Multitrack/`. It follows the rules the
  other Documents stores follow: a schema version, refusing a newer file,
  atomic writes and a flush on quit.

## Build order

Superseded by [TRANSCRIPT-EDITOR-PLAN.md](TRANSCRIPT-EDITOR-PLAN.md), the
production plan (nine phases with gates, from the Avid round-trip proof to
release). The order below is kept for the reasoning it records.

- **Phase 0: prove the AAF round trip.** Unchanged, and it comes first, as
  asked.
  1. Turn the spike in `docs/research/aaf-stringout-spike/` into a sidecar
     command.
  2. Write a hand-made edit (three segments across five tracks) from a real
     group AAF.
  3. Run the Mac test plan: it relinks to NEXIS media, the track numbers
     survive, and every cut is on a frame.
- **Phase 1: the Transcript Editor, manual.** This prototype, hooked up.
  - **Word timings.** A prerequisite, because AAF cues are sentences today.
    whisper.cpp token timestamps are about ±0.5 s, so each word boundary is
    refined against its own mic's energy.
  - The edit model and its store; the workspace and panes; undo.
  - Edit-list playback of the ISOs from NEXIS, with 10 ms joins.
  - Source/record (V, B, F, ⇧F).
  - Export to Avid through the Phase 0 writer.
- **Phase 2: clean cuts.**
  - Cut placement: lowest energy in the pause, snapped to a frame.
  - The bleed check, and room tone for a speaker-only removal.
  - Pause tightening (threshold to target, previewed).
  - Filler words: delete, silence, or leave.
- **Phase 3: local AI assembly.** A request ("two minutes, open with Rosa")
  produces an edit, and a revision comes back as a diff you accept.
- **Phase 4: Claude and Ollama.** As in the research doc.

## Open questions

1. **Speaker-only removal:** export filler for the mixer to fill, or room tone
   baked in?
2. **Preview:** is snapping cuts to frames acceptable (you hear what Avid
   gets), or do you want sample accuracy while editing?
3. **Mix track:** should the production mix follow the edit, or be left out in
   favour of the ISOs?
4. **Dragging a paragraph:** Extract/Splice (everything closes up, as now) by
   default, or Lift/Overwrite?
5. **Bleed:** when a silenced word can still be heard on another lav, warn,
   or refuse the removal?
6. **Deletion granularity:** any word, or snap to phrase boundaries?
7. **Export layout:** keep the AAF's track numbers (as the prototype does), or
   re-lay tracks in speaker order? Write 2-frame dissolves by default?
8. **Undo database:** is `app_data_dir()` right for the log (safe from iCloud,
   but not in your backups of Documents unless Time Machine covers the whole
   disk), and is "keep everything, offer compaction past 200 MB" the right
   retention?
9. **Neo Main:** its timeline rules and track assignment were asked to be the
   baseline, but the repository is not reachable from this session. Push it
   (a private repo is fine) or have a session on the Mac summarise its
   timeline model, and this section gets revised against it.

## Known gaps in the prototype

- No audio, no waveform from real media, no persistence: the undo log and
  the panel layout are in memory and reset on reload.
- Ask is scripted, not a model, and cannot yet revise its own proposal.
- A tab cannot be dragged out into a floating window, and columns cannot be
  split top and bottom.
- Overwrite, trims at an edit point (ripple, roll, slip), pause tightening
  and J/L cuts are not drawn yet. Crossfade and room tone are drawn, not
  heard. Markers are program times and do not ride a later ripple edit
  except Extract.
- The waveform does not follow Solo and Mute; they only dim the lane.

## Sources

Most vendor sites blocked direct reads from this environment, so most of these
were read through search extracts; the research reports marked each claim
verified, reported or inferred.

**Text-based editing.**
- Descript:
  - [Deleting vs ignoring script text](https://help.descript.com/hc/en-us/articles/10164872017933-Deleting-vs-ignoring-script-text)
  - [Edit boundaries](https://help.descript.com/hc/en-us/articles/20952542722957-Edit-boundaries)
  - [Automatic microfades](https://help.descript.com/hc/en-us/articles/10249332124301-Automatic-microfades)
  - [Playback and navigation](https://help.descript.com/hc/en-us/articles/10164534109837-Playback-and-navigation)
  - [The wordbar](https://help.descript.com/hc/en-us/articles/10249346632717-The-wordbar)
  - [Correct your transcript](https://help.descript.com/hc/en-us/articles/10119613609229-Correct-your-transcript)
  - [Filler words](https://help.descript.com/hc/en-us/articles/10164806394509-Filler-words)
  - [Room tone](https://help.descript.com/hc/en-us/articles/10255967999757-Room-tone)
  - [Editing crosstalk](https://www.descript.com/blog/article/how-to-edit-out-crosstalk-in-your-podcast-and-when-to-leave-it-alone)
  - [Mic bleed in multitrack](https://medium.com/descript/how-descript-handles-mic-bleed-in-multitrack-recordings-233013e02ed4)
- Riverside:
  - [Show deleted text](https://support.riverside.fm/hc/en-us/articles/10513205586077-Show-deleted-text-in-the-transcript)
  - [Remove a word or phrase](https://support.riverside.com/hc/en-us/articles/14488573075741-Remove-a-word-or-phrase-from-the-recording)
  - [Remove silences](https://support.riverside.com/hc/en-us/articles/12245776523677-Remove-individual-silences-and-pauses)
- Premiere Pro:
  - [Text-based editing](https://www.redsharknews.com/all-you-need-to-know-about-adobe-premiere-pros-text-based-editing)
  - [Pauses in transcripts](https://helpx.adobe.com/premiere/desktop/edit-projects/edit-video-using-text-based-editing/detect-and-delete-pauses-in-transcripts.html)
- Other tools:
  - [Avid Media Composer 2025.12](https://www.avid.com/resource-center/whats-new-avid-media-composer-202512)
  - [Hindenburg: edit with words](https://hindenburg.com/hindenburg-pro-2-features/edit-with-words/)
  - [Reduct](https://help.reduct.video/en/articles/2653196-how-do-i-cut-video)
- Research:
  - Rubin et al., [Content-based tools for editing audio stories](http://vis-ucb-maneesh.stanford.edu/papers/audiostories/) (UIST 2013)
  - [VideoDiff](https://arxiv.org/abs/2502.10190) (CHI 2025)
  - [ChunkyEdit](https://dl.acm.org/doi/10.1145/3613904.3642667) (CHI 2024)

**Timelines and editing verbs.**
- Final Cut Pro:
  - [The magnetic timeline](https://support.apple.com/guide/final-cut-pro/intro-to-the-magnetic-timeline-verb8fcfc133/mac)
  - [Connected clips](https://support.apple.com/guide/final-cut-pro/connect-clips-ver7a77ef9e/mac)
  - [Blade All](https://support.apple.com/guide/final-cut-pro/cut-clips-in-two-ver4e30479/mac)
  - [Audio lanes](https://support.apple.com/guide/final-cut-pro/organize-the-timeline-with-audio-lanes-verb71cb913/mac)
- Avid Media Composer:
  - [Basic editing](https://support.emerson.edu/hc/en-us/articles/21709228732699-Basic-Editing-in-Avid)
  - [Sync locks and trimming](https://www.chrisnicholas.net/tutorials/avid/trimming.html)
  - [Patching](https://www.editvideofaster.com/patching-avid-media-composer/)
  - [Reverse Match Frame](https://kb.avid.com/pkb/articles/en_US/How_To/Reverse-Match-Frame-in-Media-Composer)
  - [Multicam](https://support.emerson.edu/hc/en-us/articles/21709344829083-Multicam-Editing-in-Avid)
  - [Quick transitions](https://screenlight.tv/blog/2014/10/16/avid-media-composer-quick-transitions)
- Premiere Pro: [Sync lock](https://helpx.adobe.com/premiere/desktop/edit-projects/change-clip-sequence/sync-lock-to-prevent-changes.html)
- Audition:
  - [Multitrack clips](https://helpx.adobe.com/audition/using/arranging-editing-multitrack-clips.html)
  - [Fades and mixing](https://helpx.adobe.com/audition/using/clip-volume-matching-fading-mixing.html)
- DaVinci Resolve: [The Cut page](https://www.blackmagicdesign.com/products/davinciresolve/cut)
- Hindenburg: [auto-fades](https://www.willyurman.com/teaching/handouts/Hindenburg_Journalist.pdf)
- Pro Tools AAF: [Pro Tools-friendly AAFs](https://www.forte-ai.com/blog/how-to-create-a-pro-tools-friendly-aaf-from-avid-media-composer)
- Word timing: [WhisperX](https://github.com/m-bain/whisperX)

**Panels and platform.**
- Apple HIG:
  - [Split views](https://developer.apple.com/design/human-interface-guidelines/split-views)
  - [Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars)
  - [Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars)
  - [Keyboards](https://developer.apple.com/design/human-interface-guidelines/keyboards)
- SwiftUI:
  - [`NavigationSplitView`](https://developer.apple.com/documentation/swiftui/navigationsplitview)
  - [`inspector`](https://developer.apple.com/documentation/swiftui/view/inspector(ispresented:content:))
  - [`HSplitView`](https://developer.apple.com/documentation/swiftui/hsplitview)
  - [TextKit 2 (WWDC22)](https://developer.apple.com/videos/play/wwdc2022/10090/)
- WebKit: [Safari 17.2 features](https://webkit.org/blog/14787/webkit-features-in-safari-17-2/); MDN browser-compat-data for the feature floor.
