/**
 * Persistence for screenings — the memory of a review session.
 *
 *   ~/Documents/Sauce Bunny/
 *     Reviews/      ← untouched by this module
 *     Screenings/
 *       index.json
 *       2026-07-20-friday-review-3f2a1b9c.json
 *
 * Deliberately FLAT, not YYYY-MM/: the index's filename guard (no path
 * separators, so an entry can never escape the folder) is worth more than
 * tidy subfolders, and screenings number in the tens, not thousands.
 *
 * Unlike reviews, a screening is never needed synchronously, so boot reads
 * ONLY index.json - enough to list them - and a full doc is read on demand.
 * Writes are immediate rather than debounced: they happen on source change
 * and session end, which are rare and each one matters.
 */

import { invoke } from "@tauri-apps/api/core";
import type { ScreeningDoc } from "./screening";
import { screeningCommentCount } from "./screening";
import { screeningSourceKeys } from "./review-ledger";
import { STORE_SCHEMA_VERSION, futureVersionIn, reportFutureVersion } from "./store-schema";

/** One row in the index: everything a library card needs WITHOUT opening the
 *  full document. */
export type ScreeningIndexEntry = {
  /** Filename only, never a path (see parseScreeningIndex). */
  file: string;
  title: string;
  startedAt: number;
  endedAt: number;
  participants: string[];
  segmentCount: number;
  commentCount: number;
  bytes: number;
  /** Every source this screening watched, so "which sessions saw this clip?"
   *  can be answered from the index instead of by opening every file.
   *
   *  OPTIONAL, and absent on every entry written before it existed. Callers
   *  must treat "absent" as "unknown", never as "none" - reading it as none
   *  would hide the whole history of anything reviewed before this shipped,
   *  which is exactly the material the ledger exists to show. */
  sourceKeys?: string[];
};

const INDEX_FILE = "index.json";
let screeningsDir: string | null = null;
let index: Map<string, ScreeningIndexEntry> = new Map();
let hydrated = false;
/** Set if index.json is newer than this build. A screening is the memory of
 *  a review session and nothing regenerates it, so this store refuses to
 *  write rather than rewrite an index it only half understands. */
let futureVersion: number | null = null;

/** Test-only: drop the module-level index + hydration latch so each case
 *  starts from a cold launch (mirrors resetReviewStoreForTests). */
export function resetScreeningStoreForTests(): void {
  index = new Map();
  hydrated = false;
  futureVersion = null;
}

/** FNV-1a 32-bit hex — same helper the review store uses, kept local so the
 *  two stores stay independent. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** `<YYYY-MM-DD>-<slug>-<hash>.json`. The date leads so the folder sorts
 *  chronologically in Finder; the hash guarantees uniqueness. */
export function screeningFileName(doc: ScreeningDoc): string {
  const d = new Date(doc.startedAt);
  const date = [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, "0"),
    String(d.getDate()).padStart(2, "0"),
  ].join("-");
  const slug = (doc.title || "screening")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
  return `${date}-${slug || "screening"}-${fnv1a(doc.id)}.json`;
}

type ScreeningIndexFile = { version: number; screenings: Record<string, ScreeningIndexEntry> };

/** Tolerant parse: malformed, absent, or future-version content yields an
 *  empty index rather than throwing. A bad file must never stop the app from
 *  starting - the worst case is that the list looks empty. */
export function parseScreeningIndex(text: unknown): Map<string, ScreeningIndexEntry> {
  const out = new Map<string, ScreeningIndexEntry>();
  if (typeof text !== "string" || !text) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return out;
  }
  const rec = (parsed as ScreeningIndexFile | null)?.screenings;
  if (!rec || typeof rec !== "object") return out;
  for (const [id, e] of Object.entries(rec)) {
    if (!e || typeof e !== "object" || typeof (e as ScreeningIndexEntry).file !== "string") continue;
    const entry = e as ScreeningIndexEntry;
    // A filename carrying a path separator could escape Screenings/.
    if (/[/\\]/.test(entry.file)) continue;
    out.set(id, {
      file: entry.file,
      title: typeof entry.title === "string" ? entry.title : "Screening",
      startedAt: typeof entry.startedAt === "number" ? entry.startedAt : 0,
      endedAt: typeof entry.endedAt === "number" ? entry.endedAt : 0,
      participants: Array.isArray(entry.participants)
        ? entry.participants.filter((p): p is string => typeof p === "string")
        : [],
      segmentCount: typeof entry.segmentCount === "number" ? entry.segmentCount : 0,
      commentCount: typeof entry.commentCount === "number" ? entry.commentCount : 0,
      bytes: typeof entry.bytes === "number" ? entry.bytes : 0,
    });
  }
  return out;
}

