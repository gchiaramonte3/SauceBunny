/**
 * File-backed persistence for review docs.
 *
 * Review docs (comments, stroke annotations, versions, approval state) used to
 * live ONLY in WKWebView localStorage — evictable by macOS and quota-capped
 * (~5 MB), which annotation-heavy docs eventually hit. Like the transcript
 * library, they now persist as real files: one JSON per reviewed source in
 * `~/Documents/Sauce Bunny/Reviews/` (beside the Transcripts library), plus an
 * `index.json` mapping sourceKey → filename so hydration can find the docs
 * without a list-dir command. Everything goes through the EXISTING invoke
 * surface (`default_transcript_library_path`, `ensure_dir_exists`,
 * `read_text_file_capped`, `write_text_to_path`).
 *
 * Shape on disk:
 *   Reviews/<slug>-<hash>.json   one ReviewDoc (slug = sanitized tail of the
 *                                sourceKey, hash = FNV-1a of the full key so
 *                                any path/URL maps to a safe unique filename)
 *   Reviews/index.json           { version, docs: { sourceKey → entry } }
 *
 * The in-memory Map is the working store: `loadReview` stays synchronous (its
 * call sites depend on that), reads hit the Map, and every save write-throughs
 * via a debounced (500 ms trailing) fire-and-forget file write.
 * `hydrateReviewStore()` fills the Map from disk once at boot — main.tsx
 * awaits it (race-capped) before the first render, in both windows.
 *
 * Durability model (r140): every write is TRANSACTIONAL — `write_text_to_path
 * { atomic: true }` stages a sibling temp file, fsyncs, then renames over the
 * target, so a crash mid-save leaves the old or the new complete file, never
 * a truncated one. On top of that sit the LOGICAL clobber guards: a doc that
 * shrinks below half its last persisted size keeps the previous content as
 * `<name>.bak` first, an empty doc never overwrites one the index says has
 * content, flushes hold until the index has hydrated (the guards compare
 * against it), and boot hydration never installs a disk copy over a doc the
 * user already edited this session.
 *
 * Docs held in the Map are shared references: review ops are pure (they
 * return NEW docs, per review.ts's contract), so handing out the stored
 * instance is safe — never mutate a loaded doc in place.
 */

import { invoke } from "@tauri-apps/api/core";
import type { ReviewDoc } from "./review";

export type ReviewIndexEntry = {
  file: string;
  updatedAt: number;
  /** Root-comment count of the active version (history-card parity). */
  count: number;
  /** Byte size last persisted — powers the shrink guard even for docs whose
   *  file wasn't read this session. */
  bytes: number;
};

import { STORE_SCHEMA_VERSION, futureVersionIn, reportFutureVersion } from "./store-schema";

const INDEX_FILE = "index.json";
const WRITE_DEBOUNCE_MS = 500;
/** Per-file read cap. `read_text_file_capped`'s cap is caller-supplied (the
 *  8 MB in its doc comment is only the DEFAULT), so a doc well past the old
 *  ~5 MB localStorage quota still hydrates. */
const DOC_READ_CAP = 32 * 1024 * 1024;
const INDEX_READ_CAP = 4 * 1024 * 1024;
/** Hydration hard caps — boot must stay bounded even against a pathological
 *  library. Docs beyond the cap keep their index entry (filename + shrink
 *  guard) and simply start empty in memory this session. */
const MAX_HYDRATE_DOCS = 1000;
const MAX_HYDRATE_BYTES = 64 * 1024 * 1024;

/** localStorage keys docs used to live under: `saucebunny.review.<sourceKey>`.
 *  The same prefix is shared by prefs (author, history, fpindex, …), so
 *  migration identifies docs by SHAPE, never by prefix alone. */
const LEGACY_DOC_KEY_PREFIX = "saucebunny.review.";
const MIGRATED_FLAG_KEY = "saucebunny.reviews.migrated";

