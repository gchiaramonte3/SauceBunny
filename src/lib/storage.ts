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
  // A row that was MID-EXPORT when the app went away comes back as pending.
  //
  // Only "queued" used to survive, enforced twice over (here, and again by
  // isQueuedClip on the way back in), so quitting during an export dropped the
  // row being exported — the one the user was most actively working on, and by
  // this file's own reckoning the one thing in the workspace that "cannot be
  // recreated by pressing a button again". Everything else in the queue
  // survived; the in-flight range did not.
  //
  // Restored as "queued", not "running": nothing starts the queue on boot, so
  // it comes back as a row waiting for the user to press Run, which is also
  // the honest description of its state. Re-exporting overwrites a partial
  // output, which is what anyone would want from it.
  //
  // The cost of being wrong here is one row to delete, against the cost of
  // being wrong the other way, which is a range to mark out again by hand.
  const pending = queue
    .filter((c) => c.status === "queued" || c.status === "running")
    .map((c) => (c.status === "running" ? { ...c, status: "queued" } : c));
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
