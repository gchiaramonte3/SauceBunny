# Transcript Reader + Avid export + in-panel AI analysis + source timecode

Design plan (2026-07-22). Grounded in a 6-surface code scout; every file/function
below was read on `ui-polish-v3`. Reconfigure what exists; build new only where noted.
House rules honored: no router (activeView switch), no new state lib, ts-rs for
cross-boundary types, `cp-` CSS + tokens, SRT + `.diarization.json` stay the durable
artifacts.

**The one structural fact that shapes everything:** `reviewSourceKey` is null with no
media loaded (`App.tsx:4656`), and a scanned source-less transcript has null
source (`transcript-library.ts` `synthesizeEntry`). So the Reader serves exactly the
transcripts that reviews/chapters CAN'T key. → analysis keys on the **SRT path**, not
a source fingerprint.

---

## 1. Transcript Reader workspace (a new top-level view under Review)

**Routing** — the real `activeView` pattern, no router:
- `App.tsx:155` add `"reader"` to `AppView`; `:748` add to the boot-restore whitelist.
- `keybindings.ts` add `view.reader` (⌘5 free); `App.tsx:4257-4271` dispatch case +
  `readerViewRef`; `commands.ts` palette entry.
- `NavRail.tsx` insert a button between the Review item (74-91) and `cp-nav-spacer`
  (92) — "underneath the Screening Room". Copy the Review block, swap icon
  (`IconTranscript`) + `active==="reader"`.
- `App.tsx:5008+` a `<div className="cp-view cp-view-reader" hidden>` hosting
  `<TranscriptReader/>`; `app.css` reading-first layout.

**Body** — new shell `TranscriptReader.tsx` composes (does NOT extract):
- **Text pane = `<TranscriptViewer>` mounted directly** (self-subscribes to the
  playhead store via `usePlayheadSeconds`, so no per-frame prop; all its popovers —
  RenamePopover, SpeakerRosterModal, HistoryPopover, InsightsPopover,
  TranscriptSearchBar, CueEditor — travel with it).
- **Compact player aside = `<LocalMediaPlayer>`** (smallest viable; `onTimeUpdate` →
  App's `onPlayerTimeUpdate` → `publishPlayheadFrames`, so the highlight follows for
  free). `Monitor.tsx` is a ~50-prop full stage — do not reuse wholesale.
- **Optional burned-in captions = `<CaptionOverlay>`** (same path + clock, drops on).
- **Picker** = `loadTranscriptLibrary(defaults.transcriptLibrary)` grouped by
  `groupTranscriptsByFolder`; badges from `hasDiarization` + `hasAnalysis` (§5).

**Layout:** two columns inside `cp-view-reader` — left a `~70ch` reading column
(the TranscriptViewer bubbles as the focal point), right a sticky compact ~16:9
player pinned while text scrolls; a leading/collapsible picker. Narrow → one column,
player pinned top.

**One viewer edit:** relax `onRegenerate`/`regenerateBusy`/`canRegenerate`/
`onImportTranscript`/`onClearTranscript`/`onLoadFromHistory` to **optional** so the
reading-first toolbar self-hides Regenerate/Import/Clear (the Tools/Fix-timing/
redetect chrome already self-hides this way). Guard the empty-state Generate with
`onRegenerate && …`.

