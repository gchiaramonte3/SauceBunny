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
import { emit, listen } from "@tauri-apps/api/event";
import { sanitizeCastFile, MAX_CASTS, type Cast } from "./cast";
import { mergeCasts } from "./cast-merge";

const FILE = "casts.json";
const READ_CAP = 8 * 1024 * 1024;
const WRITE_DEBOUNCE_MS = 400;
/** How long the pre-write merge read may take before we give up on it
 *  and write what we have. A local file read is milliseconds; this only
 *  exists so a stalled read cannot strand a user's edit. */
const MERGE_READ_TIMEOUT_MS = 2000;

let casts: Cast[] = [];
let dir: string | null = null;
let dirEnsured = false;
let hydrated = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** A write is owed. Survives a flush that had to bail for hydration. */
let pendingWrite = false;
/**
 * What THIS window has changed since it last wrote, so a merge can tell "I
 * never had this" from "I deleted this".
 *
 * Both windows edit casts — the speaker roster lives in TranscriptViewer,
 * which the main window and the popped-out panel both render — and each held
 * its own in-memory list and wrote the WHOLE file. Whichever saved last
 * erased everything the other had added since. Silently: no error, no
 * conflict, no way back, and a cast is thirty names, colours and faces built
 * over a season.
 */
let touched = new Map<string, number>();
let tombstones = new Map<string, number>();
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

/**
 * Fired after a successful write so the OTHER window re-reads.
 *
 * Two buses under one name, the same shape `saucebunny:speakers-changed`
 * uses: a Tauri event crosses webviews (that is the one that matters here),
 * and a window CustomEvent covers the same-window case where a second
 * subscriber wants to know without waiting for a round trip.
 *
 * The merge in `flush` is what makes concurrent edits converge; this is what
 * makes the other window SHOW them without the user reopening the shelf.
 */
export const CASTS_CHANGED_EVENT = "saucebunny:casts-changed";

/** Our own id, so the echo of our own write is ignored. */
const WRITER_ID = Math.random().toString(36).slice(2);

function announceChange(): void {
  void emit(CASTS_CHANGED_EVENT, { from: WRITER_ID }).catch(() => { /* no Tauri in tests */ });
  try {
    window.dispatchEvent(new CustomEvent(CASTS_CHANGED_EVENT, { detail: { from: WRITER_ID } }));
  } catch { /* non-DOM context */ }
}

/**
 * Re-read the file because the other window wrote it.
 *
 * Deliberately NOT a merge: the disk copy has already been merged by whoever
 * wrote it, and anything of ours it does not contain is still sitting in
 * `touched`/`tombstones` waiting for our own next flush to fold in.
 */
export async function refreshCastsFromDisk(): Promise<void> {
  if (!hydrated || !dir) return;
  try {
    const text = await invoke<string>("read_text_file_capped", {
      path: `${dir}/${FILE}`, maxBytes: READ_CAP,
    });
    const loaded = sanitizeCastFile(JSON.parse(text));
    const same = loaded.length === casts.length
      && loaded.every((c, i) => c.id === casts[i]?.id && c.updatedAt === casts[i]?.updatedAt);
    if (same) return;
    casts = mergeCasts(loaded, casts, touched, tombstones).slice(0, MAX_CASTS);
    notify();
  } catch {
    /* unreadable — keep what we have */
  }
}

/** Attach the cross-window listeners. Returns a detach function. */
export function listenForCastChanges(): () => void {
  const onLocal = (e: Event) => {
    const from = (e as CustomEvent<{ from?: string }>).detail?.from;
    if (from === WRITER_ID) return;
    void refreshCastsFromDisk();
  };
  try { window.addEventListener(CASTS_CHANGED_EVENT, onLocal); } catch { /* non-DOM */ }
  let un: (() => void) | null = null;
  void listen<{ from?: string }>(CASTS_CHANGED_EVENT, (e) => {
    if (e.payload?.from === WRITER_ID) return;
    void refreshCastsFromDisk();
  }).then((f) => { un = f; }).catch(() => { /* no Tauri in tests */ });
  return () => {
    try { window.removeEventListener(CASTS_CHANGED_EVENT, onLocal); } catch { /* non-DOM */ }
    un?.();
  };
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
  touched.set(stamped.id, stamped.updatedAt);
  tombstones.delete(stamped.id);
  const at = casts.findIndex((c) => c.id === cast.id);
  commit(at >= 0
    ? casts.map((c, i) => (i === at ? stamped : c))
    : [stamped, ...casts]);
}

export function deleteCast(id: string): void {
  if (!casts.some((c) => c.id === id)) return;
  tombstones.set(id, Date.now());
  touched.delete(id);
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
    // Re-read and MERGE before overwriting. The window between our last read
    // and this write is exactly where the other window's additions live, and
    // writing `casts` straight out is what erased them.
    //
    // Bounded, and with a preserving fallback. Two ways this could make things
    // WORSE if written naively, both found by an existing test:
    //   · a read that never settles would strand the write forever, and
    //     `pendingWrite` has already been cleared by this point;
    //   · merging against an EMPTY disk list keeps only the casts this window
    //     touched, dropping the rest of our own hydrated list.
    // So a failed or slow read falls back to writing what we have, which is
    // exactly the old behaviour: no worse than before, and correct whenever
    // the read works, which is approximately always.
    let merged: Cast[];
    try {
      const cur = await Promise.race([
        invoke<string>("read_text_file_capped", { path: `${dir}/${FILE}`, maxBytes: READ_CAP }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("merge read timed out")), MERGE_READ_TIMEOUT_MS)),
      ]);
      merged = mergeCasts(sanitizeCastFile(JSON.parse(cur)), casts, touched, tombstones).slice(0, MAX_CASTS);
    } catch {
      // No file yet, unreadable, or too slow — preserve rather than merge.
      merged = casts;
    }
    const text = JSON.stringify({ version: 1, casts: merged }, null, 2);
    await invoke("write_text_to_path", { path: `${dir}/${FILE}`, text, atomic: true });
    // Only after the write lands: until then those edits are still owed, and
    // clearing them early would drop them from the NEXT merge if this write
    // failed and re-armed.
    touched = new Map();
    tombstones = new Map();
    if (merged.length !== casts.length || merged.some((c, i) => c.id !== casts[i]?.id)) {
      casts = merged;
      notify();
    }
    announceChange();
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
  touched = new Map();
  tombstones = new Map();
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
