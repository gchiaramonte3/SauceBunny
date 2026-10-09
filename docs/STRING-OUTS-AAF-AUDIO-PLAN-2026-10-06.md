# String Outs and AAF Audio: what to fix next (2026-10-06)

The plan after the record-side rebuild: layers, Neo's tools, three-point
editing, and stacked picture in the AAF. Findings come from reading the code,
and each one carries the file and line it rests on. The top four were checked
by hand before this was written.

It is ranked by what a story producer would notice first:

1. Does what I hear, and what Avid gets, match the timeline?
2. Does it feel like an editing timeline?
3. Is it fast on a real show?
4. Missing features.

Sizes: S is under a day, M is one or two days, L is longer.

---

## Progress (later the same evening)

**Done.** All tested; gates green: vitest 5034, cargo 1014, clippy, eslint, AAF writer 33.
- **1.1 and 1.2.** The AAF matches the timeline, and playback is the cut.
- **1.3.** No unsilencing onto a taken track.
- **1.5.** Strip Silence works by record track.
- **1.6.** Restore Line, Remove Lines, markers, and the A64 limit.
- **Section 2, String Outs.**
  - Match Frame (⇧F, and a button).
  - J-K-L shuttle.
  - Copy, cut and paste of clips.
  - Edge auto-scroll while dragging.
  - Lit track selectors.
- **Section 2, AAF Audio.**
  - Page follow.
  - Pinch and wheel zoom about the pointer, and swipe pan.
  - The ruler seeks.
  - ⌘= ⌘− ⇧Z, Home and End; ⇧I no longer marks.
  - The narrow-window header now applies.
  - The transcript follows playback, with ⇧-click to mark a line and ⌥-click
    to solo its mic.
- **Section 3.**
  - AAF Audio's frame store.
  - Indexed placeWords, seams and dead space, each checked against the old
    scan on 300 random edits.
  - A one-pass, cached clips-per-track.
  - Playback mutes indexed.
  - The undo log keeps its head in memory and diffs segments by id.
- **Section 4.** A re-exported AAF keeps its words (carry.rs).

**Still open:**
- **1.4, the same person on two tracks at once.** Needs a decision.
- **The record-track table** (names, lock, sync lock). Its saved format
  changes.
- **Clip gain and fades into the AAF.**
- **The yellow segment move.**
- **AAF Audio clip names.**
- **The word review mode.**
- **Owners by time range.**
- **Locators for Avid.**
- **"Open in String Outs" carrying more** than In and Out.

---

## Done in this pass (uncommitted, gates green)