// ── module state (the working store) ─────────────────────────────────────────
const docs = new Map<string, ReviewDoc>();
const index = new Map<string, ReviewIndexEntry>();
const dirty = new Set<string>();
let reviewsDir: string | null = null;
let dirEnsured = false;
let hydrated = false;
/** True once index.json has been read (or proven absent) — flushes hold until
 *  then, because the shrink/empty-over-content clobber guards compare against
 *  index entries: a write that races ahead of the index bypasses them all. */
let indexReady = false;
/** Set if Reviews/index.json is newer than this build. Review docs are the
 *  densest user work this app holds (comments, strokes, versions), and the
 *  index is what finds them, so an index we half understand closes every
 *  write path rather than being rewritten from a partial reading. */
let futureVersion: number | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Persistence failures were console.warn only, in an app that ships with no
 * console (r151). A review note that never reaches disk is exactly the thing
 * a user must be told about while they can still act - and two of these paths
 * did not even re-arm the flush timer, so a deferred write was simply lost if
 * the user made no further edit. This is the channel App subscribes to.
 *
 * Deliberately a listener rather than a direct import of the notification
 * system: this module is pure enough to unit-test, and it must not grow a
 * dependency on React or on App's toast plumbing.
 */
export type ReviewStoreProblem = {
  /** What failed, in words a user can act on. */
  message: string;
  /** True when the data is still held in memory and a retry is scheduled. */
  willRetry: boolean;
};
const problemListeners = new Set<(p: ReviewStoreProblem) => void>();

/** Subscribe to persistence failures. Returns an unsubscribe fn. */
export function onReviewStoreProblem(cb: (p: ReviewStoreProblem) => void): () => void {
  problemListeners.add(cb);
  return () => { problemListeners.delete(cb); };
}

/** Rate-limited so a failing disk cannot spam the user once per keystroke. */
let lastProblemAt = 0;
function reportProblem(message: string, willRetry: boolean, err: unknown): void {
  console.warn(`review-store: ${message}`, err);
  const now = Date.now();
  if (now - lastProblemAt < 30_000) return;
  lastProblemAt = now;
  for (const cb of problemListeners) cb({ message, willRetry });
}

/** Test-only: wipe module state so each vitest case starts cold. */
export function resetReviewStoreForTests(): void {
  docs.clear();
  index.clear();
  dirty.clear();
  reviewsDir = null;
  dirEnsured = false;
  hydrated = false;
  indexReady = false;
  futureVersion = null;
  if (flushTimer !== null) clearTimeout(flushTimer);
  flushTimer = null;
  writeBackoffMs = 0;
}

// ── filenames ────────────────────────────────────────────────────────────────

/** FNV-1a 32-bit, hex — stable, dependency-free, sync. Uniqueness across a
 *  user's handful of reviewed sources is what's needed, not crypto. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** `<slug>-<hash>.json` for a sourceKey (local path or URL). The slug is a
 *  readable sanitized tail; the hash of the FULL key is what guarantees two
 *  different sources never share a file. */
export function reviewFileName(sourceKey: string): string {
  const tail = sourceKey.split(/[/\\]/).filter(Boolean).pop() ?? "";
  const slug = tail
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/, "") // drop a file extension, keep URL query text
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `${slug || "review"}-${fnv1a(sourceKey)}.json`;
}

// ── index serialization ──────────────────────────────────────────────────────

type ReviewIndexFile = { version: number; docs: Record<string, ReviewIndexEntry> };

/** Tolerant parse: anything malformed (null from a mocked read, corrupt JSON,
 *  wrong shape) yields an empty index — hydration then starts fresh. */
export function parseReviewIndex(text: unknown): Map<string, ReviewIndexEntry> {
  const out = new Map<string, ReviewIndexEntry>();
  if (typeof text !== "string" || !text) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return out;
  }
  const docsRec = (parsed as ReviewIndexFile | null)?.docs;
  if (!docsRec || typeof docsRec !== "object") return out;
  for (const [key, e] of Object.entries(docsRec)) {
    if (!e || typeof e !== "object" || typeof (e as ReviewIndexEntry).file !== "string") continue;
    const entry = e as ReviewIndexEntry;
    // A filename with a path separator could escape Reviews/ — never trust it.
    if (/[/\\]/.test(entry.file)) continue;
    out.set(key, {
      file: entry.file,
      updatedAt: typeof entry.updatedAt === "number" ? entry.updatedAt : 0,
      count: typeof entry.count === "number" ? entry.count : 0,
      bytes: typeof entry.bytes === "number" ? entry.bytes : 0,
    });
  }
  return out;
}

