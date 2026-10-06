# October 5 notes: ordered plan, easiest first, UI first

**Source:** the owner's notes folder of October 5: fourteen annotated
screenshots (AAF Audio, String Outs, Transcripts, the String Outs tool row, a
sequence menu, Review in full screen), four Activity Monitor captures, an
open-files list, and two AAF Audio diagnostics exports (frontend build
`2026-10-05-hide-bleed`, a 50-track sequence, 7835 log lines each); then two
more notes the same evening: open AAF Audio and String Outs clear, and
redesign Review's full screen. They stay outside the repository because they
contain production names and paths; nothing below names a person, a show or a
sequence.

**How this is ordered.** Easiest to hardest, and at each level of effort the
change the owner can see comes before the one they cannot ("prioritize the UI
changes"). One item jumps the queue: **1** is a data-loss hazard found while
reading the Transcripts page, and it is a few lines.

**Status (2026-10-05):** items 1 to 8 are built (pull request A), 9, 12 and
13 (pull request B), 11 (pull request C), and 14 (pull request D). The rest
are taken one at a time in this order, each as its own pull request.

| # | Item | What it is | Effort | PR |
|---|---|---|---|---|
| 1 | The AAF Audio store is never a transcript project | fix, data loss | S | A |
| 2 | AAF Audio and String Outs open clear | UI | S | A |
| 3 | Transcripts: the reader counts AAF documents | UI | S | A |
| 4 | Counts read as English ("1 person", "1 track saved") | UI | S | A |
| 5 | The "!" on a track explains itself | UI | S | A |
| 6 | An offline AAF says so once, and Retry fits a Small lane | UI | S | A |
| 7 | Copy works: the Pipeline and a review link | fix | S | A |
| 8 | Network sockets at idle: diagnostics say whose they are | decision | S | A |
| 9 | String Outs: the tool row holds tools only | UI | S–M | B |
| 10 | One bleed-label pass after a run, not two | speed | S–M | F |
| 11 | Models download in Settings, never on a page | UI | M | C |
| 12 | "Add sequence…" is a short menu you can clear | UI | M | B |
| 13 | String Outs: dividers you can drag | UI | M | B |
| 14 | AAF Audio's Transcript panel says less | UI | M | D |
| 15 | String Outs: removed lines stop flooding the page | UI + speed | M–L | E |
| 16 | AAF Audio playback: windows kept, counted, never prepared twice | speed | M–L | F |
| 17 | Transcripts: organize AAF Audio documents like transcripts | UI + data | L | G |
| 18 | Review full screen, redesigned | UI | L | H |
| 19 | String Outs: playing does not redraw the whole editor | speed | L | E |
| 20 | String Outs as a document editor (the Descript direction) | design | XL | spec |

PR letters group items that touch the same files so each pull request can be
reviewed on its own; they are taken in the order of their first item.

---

## 1. The AAF Audio store is never a transcript project

**Found:** AAF Audio documents live in a fixed folder inside the default
transcript library, `Transcripts/Multitrack/` (`aaf/store.rs` `root`). The
Transcripts page lists every one-level folder as a project
(`list_transcript_folders`), so "Multitrack" was saved into `projects.json`,
offered under "Move to folder…", and shown as an empty project with Rename and
Delete whenever no AAF document was listed yet. **Renaming it moved every AAF
Audio document out of the store**: AAF Audio, String Outs and the assistants'
context (which name that folder) all lost them, and the store made a new empty
folder.

**Built:** the store folder is never listed, created, renamed, deleted or filed
into from the Transcripts page (`library.rs` `is_aaf_store`, compared without
case as APFS compares names); the reader's special case for it is gone.
`the_aaf_audio_store_is_never_a_transcript_project` (break-tested).

## 2. AAF Audio and String Outs open clear

**Seen:** AAF Audio opened on the last sequence, whose AAF was on a drive that
was not mounted: every lane said "Waveform unavailable" and the Pipeline filled
with "The original AAF is unavailable" before anyone had asked for anything.
"I want it to be default clear. Same thing with String Outs."

**Built:** neither page reopens anything by itself. AAF Audio opens on "Open a
sequence" (or the welcome, for someone who has never imported one) with Saved
sequences in its header; String Outs opens on its list with no tabs. What is
opened stays open while the app runs. `last-open.ts`, the remembered tabs and
the remembered document are gone; what older builds stored is ignored.
`e2e/aaf-open-clear.spec.ts`, `EditPage.test.tsx`.

## 3. Transcripts: the reader counts AAF documents

**Seen:** eight AAF Audio documents on the left, "Nothing to read yet." on the
right. **Built:** the hint counts AAF documents, so it reads "Pick a transcript
to read." The fuller organization of AAF documents is item 17.

## 4. Counts read as English

**Seen:** "Voices checked for 1 people." Also "1 tracks saved · 1 need timing
review" and "0 of 1 tracks saved". **Built:** `lib/plural.ts`, used at each.

## 5. The "!" on a track explains itself

**Seen:** an orange "!" beside a mic owner after a Whisper run. "I don't know
why… At the very least, I should be able to click on what the exclamation
point means."

**Found:** it means exactly one thing: **timing needs review**. The engine
(Whisper more often, Parakeet too) returned some passages with no time, a
zero-length or reversed time, or a time outside the audio it was given, and
those passages were saved off the timeline (`transcribe.rs` `parse_cues`). It is
not a failure, not a Whisper invention flag and not bleed. It was a hover title
only. Beside it: "No speech found" drew the same green check as success, and
the count included placeholder-only passages (`[BLANK_AUDIO]`) that the review
list hides, so a track could show "!" with nothing to review.

**Built** (`MultitrackTrackStatus.tsx`): every status glyph is a button that
opens a popover, anchored to it and portalled so the lane list cannot clip it.
For review: how many passages, why, that nothing is lost, and **Review N
passages** (the Transcript panel switches to that person and scrolls to them)
and **Transcript info**. "No speech found" has its own neutral glyph. Only
passages with words count, in the glyph, the panel and the run summary
(`passagesToReview`). Tests in `MultitrackTimeline.test.tsx`.

## 6. An offline AAF says so once, and Retry fits a Small lane

**Seen:** every lane of an offline sequence said "Waveform unavailable" with a
Retry button squashed under it, and the Pipeline logged one failure per lane.

**Built:** the lane note is one line, so the text and Retry fit a 30px Small
lane. When the original AAF itself cannot be read (`store::source_ready`
answers NotFound), the first answer stands for every lane: no more lanes are
asked, the lanes stay quiet, and the page says once "The original AAF can't be
read, so waveforms can't be drawn. Reconnect its drive, then Retry." Relinking
the AAF file itself is phase 4 of `RECONNECT-MEDIA-SPEC-2026-10-05.md`.

## 7. Copy works: the Pipeline and a review link

**Found:** the Pipeline's Copy built the report (several IPC calls) before
`navigator.clipboard.writeText`; WebKit allows a clipboard write only within
the click, so the write was refused ("The request is not allowed by the user
agent…", in the owner's log). The review grant's one-time **Copy link** had the
same shape (it asked Rust for the code first), on the only chance to copy that
link. Chromium keeps the window open across awaits, so the Playwright suite
never saw either.

**Built:** `lib/clipboard.ts` `copyText` starts the write in the click with a
`ClipboardItem` whose content is the promise. `clipboard-contract` parses every
clipboard write in the app and fails if anything is awaited before it in the
same function (break-tested on the old Copy link).

## 8. Network sockets at idle: diagnostics say whose they are

**Found:** the open-files list showed two UDP listeners on all interfaces and a
connection to n0's relay. They are iroh's, and iroh runs only while a
co-review session is open (`session_start` / `session_join`); review links and
grants keep nothing open. So a session was open, which is by design
(CLAUDE.md, co-review). The loopback port is the stream proxy, by design.
libndi loads on first use (Integrations, the NDI source picker) and stays
loaded, as macOS does with Objective-C libraries.

**Built:** the Pipeline's health report now says "Co-review session: none
open / hosting / joined", so the next report answers this without a question.

## 9. String Outs: the tool row holds tools only

**Seen:** the row under the panes. "This should be way more simplistic. I
should just see timeline tools, and that's it."

**Found** (`EditTimelineTools.tsx`, `EditTransport.tsx`): the row leads with Go
to start, Play, "RECORD 01:00:00:00 of 01:00:29:12" and "SOURCE <the whole
sequence name> <timecode>", then the tools, a status line, then View, Audio and
zoom. The RECORD readout repeats the record pane's own timecode exactly; the
source pane already has its own Play and timecode. The record pane has no Play.
The long name is what makes the row wrap below about 1,260px.

**Change:**
- Play and Go to start move into the record pane's header beside its timecode,
  mirroring the source pane.
- The RECORD and SOURCE readouts leave the row. (In Record mode the SOURCE
  readout showed the source timecode under the record playhead; that value
  returns with Match frame, where it belongs.)
- The status line leaves the row for a quiet line at the foot of the record
  pane, mirroring the source pane's footer.
- The row is then: edit tools · snap, follow, loop · previous/next edit ·
  View, Audio, zoom. `STRING-OUTS-SPEC-2026-10-03.md`'s lock on this row is
  updated to say so.

**Done when:** the e2e reads the record timecode from the record pane, the row
has no readout or status, and nothing wraps at 1100px.

**As built (B):** as above, with three details. The status line has no rule
above it: the source footer beside it wraps to two lines in a narrow pane, and
two rules at two heights looked like a mistake. Switching the timeline to
Source (the corner switch or ⇧T) shows the source pane if it was hidden, since
that is where the source's Play and timecode now are. `EditTransport` is gone.

## 10. One bleed-label pass after a run, not two

**Found:** `aaf_transcribe_track` emits `saucebunny:multitrack-changed` before
it returns. The event re-reads the document; the returned result then replaces
it locally, so the reread runs again (two `aaf_open` 60 ms apart), and the
ownership effect, keyed on the document object, runs `aaf_ownership` for each
(two of about 600 ms each in the owner's log). The backend has no claim, both
miss the cache (its stamp is the document's time, which the commit just
changed), and each answer is every non-owner word: 13.4 MB of JSON for a
20-mic sequence, sent to the page twice.

**Change:** the ownership effect keys on a content revision and keeps one load
in flight; `reconcile` does not retry for the result it was told about;
`ownership::resolve` takes a per-document claim, like `peaks::claim`, so a
second caller waits for the first and reads its cache. The answer leaves out
"unsure" words the page does not draw.

## 11. Models download in Settings, never on a page

**Seen:** "Parakeet Ultra does not download where everything else downloads in
the settings. You could download it on the frontend, and that should not
happen."

**Found:** AAF Audio's model picker downloads a missing Parakeet model inline
(`MultitrackModelPicker.tsx`, and the Regenerate dialog). Settings ▸
Transcription lists one hard-coded Parakeet row, v3, so Ultra cannot be seen
or deleted anywhere, and AAF Audio's "Open model settings" link leads to a page
that cannot install it. This was a choice in
`TRANSCRIPT-ACCURACY-SPEC-2026-10-04.md` that the owner has now reversed. Two
more downloads start from AAF Audio with no UI: the cast-names speller (~100
MB) and the voice model behind Check voices.

**Change:**
- Settings ▸ Transcription ▸ Parakeet lists every model in `PARAKEET_MODELS`
  with its size, a cancellable Download, an armed Delete and "In use".
- AAF Audio never downloads: a missing model says so, with **Download in
  Settings…**, which opens Settings on Transcription; the Regenerate dialog
  the same. AAF Audio re-checks installed models when Settings changes one.
- Next, separately: Settings rows for the speller and the voice model.

**Done when:** no `download_parakeet_model` call remains outside Settings
(`cancellable-download-contract` says so), and Ultra installs and deletes from
Settings.

**As built (C):** `ParakeetModelRows` in Settings ▸ Transcription ▸ Parakeet:
Ultra first and Recommended, then v3, each with Download, Cancel, an armed
Delete and Installed; only v3 offers Use as default and In use, because it is
what Clip and dictation run. Deleting v3 while it is in use falls back to
Whisper, as before. AAF Audio's picker marks a missing model "(not
downloaded)", and the workspace and the Regenerate dialog each say which
model is missing with **Download in Settings…**. Settings emits
`panel:parakeet-models-changed` after an install or a delete, and AAF Audio
checks again on it. The speller and voice-model rows are still to do.

## 12. "Add sequence…" is a short menu you can clear

**Seen:** the menu across the whole window with every sequence ever imported.
"I want to be able to clear this out from time to time. I like the shortcuts,
but it's too much, and also you should make it go more to the left."

**Found:** a native `<select>` (`EditAddSource.tsx`), so macOS draws it at the
control and as wide as the longest name, and nothing can remove an entry. It
reads the list once per mount.

**Change:**
- A button and a menu of our own (`useMenuKeys`, `useDismiss`), right-aligned
  under the button so it opens to the left, at most 420px wide: the sequence
  name, with its AAF and date small beneath and the full name as a tooltip.
- Newest first; the eight most recent show and a search field finds the rest.
- **Remove from list** (× and Delete) and **Clear list**: hides entries from
  Add sequence and Start from, deleting nothing. A hidden sequence returns by
  itself when it is saved again in AAF Audio (stored as the save time it was
  hidden at, under `saucebunny.stringOuts.hiddenSequences`).
- It refreshes when AAF Audio saves (`saucebunny:multitrack-changed`).

**As built (B):** without the search field. A text field inside an ARIA menu
either loses its letters to the menu's type-ahead or breaks the role, and with
Clear list the list stays short; the rest are behind **Show N more**. Both
pickers offer **Show N hidden sequences**, so nothing hidden is out of reach
(`lib/sequence-shelf.ts`, `EditAddSource`).

## 13. String Outs: dividers you can drag

**Seen:** "the center divider is not really movable."

**Found:** there is no divider: the panes are fixed widths. What reads as one
is a border and the active pane's outline, with the source text's scrollbar
against it, so grabbing "the divider" scrolls the source. Dividers existed in
the prototype; the UX doc still asks for them (`TRANSCRIPT-EDITOR-UX.md`).

**Change:** draggable, keyboard-operable handles between the side pane and the
source, the source and the record, and above the timeline (`usePaneWidth`,
`.cp-resize-handle`, as AAF Audio), persisted under `saucebunny.stringOuts.*`:
source 280–640px, side 260–480px, timeline 160px to 60% of the page;
double-click resets. The source scrollbar moves inside the pane's padding. The
dead `.cp-te.is-dragging` rule and orphaned divider comments go.

**As built (B):** `EditSplits`, on the shared `usePaneWidth`, which learned a
pane docked at the bottom (sized by height, Up grows it) and to start a drag
from the size as drawn. CSS keeps the record pane at least 360px wide: past
that the source gives way, and the side too at the narrowest windows. Nothing
is stored until a divider moves, so the timeline keeps its share of the page
until then, and Home or a double-click forgets the size again. A divider's
Home no longer also sends the playhead to the start.

## 14. AAF Audio's Transcript panel says less

**Seen:** "This UI is getting too busy… It's too verbose, and then also
underneath, it's just too much. You're writing way too much."

**Found:** between the tabs and the first line of transcript: a search field;
a "Search with AI" checkbox row; a bleed row made of a checkbox, a sentence and
a button (flush against the panel edge, unlike everything else); and two
paragraphs ("Generating… Each finished track appears here and is saved
locally." and "Timing review: 39 passages. The text is preserved without a
timeline position. Choose All voices to review everything."). Under the text:
a shoot-date disclosure, the format and Export, and three scope buttons.

**Change:** what is always true moves out of sight; what changes is a chip; each
explanation lives in its chip's popover.
- **Search row:** the field, with AI search as a toggle button at its end.
- **One status row, only when there is something to say:** "Bleed · 2 dimmed"
  (its popover holds Hide bleed, one sentence, Measure mics and Check voices);
  "39 to review" (jumps to the list, as item 5's popover does); "Generating 1 of
  3…" with Stop.
- **Footer, one row:** the format and **Export {person} ▾**, whose menu holds
  Selected, Entire transcript, Avid by mic and the shoot date.
- No sentence longer than a line stays on the panel.

**Done when:** at 1100×700 the first transcript line sits right under the
search row, every control is reachable by keyboard, and `no-bleed`,
`target-size` and `accessible-names` stay green.

**As built (D):** the search field carries AI search as a pressed-state
button at its end (Stop joins it while a search runs; Return searches, so the
Search button and the "Press Enter" line are gone). One chip row:
`MultitrackBleedChip` ("Bleed · 2 dimmed", "Bleed not measured", "Measuring
mics…"), whose popover holds Hide bleed, its one sentence, Measure mics and
Check voices; "N to review", which switches to All voices and scrolls to the
passages; and `MultitrackRunChip` ("2 of 3 tracks saved · 1 failed",
"Generating…"), which opens Transcript info. A bleed error stays visible
under the chips. The footer is one row: format, Export {person} and a chevron
(`MultitrackExportMore`) for Export selected, Entire transcript, Avid files
by mic or person, the SRT note and the shoot date. The three popovers, and
item 5's, share `AnchoredPopover`. `MultitrackBleedBar` and
`MultitrackRunInfo` are gone.

## 15. String Outs: removed lines stop flooding the page

**Seen:** one row per removed word, each with the speaker, "REMOVED", the
struck word and its own Restore. "This UI is getting a little bit noisy. Also,
it's very, very slow when everything is loaded up. The DOM is getting
clogged."

**Found:** "Removed lines" is on by default, and:
- everything before the first kept piece and after the last counts as removed
  for every patched mic (`edit-model.ts` `ghostLines`), so a 29-second string
  out of a half-hour sequence shows the rest of the sequence as removed;
- a line breaks at every change of track, so interleaved mics (bleed copies
  included) make one row per word, 11 DOM nodes each;
- the lines after the last kept piece are drawn outside the windowing, and with
  nothing kept yet all of them at once; `ghostsBetween` rescans them all for
  every paragraph drawn.

**Change:** only removals between kept pieces show; a removed passage is one
line per speaker turn with bleed copies left out; removed passages are laid
out inside the windowed pages and indexed once; and they read inline,
Descript-style: struck-through text in the flow with Restore on hover and in
the right-click menu. **Done when:** the scale e2e gains a partial string out
with Removed lines on and stays inside its DOM and time budgets.

## 16. AAF Audio playback: windows kept, counted, never prepared twice

**Found:** the owner's log has 348 `audio · Prepare` calls in about four
minutes, about 545 ms each, two at a time for ~50 lanes at the playhead's
5-second window and the next. Preparing every audible lane is by design
(muted and unsoloed lanes are skipped). What is not:
- leaving the page, any load (including reopening the same sequence), a relink
  and a media change all clear the in-memory windows, so returning re-prepares
  2 windows × every lane;
- Pause, a scrub and an eviction cancel renders in flight, and a cancelled
  render is thrown away, so the next request renders again;
- nothing claims a render in flight, so two requests for one lane and window
  both run ffmpeg;
- even a disk hit parses the whole document and fingerprints the AAF and every
  MXF the lane uses anywhere in the sequence;
- the WAV cache (`media/aaf/`, ~0.72 MB per lane-window) is never swept, not
  counted in Settings' cache sizes and not removed by Clear all cache (1.29 GB
  on the development Mac).

**Change:** a render runs to completion and lands in the cache even when the
listener has gone (only a new document cancels); one in-flight claim per lane
and window; the windows survive leaving the page; a disk hit checks the
window's own clips only, from a cached fingerprint; the cache is counted,
cleared with Clear all cache and swept oldest-first past a cap.

## 17. Transcripts: organize AAF Audio documents like transcripts

**Seen:** "I can't organize transcript AAFs in the folders. I can't
right-click to rename. There's a lot of logic that's missing on this page."

**Found:** the "AAF Audio" group is a separate, select-only list: no menu, no
drag, no multi-select, no sort, no saved fold state. AAF documents have no
display name (only the sequence name read from the AAF, which re-imports and
String Outs rely on), no command can rename, move or remove one, and they
cannot join Transcripts projects (folders on disk), because the store is flat
and addressed by id. The page and the sequence menus name a document two
different ways.

**Change:**
- **A title** in the AAF Audio document (an optional field, no schema bump, as
  DATA-MODEL's precedent), set by an async `aaf_rename` that emits
  `saucebunny:multitrack-changed`; the sequence name is never overwritten; one
  naming function prefers the title everywhere.
- **Projects by reference:** `projects.json` gains document ids per project and
  its own schema version, so an older build refuses it rather than dropping the
  list; AAF rows drag onto project headings.
- **Right-click:** Rename…, Move to project…, Open in AAF Audio, Open in String
  Outs, Reveal AAF in Finder, Remove from Transcripts (a hide by id).
- **The right pane** shows a summary: title, file, tracks, transcribed tracks,
  people, shoot date, duration and the two Open buttons.
- While here: dropping several selected transcripts moves all of them.

## 18. Review full screen, redesigned

**Seen:** a co-review session in full screen sharing an application window.
"Full screen view also looks like absolute dog shit here. Could use a major
redesign."

**Seen in the capture:** the shared picture fills well under half the window,
centred with wide empty margins; an empty timecode box floats above it; a line
of status prose ("Live · Timeline timecode unavailable · Playback controlled at
source") sits alone at the left; the controls huddle at the far right; the
presenter's camera tile, name, "PRESENTING" and "Hand raised" sit in the far
bottom-left corner; and the sidebar and top bar stay.

**Direction, to agree before building:**
- **The picture is the page:** it fills the window edge to edge at its aspect,
  with nothing above it but a thin title bar that fades while watching.
- **One control bar** over the bottom of the picture (auto-hiding): transport
  where the source has one, the session actions (mic, camera, share, draw,
  react, settings, exit full screen) grouped, and no status prose; "Live" is a
  chip, and "timecode unavailable" appears only when someone tries to use it.
- **People in a film strip** along one edge (collapsible), not a lone tile in a
  corner; the raised hand and the presenter are badges on the tiles.
- **No app chrome:** the nav rail and the session top bar hide in full screen
  and return on Escape.

Needs a clickable prototype in the design catalog first, then the owner's pick.

## 19. String Outs: playing does not redraw the whole editor

**Found:** playback publishes a new state object every animation frame
(`edit-audio.ts`) into state held by `EditEditor`, so every frame re-renders
the record text, the source text, the timeline and the Inspector, each redoing
full passes over the words. No Edit component is memoized; each commit repeats
`placeWords` three times; the timeline is not windowed, and each record header
carries a select of all 98 people.

**Change:** the playhead in a small store read with `useSyncExternalStore` only
by what draws it; `React.memo` on the heavy panes with stable callbacks;
placement and seams computed once per edit revision; the person picker's
options rendered on open. **Done when:** on the 146,018-word scale fixture a
playing frame costs under 4 ms of scripting, measured in the e2e.

## 20. String Outs as a document editor (the Descript direction)

"We need to make this more user-friendly, mainly like Descript." Items 9, 13,
15 and 19 make the editor quieter and faster. The larger direction, to agree
first:
- **The record transcript is the editor:** one continuous document of the
  string out; select words to cut, drag to reorder; removed text struck through
  in place or hidden.
- **The source is a library, not a second editor:** search and pick bites into
  the document; the person tabs become a filter.
- **The timeline follows the document,** below it and collapsed by default to
  the playing lanes, for trims and timing.
- **One transport, one readout per monitor, no status prose on screen.**

Needs: the owner's go-ahead on which of these to take, and a prototype first.