/** Index row for a doc — what the list shows without opening the file. */
export function indexEntryFor(doc: ScreeningDoc, bytes: number): ScreeningIndexEntry {
  return {
    file: screeningFileName(doc),
    title: doc.title,
    startedAt: doc.startedAt,
    endedAt: doc.endedAt,
    participants: doc.participants.map((p) => p.name),
    segmentCount: doc.segments.length,
    commentCount: screeningCommentCount(doc),
    bytes,
    sourceKeys: screeningSourceKeys(doc),
  };
}

async function resolveDir(): Promise<string | null> {
  if (screeningsDir) return screeningsDir;
  try {
    const lib = await invoke<string>("default_transcript_library_path");
    if (typeof lib !== "string" || !lib.trim()) return null;
    // Screenings sit beside Reviews at the app's Documents root. Derived the
    // SAME way review-store derives its own dir - strip the last segment
    // rather than matching the literal name "Transcripts", which would break
    // the moment that folder is named anything else.
    const root = lib.replace(/\/+$/, "").split("/").slice(0, -1).join("/");
    if (!root) return null;
    screeningsDir = `${root}/Screenings`;
    return screeningsDir;
  } catch {
    return null;
  }
}

/**
 * The absolute path of one screening file, for revealing it in Finder.
 *
 * Only meaningful after `hydrateScreeningIndex` has resolved the directory;
 * returns null before that, and for a name the index does not hold, so a
 * caller can never be handed a path built from an unvalidated string.
 */
export function screeningPath(id: string): string | null {
  if (!screeningsDir) return null;
  // Keyed by the screening's ID, because that is what `index` is keyed by
  // (saveScreening does `index.set(doc.id, ...)`). This took a FILENAME and
  // asked `index.has(file)`, which is never true, so Reveal in the Past
  // screenings list returned null on every row and the button did nothing.
  // The filename still comes from the entry, never from the caller, so a
  // caller still cannot make us build a path out of an unvalidated string.
  const entry = index.get(id);
  if (!entry) return null;
  return `${screeningsDir}/${entry.file}`;
}

/** Read index.json once. Cheap: one small file, no documents. */
/**
 * Shared by every concurrent caller.
 *
 * `hydrated` used to be set at the TOP of this function, before the awaits
 * below had run - so a SECOND caller arriving while the first was still
 * reading returned instantly, read an empty index, and never retried. That
 * was invisible while the shelf was the only caller and appeared the moment
 * the lobby needed the titles too: the shelf listed the screenings correctly
 * and the lobby was certain there were none.
 */
let hydrating: Promise<void> | null = null;

export async function hydrateScreeningIndex(): Promise<void> {
  if (hydrated) return;
  if (hydrating) return hydrating;
  hydrating = hydrateOnce().finally(() => { hydrating = null; });
  return hydrating;
}

async function hydrateOnce(): Promise<void> {
  const dir = await resolveDir();
  // No resolvable Documents root: nothing to read, but the attempt IS over.
  // Leaving `hydrated` false here would make every future call re-resolve a
  // path that is not going to appear.
  if (!dir) { hydrated = true; return; }
  try {
    const text = await invoke<string>("read_text_file_capped", {
      path: `${dir}/${INDEX_FILE}`,
      maxBytes: 512 * 1024,
    });
    const fv = futureVersionIn(text);
    if (fv !== null) { futureVersion = fv; reportFutureVersion("screenings", fv); }
    index = parseScreeningIndex(text);
  } catch {
    index = new Map(); // no folder yet is the normal first-run case
  }
  hydrated = true;
}

