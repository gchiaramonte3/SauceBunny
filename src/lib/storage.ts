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
