import { pathKey } from "./repath";
import { loadChosenPosters, loadSourceTimecodes, saveChosenPosters, saveSourceTimecodes } from "./library";
import { hiddenSnapshot, hidePaths, unhidePaths } from "./library-hidden";
import { libraryOrganization } from "./library-organization-store";
import { loadSourceMarks, saveSourceMarks } from "./source-marks";
import { moveHistoryPaths } from "./transcript-history";
import { moveReviewPaths } from "./review";
import type { RecentSource } from "./recent-sources";
import type { QueuedClip } from "../types";

/**
 * Moving the app's records when a folder moves (docs/RECONNECT-MEDIA-SPEC-2026-10-05.md).
 *
 * A library root that is reconnected to a new place is a prefix change:
 * every path under `/old/root` now lives under `/new/root`. About twenty
 * records key a file by its absolute path, and every one of them detaches
 * silently when the folder moves, so this is the one place that knows them
 * all. Records held in a module or on disk are moved here; records held in a
 * component's state are told through PATHS_MOVED_EVENT (use-paths-moved), since
 * writing their storage from outside would be overwritten by their next save.
 *
 * Review notes need nothing: a review is found by a fingerprint that does not
 * contain the folder, and a review document's key never changes.
 */

/** `path` re-rooted from `from` to `to`, or null when it is neither `from` nor under it. */
export function movedPath(path: string, from: string, to: string): string | null {
  const source = pathKey(from).replace(/\/+$/, ""), target = pathKey(to).replace(/\/+$/, "");
  if (!source.startsWith("/") || !target.startsWith("/") || source === target) return null;
  const key = pathKey(path).replace(/(.)\/+$/, "$1");
  if (key === source) return target;
  // The separator is the boundary: moving /Show/Test must not move /Show/Testing.
  return key.startsWith(`${source}/`) ? target + key.slice(source.length) : null;
}

/** A record's keys moved, or the SAME object when none moved (so a caller can skip a write). */
export function moveKeys<T>(map: Record<string, T>, from: string, to: string): Record<string, T> {
  let next: Record<string, T> | null = null;
  for (const [key, value] of Object.entries(map)) {
    const moved = movedPath(key, from, to);
    if (moved === null) continue;
    next ??= { ...map };
    delete next[key];
    next[moved] = value;
  }
  return next ?? map;
}

/** A list of paths moved, or the SAME array when none moved. */
export function moveList(list: readonly string[], from: string, to: string): readonly string[] {
  const next = list.map((path) => movedPath(path, from, to) ?? path);
  return next.some((path, index) => path !== list[index]) ? next : list;
}

export function moveRecents(list: RecentSource[], from: string, to: string): RecentSource[] {
  const next = list.map((entry) => {
    const moved = entry.kind === "file" ? movedPath(entry.value, from, to) : null;
    return moved ? { ...entry, value: moved } : entry;
  });
  return next.some((entry, index) => entry !== list[index]) ? next : list;
}

export function moveQueue(list: QueuedClip[], from: string, to: string): QueuedClip[] {
  const next = list.map((clip) => {
    const moved = clip.source.kind === "file" ? movedPath(clip.source.path, from, to) : null;
    return moved ? { ...clip, source: { kind: "file" as const, path: moved } } : clip;
  });
  return next.some((clip, index) => clip !== list[index]) ? next : list;
}

/** Records named after a path, one storage key each: `saucebunny.chapters.<path>`. */
const KEYED_BY_PATH = ["saucebunny.chapters.", "saucebunny.cutMarkers."];

function moveKeyFamilies(from: string, to: string): void {
  try {
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index))
      .filter((key): key is string => !!key && KEYED_BY_PATH.some((prefix) => key.startsWith(prefix)));
    for (const key of keys) {
      const prefix = KEYED_BY_PATH.find((candidate) => key.startsWith(candidate))!;
      const moved = movedPath(key.slice(prefix.length), from, to);
      const value = localStorage.getItem(key);
      if (moved === null || value === null) continue;
      localStorage.setItem(prefix + moved, value);
      localStorage.removeItem(key);
    }
  } catch { /* storage unavailable: those records stay where they were */ }
}

export type PathsMoved = { from: string; to: string };
/** Window event for records held in component state: recents, the clip queue, custom columns, tree expansion. */
export const PATHS_MOVED_EVENT = "saucebunny:paths-moved";

/**
 * Move every record under `from` to `to`. Call after the person has chosen
 * where the folder is now; the folder itself is not touched.
 */
export function moveStoredPaths(from: string, to: string): void {
  if (movedPath(from, from, to) === null) return;
  const posters = loadChosenPosters(), movedPosters = moveKeys(posters, from, to);
  if (movedPosters !== posters) saveChosenPosters(movedPosters);
  const timecodes = loadSourceTimecodes(), movedTimecodes = moveKeys(timecodes, from, to);
  if (movedTimecodes !== timecodes) saveSourceTimecodes(movedTimecodes);
  const marks = loadSourceMarks(), movedMarks = moveKeys(marks, from, to);
  if (movedMarks !== marks) saveSourceMarks(movedMarks);
  const hidden = [...hiddenSnapshot()].map((path) => [path, movedPath(path, from, to)] as const)
    .filter((pair): pair is readonly [string, string] => pair[1] !== null);
  if (hidden.length) { unhidePaths(hidden.map(([path]) => path)); hidePaths(hidden.map(([, moved]) => moved)); }
  moveKeyFamilies(from, to);
  moveHistoryPaths((path) => movedPath(path, from, to));
  moveReviewPaths((path) => movedPath(path, from, to));
  void libraryOrganization.movePaths((path) => movedPath(path, from, to));
  window.dispatchEvent(new CustomEvent<PathsMoved>(PATHS_MOVED_EVENT, { detail: { from, to } }));
}