export function serializeReviewIndex(entries: Map<string, ReviewIndexEntry>): string {
  const file: ReviewIndexFile = { version: STORE_SCHEMA_VERSION, docs: Object.fromEntries(entries) };
  return JSON.stringify(file);
}

// ── migration decision logic (pure, unit-tested) ─────────────────────────────

/** Structural check for a persisted ReviewDoc. The legacy localStorage prefix
 *  is shared by prefs (author string, history array, fpindex record, composer
 *  height number, emoji recents), so shape — not key — decides what's a doc. */
export function looksLikeReviewDoc(v: unknown): v is ReviewDoc {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const d = v as ReviewDoc;
  return (
    typeof d.sourceKey === "string" &&
    Array.isArray(d.versions) &&
    Array.isArray(d.comments) &&
    !!d.status && typeof d.status === "object"
  );
}

/** Whether a doc carries anything a user would miss. Version-only shells (one
 *  gets written for every source ever opened) aren't worth a file — they
 *  rebuild on next open. */
export function reviewDocHasContent(d: ReviewDoc): boolean {
  return d.comments.length > 0 || Object.keys(d.status).length > 0;
}

// ── store API (review.ts delegates here) ─────────────────────────────────────

/**
 * Every hydrated doc, for a caller that needs to walk the corpus.
 *
 * Exists so the fingerprint-index repair can live in `review.ts` (which owns
 * that index) without `review-store` importing a VALUE back from `review` -
 * the two already form a type-only cycle, and adding a runtime edge to it
 * would mean the module that happens to initialise first sees `undefined`.
 * The repair runs from main.tsx after hydration instead, where both modules
 * are long since ready.
 */
export function allReviewDocs(): Iterable<ReviewDoc> {
  return docs.values();
}

export function getReviewDoc(sourceKey: string): ReviewDoc | undefined {
  return docs.get(sourceKey);
}

/** Write-through: update the Map now (sync — readers see it immediately) and
 *  schedule the debounced file write. */
export function putReviewDoc(doc: ReviewDoc): void {
  docs.set(doc.sourceKey, doc);
  dirty.add(doc.sourceKey);
  scheduleFlush();
}

/**
 * Backoff after a failed write, in ms. 0 while things are healthy.
 *
 * A failed write re-arms the flush, and the flush was always armed at the
 * 500ms debounce - so a write that fails PERMANENTLY (read-only volume, the
 * Reviews folder deleted underneath us, a full disk) turned into a disk
 * attempt twice a second for as long as the app stayed open. This app is
 * meant to sit open all day, so "forever" is the operative word rather than
 * an edge case, and the user-visible warning is throttled to one per 30s,
 * which means the loop is also invisible while it runs.
 *
 * Backing off does NOT mean giving up: the notes exist only in memory until
 * a write lands, so stopping would turn a recoverable failure into data loss
 * when the user reconnects the drive. It settles at one attempt per 30s.
 */
let writeBackoffMs = 0;
const MAX_WRITE_BACKOFF_MS = 30_000;

/** Note a failed write and lengthen the wait before the next attempt. */
function backOffAfterFailure(): void {
  writeBackoffMs = writeBackoffMs === 0
    ? WRITE_DEBOUNCE_MS * 2
    : Math.min(writeBackoffMs * 2, MAX_WRITE_BACKOFF_MS);
}

/** A write landed: healthy again, so the next save uses the plain debounce. */
function clearWriteBackoff(): void {
  writeBackoffMs = 0;
}

function scheduleFlush(): void {
  if (flushTimer !== null) clearTimeout(flushTimer);
  // While a failure streak is active the backoff wins, including for a save
  // the user just made: writing sooner cannot help a disk that is refusing.
  const delay = Math.max(WRITE_DEBOUNCE_MS, writeBackoffMs);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushDirtyDocs();
  }, delay);
}

