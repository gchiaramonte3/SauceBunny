# Sauce Bunny — the data model

Every place this app puts a fact, who owns it, and what happens to it when
something goes wrong. Written because the app is local-first: there is no
server holding a second copy, so a store that loses data loses it for good.

Stack: Tauri 2. Rust owns the filesystem and the Keychain; the React frontend
owns `localStorage` and drives every file store through four invoke commands
(`default_transcript_library_path`, `ensure_dir_exists`,
`read_text_file_capped`, `write_text_to_path`). There is no database. Nothing
is a Core Data / SwiftData store; the Swift sidecar is stateless.

---

## 1. Storage map

Four roots, one per durability class. The class is the contract: it says what
the app is allowed to do to the data without asking.

| Root | Resolved by | Class | Swept? |
|---|---|---|---|
| `~/Documents/Sauce Bunny/` | `document_dir()` | **user document** | never |
| `app_data_dir()` | Tauri | **app support** (regenerable, expensive) | never |
| `app_cache_dir()` | Tauri | **cache** (regenerable, cheap) | yes, see below |
| macOS Keychain | `keyring` crate | **secret** | on explicit delete |
| WKWebView `localStorage` | webview | **preference** (evictable) | by macOS, unannounced |
| `std::env::temp_dir()` | OS | **scratch** | by the OS, plus our own sweeps |

### `~/Documents/Sauce Bunny/` — the user's work

```
Transcripts/
  projects.json            project metadata (titles, posters, colours)
  <Project>/               a project folder, or
  YYYY-MM/                 the date-organized default
    *.srt / *.vtt          the transcripts themselves
Casts/
  casts.json               every cast, one file
Reviews/
  index.json               sourceKey -> filename
  <slug>-<hash>.json       one ReviewDoc per reviewed source
  <slug>-<hash>.json.bak   shrink-guard snapshot (see 3.2)
Screenings/
  index.json               screeningId -> row
  <date>-<slug>-<hash>.json  one ScreeningDoc
Collections/
  collections.json         web-source collections (virtual, keyed by URL)
Frames/
  <source>_<timecode>.jpg  grabbed stills; the FILENAME is the only index
```

`~/Movies/Sauce Bunny/` is the default export folder. The app writes finished
clips there and never reads them back; it is output, not a store.

### `app_data_dir()` — expensive to regenerate, not the user's

`whisper/` and `models/` (Whisper GGUF), `models/llm/` (Qwen GGUF),
`parakeet/`, `bin/`, `yt-dlp/`, `window-frame.json` (window geometry), and
`clear-media-cache-on-quit` — a zero-byte marker file that is the *pref* for
clear-on-quit, deliberately a file because it is read at shutdown after the
webview and its `localStorage` are already gone.

### `app_cache_dir()` — three named directories

The root used to be one organized subtree plus a flat pile of
`saucebunny-`prefixed FILES, which is what a user saw on Reveal. Inside the
app's own cache folder that prefix says nothing, so:

```
app_cache_dir()/
  media/        downloads/ audio/ meta/      never swept
  thumbnails/   poster JPEGs                 never swept
  scratch/      job temps, playback prep,    swept at 24h
                Whisper WAVs, diarizer JSON
```

- `media/` is **sweep-exempt**: downloaded sources and their audio, which are
  "download once, reuse forever". Bounded by a user-set cap
  (`mediaCacheCapGb`, `enforce_media_cache_cap`) and clearable from Settings.
- `thumbnails/` is sweep-exempt too: posters are cheap to keep and expensive
  to regenerate daily. Settings' thumbnails bucket is the manual purge.
- `scratch/` is swept at startup, on a background thread, failures non-fatal.

`migrate_cache_layout` moves an old install over once, at startup, before the
sweep runs. The media subtree is RENAMED rather than copied (same filesystem,
so it is a metadata operation and nobody re-downloads a season); thumbnails
move file by file and shed the prefix the directory now carries; loose scratch
files at the root are left for the sweep's legacy arm, because some may be in
flight from the previous run and all of them regenerate.

### Keychain — the only secrets

Service `saucebunny`, accounts: `anthropic`, `openai` (cloud-AI API keys) and
the TURN password. `cloud_ai.rs` can `set`, `has` and `delete` a key; the
frontend can never read one back. The API call itself is made in Rust so the
key never enters the webview. Guarded by `secret-persistence-contract.test.ts`.
A legacy TURN password found in `localStorage` is migrated into the Keychain
and the `localStorage` copy blanked (`App.tsx:296`).

