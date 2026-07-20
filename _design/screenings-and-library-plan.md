# SAUCE BUNNY: SCREENINGS + LIBRARY + SHARING — EXECUTION PLAN

**Repo: `/Users/gchiaramonte/sb-ui-v3`** (git worktree of `/Users/gchiaramonte/Desktop/Clip Pull`, currently 2 commits ahead at `7b2b2ff`). All work happens there. All paths below are relative to that root.

---

## 0. VERIFIED GROUND TRUTH

I re-read the load-bearing code. Corrections to the four reports, which disagreed on line numbers:

| Claim | Verified location |
|---|---|
| The seeding guard | `src/hooks/use-co-review.ts:469` — `if (coSession.role === "host" && prev !== "host" && reviewSourceKey)` |
| Dep array (does re-run on source change) | `use-co-review.ts:487` — `[coSession.role, reviewSourceKey]` |
| `prevCoRoleRef` set before the guard | `use-co-review.ts:465`, assigned at `:468` — so `prev` is already `"host"` and the body is skipped |
| Session-end misfile | `use-co-review.ts:479` — `if (d && d.sourceKey) saveReview(mergeReviewDoc(loadReview(d.sourceKey), d));` |
| `mergeReviewDoc` has **no** sourceKey guard | `src/lib/review.ts:518-544`; returns `{ ...incoming, comments, status }` — `incoming.sourceKey` wins unconditionally |
| Guest adopts the host's doc wholesale | `use-co-review.ts:336-345` — `setSessionDoc((prev) => (prev ? mergeReviewDoc(prev, incoming) : incoming))` |
| Host broadcasts `reviewDoc` **only on join** | `use-co-review.ts:524` — inside the peer-count-rise fan-out; never on source change |
| **Local-file identity split** | `App.tsx:4608-4610` `reviewSourceKey` = **path**; `App.tsx:4593-4600` `sessionSource.reviewKey` = **fingerprint**. Different strings. |
| `screening` is today the theater toggle | `use-co-review.ts:619` `const [screening, setScreening] = useState(false)`; consumed at `App.tsx:4928, 5032, 5429, 5468` |
| Flat-flatten blocks column view | `src/lib/library.ts:62-66` `collectLibraryItems`, consumed at `LibraryBrowser.tsx:150-152` |
| Scan depth wall | `src/lib/library.ts:18` `LIBRARY_SCAN_DEPTH = 3` |
| Share MSE has no eviction | `src/lib/share-stream.ts:46` — `try { sb.appendBuffer(chunk); } catch { died(); }` |
| The proven fix already exists | `src/components/MSEStreamPlayer.tsx:497-505` — `QuotaExceededError` → `queueRef.current.unshift(item)` + `sb.remove(0, v.currentTime - 10)` |

