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
  const cmp = (a: LibraryItem, b: LibraryItem): number => {
    if (key === "date") return (a.modified_ms - b.modified_ms) || byName(a, b);
    if (key === "size") return (a.size_bytes - b.size_bytes) || byName(a, b);
    return byName(a, b);
  };
  const sorted = [...items].sort(cmp);
  return dir === "desc" ? sorted.reverse() : sorted;
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

/** The chosen poster timestamp for one path, or null when it uses the auto frame. */
export function chosenPosterFor(path: string): number | null {
  const map = loadChosenPosters();
  return Object.prototype.hasOwnProperty.call(map, path) ? map[path] : null;
}

/** Persist a user-chosen poster timestamp for `path`. */
export function setChosenPoster(path: string, seconds: number): void {
  if (!Number.isFinite(seconds) || seconds < 0) return;
  const map = loadChosenPosters();
  map[path] = seconds;
  saveJson(THUMB_TIMES_KEY, map);
}

/** Forget a chosen poster so `path` reverts to the auto/representative frame. */
export function clearChosenPoster(path: string): void {
  const map = loadChosenPosters();
  if (!Object.prototype.hasOwnProperty.call(map, path)) return;
  delete map[path];
  saveJson(THUMB_TIMES_KEY, map);
}
