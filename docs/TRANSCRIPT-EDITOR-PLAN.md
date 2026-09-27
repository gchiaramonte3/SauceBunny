# Transcript Editor and AAF round trip: production plan

This is the plan for taking the Transcript Editor prototype and the AAF
string-out spike to a shipped, production-ready feature. It supersedes the
"Build order" sections of [TRANSCRIPT-EDITOR-UX.md](TRANSCRIPT-EDITOR-UX.md)
and [AAF-ASSEMBLY-RESEARCH.md](AAF-ASSEMBLY-RESEARCH.md); those documents
still hold the reasoning, the research and the sources, and this one points
into them rather than repeating them.

## What "done" means

An editor on a reality show can:

1. **Open an Avid AAF** (a sequence or a group/multigroup export) and see
   every mic as a track, with **picture known but never shown**: the V
   tracks, their clips, tape names and timecode are read and kept, and no
   video is decoded or displayed.
2. **Relink** to the MXF media on NEXIS quickly and correctly, including
   OP-Atom `LegacySound` media, choosing between duplicate copies.
3. **Transcribe** each mic, with word timings good enough to cut on.
4. **Edit by text** on a magnetic, audio-first timeline: delete words,
   keep removed lines restorable, never cut through someone else's words by
   default, remove dead space, start from an empty timeline and build it
   from sources.
5. **Make string-outs automatically**: per character, per topic or from a
   request, as proposals the editor accepts, trims and reorders.
6. **Send the result back to Avid** as an AAF that imports with media
   online, keeps track numbers, keeps picture cuts and group clips, and puts
   every cut on a frame.
7. **Never lose work**: every step undoable across quits, with a history
   that keeps undone branches.

## Where it stands (PR #17)

| Area | State |
|---|---|
| AAF import, lanes, groups, relink, transcribe (AAF Audio) | Shipped on the branch |
| Native MXF identity reader (partition pack, 8 at a time) | Shipped on the branch |
| Range transcription, per-sequence mix and view memory | Shipped on the branch |
| AAF string-out writer | Spike (`docs/research/aaf-stringout-spike/`): approaches B and C put 0 of 680 frames wrong against fixtures; **not yet tried in Media Composer** |
| Transcript Editor | Clickable prototype in the design catalog: edit model, gaps, dead space, track selectors, tools, tabs, Ask, branching undo; 49 catalog browser tests, 21 model tests |
| Everything else in this plan | Not started |

## Invariants

These hold in every phase. Each gets a test (a contract where it is a
source-level rule, a unit or browser test where it is behaviour).

1. **Audio first, picture as metadata.** Video tracks are read and written;
   pixels are never decoded. No thumbnails, no video player in this
   feature.
2. **The app writes only AAF (and marker text).** It never writes, renames,
   deletes or locks Avid bins (`.avb`), media databases (`msmMMOB.mdb`,
   `msmFMID.pmr`) or media. Those are read-only inputs at most.
3. **One edit model.** The text, the timeline, playback, export and the undo
   log all read the same list of segments (source or gap), mutes, markers
   and track state. Nothing is derived twice.
4. **Overtalk is never cut through by default.** A delete whose time holds
   another speaker's words silences the selected words on their own track;
   rippling everyone is an explicit second step. The same applies to AI
   removals and to dead space (every mic must be quiet).
5. **Cuts land on frames.** Avid cannot express a subframe cut, so preview
   plays exactly what Avid will get.
6. **Relinking is by identity, never by name.** MobIDs and UMIDs, verified
   against the file's own header; filenames and tape names are hints.
7. **Local first.** Transcription, analysis and the default AI run on the
   Mac; Claude is the existing opt-in path with the user's own key.
8. **Nothing the user made lives only in memory.** The undo log is on disk
   from the first step, flushed on quit.

## Phases

Each phase ends in something usable, and each has a gate that must pass
before the next depends on it. Phases 1 and 2 can run alongside Phase 0.

