# September 28 notes: phased plan

**Source:** the owner's annotated screenshots and two AAF Audio diagnostics
exports from a 99-mic, 3h39m AAF (396 MXFs on NEXIS), taken 7 minutes
apart. They are kept outside the repository because they contain production
names and paths.

Each phase has a goal and a way to tell it's done. **Status (2026-09-29):**
Phases 1, 3, 4 and 5 and parts 6a and 6b are implemented and wait on a hand
test (`docs/HAND-TEST.md`, String Outs steps 10, 11 and 16). Phase 2 needs
one sample file first. 6c is not started.

| Phase | Goal | Depends on |
|---|---|---|
| 1 | Waveforms stop running by themselves; String Outs stops waiting on them | — |
| 2 | Draw from Avid's waveform cache when Avid already has it | A matched `.awf` sample |
| 3 | AAF Audio layout corrections | — |
| 4 | String Outs layout corrections | Phase 1 for 4.5 |
| 5 | One in/out mark everywhere | — (touches Phase 3/4 files) |
| 6 | Faster builds when we do build (optional) | Phase 2 results |

---

## Phase 1: waveforms stop running by themselves

**Status:** implemented 2026-09-28, pending a run on NEXIS media. Decision
taken for the open question below: before a lane is measured, its words are
placed by length and Remove Dead Space is disabled with a note pointing at
View ▸ Waveforms.

**Goal:** opening a 99-mic AAF starts no audio decoding until someone asks
for waveforms, and String Outs shows its lanes and words without waiting on
any.

**What was measured:**
- Each track's overview decodes the whole sequence in 60-second windows: 223
  ffmpeg launches, ~115 s per track, one track at a time. That's about 3
  hours for 99 tracks.
- The Waveforms button only hides the drawing. The build still runs for every
  linked track, and the button defaults to on
  ([use-multitrack-document.ts](../src/hooks/use-multitrack-document.ts)
  `wanted`, [MultitrackWorkspace.tsx](../src/components/MultitrackWorkspace.tsx)
  `showWaveforms`).
- String Outs loads lanes one by one and awaits each lane's full overview,
  because its speech analysis is computed from those peaks
  ([use-edit-sources.ts](../src/hooks/use-edit-sources.ts)). Nothing renders
  until all lanes finish, so "Reading each microphone's words…" can sit there
  for hours.
- While builds ran, each 5-second audition window took 1.5–2.3 s to prepare.
  Transcription decodes slowed from ~515 ms to as much as 1.1 s.

**Work:**
1. **The Waveforms toggle gates the build**, not just the drawing. It defaults
   to off for linked media and is remembered per document (`saveViewState`
   already stores it). When on, build only visible tracks.
2. **String Outs renders from words first.** Lanes and transcript text appear
   as soon as transcripts are read. Peaks and speech analysis arrive later,
   lane by lane, and only from cache unless waveforms are on.
   *Decide:* what speech-derived features (audible ranges, room tone,
   crosstalk prompts) do before peaks exist?
3. **Playback outranks background work.** Audition and transcription windows
   don't queue behind an overview build.
4. **Cancel wording.** "Stopped; committed transcripts are retained" is logged
   for every cancelled AAF operation, including relink, audition and waveform
   builds ([diagnostics.rs](../src-tauri/src/commands/aaf/diagnostics.rs)).
   Say it only for transcription.

**Done when:** a fresh open of a 99-track AAF logs zero
`decode-linked-audio` launches until Waveforms is turned on; String Outs
shows its lanes within seconds; audition doesn't stall while a build runs.

## Phase 2: use Avid's waveform cache

**Goal:** with waveforms on, a clip Avid has already drawn is drawn from
Avid's cache, with no reads of its media.

The format, the evidence and the design are in
[AVID-WAVEFORM-CACHE.md](AVID-WAVEFORM-CACHE.md).

**Work:**
1. **Settle the key (blocking).** One matched sample: waveforms drawn in
   Media Composer for media we can also read.
2. **Reader.** Rust, read-only. Parse, index and validate `.awf` files, and
   tolerate a truncated tail. Test with synthetic fixtures.
3. **Location.** The user points at the Avid project once; read every seat's
   cache under `AvidSharedData`; remember the choice with the document's path
   mappings.
4. **Integration.** Fill the 256-sample overview from Avid's 256x level, clip
   by clip. Uncovered ranges stay undrawn unless the user asks to build them.
   The Pipeline log records where each overview came from.

**Done when:** on NEXIS, a sequence whose waveforms were drawn in Media
Composer shows its waveforms here with no MXF reads, and the diagnostics say
so.

## Phase 3: AAF Audio layout

**Status:** implemented 2026-09-28. Fit and Track size stay beside the zoom
slider. The timecode row is `I/O | timecode | TRT`, so the timecode stays
centred over Play; DESIGN.md's Multitrack timecode rule is updated to match.
The Generate bar no longer shares the transcript footer's grid row (that
shared row was the empty band); both footers still end on one line.

