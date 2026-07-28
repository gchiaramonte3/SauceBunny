/**
 * Persistence for cast collections.
 *
 * ONE file, `~/Documents/Sauce Bunny/Casts/casts.json`, holding every cast —
 * not one file per cast like the Reviews store. Reviews shard because a single
 * annotation-heavy doc can be tens of megabytes and only one is ever open; a
 * whole shelf of casts is a few hundred kilobytes and the picker needs all of
 * them at once. Sharding here would buy nothing and cost a directory listing.
 *
 * It goes in Documents rather than localStorage for the reason the review docs
 * moved: a cast is a real piece of a user's work — thirty names, thirty
 * colours, thirty faces, built over a season — and WKWebView localStorage is
 * evictable by macOS with no warning and no recovery. It is also the folder
 * people back up.
 *
 * Uses only the EXISTING invoke surface (`default_transcript_library_path`,
 * `ensure_dir_exists`, `read_text_file_capped`, `write_text_to_path`), so this
 * feature adds no Tauri command and needs no build-ID bump.
 *
 * Reads are synchronous off an in-memory list; writes are debounced and go
 * through the atomic write (temp file, fsync, rename), so an interrupted save
 * leaves the previous complete file rather than a truncated one.
 */

import { invoke } from "@tauri-apps/api/core";
import { sanitizeCastFile, MAX_CASTS, type Cast } from "./cast";

const FILE = "casts.json";
const READ_CAP = 8 * 1024 * 1024;
const WRITE_DEBOUNCE_MS = 400;

let casts: Cast[] = [];
let dir: string | null = null;
let dirEnsured = false;
let hydrated = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** A write is owed. Survives a flush that had to bail for hydration. */
let pendingWrite = false;
const listeners = new Set<() => void>();

/** Last persist error, surfaced by the manager rather than only console-warned
 *  — a cast that never reached disk is exactly what a user must be told about
 *  while they can still act on it. */
let lastError: string | null = null;

export function subscribeCasts(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Stable identity between notifications, which useSyncExternalStore requires:
 *  every mutation below replaces the array, and nothing else does. */
export function getCasts(): Cast[] {
  return casts;
}

export function getCastError(): string | null {
  return lastError;
}

function notify(): void {
  for (const fn of listeners) fn();
}

function commit(next: Cast[]): void {
  casts = next.slice(0, MAX_CASTS);
  notify();
  scheduleFlush();
}

export function saveCast(cast: Cast): void {
  const stamped = { ...cast, updatedAt: Date.now() };
  const at = casts.findIndex((c) => c.id === cast.id);
  commit(at >= 0
    ? casts.map((c, i) => (i === at ? stamped : c))
    : [stamped, ...casts]);
}

export function deleteCast(id: string): void {
  if (!casts.some((c) => c.id === id)) return;
  commit(casts.filter((c) => c.id !== id));
}

function scheduleFlush(): void {
  pendingWrite = true;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => { void flush(); }, WRITE_DEBOUNCE_MS);
}

async function flush(): Promise<void> {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  // Never write before hydration: an empty in-memory list at boot is "not
  // loaded yet", not "the user has no casts", and writing it would erase the
  // file. This is the same clobber the review store guards against, and it is
  // the one bug in a store like this that is genuinely unrecoverable.
  //
  // `pendingWrite` deliberately STAYS set — it is what hydration reads to know
  // a write is owed once the disk copy has been accounted for.
  if (!hydrated || !dir) return;
  pendingWrite = false;
  try {
    if (!dirEnsured) {
      await invoke("ensure_dir_exists", { path: dir });
      dirEnsured = true;
    }
    const text = JSON.stringify({ version: 1, casts }, null, 2);
    await invoke("write_text_to_path", { path: `${dir}/${FILE}`, text, atomic: true });
    if (lastError) { lastError = null; notify(); }
  } catch (err) {
    // Re-arm rather than dropping the edit: a transient write failure (a
    // synced folder mid-lock, a full disk that clears) must not mean the
    // user's cast only ever existed in memory.
    pendingWrite = true;
    lastError = String(err);
    notify();
    console.warn("cast-store: save failed:", err);
  }
}

/** Force any pending write out now — called before the window closes, so the
 *  last 400ms of edits are not lost to the debounce. */
export async function flushCasts(): Promise<void> {
  if (pendingWrite) await flush();
}

let hydrating = false;

export async function hydrateCastStore(): Promise<void> {
  if (hydrated || hydrating) return;
  hydrating = true;
  try {
    let resolved: string | null = null;
    try {
      const lib = await invoke<string>("default_transcript_library_path");
      // Beside Transcripts and Reviews at the app's Documents root. Derived
      // from the DEFAULT path command, not the configurable library setting:
      // moving the transcript library should not strand a season of casts.
      const root = typeof lib === "string" && lib.trim()
        ? lib.replace(/\/+$/, "").split("/").slice(0, -1).join("/")
        : "";
      if (root) resolved = `${root}/Casts`;
    } catch (err) {
      console.warn("cast-store: could not resolve Casts dir:", err);
    }
    if (!resolved) return; // mocked or unavailable → memory-only session
    dir = resolved;

    try {
      const text = await invoke<string>("read_text_file_capped", { path: `${dir}/${FILE}`, maxBytes: READ_CAP });
      const loaded = sanitizeCastFile(JSON.parse(text));
      if (loaded.length > 0) {
        // Anything created while the read was in flight wins over the disk
        // copy: it is the newer edit, and the user is looking at it.
        const live = new Set(casts.map((c) => c.id));
        casts = [...casts, ...loaded.filter((c) => !live.has(c.id))].slice(0, MAX_CASTS);
        notify();
      }
    } catch {
      /* no file yet, or unreadable — a fresh shelf */
    }
  } finally {
    // Set at the very END, and unconditionally.
    //
    // It gates `flush`, and what it has to mean is "the disk copy is now
    // accounted for". Setting it as soon as the DIRECTORY resolved would open
    // the write path while the read was still in flight, so a save made in
    // that window could persist a list that did not yet include the user's
    // existing casts — erasing the file with a subset of itself. Unconditional
    // because a session that never resolved a directory is memory-only and
    // must still hold what the user builds in it.
    hydrated = true;
    hydrating = false;
    // A save made during hydration bailed out of its write; run it now.
    if (pendingWrite) void flush();
  }
}

/** Test seam: drop all state so a suite can hydrate again from a fresh mock. */
export function __resetCastStore(): void {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  casts = [];
  dir = null;
  dirEnsured = false;
  hydrated = false;
  hydrating = false;
  pendingWrite = false;
  lastError = null;
  listeners.clear();
}