```
0 Round-trip proof (Mac) ─────────────┐
1 Reader: picture + fixes ──┐         │
2 Media index (PMR) ────────┤         ▼
                            ├──► 3 Edit model + store ──► 5 Editor UI ──► 6 AAF export ──► 7 String-outs
4 Word timings + audio ─────┘                                                              │
                                                                                           ▼
                                                                                8 Release hardening
```

### Phase 0: prove the round trip in Media Composer

The one thing no amount of fixture testing can answer.

- **Build:** turn the spike's writer into a sidecar command
  (`aaf-sidecar` gains `write-stringout`), reached from a developer menu
  item. Keep the spike's verifier as the command's self-check.
- **Run on the Mac:** the test plan in AAF-ASSEMBLY-RESEARCH.md ("Mac test
  plan"), with a real group AAF and online media on NEXIS:
  `tools/group_report.py` first (read-only), then B and C imports.
- **Decide:** approach C (copy the group Selector, the group stays live) or
  B (point each bite at the speaker's master clip).
- **Gate:** Avid imports the file with media online, track numbers and
  frame rate intact, every cut on a frame, and (for C) the group clip still
  switchable. Written up in `docs/AAF-ROUNDTRIP-VERIFICATION.md` with the MC
  version.
- **Fallback if both fail:** Media Composer 2025.x added OTIO import; an
  OTIO file through the otio-aaf-adapter is the second route (it rebuilds
  its own mobs, so groups are lost). EDL is a last resort (tape name + TC,
  no groups).

### Phase 1: reader, with picture and two fixes

- **Fix `Legacy*` data definitions.** `graph.py` and `reader.py` compare
  `media_kind` to `sound`/`picture` only, so `LegacySound`/`LegacyPicture`
  slots would be dropped (the same class of bug that broke NEXIS relink).
- **Classify muted clips.** Avid writes a muted clip as a `Selector` whose
  selected item is `Filler` or a `ScopeReference`; today that surfaces as a
  phantom group branch. Treat it as "muted", not "group".
- **Picture as metadata.** For each V track, emit `picture_clips[]`: record
  range, clip name, master and file MobID, tape name, source timecode, and
  a descriptor summary (frame rate, stored size, compression). Timecode
  tracks become the record and source TC of the sequence.
- **UI:** one thumbnail-free V1 lane of named blocks in AAF Audio and the
  editor, so the editor can see where the picture cuts are.
- **Gate:** the 117 genuine AAFs from the OTIO and LibAAF sets parse with
  picture metadata, the muted-clip sample reads as muted, and no reader
  regression in the existing AAF tests.

### Phase 2: media index (relink at NEXIS scale)

- **Read `msmFMID.pmr` as a hint.** It maps MXF filename to file MobID per
  `Avid MediaFiles/MXF/<n>` folder. Write a clean-room Rust reader (about
  200 lines) from real sample files, validated against the native header
  reader. `msmMMOB.mdb` is not needed (no filenames, and it keeps deleted
  media).
  - Versions: 8-byte OMF IDs up to v7, 32-byte UMIDs in v8, an optional
    v16 UTF-8 section, and both byte orders.
  - Do **not** copy code from MediaMuster (no licence; its layout came from
    disassembly). pymdb (MIT) is a reference for the MDB only.
- **Staleness:** trust a record only when the file's mtime matches the one
  recorded and the folder is not newer than the PMR; otherwise, or on any
  parse doubt, fall back to the header scan. Every binding is still verified
  by reading the file's own header.
- **Extend the native header reader** with picture descriptors (CDCI,
  RGBA) and the timecode component, so picture media relinks by the same
  path as audio.
- **Gate:** relink of the 495-source NEXIS sequence in under 10 seconds warm
  (it was 116 s before PR #17), zero wrong bindings, and a clean fallback
  with the PMR deleted, truncated or stale. A fuzz test on the PMR parser.

### Phase 3: the edit model and its store

The prototype's model, made real.

- **Rust types** (with ts-rs bindings): `Segment = Source{source, in, out} |
  Gap{frames}`, `Mute{source, track, in, out}`, markers, track selectors,
  per-track mix. Frames and samples, not seconds. The prototype's rules
  and its 21 model tests port as Rust tests: ripple, air around cuts,
  midpoint ownership, restore into a gap, lift on selected tracks, dead
  space, Mark Clip.
- **Undo log in SQLite** (`rusqlite`, MIT, `bundled`) at
  `app_data_dir()/timelines.sqlite`, **not** in iCloud-synced Documents.
  The schema is in TRANSCRIPT-EDITOR-UX.md ("Undo log"): states as a tree
  (`parent_id`), ops plus inverse ops, a checkpoint every 100 steps,
  labels, pins, origin. WAL, `synchronous=FULL`, `integrity_check` on open.
- **Readable deliverable:** a debounced atomic JSON of the current edit in
  `~/Documents/Sauce Bunny/Edits/`, with the store-version guard and a
  `pagehide` flush, like every other Documents store.
- **Gate:** 100,000 steps under 50 MB, any state reached in under 5 ms,
  kill-the-app tests lose nothing but the in-flight step, and the
  store-version and quit-flush contracts cover the new store. Build ID
  bumped.

### Phase 4: word timings and audio analysis

Everything that cuts on words needs this first.

- **Word timings.** whisper.cpp token times are about ±0.5 s; refine each
  word boundary against its own mic's energy. Target ±20 ms, measured on a
  hand-labelled clip.
- **Per-mic analysis**, computed once per source and cached: RMS in 10 ms
  windows, a rolling noise floor (15th percentile over 60 s blocks, because
  lavs move between rooms), open/close hysteresis (floor +12 dB open, +8 dB
  close, 60 ms minimum open, gaps under 250 ms bridged).
- **Silero VAD** is already fetched by `ensure_vad_model` (MIT), so speech
  detection needs no new runtime.
- **Dead space = all three:** no transcript word on any track, every mic
  below its own threshold, and no speech from VAD on any mic. A spike above
  floor +18 dB inside a word gap (a laugh, a gasp, a door) is kept and
  flagged: in reality TV those are content.
- **Cut placement:** the lowest summed energy across all mics inside the
  removable span, floored and ceiled to frames so a cut never enters a word
  on any track.
- **Gate:** on three real scenes, dead-space detection agrees with an
  editor's hand-marked pauses (precision over 0.9 at the Dead air preset),
  and no cut clips a word on any track.

### Phase 5: the editor workspace

The prototype, ported onto production components and the Phase 3 model.

- The panes and dockable tabs, the transcript with removed lines, source
  and record, Ask (on the existing AI provider seam), text settings, the
  History panel.
- The timeline: speaker-coloured lanes, S/M/T, track selectors, In/Out
  highlighted on selected tracks, the tool row, View and Audio menus, gaps,
  the dead-space review (Dead air, Tighten), the V1 metadata lane from
  Phase 1.
- **Playback:** edit-list playback of the ISOs straight from NEXIS, with a
  10 ms equal-power crossfade at every join, following the solo/mute/level
  state. Scrubbing pauses and resumes, as in the prototype.
- **Empty timeline:** File ▸ New Edit (⇧⌘N), built by Insert (V), Overwrite
  (B) and Append from sources, with three-point editing (a text selection is
  the source in/out; the playhead or a paragraph boundary is the record
  point).
- Production rules apply: components under 150 lines, `cp-` classes and
  tokens, every contract in CLAUDE.md, component tests plus e2e specs for
  every behaviour the prototype's browser tests pin.
- **Gate:** the prototype's 13 Transcript Editor browser tests pass against
  the app, at 1100×700 and on Safari 17 (macOS 14), and a 3-hour scene
  (about 3,600 cues) edits without a frame of lag in the text.

### Phase 6: AAF export

- The Phase 0 writer, driven by the edit model:
  - segments become SourceClips (approach C or B, per the Phase 0 result)
    on every audio track and on V1 for picture;
  - gaps become `Filler` of the same length on every slot;
  - mutes become per-track filler;
  - markers become locators, also written as a marker `.txt`;
  - the timecode track runs continuous from the edit's start TC.
- **Naming:** `SO_E104_Rosa_Breakup_v01`-style sequence names; the app
  offers a pattern.
- **Self-check:** every export is re-read with the app's own reader and
  compared frame by frame with the edit before it is offered to the user.
- **Gate:** the Phase 0 Mac test plan passes on an edit made in the app (not
  a script), with picture, gaps, markers and a group clip; a golden-file
  test pins the writer's output structure.

### Phase 7: automated string-outs

In three steps, each shippable:

1. **Manual:** "Add to string-out" from transcript rows; a string-out is
   just an edit, so everything in Phase 5 works on it.
2. **Rules:** one sequence per character or topic, chronological by
   default, 0.5 s head and 1 s tail handles, 24 frames of filler between
   bites, a locator on each bite with its reason, speaker, source TC and
   score, colour per character.
3. **AI:** a request ("two minutes, open with Rosa") produces a proposal
   on local Qwen with structured output; Claude when the user has chosen
   it. A revision comes back as a diff to accept, never an automatic
   change. Season-wide string-outs across sequences, and overnight batches,
   come after.

- **Gate:** an editor builds three real string-outs (one per method) and
  round-trips them to Avid; the rules and AI methods save measurable time
  against doing it by hand (timed on the same scene).

### Phase 8: release hardening

- Scale: 500 mics, 15,000 cues, 100,000 undo steps, all measured.
- Accessibility and design contracts (the existing suite), plus new ones:
  the edit-model invariants, the read-only rule for Avid files (no write,
  rename or lock call on `.avb`, `.mdb`, `.pmr`), and the overtalk rule.
- HAND-TEST entries for everything a mock cannot prove: the NEXIS relink,
  the Avid import, playback from NEXIS, and quit-and-reopen history.
- `npm run verify`, `verify:packaged` and `verify:bundle` green; a signed
  DMG in the editor's hands.

## Tests that must exist before each gate

| Phase | Automated | By hand on the Mac |
|---|---|---|
| 0 | Writer self-verify on fixtures and the 117 AAFs | Avid import, media online, frames, groups |
| 1 | Reader tests incl. picture, `Legacy*`, muted Selector | Open a real picture + audio AAF |
| 2 | PMR parser tests and fuzz, stale and missing fallbacks | NEXIS relink time and correctness |
| 3 | Model tests in Rust, SQLite crash and scale tests, store contracts | Quit mid-edit, reopen |
| 4 | Detection against hand-marked pauses, frame-snap tests | Listen to 20 cuts |
| 5 | Component and e2e specs mirroring the prototype's | Edit a real scene for an hour |
| 6 | Golden-file AAF, re-read comparison | Avid import of an app-made edit |
| 7 | Proposal schema tests, diff apply/undo | Three real string-outs |

## Risks

| Risk | Mitigation |
|---|---|
| Avid rejects or relinks the AAF offline | Phase 0 first, before any UI; OTIO and EDL fallbacks |
| PMR format changes between MC versions | Hint only, header verification always, silent fallback |
| NEXIS denies reads of other clients' databases | Same fallback; never required |
| Word timings too coarse to cut on | Phase 4 gate before Phase 5 depends on it |
| Dead space removes a reaction | Reaction guard, Shorten not Delete, review before apply, one undo |
| The undo log grows without bound | Ops plus checkpoints; compaction offered past 200 MB, never automatic |
| Picture cuts drift from audio on export | One edit model, frame-only cuts, frame-by-frame self-check |

## Questions for you

1. **Neo Studio.** You asked for its timeline and panel rules to be the
   reference. This session runs in the cloud and cannot reach your Mac. Either
   push it to GitHub (a private repo is fine) or start a session on your Mac
   (`claude remote-control` in its folder, or the desktop app) and ask it to
   summarise the timeline, track-selector and panel code into a file in this
   repo.
2. **Phase 0 material:** the Media Composer version, one real group AAF with
   online media on NEXIS, and one `msmFMID.pmr` from a NEXIS media folder.
3. **Track layout on export:** one track per person, as the app shows it, or
   every bite on A1?
4. **Picture on export:** the group's live angle (C), or the speaker's own
   camera?
5. **Undo database location and retention:** see TRANSCRIPT-EDITOR-UX.md,
   open question 8.
