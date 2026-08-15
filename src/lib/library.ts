/**
 * Library pure logic — root-list persistence, scanned-tree math, and
 * client-side search. Shared by the Home shelves and the Library browser.
 *
 * Pure functions live apart from the localStorage wrappers so they unit-test
 * without a DOM (mirrors recent-sources.ts). The tree shape
 * (`LibraryFolder`/`LibraryItem`) is the ts-rs binding generated from
 * `src-tauri/src/commands/library.rs` — Rust owns that contract.
 */

import type { LibraryFolder, LibraryItem } from "../types";
import { loadJson, saveJson } from "./storage";

const ROOTS_KEY = "saucebunny.libraryRoots";
const THUMB_TIMES_KEY = "saucebunny.libraryThumbTimes";
const SOURCE_TC_KEY = "saucebunny.sourceTimecodes";

/** `HH:MM:SS:FF` (non-drop) or `HH:MM:SS;FF` (drop-frame). The store keeps the
 *  string as authored; the drop-frame-aware, frame-rate-checked validation
 *  happens at the setter dialog (marker-time.tcToFrames). This is the shape
 *  gate so a junk value can never enter the map. */
export const SOURCE_TC_RE = /^\d{2}:\d{2}:\d{2}[:;]\d{2}$/;

/** Folder levels `scan_library_folder` descends (see library.rs module docs). */
export const LIBRARY_SCAN_DEPTH = 3;

/** One breadcrumb segment of a drill-in chain (root → … → current folder). */
export type LibraryCrumb = { name: string; path: string };

/** A folder search hit plus the drill chain that reaches it. */
export type LibraryFolderHit = { folder: LibraryFolder; chain: LibraryCrumb[] };

export type LibrarySearchResult = {
  folders: LibraryFolderHit[];
  items: LibraryItem[];
  /** Matching items BEFORE the cap — drives the "showing N of M" note. */
  totalItems: number;
};

/**
 * Junk-tolerant validation of the persisted roots blob: strings only, no
 * empties, de-dup preserving order. Corrupt shapes yield [] rather than
 * crashing the Library render (same contract as sanitizeRecentSources).
 */