### `localStorage` — 55 literal keys plus five key families

All namespaced `saucebunny.`, guarded by `storage-keys-contract.test.ts`
(nine grandfathered `cp-` keys remain). `migrate-storage.ts` copies any
surviving `clippull.*` key across and sweeps the retired `saucebunny.clips.*`.

Key families (dynamic suffix): `speakerNames.<srtPath>`, `ai.model.<provider>`,
`chapters.<key>`, `noticeDismissed.<path>`, `timingFixDismissed.<path>`, and
the legacy `review.<sourceKey>` docs that `reviews.migrated` records as swept.

Not all of these are preferences. Sorted by what losing them would cost:

- **Work product** (see finding F2): `speakerNames.<path>` + `speakerNames.fpindex`,
  `sourceMarks`, `sourceTimecodes`, `clipQueue`, `transcriptHistory`,
  `libraryThumbTimes`, `review.history`, `review.fpindex`, `webPosters`.
- **Identity**: `installId`, `review.author`, `review.authorColor`.
- **Genuine preference**: layout, widths, open/closed, `keybindings.v1`,
  `playbackRate`, `streamRungPref`, `streamKeep`, `mediaDevices`, the
  `*Dismissed*` flags, `welcomed`, `onboarding`.
- **Cache**: `panelSnapshot` (the panel's synchronous boot seed),
  `lastUpdateCheck`, `ytdlpVersion`, `diarizerModelsReady`.

---

## 2. Entity catalog

| Entity | Identity | Held in | Written by |
|---|---|---|---|
| Transcript | absolute `.srt`/`.vtt` path | the file itself | `TranscriptViewer` (cue edits), `transcript.rs` (Whisper/captions) |
| Speaker override | `<srtPath>`, bridged by content fingerprint | `localStorage` **only** | `transcript/helpers.tsx`, `speaker-identity.ts` |
| Project | folder NAME, under `Transcripts/` | `projects.json` | `transcript-project-store.ts` |
| Cast | `cast.id` (generated) | `casts.json` | `cast-store.ts` |
| Review doc | `sourceKey` (path or URL) -> FNV-1a filename | `Reviews/<slug>-<hash>.json` | `review-store.ts` |
| Screening | screening id -> filename | `Screenings/*.json` | `screening-store.ts` |
| Queued clip | queue item id | `localStorage.clipQueue` | `storage.ts` |
| In/out marks | source `pathKey` | `localStorage.sourceMarks` | `source-marks.ts` |
| API key / TURN password | provider name | Keychain | `cloud_ai.rs` |
| Web collection | generated id; members keyed by raw URL | `Collections/collections.json` | `web-collection-store.ts` |
| Frame (grabbed still) | its own path; grouped by the filename stem | `Frames/*.jpg` | `commands/frames.rs`, written by `handleSnapshot` |

**Frames have no index at all, deliberately.** The filename carries
`<source>_<timecode>`, which is what the shelf groups on, so there is no
sidecar to fall out of step with the directory: a frame renamed in Finder
groups under its new name and nothing breaks. Same principle as projects
below, one step further.

**The directories are the truth about what a project is.** `projects.json`
only decorates them; `reconcileProjects` re-derives the list from disk on
every scan, so deleting the file costs posters and titles, nothing more.
That is deliberate and it is why a display string is tolerable as the key.

**Facts stored twice.** Only one, and it is intentional: a speaker override
lives under the SRT path AND under a content fingerprint
(`speakerNames.fpindex`). The path key is the synchronous working store; the
fingerprint is the durable identity that survives a re-transcribe into a new
`YYYY-MM` folder. `speaker-identity.ts` owns keeping them in step.

---

## 3. Scorecard

### 3.1 Ownership — green

Every fact has one writer module. The panel window hydrates the review store
but has no `saveReview` call site, so it is a reader. `cast-store` is the one
store with two real writers (both windows), and it is the one store that
merges before writing and announces after.

### 3.2 Atomicity — green

`write_text_to_path { atomic: true }` stages a sibling dotfile, fsyncs, then
renames: same filesystem, so the rename is atomic, and peak disk stays at one
copy. **`invoke-contract.test.ts` fails the build if any call site omits
`atomic`**, which is the right shape for this rule. `write_raw_to_path` (the
clip exporter) is unconditionally atomic.

Above that sit logical guards, all in `review-store`: a doc that shrinks below
half its last persisted size snapshots the old content to `.bak` first; an
empty doc never overwrites one the index says has content; flushes hold until
the index has hydrated; boot hydration never installs a disk copy over a doc
edited this session; an unreadable file (iCloud eviction) defers the write
instead of clobbering.

### 3.3 Identity — yellow

Casts, reviews and screenings have generated or hashed ids. Two entities key
on strings a user can change:

- **Project = folder name.** Mitigated: the filesystem is authoritative,
  and `project-rename-carry.ts` carries metadata across a rename.
- **Speaker override = SRT path.** Mitigated by the fingerprint bridge.

Both mitigations are real, and neither is free: they are the reason those two
modules exist. Collision behaviour is defined in both parsers (first entry
wins, duplicates dropped).

### 3.4 Versioning — **RED. This is finding F1.**

All four file stores WRITE `{ version: 1, ... }`. **No parser reads it.**
`sanitizeCastFile`, `parseProjects`, `parseScreeningIndex` and the review
index parser all go straight to the payload. There is therefore no migration
path and no unknown-future-version behaviour: a file from a newer build is
parsed under today's rules, its unknown fields dropped by the sanitizer, and
the next save writes the truncated result back over the user's document.

### 3.5 Placement — yellow

Correct: models and window geometry in app-support; regenerable media in
cache with a cap and a clear button; secrets in the Keychain; the user's
transcripts, casts, reviews and screenings in Documents, which is the folder
people back up. Nothing regenerable sits in Documents.

Wrong: **work product in `localStorage`** (finding F2). The review store's own
header states the reason localStorage was abandoned for review docs, and
cast-store repeats it: WKWebView `localStorage` is "evictable by macOS with no
warning and no recovery". Speaker renames, in/out marks, source timecodes and
the export queue are still there.

### 3.6 Integrity — yellow

Cross-store references are filenames and paths. Missing-target behaviour is
defined where it was reached for: the screening index rejects any `file`
containing a path separator, so an entry cannot escape its folder;
`reconcileProjects` drops metadata for folders that no longer exist. It is NOT
defined for `projects.json`'s `posterPath` (a dangling poster is simply a
broken image) or for a review index entry whose file is gone.

