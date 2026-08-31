import { pathKey } from "./repath";

/**
 * Paths the Library has been told to forget, without touching the file.
 *
 * The Library is a LIVE SCAN of the roots you point it at, not a list you
 * curated, so "remove this" has no obvious meaning: the next scan finds the
 * file again. The only honest implementation is an exclusion set the scan
 * filters through, which is what this is.
 *
 * That distinction is the whole point of the feature. "Move to Trash…" is a
 * Finder-level act on someone's footage; "Remove from Library" is a statement
 * about this app's shelf. Offering only the first meant the sole way to get a
 * clip out of view was to put the file in the bin.
 *
 * Keyed by pathKey(), the app's one NFC normaliser. macOS stores filenames
 * DECOMPOSED and a text field hands back COMPOSED, so "café.mov" is two
 * different strings depending on which side asked - and a set keyed on the
 * raw string would hide a file that then reappeared under its other spelling.
 * Deliberately case-SENSITIVE, like the rest of the path stores.
 *
 * Uncapped, and that is a decision rather than an oversight: an entry is
 * created only by an explicit act, it is one path, and there is a control in
 * Settings that empties the whole set. It is not the unbounded-by-scanning
 * kind of growth the storage notes in CLAUDE.md are about.
 */

const KEY = "saucebunny.libraryHidden";
const listeners = new Set<() => void>();

let cache: Set<string> | null = null;

function load(): Set<string> {
  if (cache) return cache;
  const out = new Set<string>();
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (Array.isArray(raw)) {
      for (const p of raw) if (typeof p === "string" && p) out.add(pathKey(p));
    }
  } catch { /* a mangled value costs the exclusions, not a crash */ }
  cache = out;
  return out;
}

function save(set: Set<string>): void {
  cache = set;
  try { localStorage.setItem(KEY, JSON.stringify([...set])); } catch { /* quota */ }
  for (const fn of listeners) fn();
}

/** Subscribe to changes, so a list re-filters the moment one is added. */
export function subscribeHidden(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function isHidden(path: string): boolean {
  return load().has(pathKey(path));
}

/** Stop showing these paths. Idempotent. */
export function hidePaths(paths: readonly string[]): void {
  const next = new Set(load());
  for (const p of paths) next.add(pathKey(p));
  save(next);
}

/** Show them again. The inverse of hidePaths, and what undo calls. */
export function unhidePaths(paths: readonly string[]): void {
  const next = new Set(load());
  for (const p of paths) next.delete(pathKey(p));
  save(next);
}

/** How many are hidden, for the Settings control that offers to clear them. */
export function hiddenCount(): number {
  return load().size;
}

export function clearHidden(): void {
  save(new Set());
}

/** Filter a scanned list. The one place a caller should need. */
export function withoutHidden<T extends { path: string }>(items: readonly T[]): T[] {
  const set = load();
  return set.size === 0 ? [...items] : items.filter((it) => !set.has(pathKey(it.path)));
}

/** Test seam: drop the memoised set so a fresh localStorage is re-read. */
export function __resetHiddenCache(): void {
  cache = null;
}