export function sanitizeLibraryRoots(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of raw) {
    if (typeof x !== "string" || x === "" || seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

/** Recursive playable-item count for a folder subtree (row/card counts). */
export function countLibraryItems(folder: LibraryFolder): number {
  return folder.items.length +
    folder.folders.reduce((n, f) => n + countLibraryItems(f), 0);
}

/**
 * Every playable item in a folder subtree, depth-first (own files before
 * sub-folder files). The Library browser's main pane is a FLAT media view of
 * the tree selection, so a selected folder shows everything beneath it —
 * search/sort/kind-filter then operate over this list.
 */
export function collectLibraryItems(folder: LibraryFolder): LibraryItem[] {
  const out: LibraryItem[] = [...folder.items];
  for (const sub of folder.folders) out.push(...collectLibraryItems(sub));
  return out;
}

/** Find a folder node by absolute path across the scanned trees (self or root). */
export function findLibraryFolder(
  trees: readonly LibraryFolder[],
  path: string,
): LibraryFolder | null {
  const walk = (node: LibraryFolder): LibraryFolder | null => {
    if (node.path === path) return node;
    for (const sub of node.folders) {
      const hit = walk(sub);
      if (hit) return hit;
    }
    return null;
  };
  for (const t of trees) {
    const hit = walk(t);
    if (hit) return hit;
  }
  return null;
}

export type LibrarySortKey = "name" | "date" | "size";
export type LibrarySortDir = "asc" | "desc";
export type LibraryKindFilter = "all" | "video" | "audio";

/**
 * Sort a copy of `items` by name / modified date / size. Name uses a
 * locale-aware, numeric-aware compare ("clip2" before "clip10"); ties on
 * date/size fall back to name so the order is stable and never jitters.
 */
export function sortLibraryItems(
  items: readonly LibraryItem[],
  key: LibrarySortKey,
  dir: LibrarySortDir,
): LibraryItem[] {
  const byName = (a: LibraryItem, b: LibraryItem) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  // The direction applies to the PRIMARY key only. Reversing the finished
  // array flips the name tiebreak along with it, so "newest first" listed
  // same-day files Z to A while "oldest first" listed them A to Z. Finder
  // keeps the secondary sort ascending in both directions, and a file list
  // that reorders its own tiebreak reads as arbitrary.
  const sign = dir === "desc" ? -1 : 1;
  const cmp = (a: LibraryItem, b: LibraryItem): number => {
    if (key === "date") return sign * (a.modified_ms - b.modified_ms) || byName(a, b);
    if (key === "size") return sign * (a.size_bytes - b.size_bytes) || byName(a, b);
    // Name IS the primary key here, so this one does flip.
    return sign * byName(a, b);
  };
  return [...items].sort(cmp);
}

/**
 * Up to `max` VIDEO paths for a folder's stacked-poster art — breadth-first
 * so the collection cover favors the folder's own files over deep leaves.
 * Audio never yields a poster frame, so it's skipped.
 */
export function libraryPosterPaths(folder: LibraryFolder, max = 3): string[] {
  const out: string[] = [];
  const queue: LibraryFolder[] = [folder];
  while (queue.length > 0 && out.length < max) {
    const node = queue.shift()!;
    for (const it of node.items) {
      if (it.kind !== "video") continue;
      out.push(it.path);
      if (out.length >= max) break;
    }
    queue.push(...node.folders);
  }
  return out;
}

/**
 * Case-insensitive substring search over every scanned tree — item names and
 * folder names both match. Item results are capped (the grid stays renderable
 * against a 10k-file music library); `totalItems` still counts every match so
 * the UI can say "showing N of M". Folder hits carry their breadcrumb chain
 * so clicking one can drill straight in.
 */
export function searchLibrary(
  trees: readonly LibraryFolder[],
  rawQuery: string,
  caps: { items?: number; folders?: number } = {},
): LibrarySearchResult {
  const itemCap = caps.items ?? 120;
  const folderCap = caps.folders ?? 30;
  const q = rawQuery.trim().toLowerCase();
  const result: LibrarySearchResult = { folders: [], items: [], totalItems: 0 };
  if (!q) return result;
  const walk = (node: LibraryFolder, chain: LibraryCrumb[]) => {
    if (node.name.toLowerCase().includes(q) && result.folders.length < folderCap) {
      result.folders.push({ folder: node, chain });
    }
    for (const it of node.items) {
      if (!it.name.toLowerCase().includes(q)) continue;
      result.totalItems++;
      if (result.items.length < itemCap) result.items.push(it);
    }
    for (const sub of node.folders) {
      walk(sub, [...chain, { name: sub.name, path: sub.path }]);
    }
  };
  for (const t of trees) walk(t, [{ name: t.name, path: t.path }]);
  return result;
}


/** "820 KB" / "34 MB" / "1.2 GB" — one significant decimal under 10. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  const kb = n / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  const gb = mb / 1024;
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`;
}

/**
 * Card date line from `modified_ms`: "Jun 3" this year, "Jun 3, 2024"
 * otherwise, "" when the FS wouldn't say (scan encodes that as 0).
 */
export function formatModifiedDate(ms: number, now = new Date()): string {
  if (ms <= 0) return "";
  const d = new Date(ms);
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" as const } : {}),
  });
}

// ── localStorage wrappers (best-effort, via lib/storage) ────────────────

export function loadLibraryRoots(): string[] {
  return sanitizeLibraryRoots(loadJson<unknown>(ROOTS_KEY, []));
}

export function saveLibraryRoots(roots: readonly string[]): void {
  saveJson(ROOTS_KEY, roots);
}

// ── Chosen thumbnail times (localStorage `saucebunny.libraryThumbTimes`):
//    path → timestamp (seconds) the user picked in the "Choose thumbnail…"
//    picker. Absence means the auto/representative frame. ──

/**
 * Load the chosen-poster map, tolerating junk: only string→finite-number
 * entries survive (a corrupt blob yields {} rather than crashing the Library).
 */
export function loadChosenPosters(): Record<string, number> {
  const raw = loadJson<unknown>(THUMB_TIMES_KEY, {});
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k === "string" && k !== "" && typeof v === "number" && Number.isFinite(v) && v >= 0) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Parsed-and-validated poster map, cached in module scope.
 *
 * `chosenPosterFor` is called once per video by the boot thumbnail sweep, and
 * every call was re-reading localStorage, JSON.parsing it and re-validating
 * every entry. Measured at 36.8µs for 200 entries and 190.7µs for 1000, so a
 * 2000-file library spent roughly 150ms of pure synchronous re-parsing while
 * the user looked at an empty Library.
 *
 * Invalidated by the two writers below, which are the only things that can
 * change it in this window. A second window has its own module instance, and
 * a poster chosen over there is exactly the kind of change the existing
 * poster-version bump already re-reads for.
 */