Timestamps are epoch milliseconds from the local wall clock (`createdMs`,
`startedAt`, `endedAt`). Nothing orders records by timestamp alone across two
machines; within one machine this is fine.

### 3.7 Concurrency — green, narrowly

Two webviews share `localStorage` and the same files. Only `cast-store` has
two writers, and it converges: a 2P-Set (grow-set plus tombstones) merged
against a fresh read before each debounced flush, then a Tauri event so the
other window re-reads. The merge read is timeout-bounded so a stalled read
cannot strand an edit. `review-store`, `screening-store` and
`transcript-project-store` are single-writer by construction.

`localStorage` itself is last-write-wins per key with no coordination. It has
not bitten because the two windows write disjoint keys, but nothing enforces
that.

### 3.8 Privacy and limits — green

No secret outside the Keychain, and a test says so. Growth is bounded
everywhere it can run away: `MAX_CASTS`, `webPosters` LRU-capped at 80, the
media cache capped by user setting and clearable, the 24h sweep, read caps on
every store (`read_text_file_capped`, 8 MB casts / 2 MB projects).

### 3.9 Sync-readiness — score only, nothing built

| Entity | Stable id | Per-record version | Idempotent ops | Tombstones | Mergeable | Verdict |
|---|---|---|---|---|---|---|
| Cast | yes | `touched` timestamp | yes | **yes** | yes | **green** |
| Review doc | yes (`sourceKey`) | `versions[]` + per-comment ids | yes | no | comment lists append | yellow |
| Screening | yes | `endedAt` | yes | no | immutable once ended | yellow |
| Project | folder name | `createdMs` only | yes | no (disk is truth) | field-wise | red |
| Speaker override | path + fingerprint | none | yes | no | per-speaker map | red |
| In/out marks | path key | none | yes | n/a | last-write-wins | red |
| Queued clip | item id | none | no (jobs are stateful) | no | no | red |

`cast-store` is the only store already built for merge, and it is the model
the others would follow. Nothing here is a blocker; the reds are reds because
they have no per-record version, not because their shape is wrong.

