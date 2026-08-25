# Sauce Bunny — QA Report

## 1. Verdict

**Not shippable as-is.** 37 defects survived adversarial verification across six surfaces; every one is backed by a reproduction against the real frontend, not by reading alone. **There are no data-loss defects** — nothing found deletes a user's media, transcript, or review file from disk. But ten defects break a task outright, and the single worst is in the app's primary verb: **typing a timecode into Mark in / Mark out corrupts the field on the very first keystroke and destroys a range that was already marked** (`src/App.tsx:781-812`). Typing `0` round-trips a full `00:00:00:00` into the controlled input, every later character appends, and retyping over a valid Mark out leaves `00:00:00:000:00:20:00`, kills the timeline selection band, and unmounts "Add to queue". Only paste-in-one-shot works, so there is no keyboard path to enter or edit a mark in a clip tool. Beyond that headline, three recurring root causes account for over half the list: a **capped render read against an uncapped model** (Home's shelf count, Home's selection order, Library's ⌘A), the **Library list branch never receiving what the grid branch gets** (folders, the Trash verb, correct type-ahead indices), and **layout collisions at or near the app's own declared 1100×700 minimum** (`src-tauri/tauri.conf.json:18`), where three separate controls are painted over, clipped off, or made inert.

## 1b. Fixed since this report

Eleven defects are closed, each with tests that fail against the old code
(every fix here was mutation-checked by reverting it and confirming the new
tests go red). Commits are on `main`.

| # | Defect | Commit |
|---|--------|--------|
| 1 | Typed timecodes corrupted Mark in / Mark out | `clip: a timecode typed by hand is the timecode that lands` |
| 2 | Peeking at a drawing discarded the one in progress | `review: peeking at a drawing is not a decision to discard your own` |
| 4 | List view hid every subfolder | `library: list view is a different spelling of the wall` |
| 7 | "Copy join code" painted over "Clear" | `room: Clear is the thing you hit when you click Clear` |
| 9 | Unique-session-name rule went stale after a session | `session: the unique-name rule stopped going stale mid-run` |
| 10 | Frames / web shelves unreachable by keyboard | `library: the Frames and web shelves have a keyboard route again` |
| 13 | ⌘A selected files the pane refused to draw | `library: selection runs over what was drawn, not what is known` |
| 16 | Shelf header counted 40, shelf drew 24 | same |
| 17 | ⌘/⇧-click dead on subfolder cards | same |
| 18 | List type-ahead offset by the folder count | `library: list view is a different spelling of the wall` |
| 22 | "Move to Trash" missing from list rows | same |

Three of these shared one root cause and were closed together, which is what
the "recurring root causes" note below is for. Defect 7 also exposed a guard
that measured a hand-written copy of the room header rather than the real one;
it now drives the real markup at the app's declared minimum window size.

## 2. Confirmed defects

*Recurring root causes are noted inline. Where several defects share one, fixing the cause clears them together.*

### Data-loss — none

No confirmed defect destroys a file on disk. Three come closest and are ranked accordingly below: the review draft-drawing discard (unsaved work, no undo), the comment line-break stripping (mutates a persisted review doc), and transcript history "Clear all" (one click, no confirm, no undo).

---

### Breaks a task (10)

**1. Typing a timecode into Mark in / Mark out corrupts the field and wipes an existing selection — Clip**
Repro: Import a 60s/25fps file, click Mark in, type `00:00:05:00` one character at a time.
Evidence: `src/App.tsx:781-789` writes `framesToTc(inFrames)` back into the field whenever marks change; `src/App.tsx:794-812` parses on every keystroke; `src/lib/timecode.ts:28-42` left-pads so bare `"0"` is a *valid* frame 0. Probe: `"0" → "00:00:00:00"` … final `"00:00:00:000:00:05:00"`, class `invalid`, readout `Full clip`. Retyping a valid out point: `band=1 → band=0`, `addQueue=1 → 0`.
Fix: Parse the field only on blur/Enter (or require 4 complete segments before committing), and never write back into an input the user is actively editing.

**2. Viewing another note's drawing throws away the drawing you are making — Review**
Repro: Draw a stroke on the monitor, then click the "✎ drawing" badge (or the plain timecode chip) on an existing comment.
Evidence: `src/App.tsx:5072` nulls `reviewDraft` and calls `clearDraftHistory()` in the same handler that pins the saved annotation; `src/App.tsx:3889` only routes the draft undo stack while draw mode is live, which that handler just turned off. Probe: inked pixels `812 → 0`; ⌘Z afterwards falls through to the app stack and *deletes the posted comment being looked at* (`Undid: add comment`).
Fix: Stash the draft on peek and restore it when draw mode re-enters; at minimum keep the draft undo stack routed so ⌘Z brings the stroke back instead of destroying a comment.

**3. Home's search reports "No matches" for cards that are on screen — Home**
Repro: With a web recent and a transcript on Home, type either one's exact title into "Search your library".
Evidence: `src/components/LibraryView.tsx:145` searches only `trees` (scanned roots); `recentSources` and `transcripts` are never consulted, and `:441` swaps the whole shelf area out for the empty result. Probe: `"Bear" → 0 results`, `"first-interview" → 0 results`, control `"clip-a" → 1`.
Fix: Search `recentSources` and `transcripts` alongside `trees`, or scope the placeholder/aria-label to what the field actually covers.

**4. List view hides every subfolder, so a folder of folders renders as a blank pane — Library**
Repro: Open a folder whose only content is another folder, then click "List view".
Evidence: `src/components/LibraryBrowserPane.tsx:279` maps `items` only; `folders` is rendered solely in the grid branch at `:199`, and the empty-state guard at `:179` is suppressed whenever folders exist. Probe: grid `folderTiles 1` → list `rows 0, folderTiles 0, statusbar absent, empty note absent`. Ordinary folders silently drop the folder from a "2 items" count.
Fix: Render `folders` in the list branch as rows (or flatten, as `FramesPane.tsx:170` deliberately does), so a view toggle cannot remove content.

**5. The second co-review session is silently dark and mute while every control says otherwise — Co-review**
Repro: Enable camera/mic, run a session, end it, press Start session again. (Or: skip devices on a fresh profile and start.)
Evidence: `src/App.tsx:4820-4821` reads `capture.choice`, not the live stream; `CoReviewLobby.tsx:73` releases the capture on session end and `:156-159` builds the strip summary from `cap.choice` alone; no `acquire()` call site is automatic. Probe: `self tile video els: 0` while `cam aria-label: Turn camera off`; the same tile renders the muted badge (derived from the real track) contradicting its own control.
Fix: Derive the bar and lobby-strip labels from live track state, and re-acquire on session start — the hook's own comment already states this invariant.

**6. A nested transcript folder gets the full project menu, and Rename targets a different directory — Transcripts**
Repro: File a transcript at `Transcripts/Marry Harry/Season 2/ep1.srt`, open ⌘5, use the "Season 2" heading's ⋯ → Rename project.
Evidence: `TranscriptReader.tsx:523` gates the menu on `isProjectFolder(g.folder)` (`transcript-projects.ts:54` returns true for any non-`YYYY-MM` key) while the drag path one line below at `:536` correctly gates on `moveTargets`. Probe: `rename_transcript_folder {folder:"Season 2"}` → addresses `<root>/Season 2`. With a real root-level "Season 2" the two headings *merge* and the unrelated directory is renamed.
Fix: Gate the project menu on the same `moveTargets` set the drag path already uses.

**7. In the room header, "Copy join code" is drawn over the presenter's "Clear" button — Co-review**
Repro: Host a session with a web source at 1100×800, click "Clear" in the source bar.
Evidence: `src/styles/room.css:767-793` (`.cp-room-source-bar` is `flex: 0 1 auto` with non-shrinking `> .btn`), rendered immediately before `.cp-room-head-actions` in `src/App.tsx:4449`. Probe: `elementFromPoint` at Clear's centre returns "Copy join code"; the click wrote the clipboard and left the source loaded. Clean only above ~1440px. The existing guard `e2e/room-head-spacing.spec.ts` passes because its synthetic header floor is 640px and the real one is 480px.
Fix: Let the source-bar *field* collapse to zero (or truncate the filename chip) before the buttons shrink — room.css's own comment already claims this.

**8. The queue drawer clips its primary "Export N clips" and its close button — Clip**
Repro: Drag the drawer's resize handle to its 320px floor, or just open Clip at 1280×800.
Evidence: `src/styles/queue-drawer.css:419-421` (nowrap flex, three `flex: 0 0 auto` ghosts) inside `overflow: hidden` (`:22`); floor `QueueDrawer.tsx:243`. Probe at 320px: Export visible 9px of 98, Hide panel 0 of 23, Pop out 0 of 24; document does not scroll. Persists across relaunch via `saucebunny.queueDrawerWidth`.
Fix: Wrap the foot row (or scroll the head strip) below ~420px; hidden-but-focusable buttons are also an a11y trap.

**9. The unique-session-name rule goes stale the moment a session ends — Co-review**
Repro: Run a session named "Rough cut", end it, press Start again on the restored name.
Evidence: `CoReviewLobby.tsx:112-120` seeds `takenTitles` from a one-shot `useEffect(..., [])`; the lobby is kept alive under `[hidden]` (`App.tsx:5092`) and never remounts; `use-co-review.ts:727` saves without notifying it. Probe: `DISK: ["Rough cut"]` but `warning 0, start disabled false` → second click gives `["Rough cut","Rough cut"]`. A reload against identical disk state blocks it correctly.
Fix: Re-read the index on session end (or add the just-saved title to `takenTitles` in the save path).

**10. The Frames and "From the web" shelves cannot be reached with the keyboard — Library**
Repro: Focus the folder tree, press ↑ from "All"; or Tab 45 times.
Evidence: `src/components/LibraryTree.tsx:246,261` hard-code `tabIndex={-1}` and render both rows outside the `rows` array that `buildRows`/`onKeyDown` navigate. `grep setShelf` shows the only setters are those two `onClick`s — no menu item, shortcut, or event reaches them. Probe: ArrowUp ×8 → `["All"]×8`; 80 Tab presses cycle a 21-stop ring four times without landing.
Fix: Include the two shelf rows in `rows` so the roving tabindex covers them.

---

### User-visible (18)

**11. Editing a comment silently deletes its line breaks — Review**
Repro: Post a two-line comment (Shift+Enter), click Edit, type one character, Save.
Evidence: `ReviewPanel.tsx:1756-1758` uses a single-line `<input>` (composer at `:1586` is a `<textarea>` that reserves Shift+Enter; `review.css:436` is `pre-wrap`). Probe: stored `"line one\nline two"` → `"line oneline two!"`, read from the persisted review doc.
Fix: Use a `<textarea>` for the edit and reply controls.

**12. "Clear all" wipes every transcript↔source link on one click, no confirm, no undo — Transcripts**
Repro: ⌘5 → open a transcript → Tools → Transcript history… → Clear all.
Evidence: `HistoryPopover.tsx:86-93` is a bare button → `TranscriptViewer.tsx:2395` `clearHistory()` → `transcript-history.ts:187` `safeWrite([])`. Probe: 0 dialogs, `history: []`, ⌘Z restores nothing; transcripts then open with "No source file is linked to this transcript". `SettingsModal.tsx:1934` gates the *cache* Clear all behind `confirm()` — for files that are regenerable by definition.
Fix: Arm the button (the app's existing convention) or make it undoable.

**13. ⌘A selects files the pane refused to draw, and the batch action runs on them — Library**
Repro: Point at a folder of 400 files, click a card, press ⌘A, press Transcribe.
Evidence: `LibraryBrowser.tsx:321` caps the render at `BROWSE_CAP = 300` while `:303-304` publish the uncapped `itemPaths` and `:365` calls `selectAll(itemPathsRef.current)`. Probe: statusbar "showing 300, 100 more not shown", selbar "400 selected", 300 cards highlighted, and Transcribe ran "1 of 400". The handler's own comment states the opposite rule.
Fix: Feed `itemPathsRef` from `shown`, not `items`. *(Same class as #16 and #19.)*

**14. A folder-only search hit wipes Home to a completely blank page — Home**
Repro: Search a folder name whose subtree holds no scannable media (a "Project Files" folder, a folder past scan depth).
Evidence: `LibraryView.tsx:443` gates the empty state on `folders.length + items.length === 0` while `:450` renders `results.items` only, so a folder-only hit satisfies neither branch. Probe: `cards 0, notes [], gridChildren 0` — the only thing left is the × button. Esc and × do restore Home.
Fix: Render folder hits, or fold `results.folders.length` out of the empty-state test.

**15. "Move to Trash" disappears from the context menu in List view — Library**
Repro: Right-click a file in Grid (menu ends with "Move to Trash…"), switch to List, right-click the same file.
Evidence: `LibraryBrowserPane.tsx:220-221` passes `onDelete` in the grid branch only; `LibraryListRow.tsx:10-31` has no such prop. Verified there is no fallback: no hover ⋯ on rows, no Delete key handler, no Trash button in `LibrarySelectionBar` as mounted (`LibraryBrowser.tsx:435-453`), nothing in `LibraryDetail`. View mode is a persisted pref, so the loss is permanent for list users.
Fix: Add `onDelete`/`deleteLabel` to `LibraryListRow` and pass it from the list branch.

**16. A shelf header counts 40 files but the shelf stops at 24 — Home**
Repro: Add a root of 40 playable files and read the number beside the shelf title.
Evidence: `LibraryView.tsx:378` passes `countLibraryItems(tree)` (recursive, uncapped) against `:389` `.slice(0, HOME_ROW_CAP)` with the cap at `:255`. Probe: `header 40 / cards 24`, no note, no "See all". The cap is deliberate; the undisclosed truncation is not — this same file discloses it for search at `:445`.
Fix: Show `min(count, cap)` plus a "See all in Library" tail card.

**17. ⌘-click and ⇧-click do nothing on any Home card in a subfolder — Home**
Repro: ⌘-click a card sourced from a subfolder; or ⌘-click card 1 and ⇧-click card 3 across it.
Evidence: `LibraryView.tsx:215` builds the selection order from root-level items only while `:389` renders `artFirst(collectLibraryItems(tree))` (all depths) and `:450` renders search hits; `library-selection.ts:55` returns state unchanged for an unknown path. Probe: `selected after cmd-click on intro.mp4: []`, and the shift range skips the card rendered between its endpoints. The memo's own comment at `:211-213` states the opposite intent.
Fix: Build `shownPaths` from the same expression the shelves and grid render.

**18. Type-ahead in list view jumps to the wrong file, offset by the subfolder count — Library**
Repro: In a folder with one subfolder, focus the first list row and press the initial of the second file.
Evidence: `LibraryBrowserPane.tsx:87-90` builds `names` as folders-then-items for *both* views while `:93` points the roving grid at `.cp-lib-lrow`, which the list branch renders for items only; `use-roving-grid.ts:110` indexes `names[i]` by element index. Probe: "v" no-op, "c" lands on `voice-memo.m4a`; control with zero folders is correct. The file's own comment at `:81-86` warns about exactly this.
Fix: Build `names` from the same list the active view actually renders.

**19. Queue drawer clips its close and Export buttons across the whole 1200–1349 window tier — Cross-cutting**
Repro: Open Clip at 1280×800 with the drawer at its default width.
Evidence: `src/styles/shell.css:752-754` caps the open drawer at `min(400px, 34vw)` while content needs 415px, inside `overflow: hidden`. Probe: Hide panel cut 12 of 23px, Export cut 15 of 104px, right edge at x=1287 on a 1280px window. Clean at 1100–1199 and 1350+. `e2e/min-window-size.spec.ts` pins 1100×700 and never sees this tier.
Fix: Raise the tier cap to fit the foot row's 415px min-content, or let the row wrap. *(Same CSS as #8.)*

**20. At 1100×700 the transcript header overflows its column and Download paints over the player panel — Transcripts**
Repro: Size to 1100×700, ⌘5, open any transcript (the follow-along player is open by default).
Evidence: `shell.css:123`/`:131` grid columns plus `transcript.css:28` `flex-shrink: 0`. Probe: main `w:368`, head `scrollWidth 400`, Download runs to x=771.9 against a stage starting at x=740; `elementFromPoint` returns the button, and clicking it opens its menu over the other panel. Picker at its permitted 520px maximum is far worse (main `w:148`).
Fix: Let `.cp-tx-head-actions` shrink or collapse to an overflow menu below a threshold.

**21. A filter chip makes a project holding transcripts report "0 transcripts / Nothing here yet" — Transcripts**
Repro: Expand a project with one transcript, click the "Speakers" or "Analyzed" chip.
Evidence: `transcript-organize.ts:133` `if (searching) return groups;` is the only guard in `withEmptyProjects`; chips never set `searching`. Probe: `"Marry Harry 1 transcript"` → `"0 transcripts"` + the empty-project invitation, hoisted *above* the bucket that holds the match. Search correctly suppresses the re-injection — same narrowing intent, opposite behaviour.
Fix: Extend the guard to any active filter, not just a query.

**22. The synthetic search-results heading is rendered as a real project with live actions — Transcripts**
Repro: ⌘5, type a query, click the ⋯ on the "N matches" heading.
Evidence: `transcript-organize.ts:93` keys the group `__results__`; `transcript-projects.ts:54` returns true for it; `TranscriptReader.tsx:523` passes that to `isProject`. Probe: Rename fires `rename_transcript_folder {folder:"__results__"}` and surfaces "Not found: __results__"; Delete says "This project holds 2 transcripts. Move them out first." (false, and disabled); Choose picture is enabled and writes nothing. The drag path was already fixed for this key at `:273-283`.
Fix: Exclude `__results__` in `isProjectFolder`, the same way `""` and `YYYY-MM` are.

**23. Home's search results are one Tab stop per card, with no arrow keys — Home**
Repro: Search a term matching many files, then Tab into the results.
Evidence: `LibraryView.tsx:448` renders a bare `role="list"` of cards using neither `LibraryRow`'s roving effect nor `useRovingGrid`. Probe: shelf `24 cards / 1 tab stop`; search grid `30 cards / 30 tab stops`, ArrowRight/Down/End all no-ops. Control: the same 30 files in the Library browser give `1 tab stop` and working arrows. Worst case is the 120-item search cap.
Fix: Wrap the search grid in `useRovingGrid`, as `LibraryBrowserPane.tsx:91` already does.

**24. "No open comments. All signed off." prints directly above an unresolved note — Review**
Repro: Open a stacked review (V1 + V2) where V1 has an unresolved note, click the "Open" filter.
Evidence: `ReviewPanel.tsx:1061` computes the hint from `visible`/`roots`; `:1098` renders `carried` outside `visible.map(...)`; counts at `:945` exclude `carried` by construction (`review.ts:749,820`). Probe: tabs `All 1 / Open 0 / Resolved 1` with Bo's unresolved note 95px below the hint, Resolve button working. It also leaks past the Resolved filter and past a no-match search.
Fix: Scope the copy ("No open comments on this cut") and run `carried` through the same filter/search pipeline.

**25. Exported markers use a colour the app never showed you — Review**
Repro: Pick the green swatch in the name gate, post a comment, export CSV or Resolve EDL.
Evidence: `src/lib/markers.ts:93` `colorHex: avatarColor(c.author)` (name hash) versus `reviewerColorFor(author, me)` used by `App.tsx:3928/3932`, `Timeline.tsx:210`, `ReviewPanel.tsx:132`. Probe: on-screen `rgb(52,211,153)`, CSV `Magenta`, EDL `ResolveColorPink`. The hash also collides — "Ada" and "Alex" both map to `#e879f9`.
Fix: Thread the reviewer colour into `buildMarkers`; markers.ts:46 already claims that is the field's meaning.

**26. A screening never records who was in the room — Co-review**
Repro: Host a 3-person session, end it, look at Past screenings.
Evidence: `src/lib/screening.ts:67` initialises `participants: []` and nothing anywhere writes to it (confirmed: `:52` type, `:67` init, `:158` read are the only hits). `ScreeningShelf.tsx:84-86` renders that as "0 people". Knock-on: `screeningIsWorthKeeping`'s `participants.length > 1` clause can never be true, so a peopled session with no source leaves no record at all.
Fix: Record the roster from `session:state` peers into `screeningRef` on join/leave.

**27. At 1100px the People panel locks to the avatar spine and the Expand button is inert — Co-review**
Repro: In a session, drag the window to 1100px and click "Expand the people panel".
Evidence: `room.css:319-325` `.cp-room .cp-people { width: 72px }` (specificity 0,2,0) outranks the base `.cp-people { width: 240px }` at `:175-184`, so React state cannot win; `PeoplePanel.tsx:119` hard-wires `aria-expanded` to that state. Probe: panel geometry byte-identical before and after the click — only the chevron transform changes; `aria-expanded` reads "true" while visibly collapsed.
Fix: Make the media query a default the explicit state can override, and derive `aria-expanded` from measured width.

**28. Shortcut recorder silently drops Ctrl and binds the bare key — Cross-cutting**
Repro: Settings → Shortcuts → "Toggle queue panel" → Record → press Control+K.
Evidence: `keybindings.ts:208-228` `eventToCombo` inspects `metaKey`/`altKey`/`shiftKey` only (verified — no `ctrlKey`); `KeybindingEditor.tsx:37-44` feeds the result straight to `assignBinding`. Probe: chip becomes "K", stored `{"queue.toggle":["k"]}`, Play/pause loses K, and bare K now toggles the drawer. Dropping Ctrl at *dispatch* is deliberate; substituting a binding at *record* is not.
Fix: Reject Ctrl-bearing events in the recorder with "Ctrl combos aren't supported on macOS."

**29. The recorder accepts Tab, producing a keyboard trap in Clip, Transcripts and Review — Cross-cutting**
Repro: Record a shortcut and press Tab (the natural key to leave the control).
Evidence: `KeybindingEditor.tsx:33-45` special-cases Escape only; `keybindings.ts` maps code `Tab` to token `tab`; `use-keyboard-shortcuts.ts:118-119` then `preventDefault()`s it in views that own a player. Probe: five Tab presses leave focus frozen on the view root in all three views; control run with defaults walks normally, and the Library (no player) is unaffected. Recoverable — ⌘, is global and Tab works inside the modal.
Fix: Reserve Tab (and Shift+Tab) in the recorder alongside Escape.

---

### Papercut (9)

**30. Bulk "Rename…" in the queue can produce two rows with the same filename — Clip**
Repro: With one Done row named "shot-1" and one queued row, use Rename… with base "shot".
Evidence: `use-clip-queue.ts:225-232` uses a bare counter with no `taken` set, while `:210-219` (single rename) builds one and bumps, commented "so Export All can't overwrite one file with another". Probe: `["shot-1" done, "shot-1" queued]`; the control via double-click rename gives `shot-1-2`. No data loss — `media.rs:2551` uniques the path — but the row and the written file then disagree.
Fix: Build the same `taken` set in `handleQueueRenameAll`.

**31. "New folder" with an existing name reports success and creates nothing — Library**
Repro: In a folder containing "Interviews", click New folder and type "Interviews".
Evidence: `LibraryBrowser.tsx:194-209` returns null (= success) on resolve; `system.rs:1290` documents `mkdir -p` semantics and `:1303` uses `create_dir_all`, which is Ok on an existing directory. Probe: no error, field closes, nothing appears. The Frames shelf refuses the identical gesture with "A folder named "Dupe" already exists."
Fix: Check `selectedNode.folders` before invoking — `LibraryBrowserBar.tsx:43-46` says rejecting is the caller's job.

**32. Clicking a search result clears the search you just typed — Review**
Repro: Open the magnifier, type a query, click a hit's timecode chip.
Evidence: `ReviewPanel.tsx:504` treats any click outside the search row as dismissal *and* resets the query. Probe: `1 row → 4 rows`, query gone. Broader than reported — clicking body text, Resolve, or Reply all lose it too, so you cannot act on a hit without retyping. Search is a toggle (`aria-pressed`, inline row), not a menu.
Fix: Exclude the comment list from the search dismissal, or drop the `setSearch("")`.

**33. The Markdown notes export drops the out-point of ranged comments — Review**
Repro: Post a comment with a time range, Export → Markdown.
Evidence: `src/lib/review.ts:1045` interpolates `secondsToHms(c.timeStart)` and never reads `c.timeEnd`. Probe: Markdown `- **[00:00:12]** hold this shot longer`; CSV, Avid, FCPXML and Resolve all carry the span. Five of six formats keep it.
Fix: Append `– {secondsToHms(c.timeEnd)}` when the range exists.

**34. A selection on Home cannot be cleared and cannot be used for anything — Home**
Repro: ⌘-click a card, press Escape, click empty space.
Evidence: `LibraryView.tsx:404` is the only key handler and only clears the search; `sel` is read once at `:243` and never passed to a verb; no `LibrarySelectionBar` or `useMarquee` in the file. Probe: selection survives Escape (even with focus on the handler's own node), a click on blank `.cp-lib-rows`, and a full round trip to the Library tab. Only exit is a plain click, which navigates away. Contrast `LibraryBrowser.tsx:381-385`.
Fix: Add the Escape/blank-click clear, and either mount a selection bar or drop the gesture.

**35. The in-session device popover is a `role="dialog"` that ignores Escape and outside clicks — Co-review**
Repro: In a session, click the gear, press Escape.
Evidence: `DevicePanel.tsx:36` declares the role and the file registers zero listeners (verified: 0 matches for `addEventListener`/`useDismiss`); `RoomControlBar.tsx:106` mounts it as bare state. Probe: Escape (focused inside), outside click, and the app's own `saucebunny:dismiss-popovers` broadcast all ignored; the control ShareDialog in the same bar with the same keypress closes both ways. ReactionPicker is identical.
Fix: Adopt `use-dismiss`; the parity ratchet misses this because the file registers nothing to match.

**36. The collapse chevron on the search-results heading does nothing — Transcripts**
Repro: Search in ⌘5, click the chevron labelled "Collapse 2 matches".
Evidence: `TranscriptReader.tsx:213` `if (folder === "__results__") return true;` short-circuits before consulting the choice map that `toggleGroup` (`:219-231`) writes. Probe: `rows 2 → 2`, `aria-expanded true → true`, and the key is still persisted to `readerFolds`. The component's own comment at `:203-205` claims there is no chevron on that group.
Fix: Suppress the chevron for `__results__`. *(Same root cause as #22.)*

**37. The command palette runs transport/marking commands from views with no player — Cross-cutting**
Repro: Import a file, ⌘1 to Home, ⌘K → "Mark out" → Enter.
Evidence: `use-keyboard-shortcuts.ts:118` gates playback-scoped actions on `VIEWS_WITH_A_PLAYER` (its comment names "silent state corruption from a screen that looks inert"), but `commands.ts:217` gates only on `hasSource` — `activeView` reaches `buildCommands` and is read only by the View group. Probe: `sourceMarks` gains `outFrames: 0`, view stays Home, no toast, Clip chrome is `[hidden]`. Bare `O` on Home is correctly ignored. Undoable if noticed.
Fix: Add `activeView` to the `disabled` predicate for playback-scoped commands.

## 3. What was checked and found sound

Beyond the failures above, these were exercised against the real frontend and behaved correctly:

- **Home.** The hero "Continue watching" card renders recents correctly from the same props the search cannot see; Escape and the × clear button both restore the shelves from any search state; the shelf rows themselves are a correct single-Tab-stop roving grid (24 cards, 1 stop, End jumps to the last card); search *does* reach items truncated out of a shelf; ⌘2 shows the full uncapped set with a correct "40 items · 40 MB" status line; a plain click on any card opens it.
- **Library.** Grid view renders folders and files correctly at every depth with working ⋯ and right-click menus (7 verbs including Trash); grid type-ahead is correct; tree ArrowUp/Down/Home/End navigate the roots and "All" correctly; the 300-item render cap and its "showing 300, 100 more not shown" status line are accurate; `e2e/library-trash.spec.ts` and `library-keyboard.spec.ts` pass; the Frames shelf correctly *refuses* a duplicate folder name with the right copy, and the Rust `scan_dir` correctly keeps empty readable subfolders.
- **Clip.** Pasting or filling a complete timecode in one shot sets marks correctly and draws the selection band; the queue exports, emits `clip-done`, retries failed rows, and reorders; single (double-click) rename correctly bumps against a `taken` set; `unique_output_path` and the `x-unique` header both prevent overwrite on collision; the toolbar's "Toggle side panel" and the palette's `queue.export` give second paths to the clipped controls.
- **Transcripts.** The picker groups by month bucket and by project; drag-and-drop correctly refuses both hazardous keys (`__results__` and nested-group keys carry no `data-drop`); the Move dialog's `moveTargets` guard works; clearing a search restores the normal headings with no phantom project; the row list, per-transcript flags, and the "N of M" header counter are accurate; `rename_transcript_folder` correctly returns `not_found` rather than renaming a non-existent path.
- **Review.** Posting, resolving, replying and undo all work; ⌘Z correctly undoes a posted comment with a toast; the name gate persists the reviewer identity and colour; the annotation canvas mounts and rasterises real strokes; five of six export formats (CSV, Avid, FCPXML, Resolve EDL, and the marker selection itself) carry in/out ranges correctly; the version stack hydrates from `Reviews/index.json` + the per-source doc and the carried-forward Resolve button works.
- **Co-review.** A host session enters the room from a real `session:state` payload; the People panel renders self and peer tiles with correct per-peer a11y controls ("Mute X for me", "Hide X's video for me"); the muted badge correctly derives from the live audio track; the screening *segments* (source, URL, title, watched) are recorded correctly to `~/Documents/Sauce Bunny/Screenings/`; ShareDialog closes on both Escape and backdrop click; the join-code copy works; `e2e/room-head-spacing.spec.ts` and `session-name-unique.spec.ts` pass on the paths they cover.
- **Cross-cutting.** Layout is clean at 1100–1199 and 1350+; Nunito Sans genuinely loads in the harness (so no measurement is a fallback-metrics artefact); the shortcut editor's per-row Reset and "Reset all shortcuts" both work and overrides survive reload; the palette's `disabled` predicates work for `hasSource`; the keyboard dispatch's `VIEWS_WITH_A_PLAYER` gate correctly ignores bare `O`/`I` outside player views; zero `pageerror`s were recorded in any probe across all six surfaces.

## 4. Refuted

**Fully knocked down — 1.**

- **"The side-panel open/closed preference is saved but never honoured; both panels re-open on every entry to Clip."** The behaviour reproduces exactly (`App.tsx:911` `if (v === "clip") { setSidebarOpen(true); setQueueOpen(true); }`), but it is a documented, shipped product decision, not a bug. `_design/clip-line-language-plan.md` §2 "Clip panels: open when you arrive" specifies it verbatim — including the implementation note to call the raw setters rather than the persisting wrapper, and the explicit disposition of the now-vestigial localStorage keys ("The persisted preference becomes session-scoped memory only; delete the localStorage reads or leave them as within-session defaults"). Commit `2cd0b40` is the change that added it. The tester's "never observable" is also wrong: the persisted values *are* applied to the keep-alive Clip subtree at boot and are simply superseded on arrival. Residual is two write-only localStorage keys — code tidiness, not a user-visible defect.

**Sub-claims knocked down inside otherwise-real defects** — these matter because they are the places the app looks worse than it is:

- **Library list view "completely unreachable" (#4).** Overstated. The "Show folder tree" button and the breadcrumb both survive collapsing the tree, so there is a recovery route. The defect is the silent drop and the un-annotated blank pane.
- **"New folder" evidence (#31).** The tester's "folder tiles unchanged" line is a harness artefact — `e2e/tauri-mock.ts:255-277` makes `scan_library_folder` a pure function of the path, so a *unique* name produced no new tile either. Verified against the real `scan_dir` instead, which does keep new empty folders. The silent-success half is decided entirely in the frontend and stands.
- **Nested-project "Delete project…" (#6).** Not a live hazard. A nested-key group always has ≥1 item and `ProjectMenu.tsx:150` disables the confirm button while items exist, so Delete is always blocked there. Only Rename is dangerous.
- **People panel spine hover and a11y (#27).** Two supporting claims refuted. The spine's hover/focus pop-over does *not* reveal names in the manually-collapsed case either (`room.css:303-317` only enlarges a live `<video>`), so hidden names in spine mode is the design on both paths. And the "Session participants" region is *not* empty to assistive tech — each remote peer exposes labelled Mute/Hide buttons naming them. What survives is only the inert Expand button and the mis-reported `aria-expanded`.
- **Room-header collision "a11y trap" (#7).** Not a trap: the Clear button stays focusable, so keyboard activation still works. Pointer users are the ones blocked. Also, `e2e/room-head-spacing.spec.ts` genuinely passes — its synthetic 640px header floor never reaches the real 480px in-room width.
- **Tab-shortcut "only route back is Reset" (#29).** Refuted. ⌘, is `global: true` and Tab still works inside the Settings modal, so Reset is reachable — a recoverable trap, not a dead end. The "every Tab also silently sets a mark-in" sub-claim was not reproduced (the probe ran with no source loaded).
- **Ctrl recorder "silently" (#28) and drawer "no way back" (#8).** Both mildly overstated: the chip and the note do display "K", and both clipped drawer actions have a second path (toolbar toggle, palette `queue.export`). The substitution and the clipping stand.
- **"All signed off" layout (#24).** Rendering carry-forward below the active version's list, and keeping counts per-version, are deliberate per `_design/review-versioning.md`. Only the unqualified copy and the search/filter leak are defects.
- **Transcript history "permanently" (#12) and the `__results__` fold key (#36).** The source link can be rebuilt one transcript at a time via "Import transcript…"; and the persisted `__results__` fold key is inert because the short-circuit always wins. Neither rescues its defect, but both narrow it.

## 5. Coverage gaps

Everything above was driven through Playwright against the Vite-served frontend with Tauri IPC mocked at `__TAURI_INTERNALS__` (`e2e/tauri-mock.ts`). That leaves whole layers untested. A human should check these by hand on a packaged build:

- **The packaged app itself.** Nothing here ran under WKWebView. Chromium and WKWebView differ on focus, `elementFromPoint`, scrollbar gutters, and CSS containment — every layout measurement in §2 (#8, #19, #20, #7, #27) should be re-measured in the real shell before or after a fix. `npm run verify:packaged` and `verify:bundle` cover the packaging invariants but not layout.
- **Real media decode.** The mediabunny/WebCodecs canvas path, the ProRes/10-bit `allowedOutputFormats` probe, the `canvasLooksBlank` backstop, and the ffmpeg transcode fallback were all bypassed — `probe_local_file` returned mock metadata. Nobody watched a frame render. Check ProRes 422 HQ and a 10-bit source play, scrub, and export.
- **Real sidecars.** yt-dlp, ffmpeg/ffprobe, whisper-cli, the Swift diarizer, and llama-server never ran. Transcription accuracy, the SRT re-basing by `+start_s` for mark-in sub-ranges, diarization speaker assignment, and JobRegistry cancellation are all unverified. In particular, defect #13 (⌘A over an uncapped set) was verified only up to the batch line "1 of 400" — nobody watched 400 real transcriptions actually run.
- **The MSE web-playback pipeline.** The loopback proxy, its capability token, the fMP4 remux, seek-anywhere via `?start=`, and the `onMediaError` → download-to-cache fallback were entirely mocked. Defects #7 and #26 involve a web source but only its metadata.
- **A real peer session.** All co-review findings (#5, #7, #9, #26, #27, #35) were produced by emitting `session:state` events locally. No iroh QUIC connection, no WebRTC mesh, no NAT traversal, no relay path, no file transfer, no BLAKE3 match, no rung ladder. Two machines are needed to confirm #5 in particular — whether a guest genuinely sees and hears nothing in a second session.
- **The floating side-panel window.** `?window=panel`, the `panel:request-state` mount handshake, the 4Hz `panel:playhead` heartbeat, and the localStorage reconciliation polls were not exercised beyond `e2e/panel-window.spec.ts`.
- **Filesystem side effects.** `move_to_trash`, `ensure_dir_exists`, `rename_transcript_folder`, and the atomic write-through in `review-store`/`cast-store` all resolved through the mock. Defect #6's worst case — renaming an unrelated real directory on a name collision — was reasoned from `library.rs:511` (`root.join(&folder)`) and reproduced only at the invoke boundary. **Confirm that one against a scratch Transcripts tree before shipping any fix**, since it is the only finding that can touch a directory the user did not point at.