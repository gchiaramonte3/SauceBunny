import { invoke } from "@tauri-apps/api/core";
import { STORE_SCHEMA_VERSION, futureVersionIn, reportFutureVersion } from "./store-schema";

/**
 * User collections for web sources - the "organize everything" the cache's
 * automatic site shelves cannot do.
 *
 * Three decisions define this store, each taken from the parity audit's
 * recommendation and recorded in docs/DECISIONS.md:
 *
 * ORGANISATION IS VIRTUAL, KEYED BY RAW URL. Moving a web item into a
 * collection never moves its cached file: a copy moved out of
 * saucebunny-media/ severs find_cached_download, goes cold on the warm
 * start, and orphans the cache cap. The URL is what every satellite store
 * (recents, posters, transcript history, review docs) already keys on.
 *
 * DOCUMENTS-CLASS, ONE FILE. ~/Documents/Sauce Bunny/Collections/
 * collections.json, beside Casts and Reviews, because a season of curation
 * is a user's work: cache-class storage is destroyed by Forget/cap/
 * Clear-all, and localStorage is the audit's named data-loss hole (F2).
 * One file, not sharded - a shelf of collections is kilobytes.
 *
 * A COLLECTION MAY HOLD URLS THE CACHE HAS FORGOTTEN. Pruning the cache
 * must not silently edit the user's curation, so membership survives a
 * forget; the pane simply has nothing to render for that URL until the
 * source is fetched again.
 *
 * Mechanically this is transcript-project-store: writes are REFUSED until
 * hydration has accounted for the disk copy (an empty list at boot means
 * "not loaded yet", and writing it would erase the file with a subset of
 * itself), the write is debounced + atomic, the file carries a schema
 * version, and a file stamped NEWER than this build loads best-effort and
 * is never written (store-schema.ts).
 */

export type WebCollection = {
  id: string;
  name: string;
  urls: string[];
  createdMs: number;
};

const FILE = "collections.json";
const DIR = "Collections";
const READ_CAP = 2 * 1024 * 1024;
const WRITE_DEBOUNCE_MS = 400;
export const MAX_COLLECTIONS = 200;

let collections: WebCollection[] = [];
let dir: string | null = null;
let dirEnsured = false;
let hydrated = false;
let hydrating = false;
let pendingWrite = false;
let futureVersion: number | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

export function subscribeWebCollections(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Stable identity between notifications; every mutation replaces the array. */
export function getWebCollections(): WebCollection[] {
  return collections;
}

/** Tolerant parse - a malformed file yields what could be read, not a crash.
 *  Duplicate ids keep the first; blank names and non-string urls are dropped. */
export function parseWebCollections(raw: unknown): WebCollection[] {
  if (!raw || typeof raw !== "object") return [];
  const list = (raw as Record<string, unknown>).collections;
  if (!Array.isArray(list)) return [];
  const out: WebCollection[] = [];
  const seen = new Set<string>();
  for (const item of list.slice(0, MAX_COLLECTIONS)) {
    if (!item || typeof item !== "object") continue;
    const o = item as Partial<WebCollection>;
    const id = typeof o.id === "string" && o.id ? o.id : "";
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (!id || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name,
      urls: Array.isArray(o.urls)
        ? [...new Set(o.urls.filter((u): u is string => typeof u === "string" && u.length > 0))]
        : [],
      createdMs: typeof o.createdMs === "number" && o.createdMs > 0 ? o.createdMs : 0,
    });
  }
  return out;
}

function save(): void {
  pendingWrite = true;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => { void flush(); }, WRITE_DEBOUNCE_MS);
}