---

## 4. Findings, ranked by user harm

| # | Finding | Harm | Status |
|---|---|---|---|
| **F1** | Schema version written but never read: a newer build's file is silently rewritten with its unknown fields stripped | **data loss** | **fixed** — but see F7, its guard could not arm |
| **F2** | Speaker renames, in/out marks, source timecodes and the export queue are work product living only in evictable `localStorage` | **data loss** | open, needs a product call — but its SILENCE is fixed (see below) |
| F3 | `projects.json` `posterPath` and a review index entry have no defined behaviour when the target file is gone | silent drift | open |
| F4 | `localStorage` is last-write-wins across two windows, coordinated by convention and one event rather than by anything enforced | silent drift | open |
| F5 | The panel window hydrated the whole review store at boot for a store it cannot reach | inefficiency | **fixed** |
| **F6** | The Reviews folder is durable; the map from a RENAMED file to its notes is not. `saucebunny.review.fpindex` lives in evictable `localStorage`, and no review doc records its own fingerprint | **notes become unreachable** | **fixed** |

### F6: the notes are durable, the way back to them is not

F2 is about work product stored in the wrong place. This is different and was
missed because the Reviews folder looks — correctly — like the durable one.

A review doc is a real file in `~/Documents/Sauce Bunny/Reviews/`, named from a
slug of the source path plus a hash. Its `sourceKey` is that path. So when the
user renames or moves the source, the only thing that reconnects the file to
its notes is `resolveByFingerprint`, and the fingerprint index it reads lives
in `localStorage` under `saucebunny.review.fpindex` — the same evictable store,
written through the same `saveJson`, that F2 is about.

Lose it and nothing looks broken. Every note is still on disk. The app simply
cannot find any of them for any source that has since been renamed, and the
doc files are named after paths that no longer exist. Restoring `Documents`
from a backup does not help, because the map was never in `Documents`.

**Measured on this machine, 30 August 2026.** 72 index entries: 33 keyed by an
absolute path, 39 by URL or fingerprint. Of the 33, **eight point at files that
no longer exist**, carrying 18 comments between them. Index and folder are
otherwise perfectly consistent — 0 orphan files, 0 missing files — so the
store's own bookkeeping is sound; the dangling is at the source level. And none
of those eight docs records a fingerprint, because **no review doc records one
at all**: `ReviewDoc` has no such field. Whether those eight are recoverable
depends entirely on whether `fpindex` still holds an entry for them, which is
not knowable from outside the app.

The fix is small and follows this document's own placement rule — nothing the
user's folder needs should live outside it. Give `ReviewDoc` an optional
fingerprint list, write it where `linkFingerprint` is already called (the value
is computed there today and thrown away after indexing), and let the store
rebuild `fpindex` from the folder when it is empty. That makes `Documents`
self-describing: a folder restored on its own is enough, and the localStorage
index becomes a cache rather than the only copy.

**Fixed.** `ReviewDoc` gained an optional `fingerprints: string[]`, written by
`linkFingerprint` where the value was already computed and thrown away after
indexing. `rebuildFingerprintIndex` walks the hydrated docs and puts back any
link the index has lost; `main.tsx` runs it once after hydration. Documents is
now self-describing: a folder restored on its own is enough, and the
localStorage index is a cache rather than the only copy.

Three properties worth knowing:

- **It adds only.** The index legitimately holds links no doc carries — entries
  written before docs recorded fingerprints, and links made for a doc that does
  not exist yet — so an existing entry always wins. This is a repair, not a
  resync.
- **A list, not a value.** `linkAsReviewVersion` deliberately points several
  cuts at one doc, and a fingerprint written before NFC normalisation differs
  from today's for the same file.
- **The change is safe downgrading.** The doc file carries no version of its
  own (only `index.json` does, unchanged at 1), `looksLikeReviewDoc` checks for
  known fields rather than rejecting extras, and the writer is a whole-object
  `JSON.stringify` — so an older build that opens and re-saves one of these
  docs preserves the field rather than stripping it.

The repair runs from `main.tsx` rather than inside the store on purpose:
`review.ts` owns the index and already imports `review-store`, so calling it
from the store would turn a type-only import cycle into a runtime one, where
whichever module initialises first sees `undefined`.

### F7: F1's guard was inert, and F1 said it was fixed

