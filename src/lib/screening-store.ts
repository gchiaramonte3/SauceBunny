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
};

const INDEX_FILE = "index.json";
let screeningsDir: string | null = null;
let index: Map<string, ScreeningIndexEntry> = new Map();
let hydrated = false;

/** Test-only: drop the module-level index + hydration latch so each case
 *  starts from a cold launch (mirrors resetReviewStoreForTests). */
export function resetScreeningStoreForTests(): void {
  index = new Map();
  hydrated = false;
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

type ScreeningIndexFile = { version: 1; screenings: Record<string, ScreeningIndexEntry> };

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
export function screeningPath(file: string): string | null {
  if (!screeningsDir) return null;
  if (!index.has(file)) return null;
  return `${screeningsDir}/${file}`;
}

/** Read index.json once. Cheap: one small file, no documents. */
export async function hydrateScreeningIndex(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  const dir = await resolveDir();
  if (!dir) return;
  try {
    const text = await invoke<string>("read_text_file_capped", {
      path: `${dir}/${INDEX_FILE}`,
      maxBytes: 512 * 1024,
    });
    index = parseScreeningIndex(text);
  } catch {
    index = new Map(); // no folder yet is the normal first-run case
  }
}

/** Every known screening, newest first. */
export function listScreenings(): (ScreeningIndexEntry & { id: string })[] {
  return [...index.entries()]
    .map(([id, e]) => ({ id, ...e }))
    .sort((a, b) => b.startedAt - a.startedAt);
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
  const file = screeningFileName(doc);
  const json = JSON.stringify(doc, null, 2);
  try {
    await invoke("ensure_dir_exists", { path: dir });
    await invoke("write_text_to_path", { path: `${dir}/${file}`, text: json, atomic: true });
    index.set(doc.id, indexEntryFor(doc, json.length));
    const indexJson = JSON.stringify(
      { version: 1, screenings: Object.fromEntries(index) } satisfies ScreeningIndexFile,
      null, 2,
    );
    await invoke("write_text_to_path", { path: `${dir}/${INDEX_FILE}`, text: indexJson, atomic: true });
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