/** Every known screening, newest first. */
export function listScreenings(): (ScreeningIndexEntry & { id: string })[] {
  return [...index.entries()]
    .map(([id, e]) => ({ id, ...e }))
    .sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * Every screening that watched `sourceKey`, for the review panel's ledger.
 *
 * The index is a filter, not the answer: an entry that LISTS its sources and
 * does not include this one is skipped without a read, while an entry with no
 * `sourceKeys` (written before that field existed) has to be opened to find
 * out. So an old library costs more reads than a new one and neither is wrong.
 *
 * Bounded on purpose. This runs when a review panel opens, which is a normal
 * thing to do repeatedly, and a shelf of hundreds of screenings must not turn
 * that into hundreds of file reads. The newest are the ones a ledger is read
 * for, and `listScreenings` already returns newest first.
 */
export async function loadScreeningsForSource(
  sourceKey: string, limit = 60,
): Promise<ScreeningDoc[]> {
  await hydrateScreeningIndex();
  const out: ScreeningDoc[] = [];
  let opened = 0;
  for (const entry of listScreenings()) {
    if (out.length >= limit || opened >= limit) break;
    if (entry.sourceKeys && !entry.sourceKeys.includes(sourceKey)) continue;
    opened += 1;
    const doc = await loadScreening(entry.id);
    if (doc && doc.segments.some((s) => s.localSourceKey === sourceKey)) out.push(doc);
  }
  return out;
}

/** Read one full screening. Null when it is missing or unreadable. */
export async function loadScreening(id: string): Promise<ScreeningDoc | null> {
  const dir = await resolveDir();
  const entry = index.get(id);
  if (!dir || !entry) return null;
  try {
    const text = await invoke<string>("read_text_file_capped", {
      path: `${dir}/${entry.file}`,
      maxBytes: 4 * 1024 * 1024,
    });
    return JSON.parse(text) as ScreeningDoc;
  } catch {
    return null;
  }
}

/** Write a screening and update the index. Best-effort: a failed write must
 *  never take down the session that produced it. */
/**
 * Fired on `window` after a screening lands on disk and the index is rewritten.
 * Anything showing the list of screenings - or enforcing the unique-name rule
 * against it - should re-read on this rather than trusting a value it read at
 * mount.
 */
export const SCREENINGS_CHANGED = "saucebunny:screenings-changed";

export async function saveScreening(doc: ScreeningDoc): Promise<void> {
  const dir = await resolveDir();
  if (!dir) return;
  // Read the on-disk index BEFORE rewriting it. Without this the module-level
  // `index` is an empty Map on every fresh launch, so the first save of each
  // session wrote an index.json containing ONLY that screening and erased
  // every earlier row - the documents stayed on disk as orphans nothing could
  // list. hydrateScreeningIndex is idempotent, so this costs one small read
  // per launch. (review-store.ts:214 carries an explicit indexReady guard
  // against exactly this hazard; this store was missing its half.)
  await hydrateScreeningIndex();
  // Refuse the whole save, not just the index write: a document written
  // beside an index we must not touch is an orphan nothing can list.
  if (futureVersion !== null) return;
  const file = screeningFileName(doc);
  const json = JSON.stringify(doc, null, 2);
  try {
    await invoke("ensure_dir_exists", { path: dir });
    await invoke("write_text_to_path", { path: `${dir}/${file}`, text: json, atomic: true });
    index.set(doc.id, indexEntryFor(doc, json.length));
    const indexJson = JSON.stringify(
      { version: STORE_SCHEMA_VERSION, screenings: Object.fromEntries(index) } satisfies ScreeningIndexFile,
      null, 2,
    );
    await invoke("write_text_to_path", { path: `${dir}/${INDEX_FILE}`, text: indexJson, atomic: true });
    // ANNOUNCE IT. The lobby reads the taken titles once on mount and is then
    // kept alive under [hidden] for the life of the app, so without this the
    // "every screening gets its own name" rule went stale the moment a session
    // ended: end "Rough cut", press Start again on the restored title, and the
    // library took a second "Rough cut" without a word. Same window CustomEvent
    // shape the speaker overrides already use for their same-window fast path.
    try { window.dispatchEvent(new CustomEvent(SCREENINGS_CHANGED)); }
    catch { /* no window in a test environment; the write still landed */ }
  } catch (err) {
    // REJECTS rather than swallowing. The previous version caught this and
    // called console.warn, with a comment claiming that meant the failure was
    // not silent - but in a packaged .app the WKWebView console needs Safari's
    // inspector attached, which CLAUDE.md states outright, so it reached
    // nobody. A screening that never landed on disk simply vanished.
    //
    // The two sibling stores both surface write failures to the UI (review via
    // reportProblem, casts via lastError + notify). This one has no subscriber
    // of its own, so it hands the error to its single caller, which sits in
    // use-co-review and has the pipeline log.
    console.warn("screening-store: save failed:", err);
    throw err;
  }
}