**Watch-outs (verified):** single global playhead clock (r88) — pause the Clip player
on Reader entry; fps fallback (`App.tsx:569`) means a bare SRT with no media reads
text-only with a static highlight; **first cut = local-file player only** (web sources
need App/Monitor's MSE resolver plumbing → open text-only or bounce to Clip).

---

## 2. Avid + SRT export (mostly a reuse of the review export machinery)

**SRT** — `serializeCues(cues, "srt"|"vtt")` (`srt.ts:491`) already round-trips
losslessly; cue times are on the full-source timeline (r132), so no offset. Two modes
already in `TranscriptViewer.downloadAs` (1017): `srt-copy` (raw file) vs
`serializeCues` (edited).

**Avid markers** — the serializer already exists, coupled to `ReviewDoc`. In
`markers.ts`: export `ExportMarker`; extract a pure `avidRows(markers, settings)` from
`markersToAvidTxt` (200-213); add `buildMarkersFromCues(cues, resolveName,
colorForSpeaker)` (one POINT marker per cue: speaker→Username, `cue.start`→time,
`cue.text`→Comment) + `transcriptCuesToAvidTxt(...)`. Reuses `inlineClean` /
`nearestCanonicalColor` / `absTc` / `totalFrames` unchanged → **zero new timecode
math**. All frame math stays in `marker-time.ts` (NTSC-exact, drop-frame-aware) — do
NOT fall back to `timecode.ts`'s integer-fps helpers (drift on 23.976/29.97).

**Critical:** the Username must be the RESOLVED human name, not raw `cue.speaker`.
Build the export at component level where `displayNameFor` (`TranscriptViewer.tsx:397`)
is in scope; pass it as `resolveName`. Color =
`nearestCanonicalColor(resolveSpeakerColor(...))` (snap roster color to Avid's 8).

**Button + save:** add "Export SRT" + "Export Avid markers…" to
`TranscriptViewer.downloadAs` — it already has `saveDialog`, `baseFilename`, and
`write_bytes_to_path`. Reuse `loadMarkerSettings(fps)` + lift `MarkerSettingsRow` out
of `ReviewPanel.tsx` into its own file so both exports share the validated
HH:MM:SS:FF editor. **No Rust, no ts-rs.**

**Range case:** v1 = point-per-cue. The bracket-pair logic (`markers.ts:209`) fires
automatically if a spanned marker (comment on a mark-in/out range) is ever authored.

---

## 3. In-panel AI analysis — tabbed document ↔ analysis

**Engine exists:** `AiSummary.tsx` + `llm.rs` (resident llama-server, no new backend).
Reusable: `ensureServer`, `transcriptForModel`, `buildSystemPrompt`, `streamChat`
(`ai-chat.ts`). Today it's interactive chat only, never saved.

**The shape to copy = `AiChapters.tsx` `detect()`**: gate on busy → `ensureServer +
streamChat` with a purpose prompt → parse → save per-source → load-saved-on-open →
Detect/Regenerate. That is exactly "analyze → save → reuse".

**Tabbed flow** = the `QueueDrawer` `.cp-tab` + `role=tab` + visited-keep-alive idiom
(no tab lib). Reader inner sub-tabs: **Document** | **Analysis**.

**New `AiAnalysis.tsx`** (modeled on AiChapters) in the Analysis tab, same props
AiSummary gets: on open `loadAnalysis(key)` → saved → render Markdown + **Regenerate**
(grey `btn btn-ghost`, per the no-green memory); null → **Analyze**. `analyze()` joins
the single-server interlock (gate on `streaming || chaptersBusy`), streams via
`buildAnalysisPrompt` (fork of `buildSystemPrompt` with a fixed "structured summary"
instruction), then `saveAnalysis(key, {...})`. Fire `saucebunny:analysis-changed` for
live badge refresh.

---

## 4. Source start timecode (burn-in alignment; feeds the Avid offset)

**Storage** — copy the `chosenPoster` per-file trio (`library.ts`:
THUMB_TIMES_KEY / chosenPosterFor / setChosenPoster) into
`sourceTimecodeFor/setSourceTimecode/clearSourceTimecode` over a new key
`saucebunny.sourceTimecodes` (`path → "HH:MM:SS:FF"`, stored as the TC string). Keyed
by absolute path (source TC is intrinsic to the file). Local files only.

**Setter — the context menu already exists:** `LibraryCardMenu.tsx` is a portaled,
edge-clamped, arrow-roving menu opened from right-click / ⋯ / Shift+F10. Add two rows
("Set source timecode…", "Clear" disabled-until-set), props `onSetTimecode` /
`onClearTimecode` / `hasSourceTimecode`, thread up
`LibraryCard → LibraryView → App`. The dialog input mirrors `MarkerSettingsRow`'s
commit-only-when-valid field but parses with `marker-time.ts` (drop-frame aware).
Also a Clip-page control in `Sidebar.tsx` beside the in/out TC inputs, keyed by
`localFilePath`.

**Feeds:** at Avid export, `sourceTimecodeFor(path)` overrides `sequenceStartTc`
(`absTc`/`totalFrames` already add it). Optionally offsets the shown Transport TC.
The karaoke highlight is seconds-driven and needs no offset.

---

## 5. Saved-analysis data model → co-located `<base>.analysis.json` sidecar

**Not** review-store, **not** localStorage. Because the stable key is the SRT PATH
(analysis is a property of the transcript, not the source video), and co-location
means a Finder move carries `Foo.analysis.json` WITH `Foo.srt` — shared fate, the
exact win of the r132 diarization sidecar. Path-keyed localStorage would strand
(the known speaker-persistence fragility).

**Exists-check is free** (the scan is the index): add `has_analysis: bool` to
`TranscriptFile` (Rust `collect_transcripts`, `path.with_extension("analysis.json").is_file()`)
and `hasAnalysis` to `LibraryTranscript` — so the Reader badges "Analyzed" and
reuses-on-open without reading every file, and it works for source-less transcripts.
(Changes the `TranscriptFile` ts-rs shape → bump the build-id handshake.)

```ts
type TranscriptAnalysis = {
  schemaVersion: 1;
  model: string;         // LlmServerInfo.model_id
  generatedAt: number;
  style: SummaryStyle;
  markdown: string;
  srtSizeBytes: number;  // staleness guard vs the scan
  srtModifiedMs: number; // staleness guard vs the scan
};
```
`analysisSidecarPath(srtPath)` (TS mirror of `diarization_sidecar_path`, handles
.srt/.vtt); defensive-validate on load. **Staleness guard** (net-new): the viewer
rewrites the SRT in place on edit/regenerate — if the scan's size/mtime moved past
`generatedAt`, mark the analysis stale (offer Regenerate, don't silently show it).

**Explicitly NOT the fingerprint re-keying:** that task is for source VIDEOS surviving
moves (content hash + alias index). Analysis keys on the SRT's own path via
co-location — orthogonal, never touches the fingerprint index. No `index.json` (the
scan is the index, exactly as diarization has none).

---

## Progress
- **Prereq — fingerprint re-keying of speaker names: DONE** (`56da0a1`).
- **Phase 0a — source-timecode store: DONE** (`7c89868`).
- **Phase 0b — analysis `.analysis.json` sidecar + `has_analysis` scan flag: DONE**
  (`0cba193`, build-id r134).
- **Phase 1 — Reader route + shell: DONE (first cut).** AppView `reader`, ⌘5,
  NavRail item under Review, `cp-view-reader` + `TranscriptReader.tsx` (picker
  over `loadTranscriptLibrary`, grouped by month, Speakers/Analyzed chips) with
  the real `TranscriptViewer` embedded as children in a reading-first config
  (`hasSource=false` self-hides the source chrome). **Deferred to Phase 1b:** the
  compact `LocalMediaPlayer` + click-to-seek (text-only for now, static
  highlight); the visual layout wants the user's eye.
- Next: Phase 1b (compact player), Phase 2 (Avid+SRT export), Phase 3 (setters +
  AI analysis tabs).

## Build order (by dependency)

- **Phase 0 (foundations, no UI):** 0a source-TC store in `library.ts`; 0b analysis
  model — `analysisSidecarPath` + schema + load/save + the `has_analysis`/`hasAnalysis`
  scan flag (Rust + FE + build-id bump).
- **Phase 1 (Reader route + shell):** AppView `reader`, NavRail item, `cp-view-reader`,
  `TranscriptReader.tsx` composing viewer + LocalMediaPlayer + picker.
- **Phase 2 (Avid + SRT export):** refactor `markers.ts`, lift `MarkerSettingsRow`,
  add the two export items to `downloadAs`, seed `sequenceStartTc` from 0a. Usable in
  BOTH the Clip transcript tab and the Reader.
- **Phase 3 (setters + AI analysis UX):** source-TC setters (LibraryCardMenu + Clip
  control); `AiAnalysis.tsx` with Analyze→save→reuse over 0b; doc↔analysis sub-tabs;
  "Analyzed" badge.

Prereq already agreed: the **fingerprint re-keying** (speaker renames) lands first.
Analysis keying is deliberately decoupled from it (SRT-path co-location).

## Resolved decisions (user, 2026-07-22)
1. **Analysis write path → Rust, atomic.** A `save_transcript_analysis` command using
   `atomic_write` (temp+rename, the diarization-sidecar's durable write) + a ts-rs
   `AnalysisDoc`. This is the plan's only backend change → bump the build-id handshake.
   Pair with a `read`/exists via the scan's `has_analysis` flag (§5).
2. **"Avid notes" = the marker `.txt` only.** ONE export path: the importable
   tab-delimited markers file (§2). No separate readable-notes doc. (SRT export still
   ships alongside as its own item.)
3. **Source TC → per-file OVERRIDES the global.** At Avid export, if
   `sourceTimecodeFor(path)` is set it wins for that file; the global
   `saucebunny.markerExport` `sequenceStartTc` (01:00:00:00 default) is the fallback.
   `absTc`/`totalFrames` already consume `sequenceStartTc` — just swap the value at
   export time when a per-file TC exists.

**Scope flag (not a decision):** the Reader's first cut is local-file player only;
web-source transcripts open text-only (static highlight) or bounce to Clip.
