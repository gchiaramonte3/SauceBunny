/**
 * Recent sources — the last few things the user successfully LOADED
 * (web URLs after their metadata resolved, local files after a
 * successful import probe). Powers the URL-bar history popover and the
 * Monitor empty-state "Resume last session" affordance.
 *
 * Only successful loads are recorded — the App.tsx call sites record
 * after `fetch_metadata` / `probe_local_file` succeed, so a typo'd URL
 * or a vanished file never pollutes the list.
 *
 * Pure logic (`upsertRecent`, `removeRecent`, `sanitizeRecentSources`)
 * is separated from the localStorage wrappers so it unit-tests without
 * a DOM (mirrors tab-state.ts).
 */

import { loadJson, saveJson } from "./storage";

export type RecentSource = {
  kind: "url" | "file";
  /** Full URL (web) or absolute file path (local). The de-dup key. */
  value: string;
  /** Display label — video/page title, or the local filename. */
  title: string;
  /** Source duration when known (yt-dlp / ffprobe metadata). */
  durationSeconds?: number;
  /** Unix ms of the most recent successful load. */
  lastOpenedAt: number;
};

export const MAX_RECENT_SOURCES = 12;
const STORAGE_KEY = "saucebunny.recentSources";

/**
 * Insert or refresh an entry, most-recent-first. De-dups by `value`;
 * a re-open keeps the prior title/duration when the fresh load doesn't
 * supply them (e.g. metadata hydration raced). Caps the list at
 * MAX_RECENT_SOURCES, evicting from the tail (oldest).
 */
export function upsertRecent(
  list: readonly RecentSource[],
  entry: Omit<RecentSource, "lastOpenedAt"> & { lastOpenedAt?: number },
): RecentSource[] {
  const prior = list.find((e) => e.value === entry.value);
  const next: RecentSource = {
    kind: entry.kind,
    value: entry.value,
    title: entry.title || prior?.title || entry.value,
    durationSeconds: entry.durationSeconds ?? prior?.durationSeconds,
    lastOpenedAt: entry.lastOpenedAt ?? Date.now(),
  };
  return [next, ...list.filter((e) => e.value !== entry.value)]
    .slice(0, MAX_RECENT_SOURCES);
}

/** Drop the entry with this value (per-row × in the popover, stale files). */
export function removeRecent(
  list: readonly RecentSource[],
  value: string,
): RecentSource[] {
  return list.filter((e) => e.value !== value);
}

/**
 * Validate a persisted blob into a well-formed list: drop malformed
 * entries and duplicate values (first wins), sort newest-first, cap.
 * Junk input (non-array, corrupt JSON shapes) yields [] rather than
 * crashing the popover render.
 */
export function sanitizeRecentSources(raw: unknown): RecentSource[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: RecentSource[] = [];
  for (const x of raw) {
    if (!x || typeof x !== "object") continue;
    const e = x as Record<string, unknown>;
    if (e.kind !== "url" && e.kind !== "file") continue;
    if (typeof e.value !== "string" || e.value === "") continue;
    if (typeof e.title !== "string") continue;
    if (typeof e.lastOpenedAt !== "number") continue;
    if (e.durationSeconds !== undefined && typeof e.durationSeconds !== "number") continue;
    if (seen.has(e.value)) continue;
    seen.add(e.value);
    out.push({
      kind: e.kind,
      value: e.value,
      title: e.title,
      durationSeconds: e.durationSeconds as number | undefined,
      lastOpenedAt: e.lastOpenedAt,
    });
  }
  out.sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  return out.slice(0, MAX_RECENT_SOURCES);
}

// ── localStorage wrappers (best-effort, via lib/storage like chapters.ts) ──

export function loadRecentSources(): RecentSource[] {
  // sanitize on load: the persisted blob is untrusted (old shapes, hand
  // edits) and must never crash the popover render.
  return sanitizeRecentSources(loadJson<unknown>(STORAGE_KEY, []));
}

export function saveRecentSources(list: readonly RecentSource[]): void {
  saveJson(STORAGE_KEY, list);
}
