# Diarization cache + data-model audit (2026-07-22)

Six-auditor persistence audit, every finding adversarially verified.
29 findings → 16 material → 2 critical.

## The diarization finding (the user's report)

"You save the transcript long term but not the diarization." Half true, and the
half that's wrong matters:

| Artifact | Where | Status |
|---|---|---|
| Per-cue machine labels (`[SPEAKER_00]`) | baked into the SRT, re-derived on open | **durable** |
| Raw diarizer turns + provenance (model, audio secs, overlaps, sub-cue boundaries) | temp JSON in app_cache, **deleted after merge** (transcript.rs:2799) | **WAS discarded → now cached (r132)** |
| Human renames / colors / aliases | localStorage `saucebunny.speakerNames.<srt-path>` | persisted but **fragile** (orphans on any path change) |
| Speaker count | nowhere in the history index | invisible until the SRT is opened |

The merge (`merge_diarization_into_srt`) is a one-way lossy projection — one
best-overlap speaker per cue, renumbered — so overlaps and true turn boundaries
can't be recovered from the SRT. The diarizer already emits a rich versioned
envelope (`schema_version`, `model`, `model_package_version`, `audio_seconds`,
`turns[]`); the app parsed out only `turns` and deleted the file.

## Design

- **Machine turns** → co-located sidecar `<base>.diarization.json`, **Rust-owned**,
  written at merge time. Keyed implicitly by the SRT path (reopen already holds
  it). This is what r132 (below) implements: persist the envelope verbatim
  instead of deleting it — a rename, not a store.
- **Human identities** → relocate out of path-keyed localStorage into a durable
  **content-fingerprint-keyed** doc, reusing `review.ts`'s `reviewFingerprint`
  (location-independent: survives new-month folders, renames, Finder moves). This
  is the follow-on, ~1-2 days, touches 6 consumers.
- **history entry** gains `speakerCount` / `diarizedAt` so the library shows an
  "N speakers" chip without opening the file.
- **migration**: existing merged SRTs get a `source: "reconstructed-from-srt"`
  doc synthesized from cue labels on first open — no re-diarize.

## Done in r132

`diarizer: cache the raw speaker turns beside the transcript` — persist the
diarizer's envelope to `<base>.diarization.json` (atomic temp+rename) instead of
deleting it; make the merged-SRT write atomic too (finding #10). Internal helper
change only — no command surface touched, no build-id bump. Unit tests for
`atomic_write` + `diarization_sidecar_path`.

## Data-model bug list (ranked, fix-first)

**CRITICAL — silent loss of user work via an ordinary action**
1. **Review overwritten with an empty doc when its file was iCloud-evicted.**
   `src/lib/review-store.ts:231`. Opening a source whose `.json` was offloaded →
   read fails → `emptyDoc` → shrink-guard backup read *also throws, swallowed* →
   no `.bak` → the real review is clobbered. Fix: a backup read that THROWS
   (vs returns empty) means "unknown — do NOT overwrite"; abort, keep dirty.
2. **Mark-range transcript overwrites the full-source transcript in place.**
   `src-tauri/src/commands/transcript.rs:1368`. Same default filename; no
   uniquing. Fix: append `in-out` to range runs / record coverage / confirm.

**HIGH**
3. `index.json` is an un-rebuildable SPOF for Reviews + Screenings
   (review-store.ts:308, screening-store.ts:153/199) — evict/truncate → empty
   Map → next save orphans every other doc. Fix: folder-scan reconcile + atomic
   index write.
4. Re-diarize renumbers `SPEAKER_NN` clusters but renames stay bound to the old
   tag → every name silently misattributed (transcript.rs merge / re_diarize).
   Fix: reconcile new tags against the now-persisted turns (unblocked by r132).
5-6. Speaker identities keyed by absolute SRT path, never written beside the SRT
   → orphan on new-month/rename/move (TranscriptViewer.tsx:200, helpers.tsx:205).
   Fix: the fingerprint follow-on above.

**MEDIUM**: per-turn overrides keyed by ephemeral turn ordinal (7); Transcripts/
folder never scanned so evicted/50-cap SRTs vanish (8); exact-path source
matching (9); non-atomic in-place SRT writes elsewhere (10, partly done r132).

**LOW**: dead history entries never pruned (11); unbounded localStorage +
swallowed QuotaExceededError (12).

## Root themes
1. Ephemeral/location keys instead of stable content identity (Reviews already
   solved this with a fingerprint).
2. Non-atomic writes to the single durable copy (the temp+rename pattern exists
   in llm.rs/download.rs, just not used here — r132 starts applying it).
3. iCloud eviction treated as absence → overwrite-with-empty.
4. Indexes are the sole authority, not rebuildable from the files they point at.
5. Machine cluster IDs (`SPEAKER_NN`) treated as stable identities while the data
   that could reconcile them (the turns) was thrown away — r132 stops that.