`futureVersionIn` compares a file's `version` against `STORE_SCHEMA_VERSION`.
Every one of the five writers stamped a bare `version: 1` instead of using that
constant. So bumping it would have changed what this build REFUSES while
changing nothing about what it WRITES: a v2 build stamping v1 files, which a v1
build then clobbers with the old shape — precisely the loss F1 exists to
prevent, inside the mechanism built to prevent it.

Fixed by stamping the constant at all five sites. `store-version-contract` now
requires it, and gained a canary, because widening the writers broke its own
sweep: it matched `/version:\s*\d+/`, so the moment the literals became the
constant it stopped matching anything and went green over an empty set —
reporting perfect conformance for the very change it should have checked.

### F8: overrides were deleted rather than saved

Not a storage-placement problem like the rest of this file; a plain bug found
while auditing the same surface. `SpeakerOverrides` has eight sub-maps and
TranscriptViewer decided emptiness with a hand-listed disjunction over five —
missing `cueTag`, `icons` and `splits`. The branch that emptiness guards calls
`localStorage.removeItem`. So a user whose only edit was a per-cue
reassignment — the layer that exists to separate two people the diarizer merged
into one, and the most worthwhile speaker edit there is — was measured as having
changed nothing, and their overrides were removed from disk.

The check is derived from the object now, so a ninth sub-map is free, and the
write reports a quota failure instead of swallowing it: this was the one
work-product write that still bypassed `saveJson`, in the family the silence fix
was named after.

### F2's silence is fixed; F2 itself still needs the decision

The sharper half of F2 was not that this work product lives in evictable
storage. It was that losing it is SILENT. All five families write through
`saveJson`, which caught the quota and called `console.warn` — and in a
packaged `.app` the WKWebView console needs Safari's inspector attached, so it
reached nobody. Past the quota the app kept working perfectly and simply
stopped remembering: rename twelve speakers, set chapters, mark a range,
relaunch, and it is all gone with no error and nothing in any log the user can
open.

`saveJson` now reports through a rate-limited listener (the shape
`review-store` already used), `speaker-identity`'s two direct writes go through
the same reporter, and App turns it into a notification naming the key and
suggesting what frees space. `store-problem-contract` pins that all three of
the app's store reporters have a subscriber that NOTIFIES rather than only
logging — a reporter whose subscriber is deleted fires into an empty Set and
reads as complete from either end.

What that does NOT settle is whether these five belong in files. That is still
the product call, and it is still open.

### F4 is smaller than it first looked, and worth writing down

The two windows do NOT write disjoint `localStorage` keys: `TranscriptViewer`
renders in both, so both write `speakerNames.<path>` and `chapters.<key>`.
That is coordinated, by the `saucebunny:speakers-changed` event which makes the
other window re-read. It works. What is missing is enforcement: nothing fails
if a third feature starts writing a shared key without an event, which is
exactly how the casts cross-window clobber happened at the file layer. A test
for this would have to reason about which components each window's tree
mounts, so it is a real piece of work rather than a one-liner, and it is
recorded here rather than half-built.

### F5, for the record, was nearly a much worse finding

`QueueDrawer` is what the panel renders, and it imports `ReviewPanel`, which
calls `saveReview`. On that reading the panel is a second WRITER of review
docs, and `review-store` has none of the merge-and-announce machinery that
`cast-store` grew for exactly that situation. It would have been the same
data-loss bug in a second store.

It is not, though the first fix overclaimed HOW. The Review tab is dropped
from the tab list when `embedded` and a restored `"review"` tab is redirected
to `"transcript"` - but the keep-alive set was fed the RAW restored value, so
a Review tab persisted by the main window mounted a hidden `ReviewPanel` in
the panel anyway (found by an adversarial review of the release notes; fixed
by feeding the set the redirected value). What actually makes the panel safe
is that it is never handed a review source key, which every read and write in
`ReviewPanel` is gated on. `e2e/panel-window.spec.ts` pins both: no Review
tab, and no hidden review body even when the main window persisted that tab.

### F2 needs a decision, not a patch

Moving speaker overrides to Documents is the same move reviews made in r140
and casts made after, and it would close the largest remaining data-loss hole.
It needs an answer to a product question first: **one index file, or a sidecar
beside each transcript?** A sidecar travels with the transcript when the user
moves it in Finder, which is exactly the failure the fingerprint bridge was
built to paper over. An index is one file to write and one to back up. The
in/out marks and source timecodes would follow whichever is chosen. The export
queue is a different animal: it holds live job state, so it wants app-support,
not Documents.

