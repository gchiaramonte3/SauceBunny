/**
 * Tiny typed wrappers around `localStorage` JSON persistence.
 *
 * Both swallow errors (corrupt blob, private-mode quota) and `console.warn`
 * instead of throwing, so a bad persisted value can never crash boot — it just
 * falls back to the default. Used for the app's namespaced prefs.
 */

export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as T;
  } catch (err) {
    // Don't crash on a corrupt persisted blob — but do log it so we can
    // diagnose "my settings keep resetting" reports.
    console.warn(`loadJson(${key}) failed:`, err);
  }
  return fallback;
}

export function saveJson(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch (err) {
    console.warn(`saveJson(${key}) failed:`, err);
  }
}

// ── Clip queue (localStorage `saucebunny.clipQueue`) ────────────────────
//
// The queue was plain component state: closing the app, or one misclick on a
// Clear button with no confirmation and no undo, and an afternoon of marked
// ranges was gone. Every other destructive action in the app already confirms
// (recents, cached files, library roots), and every other piece of workspace
// state already persists — the queue was simply the one nobody had got to.
//
// Each item carries its own `source` and `fps` by design, precisely so it does
// not depend on what happens to be loaded, which is what makes rehydrating it
// safe.

const QUEUE_KEY = "saucebunny.clipQueue";

/**
 * Items whose work already finished are dropped on the way out.
 *
 * A "done" row points at a file on disk and a "failed" row points at an error
 * from a session that is over; neither is something to resume, and restoring
 * them would greet the user with yesterday's results in a panel that is
 * supposed to be a to-do list. Only work still to do survives.
 */
export function saveClipQueue<T extends { status: string }>(queue: readonly T[]): void {
  const pending = queue.filter((c) => c.status === "queued");
  if (pending.length === 0) {
    try { localStorage.removeItem(QUEUE_KEY); } catch { /* quota/private mode */ }
    return;
  }
  saveJson(QUEUE_KEY, pending);
}

/** The queue from the last session, or [] when there is nothing to resume. */
export function loadClipQueue<T>(isValid: (x: unknown) => x is T): T[] {
  const raw = loadJson<unknown>(QUEUE_KEY, []);
  if (!Array.isArray(raw)) return [];
  // Validated item by item rather than trusted: this is JSON a previous
  // build wrote, and one malformed row must not cost the user the rest.
  return raw.filter(isValid);
}