async function flushDirtyDocs(): Promise<void> {
  // No dir (hydration failed / e2e mock / plain-browser dev) → memory-only
  // session; keep the dirty set so a later flush can still land.
  if (!reviewsDir || dirty.size === 0) return;
  // Index not read yet (slow disk at boot): every clobber guard below depends
  // on it, so hold the write and re-arm — the edit stays dirty, nothing is
  // lost, and the flush lands the moment hydration finishes.
  if (!indexReady) { scheduleFlush(); return; }
  // A newer build wrote this index. Hold the edits in memory (they stay
  // dirty and stay visible) rather than rewriting an index, and docs beside
  // it, from a reading we know is incomplete.
  if (futureVersion !== null) return;
  const keys = [...dirty];
  dirty.clear();
  try {
    if (!dirEnsured) {
      await invoke("ensure_dir_exists", { path: reviewsDir });
      dirEnsured = true;
    }
  } catch (err) {
    reportProblem(
      "Your review notes could not be saved to the Reviews folder. They are still here, and saving will be retried.",
      true, err,
    );
    for (const k of keys) dirty.add(k); // retry on the next save
    scheduleFlush(); // re-arm: without this a deferred write is lost unless the user edits again
    return;
  }
  let indexDirty = false;
  for (const key of keys) {
    const doc = docs.get(key);
    if (!doc) continue;
    const prev = index.get(key);
    const file = prev?.file ?? reviewFileName(key);
    const path = `${reviewsDir}/${file}`;
    const json = JSON.stringify(doc);
    // Encoded ONLY for byte-length accounting (the shrink guard + index sizes
    // are byte-based); the write itself passes the string, never the array.
    const bytes = new TextEncoder().encode(json);
    // Destructive-write guard. Two shapes of a logical clobber: a rich doc
    // collapsing below half its persisted size, OR replacing a doc the index
    // says HAS content with a contentless shell. Both are what a failed
    // hydration looks like — opening a source whose file is unreadable yields
    // an emptyDoc that then saves over the real notes. (The shrink half-rule
    // alone missed this: most real reviews are under the 2 KB floor, so an
    // emptyDoc overwriting a small review never tripped it.)
    const shrinking = prev && prev.bytes > 2048 && bytes.length < prev.bytes / 2;
    const emptyOverContent = prev && prev.bytes > 2 && !reviewDocHasContent(doc);
    if (shrinking || emptyOverContent) {
      let existing: string | null = null;
      let readThrew = false;
      try {
        const old = await invoke<string>("read_text_file_capped", { path, maxBytes: DOC_READ_CAP });
        existing = typeof old === "string" ? old : "";
      } catch {
        readThrew = true;
      }
      if (readThrew) {
        // We believe there is real content on disk but CANNOT read it — almost
        // always iCloud evicted the file (present as a placeholder, not
        // downloaded), not that it's gone. Overwriting now destroys real notes
        // with a near-empty doc. Never overwrite a file you couldn't first read
        // back: defer and keep the key dirty.
        //
        // THE RETRY IS NOT AUTOMATIC, and that is deliberate rather than an
        // oversight — every other deferral in this function re-arms, this one
        // does not. The debounce is 500ms, so re-arming here would re-read an
        // evicted placeholder twice a second for as long as it stays evicted,
        // which for an offline machine is forever. The key stays dirty, so the
        // write lands on the user's NEXT save.
        //
        // What that costs: the deferred write is by definition one that would
        // shrink or empty the file, so the copy on disk stays the richer one.
        // A user who deletes their comments and quits without touching
        // anything else will see them again on reopen. Preferring stale notes
        // to destroyed notes is the right way round, but it is a real
        // behaviour and it is pinned by a test rather than left to be
        // rediscovered.
        console.warn(`review-store: ${file} is unreadable (likely iCloud-evicted); deferring a destructive write rather than clobbering it.`);
        dirty.add(key);
        continue;
      }
      // Read succeeded → the file is present. Back up any real content before
      // overwriting so a genuine shrink is still recoverable.
      if (existing && existing.length > 2) {
        try {
          await invoke("write_text_to_path", { path: `${path}.bak`, text: existing, atomic: true });
        } catch {
          /* .bak is best-effort; the successful read already proved the file exists */
        }
      }
    }
    try {
      await invoke("write_text_to_path", { path, text: json, atomic: true });
      const count = doc.comments.filter(
        (c) => c.parentId === null && c.versionId === doc.activeVersionId,
      ).length;
      index.set(key, { file, updatedAt: Date.now(), count, bytes: bytes.length });
      indexDirty = true;
      clearWriteBackoff();
    } catch (err) {
      reportProblem(
        "A review note could not be written to disk. It is still here, and saving will be retried.",
        true, err,
      );
      dirty.add(key); // retry on the next save
      backOffAfterFailure();
      scheduleFlush();
    }
  }
  if (!indexDirty) return;
  try {
    await invoke("write_text_to_path", {
      path: `${reviewsDir}/${INDEX_FILE}`,
      text: serializeReviewIndex(index),
      atomic: true,
    });
  } catch (err) {
    // The documents landed; only the index did not. Recoverable on the next
    // write, but say so: a stale index is how notes go missing from lists.
    reportProblem(
      "The review index could not be updated. Your notes are saved; the list may look out of date until the next save.",
      true, err,
    );
  }
}