let posterCache: Record<string, number> | null = null;

/** The chosen poster timestamp for one path, or null when it uses the auto frame. */
export function chosenPosterFor(path: string): number | null {
  const map = (posterCache ??= loadChosenPosters());
  return Object.prototype.hasOwnProperty.call(map, path) ? map[path] : null;
}

/** Persist a user-chosen poster timestamp for `path`. */
export function setChosenPoster(path: string, seconds: number): void {
  if (!Number.isFinite(seconds) || seconds < 0) return;
  const map = loadChosenPosters();
  map[path] = seconds;
  saveJson(THUMB_TIMES_KEY, map);
  posterCache = map;
}

/**
 * Replace the whole chosen-poster map.
 *
 * Exists for the rename path, which has to MOVE a key rather than set or clear
 * one — doing that as clear-then-set would lose the value if anything failed
 * between the two writes.
 */
export function saveChosenPosters(map: Record<string, number>): void {
  saveJson(THUMB_TIMES_KEY, map);
  posterCache = map;
}

/** Forget a chosen poster so `path` reverts to the auto/representative frame. */
export function clearChosenPoster(path: string): void {
  const map = loadChosenPosters();
  if (!Object.prototype.hasOwnProperty.call(map, path)) return;
  delete map[path];
  saveJson(THUMB_TIMES_KEY, map);
  posterCache = map;
}

// ── Source start timecodes (localStorage `saucebunny.sourceTimecodes`):
//    path → "HH:MM:SS:FF" the file's own timeline starts at (its burn-in
//    timecode). Absence means it starts at 00:00:00:00. Used to align notes
//    and, above all, to offset Avid marker export so markers land on the
//    burn-in TC. Keyed by absolute path — source TC is intrinsic to the file,
//    so no content fingerprint is needed. Local files only. ──

/** Load the source-timecode map, tolerating junk: only string→well-formed-TC
 *  entries survive (a corrupt blob yields {} rather than crashing). */
export function loadSourceTimecodes(): Record<string, string> {
  const raw = loadJson<unknown>(SOURCE_TC_KEY, {});
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k === "string" && k !== "" && typeof v === "string" && SOURCE_TC_RE.test(v)) {
      out[k] = v;
    }
  }
  return out;
}

/** Replace the whole source-timecode map. See saveChosenPosters — same reason:
 *  a rename moves a key, and clear-then-set can lose the value in between. */
export function saveSourceTimecodes(map: Record<string, string>): void {
  saveJson(SOURCE_TC_KEY, map);
}

/** The source start timecode for one path, or null when it starts at zero. */
export function sourceTimecodeFor(path: string): string | null {
  const map = loadSourceTimecodes();
  return Object.prototype.hasOwnProperty.call(map, path) ? map[path] : null;
}

/** Persist a file's source start timecode. Ignores a malformed TC (the dialog
 *  validates against the frame rate before calling this; this is the last
 *  gate). */
/** Shape AND field-range check for a source start timecode: `HH:MM:SS:FF`
 *  (`;` for drop-frame) with MM<60, SS<60, FF<60. Shape alone let junk like
 *  99:99:99:99 be stored, then silently dropped to a zero offset at export. */
export function isValidSourceTc(tc: string): boolean {
  const t = tc.trim();
  if (!SOURCE_TC_RE.test(t)) return false;
  const [, mm, ss, ff] = t.split(/[:;]/).map(Number);
  return mm < 60 && ss < 60 && ff < 60;
}

export function setSourceTimecode(path: string, tc: string): void {
  if (!isValidSourceTc(tc)) return;
  const map = loadSourceTimecodes();
  map[path] = tc.trim();
  saveJson(SOURCE_TC_KEY, map);
}

/** Forget a file's source timecode so it reverts to starting at zero. */
export function clearSourceTimecode(path: string): void {
  const map = loadSourceTimecodes();
  if (!Object.prototype.hasOwnProperty.call(map, path)) return;
  delete map[path];
  saveJson(SOURCE_TC_KEY, map);
}