async function flush(): Promise<void> {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  // `pendingWrite` deliberately STAYS set until hydration accounts for the
  // disk copy - same guard, same reason as every sibling store.
  if (!hydrated || !dir) return;
  if (futureVersion !== null) { pendingWrite = false; return; }
  pendingWrite = false;
  try {
    if (!dirEnsured) {
      await invoke("ensure_dir_exists", { path: dir });
      dirEnsured = true;
    }
    const text = JSON.stringify({ version: STORE_SCHEMA_VERSION, collections }, null, 2);
    await invoke("write_text_to_path", { path: `${dir}/${FILE}`, text, atomic: true });
  } catch {
    // Re-arm rather than dropping the edit - a transient failure must not
    // cost curation the user already saw take effect.
    pendingWrite = true;
  }
}

/** Force any pending write out now (window close). */
export async function flushWebCollections(): Promise<void> {
  if (pendingWrite) await flush();
}

/** Flush on quit, for the same reason cast-store does: a debounced write that
 *  only runs on a React unmount is lost when the window closes. */
let quitFlushRegistered = false;
function registerQuitFlush(): void {
  if (quitFlushRegistered) return;
  quitFlushRegistered = true;
  try { window.addEventListener("pagehide", () => void flushWebCollections()); }
  catch { /* non-DOM context (tests) */ }
}

export async function hydrateWebCollections(): Promise<void> {
  registerQuitFlush();
  if (hydrated || hydrating) return;
  hydrating = true;
  try {
    let resolved: string | null = null;
    try {
      const lib = await invoke<string>("default_transcript_library_path");
      // Beside Transcripts, Casts and Reviews at the app's Documents root -
      // derived from the DEFAULT path command, exactly as cast-store does.
      const root = typeof lib === "string" && lib.trim()
        ? lib.replace(/\/+$/, "").split("/").slice(0, -1).join("/")
        : "";
      if (root) resolved = `${root}/${DIR}`;
    } catch { /* mocked or unavailable - memory-only session */ }
    if (resolved) {
      dir = resolved;
      try {
        const text = await invoke<string>("read_text_file_capped", {
          path: `${dir}/${FILE}`, maxBytes: READ_CAP,
        });
        const fv = futureVersionIn(text);
        if (fv !== null) { futureVersion = fv; reportFutureVersion("collections", fv); }
        const loaded = parseWebCollections(JSON.parse(text));
        if (loaded.length > 0) {
          // Anything created while the read was in flight wins over disk.
          const live = new Set(collections.map((c) => c.id));
          collections = [...collections, ...loaded.filter((c) => !live.has(c.id))].slice(0, MAX_COLLECTIONS);
        }
      } catch { /* no file yet - a fresh start */ }
    }
  } finally {
    hydrated = true;
    hydrating = false;
    notify();
    if (pendingWrite) void flush();
  }
}

export function createWebCollection(name: string): WebCollection | null {
  const trimmed = name.trim();
  if (!trimmed || collections.length >= MAX_COLLECTIONS) return null;
  const c: WebCollection = {
    id: Math.random().toString(36).slice(2),
    name: trimmed,
    urls: [],
    createdMs: Date.now(),
  };
  collections = [...collections, c];
  save();
  notify();
  return c;
}

export function deleteWebCollection(id: string): void {
  const next = collections.filter((c) => c.id !== id);
  if (next.length === collections.length) return;
  collections = next;
  save();
  notify();
}

export function renameWebCollection(id: string, name: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  collections = collections.map((c) => (c.id === id ? { ...c, name: trimmed } : c));
  save();
  notify();
}

/** Add a URL to a collection (idempotent). */
export function addToWebCollection(id: string, url: string): void {
  collections = collections.map((c) =>
    c.id === id && !c.urls.includes(url) ? { ...c, urls: [...c.urls, url] } : c,
  );
  save();
  notify();
}

export function removeFromWebCollection(id: string, url: string): void {
  collections = collections.map((c) =>
    c.id === id ? { ...c, urls: c.urls.filter((u) => u !== url) } : c,
  );
  save();
  notify();
}

/** Test seam: reset module state between cases. */
export function __resetWebCollectionStore(): void {
  collections = [];
  dir = null;
  dirEnsured = false;
  hydrated = false;
  hydrating = false;
  pendingWrite = false;
  futureVersion = null;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  listeners.clear();
}