// ── hydration ────────────────────────────────────────────────────────────────

/**
 * Fill the Map from disk. Called ONCE at boot (main.tsx, both windows) before
 * the first render — local JSON reads are fast, and main.tsx additionally
 * race-caps the await so a hung read can never block boot. Every failure is
 * tolerated: missing dir/index/corrupt file → empty store + console.warn.
 *
 * `migrate` (main window only) then imports any legacy localStorage docs and
 * removes their entries — the quota relief this store exists for. The panel
 * window skips migration so two windows can never write the library at once.
 */
export async function hydrateReviewStore(opts?: { migrate?: boolean }): Promise<void> {
  if (hydrated) return;
  hydrated = true; // one shot — a failed hydrate degrades to memory-only, no retry loops
  try {
    const lib = await invoke<string>("default_transcript_library_path");
    if (typeof lib !== "string" || !lib.trim()) return; // mocked/unavailable → memory-only
    // Reviews sit beside the Transcripts library at the app's Documents root:
    // ~/Documents/Sauce Bunny/Reviews. Derived (not configurable) — the
    // transcript-library SETTING can move transcripts, but the default path
    // command is the stable anchor for the app's Documents folder.
    const root = lib.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
    if (!root) return;
    reviewsDir = `${root}/Reviews`;
  } catch (err) {
    console.warn("review-store: could not resolve Reviews dir:", err);
    indexReady = true; // memory-only session: nothing to guard against
    return;
  }

  let indexText: unknown = null;
  try {
    indexText = await invoke<string>("read_text_file_capped", {
      path: `${reviewsDir}/${INDEX_FILE}`,
      maxBytes: INDEX_READ_CAP,
    });
  } catch {
    /* no index yet — fresh store */
  }
  const fv = futureVersionIn(indexText);
  if (fv !== null) { futureVersion = fv; reportFutureVersion("reviews", fv); }
  const entries = [...parseReviewIndex(indexText)];
  // Keep every index entry — filename + shrink guard survive even unloaded.
  for (const [key, entry] of entries) index.set(key, entry);
  // The clobber guards have their comparison basis now — writes may proceed
  // (doc BODIES may still be loading; the dirty-key guard above covers them).
  indexReady = true;
  // Per-doc reads run through a small worker pool instead of strictly one at
  // a time: main.tsx gates first render on this, the files are tiny, and the
  // real cost was one full IPC round-trip PER DOC in sequence. Each doc
  // writes its own Map key, so order doesn't matter. The doc/byte caps stay
  // as a bounded-boot backstop; in-flight workers can overshoot them by at
  // most the pool width, which is noise against 1000 docs / 64 MB.
  let loadedDocs = 0;
  let loadedBytes = 0;
  let nextEntry = 0;
  const HYDRATE_POOL = 8;
  const worker = async () => {
    while (nextEntry < entries.length) {
      const [key, entry] = entries[nextEntry++];
      if (loadedDocs >= MAX_HYDRATE_DOCS || loadedBytes >= MAX_HYDRATE_BYTES) return;
      try {
        const text = await invoke<string>("read_text_file_capped", {
          path: `${reviewsDir}/${entry.file}`,
          maxBytes: DOC_READ_CAP,
        });
        if (typeof text !== "string" || !text) continue;
        const parsed: unknown = JSON.parse(text);
        if (looksLikeReviewDoc(parsed) && parsed.sourceKey === key) {
          // The UI can render (and take edits) before this read returns — the
          // boot gate is a 2s RACE, not a barrier. An edited doc is the newer
          // truth; installing the disk copy over it would silently drop the
          // user's changes. The dirty flush will persist the merge-worthy
          // state; unedited keys still hydrate normally.
          if (!dirty.has(key)) {
            docs.set(key, parsed);
          }
          loadedDocs++;
          loadedBytes += text.length;
        }
      } catch (err) {
        console.warn(`review-store: skipping unreadable review file ${entry.file}:`, err);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(HYDRATE_POOL, entries.length) }, worker),
  );

  if (opts?.migrate !== false) migrateLegacyLocalStorageDocs();

  // Best-effort flush of anything still debounced when the window goes away.
  // (App quit races the async invokes — accepted; see durability note above.)
  try {
    window.addEventListener("pagehide", () => void flushDirtyDocs());
  } catch {
    /* non-DOM context (tests) */
  }
}

