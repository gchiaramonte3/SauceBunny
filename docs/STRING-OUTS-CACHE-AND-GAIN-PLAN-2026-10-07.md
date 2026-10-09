# String Outs: a words cache, and Avid's gain (2026-10-07)

Two problems the owner hit on "Twins Rivalry Before The Fall" (HEAT 1, 98 mics):

1. **Switching string-out tabs takes about 30 seconds of work every time.** The
   panel reads as busy while nobody is doing anything.
2. **Play is close to silent.** The audio is there, but much quieter than Avid.

**Status.** A1 and A2 are built (2026-10-07, asked for as "can we improve
performance?"): the document is parsed once per change for every mic's
words and for the bleed labels (`store::read_document`), String Outs opens
sequences lean (`aaf_open` with `transcripts: false`), and
`src/lib/edit-words-cache.ts` keeps what was read for the session. Measured
on HEAT 1 in a release build: 99 mics in 0.55 s cold, 0.35 s warm, against
about 200 ms a mic before. A3 and all of part B are **on hold (owner,
2026-10-07)** until asked for again. Sizes: S is under a day, M is one or
two days, L is longer.

---

## What was measured

**Tabs.** `EditWorkspace` is keyed by edit id (`EditPage.tsx:126`), so a tab
switch unmounts everything that tab had read. `useEditSources` then reads all
98 mics again, one at a time (`use-edit-sources.ts:194`).

- That is 901,138 words and 26 to 33 s per switch. One session made 573 mic
  reads, six full passes.
- **Each mic costs about 180 ms** because `aaf_speech` calls `store::load`
  (`aaf.rs:238`). That parses the whole AAF Audio document for every mic, and
  HEAT 1's document is **95 MB** of JSON (48 saved transcripts). On 2026-10-06,
  before the document grew, the same 98 mics read in 1.3 s.
- **`aaf_open` sends the entire 95 MB document to the page** on every open
  (`use-edit-sources.ts:169`), about 550 ms per open. String Outs reads only the
  manifest from it; nothing in String Outs reads `.transcripts`.
- **The page freezes once a second while words arrive.** Each publish turns
  every mic's speech back into words (100 to 130 ms). The source side then lays
  out every word again (`use-edit-source-side.ts:82`): 350 to 950 ms per
  publish, and one freeze of 1.1 s.
- **Words never refresh.** An open string out ignores
  `saucebunny:multitrack-changed`, so a transcript finished in AAF Audio does
  not reach it until the tab is reopened.

**Level.** Playback works: windows for tracks 14 and 16 were fetched on
schedule, and no error was raised. The trouble is the level.

- The raw lavs are low. The windows played at 10:54 peak at −20 to −34 dBFS and
  average −47 to −55 dBFS.
- In the source AAF, each person's group clip is wrapped in an **Audio Gain
  OperationGroup with a constant Amplitude**. That is Avid's **Clip Gain**:
  - +12.0 dB on DONNY (slot 14), and on Bombette, Emily, Joe, Mada, Prescilla,
    Spencer, Trey, Will and Yeremi;
  - +11.9 dB on GILIO (slot 16);
  - +4.0 dB on Kacy, +9.0 dB on Ven, +10.8 dB on Zachary.

  The gain wraps the Selector, so it applies to whichever angle plays on that
  track, alternates included.
- `graph.py:274-279` passes straight through it and only warns "Avid audio gain
  is not applied". AAF Audio and String Outs therefore play these people
  **about 12 dB quieter than Avid**.
- String Outs adds a fixed master volume of 0.8 (`use-edit-playback.ts:37`) and
  gives the editor no level control. `EditAudio.setTrackLevel` exists but
  nothing calls it.
- **Our export is already right.** "Twins Rivalry Before The Fall3.aaf" carries
  40 Audio Gain groups: 21 at +12.0 dB on A1 and 19 at +11.92 dB on A2, all
  ConstantValue. Avid plays the export correctly. Only our own playback is
  wrong.

---

## A. A cache, so a tab switch is instant

### A1. Parse the document once, not once per mic (S)

- **Cache what `aaf_speech` reads.** Give it a parsed-document cache keyed by
  document id and file stamp, the same pattern as `store::playback_document`
  (`store.rs:496`). Keep each track's cue inputs, not the whole document, so
  memory stays small. Cache each track's result against its overview file's
  stamp, so a waveform built later replaces it.
- **Add a lean open.** Add an `aaf_open` without transcripts (from
  `playback_document`) and use it in String Outs. Check every reader of
  `data.documents` first; today none needs transcripts.
- **Target:** the first open after launch reads 98 mics in about 2 s instead
  of about 30 s.

### A2. One words cache shared by every tab (M)

- **The cache.** A new module, `src/lib/edit-words-cache.ts`. Per AAF Audio
  document it holds the document's file stamp, the lean document, the bleed
  labels, and each mic's speech with its measured flag. It lives for the app
  session and holds at most four documents, least recently used out first,
  the same limit as the Rust playback cache.
- **Reading through it.** `useEditSources` asks the cache first, after one
  cheap stamp check per source. If the stamp matches, every mic is there and
  there are no backend calls; otherwise only what is missing is read, and the
  cache is filled as it goes. The waveform pass writes the measured speech it
  builds back into the cache.
- **Invalidation.**
  - Listen for `saucebunny:multitrack-changed` (`aaf.rs` and `transcribe.rs`
    already emit it on every document write) and drop that document's entries.
  - An open string out re-reads that source in the background and keeps the
    old words on screen until the new ones land. This also fixes the words
    never refreshing.
  - The stamp check covers a missed event, so stale words are never served.
- **Derived work.** Cache, by object identity (`WeakMap`), each mic's words, the
  merged list and the source side's placement. A remount then skips "Turning 98
  mics' speech into words" and "Placing the source's words" entirely.
- **Not built, on purpose: a disk cache.** After A1, a cold read is about 2 s,
  so speech kept across launches would cost invalidation risk for little gain.
  Revisit if a 300-mic show proves otherwise.
- **Target:** a tab switch does under 100 ms of work, and no publish holds the
  page for more than 100 ms. The Pipeline's existing "Read N words in" and
  "held the page" rows are the measure.

### A3. Each tab keeps its place (S)

Keep each open tab's playhead, zoom and scroll, so coming back lands where you
left it, as Avid keeps each sequence's position. Today a reopened tab starts at
frame 0.

---

## B. Avid's gain, following Neo

**Neo's model, read from `neo-main`; we rebuild it here rather than copy it.**
Neo's `docs/AUDIO_GAIN_AVID_PARITY_PLAN.md` quotes Avid's Help directly.

- **Clip Gain is per segment and constant.**
- **Each sound clip has a fader glyph** at its left edge, with a dB pill when
  the level is not 0. Clicking it opens a **mini fader**. Option-click resets to
  0. ⌥⇧↑ and ⌥⇧↓ nudge by 1 dB.
- **Range.** Dragging stops at +12 dB; typing reaches +36 dB, as Media Composer
  extends it. Anything over +12 is drawn **yellow**.
- **Volume automation (the rubber band) is a separate stage.** Both stages
  apply.
- **Waveforms are drawn at output level,** with clip gain included.

The Neo code behind this:

| Part | Neo file |
|---|---|
| Model | `rve/model/audio/audio-gain.ts`: `CLIP_GAIN_DRAG_MAX = 12`, `CLIP_GAIN_TYPED_MAX = 36`, step 1 dB, rounded to 0.1 dB |
| Glyph on the clip | `timeline/stage/draw/clip-detail.ts` |
| Mini fader | `timeline/components/clip-gain-popup.tsx` and `fns/clip-gain-fader.ts`: Enter commits and closes, Tab commits and stays open, Esc reverts, one undo per drag |
| Commands | `state/doc/edit/clip-gain.ts`: acts on the selection, or else on clips under the playhead; ⇧G sets clip gain In to Out |
| Waveforms | `timeline/stage/draw/waveform.ts` |

Neo has no AAF reading or writing, no pan and no track fader, so those parts
come from our own AAF code and are not ported.

### B1. Read Avid's gain from the AAF (M)

- **What is read.** In `graph.py`, an Audio Gain with a ConstantValue Amplitude
  becomes a `gain` (linear) on every audio piece under it. Nested gains
  multiply. Rust `AafClip` gains the field, with its ts-rs binding and the e2e
  mock shape.
- **What is not, yet.** An Audio Gain with a VaryingValue is Avid's volume
  automation. It keeps an explicit warning, "Avid volume automation is not
  applied yet", and its playback is phase 2. This show has none.
- **Documents imported before this.** Their manifests have no gain. Re-read the
  AAF once, keeping transcripts and labels. If the AAF has moved, playback stays
  raw and the existing warning stays. This touches the import and refresh path
  and is the riskiest step here; prove it on HEAT 1 first.
- **Pan stays out.** Every mic is played centred, as now. Avid's default pan
  alternates 0 and 32768 across tracks, and that encoding was not verified.

### B2. Play it, in AAF Audio and String Outs (M)

- **Playback.** `EditAudio` and `MultitrackAudio` multiply each voice by the
  source clip gain at its frame. A piece is split where the gain changes; with
  whole-clip gains that is rare.
- **What stays raw.** Windows on disk stay raw. Speech analysis, bleed labels
  and transcription keep reading raw mics, since they compare mics against each
  other.
- **Waveforms** in both views are drawn with the gain applied, as Avid's.
- **The AAF Audio faders** become an audition trim on top of Avid's level.
- **The warning goes.** "Avid audio gain is not applied" is removed wherever the
  gain is constant and now applied.
- **Proof.**
  - A unit test runs the voice plan for a +12 dB clip and checks the scheduled
    gain is 3.98.
  - In the app, Donny on the Twins string out sits about 12 dB louder.
  - The exported AAF still writes +12.0 and +11.92 dB.

### B3. Clip gain in String Outs, Neo-style (L)

- **Model.**
  - A record clip carries `gain?: { [person]: dB }` on its segment, as `layers`
    and `overrides` do. It is absent while the clip inherits Avid's value.
  - The value shown is the absolute Clip Gain, the number Avid shows, so Donny's
    clips read +12.0 dB. It is written to the export exactly, replacing the
    copied Amplitude.
  - Splitting, trimming and Stack Conversations keep the value on both halves.
  - Rust `edit_doc.rs` and `writer.py` gain the field. The schema version is
    stamped only when the field is used, the same rule as overrides.
  - The writer's self-check verifies each Amplitude, under the exact-or-fail
    rule.
- **UI**, rebuilt from Neo's behaviour in our CSS and tokens:
  - The glyph and dB pill on each sound clip on the record timeline, yellow
    over +12.
  - The mini fader on click: drag to +12, type to +36, Enter, Tab, Esc,
    Option-click for 0, the wheel stepping 1 dB as `MultitrackLevel` already
    does.
  - ⌥⇧↑ and ⌥⇧↓ for ±1 dB on the selected clips or the clips under the
    playhead.
  - "Clip gain…" in the clip menu, and ⇧G for Set Clip Gain In to Out. The keys
    look free; check them against `command-coverage-contract` and
    `mark-keys-contract` before binding.
  - View ▸ "Clip gain on sound clips", on by default as in Neo.
  - Each entry or drag is one undo step.
- **Not in this pass.** The rubber band (volume automation), Avid's relative
  "Adjust Pan/Vols" modal, and a track fader. Neo has no track fader either.

### B4. A listening level (S)

String Outs has no volume control and plays at a fixed 0.8. Add a speaker
button and slider beside the record timecode, as AAF Audio has. It is for
listening only and is never exported. Remember it per user (`saucebunny.`
namespace).

---

## Order

1. **A1, then B4.** About a day. Tab switches fall from about 30 s to about
   2 s, and the editor can turn playback up at once.
2. **B1 and B2.** Donny and Gilio play at Avid's level everywhere. This is the
   real fix for "I can't hear anything".
3. **A2 and A3.** Tab switches become instant and keep their place.
4. **B3.** Clip gain editing in String Outs.

Each step ends with the full gate (`npm run verify`). Before a DMG, it ends
with a check on the real HEAT 1 document: tab-switch timings from the Pipeline,
window levels measured as above, and the exported AAF's Amplitudes read back
with pyaaf2.

**Contracts this touches:**
- `ipc-surface` and `main-thread`, for the lean open, which must be async;
- `e2e-mock-shape`, for the `AafClip` gain field;
- `store-version`, if the manifest version moves;
- `voice`, for new copy;
- `command-coverage` and `mark-keys`, for the new keys.

## Decisions for the owner

1. **Apply Avid's gain in AAF Audio too**, not only String Outs. Recommended:
   yes, so both views sound like Avid.
2. **Show clip gain as Avid's absolute value** (+12.0 dB on Donny) rather than
   as a change from it. Recommended: absolute, because it is what Avid shows and
   what the export writes.
3. **Volume automation (the rubber band):** decided 2026-10-07, later. It is
   phase 2 and not part of B1 to B4; B1 keeps its explicit warning for it.