- **Move and adjust clips with the Selection tool, as in Neo and Avid's Smart
  Tool** (`src/hooks/use-record-gestures.ts`).
  - The pointer shows what a press will take: grab over a clip, a trim cursor
    on its last 14 px, a roll cursor on the line between two clips.
  - The near pixels outside a clip with filler beside it now trim that clip.
    They used to seat a roller on the empty side, which refused.
  - A count beside the pointer shows frames moved, the track a move is going
    to, and where a trim stopped ("+12 frames, stopped at no more source
    media").
  - Trimmed edges snap to cuts and the playhead, as moved clips already did.
  - ⌥-drag copies a clip, as Media Composer's Option-drag does.
  - Esc drops a drag that is under way.
  - A drag redraws only when its frame count, track or ⌥ changes.
- **A clip dropped past the end lands where it was dropped**, with filler
  before it. Overwrite used to clamp it to the end (`edit-model.ts` overwrite).
- **No edit can silently take a person off another track any more.**
  - The model holds each person on ONE record track at a time: a segment's
    overrides and layers are keyed by person.
  - So overwriting Kara onto A2 over a stretch where her other line plays on A1
    used to take the A1 line away without a word. The same happened through
    trims, slides and moves.
  - All of them now refuse, saying who is already on which track
    (`doubledLane`, guarded in `edit-trim.ts` and `place()`).
  - A unit test pinned the old behaviour; it now checks the refusal.
- **Build ID bumped** (`2026-10-06-string-outs-cuts`) for the `cuts` field the
  saved document gained.

Not yet tried in the app: Avid was frontmost, so nothing was dragged for real.
The build is ready to relaunch.

---

## 1. What you hear, and what Avid gets (String Outs)

**1.1 Avid gets through edits the timeline does not draw (M).**
- `aaf-sidecar/writer.py:726-745` writes one source clip per segment per
  track. `append_piece` (560-578) merges only filler.
- A segment splits whenever ANY track is cut. So A1's continuous line arrives
  in Media Composer in pieces, with an edit at every place another track was
  cut.
- The timeline joins those pieces (`layerClips`), so String Outs and Avid
  disagree.
- **Fix:** extend the previous source clip when the next piece continues it:
  same mob, slot and angle, contiguous source, and no deliberate Add Edit in
  `cuts`. Then check on the Team Selection AAF in Media Composer.

**1.2 Playback is not the cut (S–M).**
- `edit-audio.ts:90,109` marks every segment start as a join. A person whose
  audio simply carries on through another track's cut is crossfaded with
  themselves, a small bump in level at every such point.
- `edit-audio.ts:245` divides the mix by the number of people who can be
  heard: about −26 dB with 20 people. It also gets quieter each time someone
  new is cut in. Avid does neither.
- The crossfade setting affects preview only; the AAF has hard cuts.
- **Fix:**
  - Fade only where a track's material changes, by the rule `placeWords`
    already uses.
  - Play at unity gain, with a limiter if it clips.
  - Label the crossfade "preview only".

**1.3 Two people can end up on one track (S–M).**
- To reproduce:
  1. Overwrite Jane onto A1. Harry is lifted there.
  2. Unsilence Harry's struck-through words (⇧⌫).
- `unliftOnTrack` (`edit-model.ts:1032`) puts Harry back without asking who
  holds A1.
- The timeline then draws one of them, playback plays both, and the export
  keeps "the first named", whose order can differ between TypeScript and Rust.
- **Fix:** one rule for who holds a track, used by restore, unlift and `tidy`,
  with the same tie-break in TS and Rust. Playback plays only `playersOf`.

**1.4 The same person on two tracks at once (M–L, a model change).**
- The guard above stops the silent loss. The capability is still missing:
  Kara at 10 s on A1 under Kara at 50 s on A2 cannot be built.
- **Fix:** key a segment's plays by record track rather than by person
  (`layer → {person, source, in}`), in `edit-model.ts`, `edit_doc.rs`, the
  export and playback.
- Worth doing only if producers layer one person over themselves. Your call.

**1.5 Strip Silence and Silence work per person, not per track (M).**
- `edit-strip-silence.ts:44-57` measures only a segment's own clip, so
  overwritten material is never stripped.
- Its track choice becomes "everyone who is ever on A1", so stripping A1 also
  strips those people where they sit on A3.
- Silences are stored by source range, so a line used twice is silenced in
  both places.
- **Fix:** build the targets from `playersOf` on the selected tracks, and store
  the results per segment, the way Lift already does.

**1.6 Smaller leftovers from "person = track" (S).**
- **Restore Line** (`restoreRange`, `edit-model.ts:958`) inserts a segment with
  no tracks or layers, so it brings back every mic.
- **Ask ▸ Remove Lines** (`edit-model.ts:1106`) counts overlapping words from
  people who are not in the clip as overtalk, so it silences when it should
  cut.
- **Markers** ripple by the segment's own source only.
- **64 tracks:** a 98-mic group can be patched onto A1 to A98, and the save then
  fails with an internal-sounding message. Refuse in `place()` instead.

---

## 2. Feels like an editing timeline

### String Outs

| What | Why it matters | Size |
|---|---|---|
| Match Frame (record clip → source, parked on the same frame) | The most-used Avid key after Mark In/Out. The jump-to code from Ask is reusable | S |
| Real J-K-L shuttle (speeds, reverse, K+J/L) | J only steps back 1 s here; AAF Audio already has Avid's speeds | M |
| Copy / paste clips, Replace, Extend Edit, Select In/Out | Neo has all four; String Outs has none | M |
| Saved record-track table: names, lock, sync lock, add/delete tracks | Tracks are derived (minimum four) and cannot be named or locked | M |
| Auto-scroll while dragging at the timeline's edge | Neo does it (`gestures/edge-scroll.ts`); here a drag stops at the window | S |
| Yellow segment move (extract and splice in) beside today's red one | Avid's other Smart Tool arrow | S |
| Clip gain and fades, written into the AAF | Neo has both; the writer drops automated gain today | L |
| Track headers closer to Avid: a bright track-selector colour, height per track | Today one global height, and a grey selector | S |

### AAF Audio

- **The view does not follow the playhead (M–L).**
  - No wheel or trackpad zoom at the pointer.
  - Zoom is relative to the sequence's length rather than a fixed scale.
  - The ruler has five labels, no ticks, and cannot be clicked.
  - In and Out cannot be dragged.
  - **Fix:** use String Outs' scale, ruler and playhead, so both pages move
    alike (`MultitrackTimeline.tsx:81-140`, `MultitrackZoom.tsx:5`).
- **One keymap for both pages (S–M).** Only the seven mark keys are shared and
  tested.
  - AAF Audio lacks T, M, A/S, ⌘= and ⌘-.
  - Home and End work only while a lane has focus.
  - Shift+I/O also mark in AAF Audio, but not in String Outs.
  - **Fix:** widen `mark-keys-contract` to the whole map.
- **Track headers (S).**
  - The header is 360 px at every window width. The narrow-window rule never
    applies (`multitrack.css:161` is overridden by `:230`).
  - The owner name is a live text field in every header, easy to edit by
    accident.
  - Clips carry no names.
- **The transcript list does not follow playback (S–M).** Its window of 200
  lines often does not hold the playing line.
  - ⇧-click (or T) on a line should mark it.
  - ⌥-click should solo that person's mic.

---

## 3. Fast on a real show

- **AAF Audio redraws the whole page on every animation frame (M).**
  - It re-renders every lane and up to 200 transcript lines.
  - It also serializes every clip in the sequence
    (`use-multitrack-audition.ts:30,51`).
  - String Outs fixed the same thing with its frame store, and went from about
    16 to 60 frames a second. Reuse it.
- **String Outs on big edits (M).**
  - `placeWords` checks every word in every segment, 4–5 times per delete.
  - `layerClips` runs per track × segment × mic on every render.
  - Dead-space search steps 0.05 s across a whole source.
  - **Fix:** index the words by source, and build every track's clips in one
    pass, cached by edit.
- **The undo log (M).**
  - Splitting a segment gives both halves new ids, so the stored patch for an
    edit near the start rewrites every later segment.
  - Each commit replays up to 99 patches and re-sends the whole history.
  - **Fix:** keep the left half's id, diff by id, and send only what changed.
- **AAF Audio transcription and bleed (M–L).**
  - The recognizer runs over the full length of every mic: 100 mics × 3 hours
    is 300 hours of audio. Skip what the level shows is inactive.
  - Default to "untranscribed only", and keep each window as it finishes.
  - Bleed and voice-check loops grow with the square of the word count, and
    the voice check stops at 100,000 words, so later mics never get one
    (`voices.rs:282`).
  - Waveforms load in track order, not with what is on screen first.

---

## 4. Workflow gaps

- **A re-exported AAF starts from nothing (L).** When the group is re-exported
  from Avid (a new day, a trim), transcripts, mic owners and bleed calls do
  not carry over (`store.rs:137,152` matches only path and file).
  - Carry each line across by the master clip and source position it came
    from, and transcribe only what is new.
  - This is the largest time saving on the list.
- **Open in String Outs carries In and Out only (S–M).** It should also bring:
  - the playhead;
  - the checked mics, as the source tracks to cut with;
  - the person tab;
  - "New string out from this range".
- **Uncertain words (M–L).** On the test sequence 65.8% of words came back
  "unsure", and no screen steps through them.
  - A review mode: next/previous, hear the word against the louder mic, one key
    for owner or bleed per word, and typed corrections kept as overrides.
- **One owner per mic for the whole day (M).** A lav swap is only a warning.
  - Owners by time range, split at a frame.
- **Locators for Avid (M).**
  - M with a comment, a marker list, and export as Avid markers.
  - "Export marked range as AAF".

---

## Suggested order

1. **1.1 and 1.2:** the AAF and playback match the timeline. This is "compile
   the audio correctly".
2. **1.3, 1.5, 1.6:** no edit can put the wrong person on a track or silence
   the wrong place.
3. **AAF Audio redraw, then String Outs indexing:** speed on real sequences.
4. **Match Frame, J-K-L, copy/paste, track table, edge auto-scroll:** the
   editing feel.
5. **Shared keymap and AAF Audio's timeline on String Outs' scale:** one way of
   moving through both pages.
6. **Re-exported AAF carry-over, then the word review mode:** the large
   workflow wins.

Separately:
- Several String Outs Playwright specs still describe the retired
  whole-sequence start. They cannot run on this Mac until Playwright's
  Chromium is downloaded.
- Nothing from this branch is committed yet.
