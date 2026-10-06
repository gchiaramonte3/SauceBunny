# Reconnect media, October 5: offline files, folders and library roots

**Goal (the owner, October 5):** when media, a folder or a whole library root
goes offline, reconnect it instead of losing it, the way Premiere Pro's Link
Media does. Think through the flow, and write it against this codebase.

**Source:** a read of every place the app stores a path to local media (file
references below), the two relink mechanisms that already exist (AAF Audio's
linked media and Library project folders' "Relink…"), and Premiere Pro's Link
Media dialog as the model.

**Status (2026-10-05):** spec written. Phase 1 is built in the same pull request
(see "As built" under phase 1). Phase 2's core (2, 2a, 2c) is built in the same
pull request; its remembered mappings (2b), identity cache (2d) and Search a
folder… are not. Phases 3 and 4 are not built.

**Rules that hold in every phase:**
- **Offline is a state, not a deletion.** Nothing is removed from the Library,
  Continue, the transcript history, a project folder or a review because its
  file cannot be reached. Removing is always a separate, explicit click.
- **Nothing waits on a network volume on the main thread.** Every availability
  check runs off it, with a time limit per volume, and a volume that does not
  answer is reported as not responding rather than waited on. This is the
  NEXIS freeze (`main-thread-contract`, `asset_protocol.rs`) applied to the
  one feature most likely to stat a dead mount.
- **A drive that is not mounted is never searched.** Whether `/Volumes/NEXIS`
  is mounted comes from the kernel's mount table (`getmntinfo`, `MNT_NOWAIT`),
  not from touching the path, so an unmounted server cannot hang the check.
- **One located item reconnects everything that moved with it.** A move is
  almost always a folder moving, a drive being renamed or a project being
  copied, so the path change learned from one item is tried on every other
  offline item before anyone is asked again (Premiere's "Relink others
  automatically", and what AAF Audio already does in `linked_paths.rs`).
- **Verify, then reconnect; never guess between two.** A candidate is accepted
  only when its name, size and (when known) duration match what was last seen.
  A different size is shown as "changed" and needs a click. Two equally good
  candidates are both shown and the person picks one; the app never does.
- **One undo for a whole reconnect.**
- **Local only.** No mount, no network call, no credential. A server name in a
  path is a name, never an address to contact (as in AAF Audio).
- The CLAUDE.md contracts, `npm run verify`, and the build-ID bump whenever
  an invoke shape changes.

| Phase | Goal | Depends on |
|---|---|---|
| 1 | Offline roots: say why, reconnect a root, come back by themselves when a drive mounts; stop deleting recents | nothing |
| 2 | Offline files: a reconnect sheet when one is opened, and reconnecting others that moved with it | phase 1 |
| 3 | Reconnect Media: every offline item in one dialog, offline marks on tiles, menu and ⌘K | phase 2 |
| 4 | The AAF file itself, and one path resolver for AAF Audio and the Library | phase 2 |

---

## What happens today

Measured by reading the code on October 5.

**Library roots** are bare strings in `localStorage` `saucebunny.libraryRoots`
(`src/lib/library.ts:15`), scanned by `scan_library_folder`
(`src-tauri/src/commands/library.rs:247`, off the main thread). A missing root
comes back as `NotFound`, which `formatError` renders as "Not found: /path"
(`src/lib/error-format.ts:62`), and Home shows it as a red error row with
Retry (`src/components/LibraryView.tsx:375`). That is the row in the owner's
screenshot. The same row is used for a folder that was moved, a drive that is
not mounted, a permission problem and "not a folder"; nothing tells them apart.

- On the **Library page** an offline root simply disappears: the tree is given
  only roots that scanned (`LibraryBrowser.tsx:226`), so it cannot be retried
  or removed there, and its files drop out of All without a word.
- **Nothing notices a drive mounting.** Roots are scanned at launch, on Add, on
  Retry and on Rescan only. Mounting NEXIS after launch leaves its roots
  "Not found" until someone clicks.
- **A scan has no time limit.** A root on a volume that stops answering stays
  on "Scanning…" for ever, holds one of three scan workers, and keeps Rescan
  disabled (`use-library-scan.ts:711`).

**Files** are referenced by absolute path in about twenty stores, almost all
with no content fingerprint beside the path:

| Store | Holds | File |
|---|---|---|
| Continue (`saucebunny.recentSources`) | path, title, duration | `src/lib/recent-sources.ts` |
| Transcript history (`saucebunny.transcriptHistory`) | SRT path ↔ media path | `src/lib/transcript-history.ts` |
| Library project folders (`Library/organization.json`) | locators, disk Favorites | `src/lib/library-organization.ts` |
| Posters, source timecode, in/out marks, custom columns, exclusions | path → value | `library.ts`, `source-marks.ts`, `custom-columns.ts`, `library-hidden.ts` |
| Clip queue, recent exports | source paths | `src/lib/storage.ts`, `App.tsx` |
| Review docs, received-as, review history | first path, version paths | `src/lib/review.ts` |
| Tree expansion | folder paths | `LibraryTree.tsx` |
| AAF Audio documents | the `.aaf` path; linked media with fingerprints | `aaf/model.rs`, `aaf/store.rs` |

What a missing file does today:

- **Opening it from Continue removes it from Continue** (`App.tsx:2339`) with
  the toast "Removed from recents". For a file on a drive that is simply not
  mounted yet, that throws the entry away. This is the opposite of the goal and
  is fixed in phase 1.
- Opening it from the Library or the transcript history shows "Couldn't
  resolve source" or "Opened without its video", with no way to point at the
  file.
- A Home tile shows the placeholder film icon and the filename (the second row
  of the screenshot) and still says "Local file".

**What already reconnects:**

- **AAF Audio linked media** (`aaf/linked.rs`, `aaf/linked_paths.rs`,
  `use-multitrack-relink.ts`): Refresh availability, Locate media folder,
  Locate file, remembered prefix mappings, a bounded folder search, MXF
  identity, "Use this copy" when two candidates fit. It is verified against
  NEXIS (`docs/NEXIS-RELINK-VERIFICATION.md`). It works per document and
  shares nothing with the Library.
- **Library project folders** (`LibraryProjectPane.tsx`): a per-item
  "Relink…" that rewrites `organization.json` only. It does not move the
  item's poster, timecode, review link or transcript, and checks nothing about
  the file chosen.
- **The rename bridge** (`src/lib/rename-apply.ts` `repathIdentity`): when the
  Library renames or moves a file itself, it moves the poster, the timecode,
  the review fingerprint link, the project locator and the transcript history
  entry. It does not move in/out marks, custom columns, exclusions, Continue,
  the clip queue or tree expansion, and it is never used for a move made in
  Finder.

---

## The states an item can be in

One check, `media_availability`, answers for any list of paths. It never opens
a file and never touches a path on a volume that is not mounted.

| State | Means | What the person sees | What they can do |
|---|---|---|---|
| **online** | it is there | nothing | |
| **drive offline** | the path is under `/Volumes/<name>` and `<name>` is not mounted | "NEXIS is not connected" | connect the drive (it comes back by itself), or Locate elsewhere |
| **missing** | the drive is there (or the path is local) and the item is not | "Moved, renamed or deleted" | Locate, Search a folder, Remove |
| **not responding** | the volume did not answer within its time limit | "NEXIS is not responding" | Retry (automatic on the next check) |
| **no access** | the item is there but cannot be read | "Sauce Bunny cannot read this folder" | Open System Settings (Files and Folders), Retry |
| **changed** | it is there but its size or duration differs from when it was last opened | "This file changed since it was last opened" | Use it anyway, or Locate the original |

"Drive offline" and "missing" are the two that matter, and the difference is
the whole point of this section: an editor whose NEXIS is unmounted should be
told to connect it, not to go hunting for files that are exactly where they
were.

Time limits: two seconds per volume. The first path on a volume that does not
answer marks the whole volume not responding for that check, so a thousand
items on a stalled NEXIS cost two seconds, not two thousand.

---

## Phase 1: offline roots, and nothing deleted

**Status (2026-10-05):** built (see "As built" below).

### 1a. A root that is offline says why, and can be reconnected

The red "Not found: /Users/…/Desktop/Test" row becomes an offline row that
names the state and offers the next step. It is not red: an unmounted drive is
not an error.

```
Test                                                     offline
  ⌁  NEXIS is not connected
     /Volumes/NEXIS/Show/Test
     Sauce Bunny reconnects it when NEXIS mounts.        [Locate folder…]  [Remove]

Test                                                     offline
  ⌁  This folder was moved or renamed
     /Users/editor/Desktop/Test                          [Locate folder…]  [Retry]  [Remove]

Test
  ⌁  NEXIS is not responding                             [Retry]
```

- **Locate folder…** opens the folder picker at the nearest folder that still
  exists (the root's parent, or `/Volumes`). The chosen folder replaces the
  root in place: same position on Home, same tree expansion, and every store
  keyed under the old path moves with it (1c).
- **Remove** is the existing remove, with its existing confirmation.
- **Retry** scans again. On "drive offline" it is not offered, because the
  mount watch (1b) does it.

The **Library sidebar keeps offline roots**, dimmed, with the same state as a
tooltip and the same three actions in their right-click menu. Today they
vanish, which is how a missing root becomes a library that is quietly smaller.

### 1b. A drive that mounts brings its roots back

The backend watches the mount table (`getmntinfo`, `MNT_NOWAIT`, every three
seconds on a background thread; cheap, and it cannot block) and emits
`media:volumes-changed` when a volume mounts or unmounts. On that event, and
when the window regains focus, the Library re-checks its offline roots and
scans the ones that came back. Mounting NEXIS after launch now fills its
shelves without a click.

Every scan asks `media_availability` first, with its per-volume limit, so a
root on a volume that does not answer becomes "not responding" instead of
"Scanning…" for ever, and is not handed to a scan that would hang.

### 1c. Moving a root moves everything under it

Reconnecting a root is a prefix change, `/old/root/…` → `/new/root/…`, applied
to every store that keys a path under it: the root list itself, tree
expansion, posters, source timecodes, in/out marks, custom column values,
exclusions, Continue, the clip queue, transcript history, project folder
locators and disk Favorites, and the review links (by adding the new path to
the fingerprint index; a review doc's key never changes). One function does
this for every caller, `relinkPrefix(from, to)` beside `repathIdentity` in
`rename-apply.ts`, so the next store that keys a path has one place to be
added, and a test that lists the stores fails when one is missed.

The same function serves renames done in the app, which closes the stores
`repathIdentity` misses today (marks, custom columns, exclusions, Continue).

### 1d. Continue stops deleting entries

Opening a Continue item whose file is unreachable no longer removes it. In
phase 1 it says why ("NEXIS is not connected" / "moved or renamed") and keeps
the entry; phase 2 replaces the message with the reconnect sheet.

### As built (phase 1)

- **Backend:** `src-tauri/src/commands/availability.rs`: `media_availability`
  (async, on the blocking pool, at most 2,000 paths) and `watch_volumes`
  (started in `lib.rs` setup). The rules are a pure `classify` over a mount
  table and a probe, tested without a filesystem: an unmounted drive is never
  touched, and a volume that does not answer is asked once per check. A probe
  that never returns leaves its volume marked stalled, so later checks do not
  pile up stuck threads behind it. The Pipeline's volume list now reads the
  same mount table (`aaf/health.rs`).
- **Scan:** `use-library-scan.ts`: `RootScan` gains `offline` (state and
  drive name); a root is asked about before it is scanned; offline and failed
  roots are asked again on `media:volumes-changed` and on window focus;
  `locateRoot` replaces a root in place (or merges it into one the library
  already has) and calls `moveStoredPaths`. Tested in
  `use-library-scan.offline.test.ts` (break-tested: removing the check, the
  listener or the move fails it).
- **Moving records:** `src/lib/relink.ts` `moveStoredPaths` moves posters,
  source timecodes, in/out marks, exclusions, chapters and cut markers,
  transcript history, files received in a session, past reviews and project
  folder locators and disk Favorites; `PATHS_MOVED_EVENT` (`use-paths-moved`)
  moves Continue, the clip queue, custom column values and the tree's open
  folders, which components hold in state. `relink.test.ts` seeds each store
  with a record inside the folder and one beside it (`/Test` and `/Testing`).
- **UI:** `LibraryOfflineRoot.tsx` (Home) and `LibraryOfflineRoots.tsx` (the
  Library sidebar, under the tree), both worded by `src/lib/media-offline.ts`.
- **Continue:** opening an entry whose file cannot be reached keeps it and
  says why (`offlineFileCopy`), instead of "Removed from recents".
- **Not yet:** undo for a root reconnect (Locate folder again moves it back);
  the rename bridge still uses `repathIdentity` for single files, which phase
  2 widens to the stores it misses.

---

## Phase 2: reconnect a file when it is opened

**Status (2026-10-05):** 2, 2a and 2c built (see "As built" at the end of this
phase); 2b, 2d and Search a folder… are not.

Opening anything whose file is offline (a Continue tile, a Library item, a
transcript, a project folder item) opens a small sheet instead of an error:

```
Where is KT#778-JIMMY-CARR-1-2.mp4?
It was in /Volumes/NEXIS/Show/Day 3/Selects. That folder is not there now.

  [Locate file…]   [Search a folder…]                         [Cancel]

  ☑ Reconnect other offline files that moved with it
```

- **Locate file…** opens the file picker filtered to the same extension, at
  the nearest folder that exists. The chosen file is checked (name, size,
  duration from the identity cache, 2d). A match reconnects at once. A
  mismatch says what differs ("1.2 GB, was 1.4 GB") and offers **Use this file
  anyway**.
- **Search a folder…** looks under a chosen folder for the same filename
  (bounded: 20,000 entries, 12 levels, no symlinks, cancellable, a job id
  minted in the renderer like every other cancellable job). One match is
  offered; several are listed with their sizes and dates and the person picks.
- For "drive offline" the sheet leads with the drive: "This file is on NEXIS,
  which is not connected. Connect it and it opens by itself." with **Locate
  elsewhere…** underneath.

### 2a. Reconnect others automatically

After one file is reconnected, the app derives the path change (the longest
common tail of old and new path, so `/Volumes/NEXIS/Show/Day 3/a.mov` →
`/Volumes/NEXIS 1/Show/Day 3/a.mov` teaches `/Volumes/NEXIS` →
`/Volumes/NEXIS 1`), tries it on every other offline reference, and
reconnects the ones that match by name and size. The sheet ends with
"Reconnected 14 files. 2 are still offline: Review…". This is the
`linked_paths::remember` rule that AAF Audio already uses: a mapping is only
learned from an item whose filename did not change.

### 2b. Remembered path changes

Learned mappings are kept in `app_data_dir()/path-mappings.json` (`{from, to,
learnedAt}`, newest first, at most 200) and tried before anything is reported
offline, so a NEXIS workspace that mounts under a new name next week resolves
without asking. Settings ▸ General ▸ Library lists them with Forget.

### 2c. The rewrite and its undo

`relinkPaths(pairs)` (the file-level sibling of 1c's `relinkPrefix`) moves
every store's key for each pair in one transaction and returns the inverse
pairs. Undo is one step for the whole reconnect, through the same undo HUD the
Library's moves use.

### 2d. The identity cache

To verify a candidate the app needs what the file was. `probe_local_file`
already reads size, modification time and duration on every open, so it
records `{size, modifiedMs, durationSeconds, width, height}` per path in
`app_data_dir()/media-identity.json` (an LRU of 5,000 entries, about 600 KB,
written off the main thread). Losing it only weakens verification to
name-and-size; nothing depends on it existing. Library scans add size and
modification time for every file they list.

### As built (phase 2)

- `src/components/ReconnectFileSheet.tsx`, opened from Continue (Home's
  Resume and the Continue row) and the Library when `loadLocalPath` answers
  NotFound. It asks `media_availability` first: a drive that is not
  connected waits (`media:volumes-changed`) and opens the file by itself; a
  moved file offers Locate file… (any video or audio file).
- The located file is probed and compared by `fileDifferences`
  (`src/lib/media-offline.ts`): name, and length when Continue knew it, to
  half a second. A difference is listed and needs "Use this file anyway".
- `othersThatMoved` (`src/lib/relink.ts`) learns the folder change only from a
  file whose name did not change, and applies it to every stored path under
  the old folder (`storedPathsUnder`: posters, timecodes, marks, transcript
  history, Continue, the clip queue). A candidate moves only when it is gone
  from the old place and present at the new one, checked in one
  `media_availability` call.
- `reconnectFiles` moves every pair's records as one undo step ("reconnect N
  files").
- Tests: `ReconnectFileSheet.test.tsx` (waits for a drive; locates and brings
  the others; a different file needs a click; break-tested by moving a file
  still at its old place), `relink.test.ts` (mapping, discovery, undo),
  `e2e/reconnect-media.spec.ts` (Resume on Home, through to Continue and
  posters moved on disk).
- **Still to build:** remembered mappings (2b), the identity cache (2d), Search
  a folder…, and the sheet for transcripts opened from the history (which
  still say "Opened without its video").

---

## Phase 3: Reconnect Media, for everything at once

**File ▸ Reconnect Media…**, ⌘K "Reconnect media", and a small "14 offline"
pill at the top of the Library sidebar (shown only when something is
offline) open one dialog:

```
Reconnect media                                   14 offline in 3 places
───────────────────────────────────────────────────────────────────────────
▾ /Volumes/NEXIS/Show/Day 3          12 files    NEXIS is not connected
    KT#778-JIMMY-CARR-1-2.mp4    Video    Continue, Transcripts     ⌁
    DIGGER-Official-Trailer.mp4  Video    Library                   ⌁
    …                                                   [Locate folder…]
▸ /Users/editor/Desktop/Test         1 folder    Moved or renamed   [Locate folder…]
▸ /Users/editor/Downloads             1 file     Moved or renamed   [Locate…]
───────────────────────────────────────────────────────────────────────────
▸ Match on: ☑ name  ☑ size  ☑ duration       ☑ Reconnect others automatically

[Remove from Library…]                               [Cancel]  [Reconnect 13]
```

- **Grouped by folder**, because moves are folder moves; one Locate folder…
  per group usually fixes the group.
- **Where it is used** comes from the stores that reference it, so the person
  knows what they lose by removing it.
- **After a locate the rows preview the result** before anything is written:
  found (a check), changed (what differs, with Use anyway), two candidates
  ("Use this copy", as in AAF Audio), still missing. **Reconnect N** writes
  them, as one undo.
- **Remove from Library…** is the explicit way to stop referencing items
  (Premiere's "Offline"): it asks, and lists where each is used.
- **Not opened automatically.** Premiere opens Link Media when a project
  opens; doing that here would put a modal in front of every NEXIS editor who
  launches before mounting. The pill and the per-file sheet are enough.

Tiles and list rows of offline items keep their place and show an offline
mark. The top-left corner already holds the WEB/SRT/VTT badge and the review
chip (`library.css:546`, `review.css:1145`), so the mark goes top-right, and
the art dims. Clicking an offline tile opens phase 2's sheet.

**The toast problem:** `CanvasToast` renders only inside the Clip view's
monitor (`Monitor.tsx:378`), so "Reconnected 14 files" fired from Home or the
Library would reach the bell but not the screen. Phase 3 reports results
inside the dialog and the sheet, and adds a toast host to Home and the
Library rather than relying on the monitor's.

---

## Phase 4: the AAF file itself, and one resolver

- **An AAF Audio document whose `.aaf` moved** cannot be reopened today:
  `store::source_ready` requires the same path, size, time and fingerprint
  (`aaf/store.rs:367`), and importing it again from its new place makes a new
  document with no transcripts while String Outs keeps pointing at the old
  one. Reconnecting the `.aaf` through the same sheet (verified by its
  existing bounded SHA-256 fingerprint, minus the modification time a copy
  loses) keeps the document, its transcripts and its string outs.
- **One resolver.** `linked_paths.rs`'s candidates, suffix search and
  remembered mappings become `src-tauri/src/relink.rs`, used by AAF Audio and
  by the Library, so a NEXIS rename learned in one is known to the other.
  `library_reference_status` is replaced by `media_availability`.

---

## Decisions (the owner agreed all three as recommended, 2026-10-05)

1. **The Reconnect Media dialog does not open by itself** when the app starts
   with offline items (see phase 3); a pill instead, because the owner often
   launches before NEXIS is mounted.
2. **"Reconnect others automatically" is on by default**, as in Premiere; it
   only acts on items whose name matches and that are present at the new place.
3. **"Changed" (same name, different size or length) stops for one click**: a
   re-exported file with the same name is a different cut, and its review
   notes may not apply.

---

## Not in scope

- Mounting servers or remembering credentials (never).
- Relinking web sources (they have URLs, and the cache already re-fetches).
- Relinking the outputs of exports (`cp-recents` points at files the app made;
  they are listed as offline but not searched for).
- Watching folders for new files (a separate feature: live scans already show
  new files on the next scan).