---

## 4b. How a comment knows which session it belongs to

Written up after the report "I started a second and third session and the
previous notes persisted throughout". The notes were not leaking. There was no
such thing as a session, as far as the review panel was concerned, and this
records what the model already held before anything was added.

### What was already there

| Fact | Where | Written by | Read by (before) |
|---|---|---|---|
| Notes for a source | `Reviews/<slug>-<hash>.json`, one doc per `sourceKey` | `review-store` | the panel, whole |
| Which cut a note is on | `ReviewComment.versionId` | `addComment` | `rootComments` |
| Which SESSION a note was made in | `ReviewComment.sessionId` / `segmentId` | `stampOpWithSession` | **nothing** |
| Which notes a session collected | `ScreeningSegment.commentIds` | `recordOpInScreening` | **nothing** |

Both halves of the attribution existed and were already being written. Neither
had a reader. So the ledger is a READ, not a schema change: no migration, no
wire change, and a library reviewed before it shipped has a full history.

### Five findings

**F-L1. One doc per source is correct and must stay.** Every note about a
source lands in one `ReviewDoc`, and the invariant is written into
`ReviewComment.sessionId`'s own comment: opening that source SOLO, with no
screening files present, must still show every note ever made about it.
Partitioning notes per session would break it, and would also mean a note
existed in two places.

**F-L2. A session is not a version.** A `ReviewVersion` is a new CUT: it owns
its own approval state (`ReviewDoc.status` is keyed by version id) and
`carriedComments` deliberately carries unresolved notes forward across one.
Three sessions watching the same cut are one version. Minting a version per
session would fork approval and start carrying notes into a cut that never
changed. "Automatic versioning" is the right instinct on the wrong axis: what
changed between session 1 and session 3 is the ROOM, not the picture.

**F-L3 (defect). `comment.sessionId` is only trustworthy for your own notes.**
`ScreeningDoc.id` is a `crypto.randomUUID()` minted per machine, deliberately
(nothing correlated two attendees' files, because nothing needed to). A note is
stamped by its AUTHOR, on the author's machine, and relayed verbatim. So a note
that arrived from a peer carries an id matching no screening on this Mac. A
ledger keyed on `sessionId` would show only the notes you wrote yourself, in a
list that looks complete. This is the finding that decided the design.

**F-L4. `segment.commentIds` is the complete local record.**
`recordOpInScreening` runs for relayed ops as well as local ones ("Everyone's
notes belong to the screening, not just ours"), so it holds every root comment
this machine saw, whoever wrote it. The ledger reads this, and keeps
`sessionId` only as a fallback for a note the screening never recorded.

**F-L5. The screening index could not answer "which sessions watched this
clip".** It carried a title, times, participants and counts, but no source
keys, so the question needed every file opened. `ScreeningIndexEntry.sourceKeys`
is now written alongside them. It is OPTIONAL, and absent means UNKNOWN, never
none: reading absent as none would hide the entire history of anything
reviewed before it shipped, which is the exact material the ledger exists to
show. Entries without it are opened and checked; entries with it are skipped
unread.

### The resulting shape

`lib/review-ledger.ts` is pure and takes screenings + a source key + the doc's
comments, and returns sessions (newest first, each with its own comment ids)
plus a solo bucket for notes made alone. The panel filters through a lens whose
default is **All notes** - scoping by default would answer the original
complaint by hiding work someone did, which is worse than showing too much.

Replies are placed with their parent rather than bucketed on their own, or a
thread would appear in two sessions at once. Ids no longer in the doc are
dropped, so a deleted note leaves no phantom in a count. A session that watched
the source and collected nothing still lists: "we watched it and said nothing"
is a fact about that session.

## 5. What checks this

| test | what it holds |
|---|---|
| `invoke-contract` | every `write_text_to_path` call passes `atomic` |
| `storage-keys-contract` | every new key is namespaced `saucebunny.` |
| `secret-persistence-contract` | no secret is written outside the Keychain |
| `store-version-contract` | every file store writes a version AND refuses a future one |
| `cast-store` / `review-store` / `screening-store` / `transcript-project-store` | per-store hydration, merge and clobber guards |