1. **TRT beside the timecode box, in the same style.** When both marks are
   set, also show the In→Out duration. Today the timecode is centred and TRT
   is small text at the far right.
2. **Remove the "1 soloed" readout** under TRT.
3. **Zoom slider.** Replace `[−] 1× [+] Fit` with a slider between a
   magnifier-minus and a magnifier-plus. *Decide:* do Fit and Track size stay?
4. **Spacing.** Give "Save Mic Owners as Cast" room below the media status
   box, and inset the media status box to line up with the title above it.
5. **Close the gap** below the Engine / Model / Generate row.
6. **Scroll wheel on the gain popover.** One step per wheel notch, reusing
   the fader's existing arrow-key steps. Trackpad scrolling is accumulated
   rather than applied per event. Scrolling over the popover must not scroll
   the track list behind it, which React's `onWheel` can't prevent (it is
   passive). Scope: only while the popover is open.

**Done when:** checked at the 1100×700 minimum and at a large window, and
`no-bleed`, `target-size` and `min-window-size` stay green.

## Phase 4: String Outs layout

**Status:** implemented 2026-09-28. The transport leads the tool row and the
row wraps below ~1,260px (the 1100px window) rather than overflowing. Undo and
redo were stacked because the toolbar group and the History panel shared the
class `.cp-te-history`; the group is now `.cp-te-undo`. Headers are
`fit-content(280px)`. Decision for 4.5: a string out with nothing cut in
shows a note over its lanes with **Add all of** each source.

1. **Move the RECORD / SOURCE line into the tools row** below it.
2. **Readable track names.** Headers currently cut names to one letter;
   they should size to the names or be resizable.
3. **Undo and redo side by side**, with hover states, instead of stacked.
4. **A new String Outs icon.** Today it's a fader glyph, like AAF Audio's.
5. **A brand-new string out** is zero length, so its timeline is empty even
   once loaded. *Decide:* what should it show before any bites are added?

**Done when:** checked at both window sizes, and names are readable on a
99-lane AAF.

## Phase 5: one in/out mark everywhere

**Status:** implemented 2026-09-28. `marks.css` holds the ruler versions
(`.cp-mark-range`, `.cp-mark.in/.out`); AAF Audio and String Outs use them,
including a lone In or Out, which neither drew before. No in-band timecode
is printed (the timecode in the old screenshot was a ruler tick). The lane
tints stay regions. `mark-shape-contract` guards it and is in CLAUDE.md's
register.

**Goal:** every timeline draws marks the way
[DESIGN.md](DESIGN.md) already specifies: a stem with a chevron wing
(`--mark-wing-l` / `--mark-wing-r`, the same shape as `IconMarkIn` /
`IconMarkOut`).

**Today:**
- Clip (`.cp-track-mark`, `.cp-track-selection`) and the Reader
  (`.cp-reader-pin`) use the canonical mark.
- AAF Audio (`.cp-multitrack-mark-range`) and String Outs
  (`.cp-te-tl-marked`) draw a violet band with plain edges. (The timecode
  seen inside AAF Audio's band was a ruler tick under it, not a label.)

**Work:** inventory every marked-range renderer, adopt the wings, and decide
whether the in-band timecode stays. Consider a contract test so that in/out
edges can only be drawn with `--mark-wing-*`.

## Phase 6 (optional): faster builds when we do build

**Status:** 6a and 6b implemented 2026-09-29, ahead of Phase 2 because
Phase 2 is waiting on a sample and these help whenever a waveform is built.
6c is not started. Speed on NEXIS is unmeasured; HAND-TEST step 10 records
the per-track time to compare with the ~115 s before.

- **6a (done).** One ffmpeg per clip, streaming PCM into the peaks, instead of
  one per 60-second window per clip: about 4 launches per track instead of
  223. Peaks are byte-identical to the per-minute build (a nightly test runs
  the real ffmpeg both ways), so existing caches stay valid.
- **6b (done).** Two builds at a time, frontend and native gate. Found on
  the way: builds and failures were keyed by media revision alone, which
  tracks with identical clips share, so one failed build could block every
  look-alike track. Now keyed by track and revision.
- **6c (not started).** Transcription reuses decoded audio, and Parakeet
  stops reloading its model for every 2-minute window. This changes how
  recognition input is prepared and needs a multi-window mode in the Swift
  sidecar, so it should be its own change, measured on NEXIS.

## Open decisions

1. ~~Phase 1: what speech-derived String Outs features do before peaks exist?~~
   Words by length; Remove Dead Space waits for measured mics.
2. ~~Phase 3: do Fit and Track size stay beside the zoom slider?~~ Both stay.
3. ~~Phase 4: what does a brand-new string out show?~~ A note over the lanes
   and **Add all of** each source.
4. ~~Phase 5: does AAF Audio keep a timecode label inside the marked range?~~
   There never was one; the text in the band was a ruler tick.