The bug is confirmed exactly as diagnosed, **plus** two amplifiers no report should let the implementer miss: the guest cross-contamination path at `:342` and the local-file key split at `App.tsx:4608` vs `:4599` (which loses a guest's notes on **every** local-file session, source change or not).

**Naming collision — resolve in Phase 1, non-negotiable.** `screening` currently means the theater layout toggle. Rename it `theater` / `setTheater` / `theaterParticipants` across `use-co-review.ts:141,143,619,632,689,694,801` and `App.tsx:4642,4928,5032,5033,5429,5468,5472,5629` **before** the noun is reused. The CSS class `cp-room-theater` is already correctly named; no CSS churn.

---

## 1. THE SCREENING MODEL

### 1.1 The one decision everything follows from

**A screening is an INDEX over per-source ReviewDocs. Comments live in exactly one place: the ReviewDoc. `Screenings/*.json` contains zero comment bodies.**

Rationale: `loadReview(sourceKey)` → panel already works (`ReviewPanel.tsx:573-574`), and it must keep working. If a screening owned copies, every solo open would need to scan every screening and reconcile two directions. Ids are already globally unique and stamped once at author time (`review.ts:97-103`, `:245-259`), so id-pointers are free.

### 1.2 Types — `src/lib/screening.ts` (new, pure, ~130 lines)

```ts
/** A screening is a memory of a room, not an identity record: member ids are
 *  only valid inside the live session, so we keep display names. */
export type ScreeningParticipant = { name: string; color: string; isHost: boolean };

/** One source watched during one screening. The comments live in that source's
 *  ReviewDoc; this holds pointers plus enough denormalized data to render a
 *  card without opening the doc. */
export type ScreeningSegment = {
  id: string;
  /** Portable content identity, straight off the loadSource wire message.
   *  This is what crosses machines. */
  kind: "web" | "file";
  url: string | null;
  fingerprint: string | null;
  /** THIS machine's review-doc key — the same string App.tsx:4608 computes.
   *  loadReview(localSourceKey) opens the notes. null = we never resolved it. */
  localSourceKey: string | null;
  /** The version inside that doc the comments were filed against. */
  versionId: string | null;
  title: string;
  duration: number | null;
  startedAt: number;
  endedAt: number;
  /** Root-comment ids minted during THIS segment, creation order. */
  commentIds: string[];
  /** commentIds.length at close. List rendering never opens the doc. */
  commentCount: number;
  /** False when this machine never got the source open (the "missing" tier at
   *  use-co-review.ts:322). Segment still lists; card offers "Find my copy". */
  watched: boolean;
};

export type ScreeningDoc = {
  /** Minted by the HOST and broadcast, so every attendee's record shares it. */
  id: string;
  title: string;
  startedAt: number;
  endedAt: number;
  role: "host" | "guest";
  participants: ScreeningParticipant[];
  segments: ScreeningSegment[];
};
```

Pure helpers in the same file: `newScreening(id, title, role, now)`, `openSegment(doc, src, key, versionId, now)`, `closeSegment(doc, now)`, `noteComment(doc, commentId)`, `unnoteComment(doc, commentId)`, `screeningIsWorthKeeping(doc)`.

**Discard rule** (`screeningIsWorthKeeping`): persist iff `segments.some(s => s.localSourceKey || s.fingerprint || s.url)` **or** `participants.length > 1`. A solo "started and immediately ended, nothing loaded" writes nothing.

### 1.3 On-disk layout — `src/lib/screening-store.ts` (new, ~200 lines)

```
~/Documents/Sauce Bunny/
  Reviews/       ← UNCHANGED, byte for byte
  Transcripts/   ← UNCHANGED
  Screenings/
    index.json
    2026-07-20-quarterly-cut-3f2a1b9c.json
```

**Flat, not `YYYY-MM/`.** `parseReviewIndex` rejects any `file` containing a path separator as a traversal guard (`review-store.ts:141-142`); copying that guard verbatim is worth more than folders. Screenings are tens of small files, not thousands.

```ts
export type ScreeningIndexEntry = {
  file: string;              // no path separator — reuse the traversal guard
  title: string;
  startedAt: number;
  endedAt: number;
  participants: string[];    // display names
  segmentCount: number;
  commentCount: number;
  posterSourceKey: string | null;  // segment whose art represents the card
  bytes: number;
};
type ScreeningIndexFile = { version: 1; screenings: Record<string, ScreeningIndexEntry> };
```

Filename: `<YYYY-MM-DD>-<slug(title)>-<fnv1a(id)>.json`, reusing the slug + `fnv1a` rules from `review-store.ts:97-119`.

**Boot cost is one small file.** Unlike reviews, screenings are never read synchronously, so `hydrateScreeningIndex()` reads **only `index.json`**; a full `ScreeningDoc` is read on demand via `loadScreening(id)`. Same four existing invoke commands — `default_transcript_library_path`, `ensure_dir_exists`, `read_text_file_capped`, `write_bytes_to_path` (all used at `review-store.ts:281,214,299,244`). **No new Rust commands for the store.**

Mirror `review-store.ts` exactly for: dir derivation (`:283-291`), one-shot hydrate flag (`:281`), junk-tolerant index parse, `pagehide` best-effort flush (`:333`). Skip the 500 ms debounce — screening writes are event-driven and rare; write immediately.

### 1.4 Migration: purely additive, zero backfill, zero data loss

1. `ReviewDoc`, `Reviews/`, `Reviews/index.json`, `saucebunny.review.*` — **untouched**. No index version bump. A user who never starts a session sees no change on disk.
2. First boot with the feature: `Screenings/` is missing → hydrate warns and yields an empty Map, exactly like `review-store.ts:297-305`. Home/Library show an empty state.
3. **Do NOT synthesize past screenings from `saucebunny.review.history`.** `ReviewHistoryEntry` (`review.ts:207`) is per-source with no session grouping, no start time, no participants. Fabricating records would invent attendees. Screenings start from the ship date; say so in the empty-state copy.
4. `ReviewHistoryEntry` stays and keeps powering the past-reviews popover (`ReviewPanel.tsx:986-1008`). Screenings are a **second, independent** index over the same docs.
5. Docs already polluted by the bug cannot be un-mixed automatically — a misfiled comment is indistinguishable from a real one. Ship no auto-repair. The `.bak` files from the shrink guard (`review-store.ts:230-242`) are the only recovery surface; mention them in the release note.

### 1.5 THE BUG FIX — exactly what writes at what moment

Replace `use-co-review.ts:465-487` wholesale. The new effect is **source-transition-aware**, not role-transition-aware, and it **closes before it opens**.

```ts
const prevCoRoleRef = useRef("off");
const seededKeyRef = useRef<string | null>(null);
const screeningRef = useRef<ScreeningDoc | null>(null);

useEffect(() => {
  const prev = prevCoRoleRef.current;
  prevCoRoleRef.current = coSession.role;
  const role = coSession.role;

  // ── session start ────────────────────────────────────────────────────────
  if (role !== "off" && prev === "off") {
    screeningRef.current = newScreening(
      role === "host" ? newScreeningId() : (adoptedScreeningIdRef.current ?? newScreeningId()),
      metadataRef.current?.title ?? "Screening",
      role === "host" ? "host" : "guest",
      Date.now(),
    );
    // NO disk write. A three-second misclick must not leave a file.
  }

  // ── source seeded OR CHANGED (host) ──────────────────────────────────────
  if (role === "host" && reviewSourceKey && seededKeyRef.current !== reviewSourceKey) {
    // 1. CLOSE the outgoing segment and PERSIST its comments under ITS OWN key.
    const out = sessionDocRef.current;
    if (out?.sourceKey && out.sourceKey !== reviewSourceKey) {
      saveReview(mergeReviewDoc(loadReview(out.sourceKey), out));
    }
    if (screeningRef.current) {
      screeningRef.current = closeSegment(screeningRef.current, Date.now());
      void writeScreening(screeningRef.current);   // checkpoint: a crash loses ≤ 1 segment
    }

    // 2. OPEN the new one.
    const { doc } = ensureVersion(
      loadReview(reviewSourceKey), reviewSourceKey, metadataRef.current?.title ?? undefined,
    );
    seededKeyRef.current = reviewSourceKey;
    setSessionDoc(doc);
    if (screeningRef.current) {
      screeningRef.current = openSegment(
        screeningRef.current, sessionSourceRef.current, reviewSourceKey,
        doc.activeVersionId, Date.now(),
      );
    }

    // 3. Re-broadcast so guests adopt the NEW doc instead of accruing into the old.
    //    Today this only fires on join (use-co-review.ts:524) — that is the
    //    other half of the bug.
    void invoke("session_broadcast", {
      msg: { kind: "reviewDoc", doc: JSON.stringify(doc) },
    }).catch(() => {});
  }

  // ── session end ──────────────────────────────────────────────────────────
  if (role === "off" && prev !== "off") {
    const d = sessionDocRef.current;
    if (d && d.sourceKey) saveReview(mergeReviewDoc(loadReview(d.sourceKey), d));
    let sc = screeningRef.current;
    if (sc) {
      sc = closeSegment(sc, Date.now());
      sc = { ...sc, endedAt: Date.now(), participants: snapshotParticipants() };
      if (screeningIsWorthKeeping(sc)) void writeScreening(sc);
    }
    screeningRef.current = null;
    seededKeyRef.current = null;
    setSessionDoc(null);
    setCoGhosts([]); setLiveReactions([]); setRaisedHands(new Set());
    coLastHostPosRef.current = null;
    coReadyRef.current = false;
  }
}, [coSession.role, reviewSourceKey]);
```

**Guest mirror** — three changes, all in `coApplyRef.current`:

- **`case "loadSource"`** (`use-co-review.ts:269`): when `m.reviewKey !== sessionDocRef.current?.sourceKey`, first flush the outgoing doc (`saveReview(mergeReviewDoc(loadReview(out.sourceKey), out))`), close the segment, then `setSessionDoc(null)` and wait for the host's `reviewDoc`. Never keep accruing against the old key.
- **`case "reviewDoc"`** (`:336-345`): **re-stamp `sourceKey` to this machine's key before adopting.** The host broadcasts a doc whose `sourceKey` is a host-local path (`App.tsx:4608`) while the wire identity is a fingerprint (`App.tsx:4599`). Add `stampSourceKey(incoming, myLocalKey)` where `myLocalKey = resolveByFingerprint(pendingSource.fingerprint) ?? localFilePath ?? incoming.sourceKey`. This alone fixes total guest data loss on every local-file screening.
- **`case "reviewOp"`** (`:346`): after `applyReviewOp`, feed segment bookkeeping — `op.t === "add" && op.comment.parentId === null` → `noteComment`; `op.t === "del"` → `unnoteComment`. Same at `postSessionOp` (`:260`) for locally-authored ops.

**Hardening in `src/lib/review.ts:518`** — first three lines of `mergeReviewDoc`:

```ts
// Refuse to fold two DIFFERENT sources together. Without this a stale session
// doc silently refiles comments into another source's file (r-bug: mid-session
// source change) and a guest holding doc A folds it into an incoming doc B.
if (local.sourceKey && incoming.sourceKey && local.sourceKey !== incoming.sourceKey) return incoming;
```

**Screening id must be host-minted and broadcast.** Add one `SessionMsg` variant in Rust: `{ kind: "screening", id: String, title: String, startedAt: i64 }`, broadcast from the same join fan-out as the `reviewDoc` snapshot (`use-co-review.ts:516-534`). Regenerate `src/bindings/SessionMsg.ts` with `cargo test --lib`, and **bump the build ID in both `src/lib/build-id.ts` and `src-tauri/src/commands/system.rs`** (CLAUDE.md "Build-ID handshake").

**Guests persist their own record — yes.** There is no server and the host is not queryable later (`use-co-review.ts:8-13`). A guest already persists the underlying comments at `:479`; a screening record is ~1 KB of pointers over data that is already on their disk. Records are **never reconciled** between attendees — a late joiner honestly saw a different roster, and `role` distinguishes the two accounts.

### 1.6 Write timeline (authoritative)

| Moment | Disk write |
|---|---|
| Session start | none (in-memory `ScreeningDoc` only) |
| Comment add/del | none (in-memory `commentIds` bookkeeping) |
| **Source change mid-session** | `saveReview` outgoing doc **+** checkpoint `writeScreening` |
| Session end | `saveReview` final doc **+** `writeScreening` + index entry (if `screeningIsWorthKeeping`) |
| Crash mid-segment | comments survive (previous boundary already saved); that segment's screening membership is lost |

---

## 2. WHERE SCREENINGS SURFACE

**A screening is an event, not a file, so it never appears as a row inside a real folder's listing.** Injecting it there breaks the disk mirror, breaks Reveal in Finder, makes sort-by-size incoherent, and makes multi-select semantics ambiguous. Three surfaces, exactly:

**(1) A "Screenings" smart source in the left panel** — a sibling of the existing `"all"` pseudo-row (`LibraryTree.tsx:41-43`), above the roots, same `role="treeitem"` treatment, participants glyph. Selecting it makes the main pane list `ScreeningDoc`s in whichever view is active. This is the one place a screening is the primary object.

- **List view:** columns remap — Kind → "Screening", Size → participant count, Modified → session date, Notes → `commentCount`, Duration → session length.
- **Icon view:** tile art is the poster segment's source art with a `.cp-lib-badge-screened` overlay.
- **Column view:** selecting one opens a session info pane (participants, date, duration, notes) with grey-chip actions.
- Screening rows are never draggable to Finder; the context menu has **no** "Reveal in Finder" but does carry "Reveal the source file" when `localSourceKey` is non-null and still exists.

**(2) As a badge on the file that was screened** — `.cp-lib-badge-screened` count pill in icon view, optional "Screenings" column in list view, `--fg-4` glyph in column-view rows. This is the join from event back to file, keyed on `localSourceKey`.

**(3) In the info pane's Screenings section** — up to 3 recent records (`date · N people · N notes`), then "See all".

**Opening a screening** does not open a player. It opens a **segment list**: one row per segment (title, poster, duration watched, N notes), each row a grey chip "Open with these notes" that (a) resolves `localSourceKey`, falling back to `resolveByFingerprint(fingerprint)` (`review.ts` ladder tier 1), (b) loads the source in Clip, (c) opens the Review panel filtered to that segment's `commentIds`. A segment with `localSourceKey === null` renders "Find my copy" instead, reusing `adoptPendingSource` (`use-co-review.ts:773-788`) so the fingerprint links and resolves silently next time.

`commentIds` pointers go dangling if a comment is deleted solo. That is correct — deletion is deletion. Recompute the count on read; treat the stored `commentCount` as a listing hint only.

**Home:** one "Recent screenings" shelf via the existing `LibraryRow` (`LibraryRow.tsx`), placed after "Continue" and before the per-root shelves (`LibraryView.tsx:364-378`). Cards are `LibraryTile`s with the screened badge. Empty → the shelf is not rendered at all (no placeholder shelf on Home).

**Empty state (Screenings source):** "No screenings yet." plus a grey chip "Start a co-review" routing to the lobby. Not green — the lobby owns that primary action.

---

## 3. THE LIBRARY REBUILD

### 3.1 What is reused verbatim (do not rewrite)

1. **The Rust scan** — `src-tauri/src/commands/library.rs`. ~21 ms over 6k files, correct symlink/bundle/hidden/non-UTF-8 skips, missing-vs-denied distinction, `spawn_blocking`, 8 tests at `:240-479`. Only change: it is called with `max_depth: 1` for on-demand deepening (the arg already exists at `:230`).
2. **The entire thumbnail/poster subsystem** — `src/hooks/use-library-scan.ts:19-403` + `src-tauri/src/commands/media.rs:1151-1240`. Three caches, one concurrency gate, generation guards, correct blob revocation on all five exit paths. Reuse `requestThumbnail` / `requestHeroStill` / `requestHoverFrames` unchanged.
3. **`useLibraryScan` as the single scan owner** (`:449-542`), sweep token and all.
4. **`useLazyThumbnails`** (`src/hooks/use-lazy-thumbnails.ts:16-19`) — the intersection-not-mount choice is subtle and correct under `[hidden]` keep-alive. **One change:** share a single `IntersectionObserver` instance at module scope instead of one per element (`:55`); a multi-column view over a large tree does not survive per-card observers. No new dependency.
5. **`LibraryTree`'s keyboard model** (`:112-135`) and **`LibraryRow`'s DOM-driven roving tabindex** (`:31-99`) — these are the two halves of every keyboard model the new views need.
6. **`LibraryCardMenu`'s portal** (`:6-11`) — the overflow-clipping escape is hard-won and column view has the same problem.
7. **The CSS color/focus contract** — neutral `--bg-3` selection (`library.css:933-939`), one green live signal (`:970-973`), `--focus-ring` on wrappers via `:focus-within`.

### 3.2 What is replaced

- `LibraryBrowserPane.tsx` (grid + list dispatch) — **replaced** by three sibling view components.
- `LibraryListRow.tsx` — **rewritten** as a `role="row"` with `gridcell` children.
- `LibraryDetail.tsx` — **retired** in favor of `LibraryInfoPane.tsx`, one info surface across all three views.
- `LibraryHero.tsx` — **stays on Home only**, with its duplicate CTA collapsed (`:118-123`: "Resume" and "Open in Clip" call the identical `onOpen(recent)`; keep one, label it "Open in Clip"). It does **not** carry over to the Library.
- `LibraryCard.tsx` — **untouched**, keeps serving Home's shelves. It is already 237 lines with a documented waiver (`:1-4`); do not bolt badges or skim onto it.

### 3.3 Foundation (must land before any view)

**`src/lib/library-entries.ts`** (new, pure, ~110 lines)

```ts
export type LibraryEntry =
  | { kind: "folder";    folder: LibraryFolder;  path: string; name: string }
  | { kind: "file";      item: LibraryItem;      path: string; name: string }
  | { kind: "screening"; rec: ScreeningIndexEntry; path: string; name: string };
```

`path` is the sort/selection identity. Screenings use a `screening:<id>` prefix so they never collide with filesystem paths. **Do not widen the ts-rs-generated `LibraryItem`** (`src/bindings/LibraryItem.ts`) — the union is frontend-only.

- `libraryChildren(folder)` — **one level only**. Replaces `collectLibraryItems` in the browser pane. Do **not** modify `collectLibraryItems` (`library.ts:62-66`); Home's search and the "All" aggregate still need it.
- `sortLibraryEntries(entries, key, dir)` — **folders first, then files**, each group by the active key. Deliberate deviation from Finder: in a media library the container/leaf distinction is load-bearing. No preference toggle.
- `flattenVisibleRows(roots, expanded)` → `{ entry, depth, posinset, setsize }` for list-view disclosure.
- Fix the latent `out.push(...collectLibraryItems(sub))` spread at `library.ts:64` while in there — `RangeError` past ~65k args. One-line change to a loop.

Search stays **recursive** regardless of view (`searchLibrary`, `library.ts:140-165`). Browsing is per-level. Add a `.cp-lib-chip` "Include subfolders" (default **off**) so today's flat-wall behavior stays reachable — removing it outright is a visible regression.

**`src/lib/tree-nav.ts`** (new, pure, ~50 lines): `nextRow`, `prevRow`, `parentRow`, `typeSelectIndex(rows, buffer)`. Three call sites (existing `LibraryTree`, new list, new column) clears the 3+ bar. Pure functions, not a hook — testable without a DOM. Port from `LibraryTree.tsx:112-135`.

**`src/hooks/use-library-selection.ts`** (~90 lines): `{ anchor: string | null; paths: string[] }` with `click` / `shiftClick(path, orderedPaths)` / `cmdClick` / `selectAll` / `clear`. Range is contiguous over the **visible** order (Finder parity). Three call sites.

**`src/lib/library-prefs.ts`** (extracted from `LibraryBrowser.tsx:17-32`, same key `saucebunny.libraryBrowser`):

```ts
type BrowserPrefs = {
  view: "icon" | "list" | "column";
  sort: LibrarySortKey; dir: LibrarySortDir; kind: LibraryKindFilter;
  tile: 120 | 160 | 200 | 260;
  cols: Partial<Record<ColumnId, number>>;
  colWidth: number;
  columns: ColumnId[];
  recursive: boolean;
  selected: LibraryCrumb[] | null;   // now persisted
  treeOpen: boolean;                 // now persisted
};
```

**`normalizePrefs` must map legacy `"grid"` → `"icon"`** or existing installs silently fall back to the default. `LibrarySortKey` (`library.ts:88`) extends to add `"duration" | "kind" | "notes" | "captured"`.

**On-demand deepening** (fixes the depth-3 wall at `library.ts:18`): when a pane or expanded row targets a folder with `folders.length === 0 && items.length === 0` sitting at scan depth, fire `scan_library_folder(path, 1)` and splice into the in-memory tree in `useLibraryScan`. Render "Scanning…" (existing copy, `LibraryView.tsx:239`) meanwhile. Cache per folder path. **This must ship with column view, not after** — a column cascade hits the wall as an unexplained empty pane.

**`src/lib/media-meta.ts` + `src/hooks/use-media-meta.ts`** — `{ durationSec, width, height, codec, captureMs }`, sourced from **mediabunny, not a new sidecar call** (CLAUDE.md already designates it "the lightweight codec/duration probe"; it is bundled; no ffprobe spawn per file). IntersectionObserver-gated, concurrency-capped, module Map keyed `path#modified_ms`, mirrored to `saucebunny.libraryMeta` (LRU cap ~2000). **Degradation rule: unresolved meta renders nothing.** No spinner, no placeholder. Badge slots have fixed reserved height so nothing reflows. Every view must be fully usable with zero meta resolved — this is the clean cut line if the phase runs long.

### 3.4 The three views — component boundaries

All new CSS goes in **`src/styles/library-views.css`**, imported from `index.css` alongside `library.css` (which is already 1311 lines with four region banners). Same `cp-` prefix, tokens only.

**Icon view** — `role="listbox"` + `aria-multiselectable`, children `role="option"`. Explicitly **not** `role="grid"`: a wrapping `auto-fill` grid has no honest row structure.

| File | ~Lines | Responsibility |
|---|---|---|
| `LibraryIconView.tsx` | 120 | listbox, 2D arrow math from `ResizeObserver` column count, type-select |
| `LibraryTile.tsx` | 140 | 16:9 art, title, detail, pointer skim |
| `LibraryTileBadges.tsx` | 60 | badge rules in one testable place |

Badges, all neutral, none green: duration bottom-right (`rgba(0,0,0,0.72)`, tabular-nums), resolution bottom-left **only at ≥2160 or HDR** (a badge on everything communicates nothing), notes count pill top-left (`--bg-3` + `--line-2`). Tile size from `prefs.tile` via `--cp-tile` on the existing `auto-fill` rule (`library.css:1105-1110`).

Hover: keep the existing 600 ms-dwell cross-dissolve (`useHoverFrames`), then add **positional skim** — `onPointerMove` maps `offsetX / width` to the nearest of the 25/50/75 % frames, with a 1px `--fg-3` hairline showing skim position. Under reduced motion the cross-dissolve becomes an instant swap but **skim stays enabled**; it is user-directed and discrete, not animation.

**List view** — `role="treegrid"` + `aria-multiselectable`, rows `role="row"` with `aria-level`/`posinset`/`setsize`/`selected`/`expanded`, cells `role="gridcell"`, headers `role="columnheader"` + `aria-sort`. **Focus lands on rows, never cells.**

| File | ~Lines | Responsibility |
|---|---|---|
| `LibraryListView.tsx` | 120 | treegrid container, expansion state, keyboard, roving tabindex |
| `LibraryListHeader.tsx` | 90 | columnheaders, sort marks, `role="separator"` resize handles |
| `LibraryListRow.tsx` | 120 | one row (rewrite of the existing file) |
| `LibraryColumnMenu.tsx` | 80 | show/hide columns; reuse `LibraryCardMenu`'s portal + anchor pattern |

One CSS custom property drives widths so there is no per-cell plumbing: `.cp-lib-lv { display: grid; grid-template-columns: var(--cp-cols); }` set inline. Default columns: Name `minmax(220px,1fr)` (pinned first, disclosure + 34px art) · Duration 72px · Kind 84px · Size 88px · Modified 104px · Notes 64px. Optional via header menu: Resolution, Codec, Captured, Status, Screenings, Path.

**Folders show `N items` in Size, not Finder's `--`** — `countLibraryItems` (`library.ts:51-54`) already walks the in-memory tree for free.

Header click sorts and supersedes the `<select>` (`LibraryBrowserBar.tsx:80-89`) **in list view only**; icon and column keep the select. Option/Alt+click on a disclosure expands the whole subtree. Children sort within their level, never globally.

**Column view** — panes derive from a **single** `path: LibraryCrumb[]`, the shape already used for `selection` and breadcrumbs (`library.ts:21`, `LibraryBrowserBar.tsx:48-60`). The strip and the breadcrumbs are therefore the *same state*, for free.

| File | ~Lines | Responsibility |
|---|---|---|
| `LibraryColumnView.tsx` | 140 | pane derivation, focus management, strip scrolling, lazy deepening |
| `LibraryColumnPane.tsx` | 110 | one pane: rows, own scroll, its grip |
| `LibraryColumnRow.tsx` | 70 | one row |
| `LibraryInfoPane.tsx` | 140 | terminal info pane (retires `LibraryDetail.tsx`) |

ARIA: strip `role="group" aria-label="Column browser"`; each pane `role="listbox" aria-label="Contents of <folder>"` with `role="option"` rows; `aria-multiselectable` on the deepest pane only. **Do not `aria-owns` the panes into a synthetic tree** — they are genuinely separate lists and screen readers handle "Contents of Renders, listbox, 12 items" far better than a fabricated four-level tree.

**The single most important column-view detail:** a visually-hidden `aria-live="polite"` element inside the strip announcing **"Contents of &lt;name&gt;, N items"** whenever Right creates a pane (and "Back to &lt;name&gt;" on Left). Without it a screen-reader user pressing Right hears only the first row's label and loses all container context.

Two states Finder has and this app must add: `.cp-lib-col-row.ancestor` (`--bg-2`, on the path but pane unfocused) is what makes a cascade read as a path rather than five unrelated lists; `.cp-lib-col.focused` (`--bg-1` wash) answers "which pane owns the keyboard", the most common orientation failure.

Keyboard: Down/Up move within the focused pane **and re-derive panes to the right on every move**, discarding panes beyond the new selection. Right steps into the child pane at index 0, or into the info pane on a file. Left returns to the parent pane with the parent folder still selected; **at pane 0 Left is a no-op** (the strip stays a closed loop; Shift+Tab is the documented exit). Roving tabindex is **strip-wide** — exactly one `tabIndex={0}` across all panes, precedent at `LibraryTree.tsx:176`.

Four non-negotiable focus rules (this is where column views die):
1. Never let React unmount a pane containing `document.activeElement`. A `useLayoutEffect` keyed `[focusedPane, panes.length]` re-focuses the active row through a ref map if `activeElement` is detached or outside the strip — same idiom as `LibraryTree.tsx:97,170`.
2. Focus a newly created pane's first row **in that layout effect**, never in the key handler (the pane has not rendered yet when the key fires).
3. Scroll with one call: `el.scrollIntoView({ inline: "nearest", block: "nearest", behavior: reducedMotion ? "auto" : "smooth" })`.
4. Never `.focus()` while the pointer is driving selection. Guard with a `lastInputWasKeyboard` ref set in the key handler, cleared on `pointerdown`.

Narrow windows: **do not collapse or stack panes.** Keep `--cp-col-w` fixed and scroll horizontally. Below ~900px auto-collapse the left folder panel (the strip already *is* a folder navigator; recovers 224px in one move — `treeOpen` state exists at `LibraryBrowser.tsx:74` and the reopen affordance at `LibraryBrowserBar.tsx:37-47`). Below ~640px, `--cp-col-w: 200px` and info pane `220px`. Drive with container queries on `.cp-lib-browse-body` (Safari 16+, target is macOS 14 / Safari 17). Fallback if WKWebView misbehaves: `ResizeObserver` setting a `narrow` class.

One width for **all** panes (`prefs.colWidth`), not per-pane. Per-pane widths mostly produce ragged accidental layouts, and one width makes Finder's Option+drag-all unnecessary.

**Focus-ring correction across all new rows:** use `box-shadow: inset 0 0 0 1px var(--focus-ring)` for focus and reserve the `--bg-3` fill for *selected*. The existing rows opt out of the ring in favor of a fill (`library.css:932, 1153`), which conflates focus with selection. Update `.cp-lib-tree-row` and `.cp-lib-lrow` in the same pass so there is no split personality. `src/lib/focus-contract.test.ts` guards this — do not allowlist around it.

**Reduced motion:** extend the existing block (`library.css:1268-1278`) to `.cp-lib-col`, `.cp-lib-col-row`, `.cp-lib-tile`, `.cp-lib-lv-row`, `.cp-lib-lv-tw`, `.cp-lib-badge-*`; add `.cp-lib-cols { scroll-behavior: auto; }`.

**Copy** (no em/en dashes, no strikethrough): "No playable media in this folder." · "No matches for “&lt;query&gt;”." (existing, verbatim) · "This folder is empty." · "Scanning…" (existing) · "N items selected" · "Screened 3 times" · "No screenings yet." · "No video in this folder." + grey chip "Show all kinds" · "Add a folder to build your library." (existing).

**Flag for the user before implementing:** `LibraryDetail.tsx:81` currently uses `btn btn-primary` (green) for "Open in Clip". The info pane is a browse surface, not a CTA surface, so this plan makes all its actions grey `.btn` chips. That changes shipped behavior — confirm.

### 3.5 Small cleanups (none block the rebuild)

- Delete `Row.artPath` in `LibraryTree.tsx:31,51` (computed via `libraryPosterPaths(node, 1)` — real work — and never rendered) and the phantom `requestThumb` prop doc at `:16` and the stale promise at `:66-68`. Dead code violates the constitution.
- Replace raw glyphs `↑↓` (`LibraryBrowserBar.tsx:97`), `×` (`:76`, `LibraryView.tsx:232`), `✕` (`LibraryDetail.tsx:53`) with icons from `src/components/Icons.tsx`. A new `IconColumns` is needed for the third toggle — draw it in the existing 1.6-stroke style.
- Make `onReviewLocalPath` non-optional in `LibraryBrowser.tsx:51` (it is required on Home at `LibraryView.tsx:46`).
- `LibraryView.tsx` is 409 lines against a 150-line budget. Extract the four inline card builders (`:146-217`) and the per-root shelf states (`:221-284`) into siblings. Not urgent, but do it before adding the screenings shelf, not after.

---

## 4. SHARING UX FIXES

### 4.1 Make the three delivery modes legible

Three ways to put media in front of someone, making **incompatible promises**, and the difference users actually care about — *can I scrub this?* — is currently invisible.

| Mode | Guarantee | Scrub? | Today's affordance |
|---|---|---|---|
| Share my screen | Live pixels, ~1s behind | No | unlabeled `IconScreenShare` (`RoomControlBar.tsx:57-70`) |
| Watch a source together | Frame-accurate synced transport | Yes | unlabeled field "Paste a link to watch together" (`RoomSourceBar.tsx:37`) |
| Stream my file to peers | Frame-accurate, no pre-sharing | Yes | does not exist (task #58, `_design/p2p-media-plan.md`) |

**One "Show everyone" grey chip owns all three.** Replace the bare share icon with a labelled grey chip (`.cp-colobby-cta`, `coreview.css:135-151` — already the grey chip, so no green enters the flow) opening a menu whose items lead with the guarantee:

- **Watch a source together** — "Everyone plays the same file or link. Full quality, and anyone can scrub." *(primary; today's RoomSourceBar promoted out of the header)*
- **Share my screen** — "A live picture of your screen. Others watch, they cannot scrub."
- **Stream a file from this Mac** — "Peers watch your file without a copy. Full quality and scrubbing." *(disabled, "Coming soon")*

Keep the terse icon bar for mic/cam/reactions/theater. The media-delivery decision is the one place worth a label.

**In-room state strip** (room header, not a 9.5px tile badge): sharer sees "You are sharing Display 1. Others cannot scrub." with a Stop button; viewers see "Gasper is sharing their screen. Scrubbing is off while a screen is shared."

### 4.2 Prioritized defects

**P0 — share is broken in normal use**

1. **`src/lib/share-stream.ts:46`** — bare `catch { died(); }` on `appendBuffer` turns a recoverable `QuotaExceededError` into permanent teardown; no eviction anywhere in the file. Port the eight lines from `MSEStreamPlayer.tsx:497-505` verbatim. **Estimated time to death today: 1-5 minutes.**
2. **`use-co-review.ts:721-724` + `src/lib/share-machine.ts:82-86`** — pipeline death logs to `console.error` only. `pushNotification` is wired for *start* failures (`use-co-review.ts:732,736,739`) but not for death. Add an `onDied` → `pushNotification` path. The asymmetry is the bug.
3. **`App.tsx:5026, 5450` / `PeoplePanel.tsx:70`** — a shared screen has **no route to the stage**. It renders at 224x126 (`room.css:134-136,170-177`) or 168x94 in theater (`:426-429`), cropped by `object-fit: cover` (`:188-192`). Route `shareStream` to the stage when any member is sharing; People keeps cameras; switch share tiles to `contain`.
4. **`src/lib/rtc-mesh.ts:190-197, 222, 241`** — `scaleResolutionDownBy = sourceHeight / 360` is computed from the sharer's **webcam** and survives `replaceTrack`. **A better webcam gives your peers a blurrier screen share.** On `setVideoOverride`: `scaleResolutionDownBy = 1`, `contentHint = "detail"`, `degradationPreference = "maintain-resolution"`; restore the tile cap on override-null.
5. **`src-tauri/src/stream_proxy.rs:1115-1137`** — no bitrate cap (libx264 default CRF 23, uncapped). Add `-maxrate 8M -bufsize 4M`. Scope honestly: this stream is loopback-only, so the win is CPU and MSE-buffer headroom for #1, **not** bandwidth.

**P1 — dead ends and wrong states**

6. `ShareDialog.tsx:59-75` — `picked` not cleared on tab change; pick a display, switch to Windows, `share()` at `:73` shares the **display**. Clear `picked` in `setTab`.
7. `App.tsx:5449` — theater `PeoplePanel` gets no `presenter`/`canGrantPresenter`/`onMakePresenter`; defaults (`PeoplePanel.tsx:21`) pin "Presenting" to the host, **actively wrong** after a hand-off, and the floor cannot be passed.
8. `room.css:776` — selector is `.cp-person-tile:hover .cp-person-grant` but the rendered class is `cp-person` (`PeoplePanel.tsx:157`). "Let them present" sits at `opacity: 0`, **invisible to every mouse user**.
9. `ShareDialog.tsx:132,139,240` — "Needs the capture engine (npm run build:capture)" shown to `.dmg` users with no repo and no npm. Replace with "Sharing a single window needs a newer build of Sauce Bunny."
10. `RoomControlBar.tsx:59-70` — `shareState === "starting"` only sets `disabled`; no spinner, no "Starting…". Capture can legitimately take 8s (`stream_proxy.rs:1231`).
11. `ShareDialog.tsx:244` — Share disabled with no reason; on the Portion tab `shareReady` needs `crop.w > 16 && crop.h > 16` (`:59-62`).

**P2 — polish and a11y**

12. `ShareDialog.tsx:105` — the only dialog with neither `useModalFocus` nor `aria-modal="true"` (cf. `SettingsModal.tsx:686,711-712`). Focus escapes behind it.
13. `ShareDialog.tsx:43-45` — sources fetched once, never refreshed; the header at `:13` claims "live thumbnails" inaccurately. Add a refresh control, fix the comment.
14. `ShareDialog.tsx:104` — backdrop `onClick={onClose}` discards a crop drag that releases outside the surface.
15. `ShareDialog.tsx:163-179` — Windows grid has no search.
16. `share-stream.ts:95-109` — `mixShareAudio` snapshots the mic at share start; a mid-share device change is silently ignored. Note it in the device panel.
17. `PeoplePanel.tsx:169` / `room.css:357-370` — "Sharing screen" at 9.5px uppercase over live video is unreadable, and it is the *only* indication of who is sharing. Superseded by the header strip in 4.1.

`ShareDialog.tsx` is 254 lines. Split the tab bodies (`ShareScreensGrid`, `ShareWindowsGrid`, `SharePortionPicker`) into **siblings** before adding anything.

---

## 5. PHASED PLAN

Every phase is independently shippable and must pass, from the repo root and `src-tauri/` / `swift-sidecar/` respectively: `npx tsc --noEmit` · `npm test` · `npm run test:e2e` · `cargo check` · `cargo test --lib` · `swift build`.

| Phase | Content | Touches persisted user data? | Migration test required |
|---|---|---|---|
| **1** | **Data-loss fixes** | **YES — Reviews/** | **YES** |
| **2** | Share P0 | no | no |
| **3** | Screening model + store | YES — new dir only | YES (index tolerance) |
| **4** | Library foundation | YES — prefs key | YES (`"grid"` → `"icon"`) |
| **5** | List + icon views | no | no |
| **6** | Column view + info pane | no | no |
| **7** | Screenings surfaces | no | no |
| **8** | Sharing IA + P1/P2 | no | no |

### Phase 1 — Stop the data loss (highest value, highest risk, ship first)

Scope: nothing but correctness. No new files except tests.

1. Rename `screening` → `theater` throughout (`use-co-review.ts:141,143,619,632,689,694,801`; `App.tsx:4642,4928,5032,5033,5429,5468,5472,5629`). Frees the noun.
2. `review.ts:518` — add the sourceKey inequality guard as the first line of `mergeReviewDoc`.
3. `use-co-review.ts:465-487` — replace the role-transition guard with the source-transition-aware effect from §1.5, **minus** the screening bookkeeping (that is Phase 3). Close-and-persist before re-seed; re-broadcast `reviewDoc` on source change.
4. Guest mirror: flush-and-clear on `loadSource` key change (`:269`); `stampSourceKey` on adopt (`:336-345`).
5. Fix the local-file key split: `App.tsx:4608-4610` and `:4593-4600` must agree on what identity the room carries. The doc key stays local (path or fingerprint-resolved); the **wire** key stays the fingerprint; the guest re-stamps on adopt. Document the asymmetry in a comment at both sites.

**Tests (all new, all required to merge):**
- `src/lib/review.test.ts` — `mergeReviewDoc` refuses to fold across differing `sourceKey`; still folds when equal; still unions likes/reactions.
- `src/hooks/use-co-review.test.ts` — change `reviewSourceKey` mid-session, assert (a) `sessionDoc.sourceKey` follows, (b) the outgoing doc was saved under its **own** key with its comments intact, (c) source B's file receives only B's comments.
- **Migration test:** hydrate a fixture `Reviews/` with a doc + index entry, run a simulated mid-session switch, assert byte-level that source A's file is unchanged except for A's own comments.

**Gate:** `cargo test --lib` unchanged (no Rust in this phase). No build-ID bump needed.

### Phase 2 — Share P0 (small, isolated, unblocks the rest)

Defects 1, 2, 5 from §4.2 (the two MSE/notification fixes plus `-maxrate`). Extend `src/lib/share-machine.test.ts` with a quota case — the deps are already injected at the right seam. Rust change in `stream_proxy.rs:1115-1137` → `cargo check` + `cargo test --lib`.

**Deliberately deferred to Phase 8:** defects 3 and 4 (stage routing, `contentHint` re-cap). Both need a WKWebView spike and #3 collides with the single-clock model — see Risks.

### Phase 3 — Screening model + store (data phase)

`src/lib/screening.ts`, `src/lib/screening-store.ts`, the `SessionMsg::Screening` variant, segment bookkeeping wired into the Phase 1 effect. Build-ID bump in `src/lib/build-id.ts` **and** `src-tauri/src/commands/system.rs`; `cargo test --lib` regenerates `src/bindings/SessionMsg.ts`.

**No UI.** Records are written and readable; nothing renders them yet. This keeps the data model shippable and observable (the user can open `~/Documents/Sauce Bunny/Screenings/` and read the JSON) before any pixel work.

**Migration test:** malformed / absent / future-version `Screenings/index.json` all degrade to an empty Map without throwing, mirroring `parseReviewIndex`'s tolerance (`review-store.ts:127-151`); path-separator entries are rejected.

### Phase 4 — Library foundation (prefs data phase)

`library-entries.ts`, `tree-nav.ts`, `use-library-selection.ts`, `library-prefs.ts`, on-demand deepening in `useLibraryScan`, shared `IntersectionObserver` in `use-lazy-thumbnails.ts`, the `push(...spread)` fix. Extract `library-prefs.ts` **before** touching view routing or `LibraryBrowser.tsx` (261 lines) becomes a god component immediately.

**Migration test:** an existing `saucebunny.libraryBrowser` with `view: "grid"` normalizes to `"icon"`; unknown fields are dropped without throwing; a missing key yields the full default.

Ship with the existing grid/list still rendering (the new modules are unused). Pure green build, zero user-visible change.

### Phase 5 — List + icon views

Six new components, `library-views.css`, `IconColumns`, the focus-ring correction applied to `.cp-lib-tree-row` and `.cp-lib-lrow` in the same pass. Media meta behind a flag; ship badge-free if it slips.

**e2e must grow here.** Today `e2e/smoke.spec.ts:309-380` covers Home only — no test of the browser's toggle, tree, breadcrumbs, selection, or detail panel. Add: view-mode toggle persists across reload; list header sorts and flips; disclosure expands and collapses; Shift-click selects a range.

### Phase 6 — Column view + info pane

Four new components, `LibraryDetail.tsx` retired. The four focus rules and the `aria-live` announcement are acceptance criteria, not polish.

**e2e:** "Right, Right, Left, Left keeps focus inside the strip" — this is the regression that will otherwise ship broken.

### Phase 7 — Screenings surfaces

Screenings smart source in `LibraryTree`, screening rows in all three views, `.cp-lib-badge-screened` on files, the info pane's Screenings section, the Home shelf, the segment-list open flow. Depends on Phase 3 for data and Phase 6 for the info pane.

### Phase 8 — Sharing IA + remaining defects

The "Show everyone" menu, the room state strip, share-to-stage (#3), the `contentHint` re-cap (#4), and P1/P2 6-17. Split `ShareDialog.tsx` into siblings first.

---

## 6. RISKS — what could lose or corrupt comments, and the guard

**R1 — Phase 1's close-and-persist runs at the wrong moment and double-saves or half-saves.**
The outgoing `saveReview` at source change must read `sessionDocRef.current` (the ref, not the state) or it saves a stale render. Guard: the ref is already maintained (`use-co-review.ts` `sessionDocRef`); the migration test asserts A's file contains exactly A's comments and nothing of B's.

**R2 — The `mergeReviewDoc` guard changes behavior for anyone mid-upgrade.**
A stale session doc that *would* previously have merged now silently does not. That is the intended fix and there is no user-visible loss (the comments were being misfiled), but it is a behavior change. Guard: the unit test asserting refusal, plus a release note.

**R3 — Guest re-stamping picks the wrong local key.**
If `resolveByFingerprint` misses and `localFilePath` is null, `stampSourceKey` falls back to `incoming.sourceKey` — the host's path. That writes a `Reviews/` file keyed to a nonexistent path on the guest's disk. It is not *loss* (the comments are there, filed under a dead key), but it is invisible. Guard: when the fallback fires, set `segment.localSourceKey = null, watched = false` so the screening card offers "Find my copy", and `adoptPendingSource` (`use-co-review.ts:773-788`) links the fingerprint for next time. Do not silently write under a foreign path without recording that we did.

**R4 — The shrink guard fires and looks like corruption.**
`review-store.ts:230-242` writes a `.bak` when a doc >2 KB collapses below half its persisted size. Phase 1's close-and-persist writes a *smaller* doc for source A than a bugged session would have (B's comments are no longer folded in). Expect `.bak` files on the first post-fix session for anyone previously affected. Guard: this is exactly what the mechanism is for. Do not suppress it. Note it in the release note as expected and recoverable.

**R5 — Already-polluted docs are unrecoverable.**
A misfiled comment is indistinguishable from a real one. Ship no auto-repair; anything automatic would delete real comments. `.bak` files are the only surface. Guard: state this plainly in the release note rather than attempting heuristics.

**R6 — Phase 3's segment checkpoint fails and the screening loses a segment.**
A crash mid-segment loses that segment's screening membership. The **comments survive** — the per-source `saveReview` already happened at the previous boundary. Guard: this ordering (persist comments first, screening second) is deliberate; a screening is recoverable metadata, a comment is not.

**R7 — Abrupt host disconnect never drives `role → "off"`, so nothing persists.**
Unverified. If `src-tauri/src/commands/session.rs` does not transition to `"off"` on an abrupt drop, the end-of-session persist at `use-co-review.ts:479` never fires and both the merge and the screening are lost. **Verify this before Phase 1 merges** — it is the one open question that could make the whole fix a no-op in the most common failure mode. If it does not transition, add a `pagehide` flush mirroring `review-store.ts:333`.

**R8 — Phase 4's prefs migration silently resets everyone's view.**
`normalizePrefs`'s `oneOf` fails safe, so a missed `"grid"` → `"icon"` mapping degrades to the default with no error and no signal. Guard: the migration test is mandatory for this phase.

**R9 — Phase 8's share-to-stage collides with the single-clock model.**
CLAUDE.md's "Media playback path" makes the streamed `<video>` the one clock, and the transcript/caption highlight reads that playhead. A share on the stage has no timeline. **Do not let an implementer improvise this.** Decide explicitly — suspend transport and show a disabled timeline — before any code. Not a data risk, but the most likely place to ship something incoherent.

**R10 — Scope creep into `Screenings/`.**
Someone will propose storing comment bodies there "for offline export". That is the double-storage this model exists to avoid; export renders from the review docs at export time. Similarly: no `ScreeningStore` context or provider — segment bookkeeping belongs inside `use-co-review.ts`, which already owns the session lifecycle.

**R11 — E2E gives false confidence.**
`e2e/smoke.spec.ts:309-380` exercises Home only. Phases 5-6 could break the entire grid/list browser with the suite green. Guard: the new e2e cases listed in each phase are merge blockers, not follow-ups.

---

**Start here:** Phase 1, step 5 (verify R7 in `src-tauri/src/commands/session.rs`) before writing any code. If abrupt disconnect does not drive `role → "off"`, the persist trigger must change and every phase after it shifts.