/**
 * One-time localStorage → files migration, re-scanned on every hydrate: the
 * scan IS the cheap straggler check (a doc key written later by an older
 * build still gets imported), and it's idempotent — files win on conflict,
 * because once this ships the files are the newer canon. Doc entries are
 * REMOVED from localStorage either way (the quota relief); prefs sharing the
 * prefix (author, history, fpindex, …) fail the shape check and stay put.
 * `saucebunny.reviews.migrated` records that the initial sweep completed.
 */
function migrateLegacyLocalStorageDocs(): void {
  try {
    const docKeys: { storageKey: string; sourceKey: string; doc: ReviewDoc }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const storageKey = localStorage.key(i);
      if (!storageKey || !storageKey.startsWith(LEGACY_DOC_KEY_PREFIX)) continue;
      const sourceKey = storageKey.slice(LEGACY_DOC_KEY_PREFIX.length);
      let parsed: unknown;
      try {
        parsed = JSON.parse(localStorage.getItem(storageKey) ?? "null");
      } catch {
        continue;
      }
      if (!looksLikeReviewDoc(parsed) || parsed.sourceKey !== sourceKey) continue;
      docKeys.push({ storageKey, sourceKey, doc: parsed });
    }
    for (const { storageKey, sourceKey, doc } of docKeys) {
      if (!docs.has(sourceKey) && reviewDocHasContent(doc)) {
        docs.set(sourceKey, doc);
        dirty.add(sourceKey);
      }
      localStorage.removeItem(storageKey);
    }
    if (dirty.size > 0) scheduleFlush();
    localStorage.setItem(MIGRATED_FLAG_KEY, "1");
  } catch (err) {
    console.warn("review-store: localStorage migration failed:", err);
  }
}

/** Card-surface lookup: the ACTIVE version's verdict for a source, or null
 *  when there is no doc / no explicit verdict (cards never show a default
 *  chip). Reads the hydrated in-memory map - cheap enough per card render.
 *  Fingerprint-keyed local docs resolve only via their fingerprint alias,
 *  so a raw-path lookup can miss those; the chip is best-effort by design. */
export function reviewStatusForKey(sourceKey: string): { state: "approved" | "changes"; reviewer: string } | null {
  const doc = docs.get(sourceKey);
  if (!doc) return null;
  const st = doc.activeVersionId ? doc.status[doc.activeVersionId] : undefined;
  if (!st || st.state === "pending") return null;
  return { state: st.state, reviewer: (st as { reviewer?: string }).reviewer ?? "" };
}
