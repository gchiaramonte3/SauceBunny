/**
 * Drawer-tab state — the single source of truth shared by the docked drawer
 * and the floating panel window (r44.B).
 *
 * Both windows are the same origin, so they share localStorage — and exactly
 * one drawer instance is mounted at a time (the docked drawer unmounts while
 * the panel is floated). That makes persistence the whole sync story: the tab
 * you're on and your tab order survive every pop-out / re-dock / relaunch
 * handoff, with no event bus or store needed. Each drawer mount simply
 * restores the last persisted state; every change writes straight through.
 *
 * Pure logic (`normalizeActiveTab`, `mergeTabOrder`) is separated from the
 * localStorage wrappers so it unit-tests without a DOM.
 */

export const TAB_IDS = ["queue", "transcript", "ai", "review"] as const;
export type TabId = (typeof TAB_IDS)[number];

const ACTIVE_TAB_KEY = "saucebunny.queueDrawerActiveTab";
const TAB_ORDER_KEY = "saucebunny.queueDrawerTabOrder";

export function isTabId(x: unknown): x is TabId {
  return typeof x === "string" && (TAB_IDS as readonly string[]).includes(x);
}

/** Validate a persisted active-tab value; anything unknown falls back to
 *  "queue" (also covers tabs removed in a newer build, e.g. the old Clips). */
export function normalizeActiveTab(raw: unknown): TabId {
  return isTabId(raw) ? raw : "queue";
}

/**
 * Reconcile a persisted tab order with the current tab set: keep the stored
 * order for ids that still exist (deduped), then append any brand-new ids so
 * a code-level tab addition can never be hidden by a stale localStorage entry.
 * Junk input (non-array, wrong types) yields the defaults unchanged.
 */
export function mergeTabOrder(stored: unknown, defaults: readonly TabId[]): TabId[] {
  if (!Array.isArray(stored)) return [...defaults];
  const merged: TabId[] = [];
  for (const id of stored) {
    if (isTabId(id) && defaults.includes(id) && !merged.includes(id)) merged.push(id);
  }
  for (const id of defaults) {
    if (!merged.includes(id)) merged.push(id);
  }
  return merged;
}

// ── localStorage wrappers (best-effort; storage can be unavailable) ─────────

export function loadActiveTab(): TabId {
  try {
    return normalizeActiveTab(localStorage.getItem(ACTIVE_TAB_KEY));
  } catch {
    return "queue";
  }
}

export function saveActiveTab(tab: TabId): void {
  try { localStorage.setItem(ACTIVE_TAB_KEY, tab); } catch { /* quota */ }
}

export function loadTabOrder(defaults: readonly TabId[]): TabId[] {
  try {
    const raw = localStorage.getItem(TAB_ORDER_KEY);
    return mergeTabOrder(raw ? JSON.parse(raw) : null, defaults);
  } catch {
    return [...defaults];
  }
}

export function saveTabOrder(order: readonly TabId[]): void {
  try { localStorage.setItem(TAB_ORDER_KEY, JSON.stringify(order)); } catch { /* quota */ }
}
