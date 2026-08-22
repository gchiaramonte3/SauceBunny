import type { LibraryTranscript } from "./transcript-library";
import { monthLabel } from "./transcript-library";

/**
 * Search, sort and grouping for the Transcripts panel.
 *
 * The panel was a flat list grouped by folder, newest first, with no way to
 * narrow it. That is fine at a dozen transcripts and useless at a hundred:
 * finding one meant scrolling past every month you have ever worked in. The
 * Library solved the same problem with a debounced search, a sort control and
 * an honest count, so this is that, over transcripts.
 *
 * Pure and here rather than in the component for the reason the rest of this
 * codebase gives: ordering and filtering are decisions worth pinning, and a
 * component that owns them cannot be tested without rendering a panel.
 */

export type TranscriptSort = "recent" | "oldest" | "name" | "size";

export type TranscriptFilter = {
  /** Free text over the title and the folder name. */
  query: string;
  sort: TranscriptSort;
  /** Only transcripts carrying a diarization sidecar. */
  speakersOnly: boolean;
  /** Only transcripts carrying a saved AI analysis. */
  analyzedOnly: boolean;
};

export const DEFAULT_TRANSCRIPT_FILTER: TranscriptFilter = {
  query: "",
  sort: "recent",
  speakersOnly: false,
  analyzedOnly: false,
};

/**
 * A folder's display name.
 *
 * `monthLabel` turns "2026-07" into "July 2026" and EVERYTHING else into
 * "Other" — which quietly erased the name of any folder the user made with
 * "Move to folder…". A folder someone deliberately named "Marry Harry" showing
 * up as "Other" is worse than no grouping at all, because it looks like the app
 * lost it. Month folders keep their friendly label; a named folder keeps its
 * name; the root says what it is.
 */
export function folderLabel(folder: string): string {
  if (folder === "") return "Loose transcripts";
  const asMonth = monthLabel(folder);
  return asMonth === "Other" ? folder : asMonth;
}

/** Case- and punctuation-insensitive haystack for one transcript. */
function haystack(t: LibraryTranscript): string {
  return `${t.title} ${t.folder}`.toLowerCase();
}

function compare(a: LibraryTranscript, b: LibraryTranscript, sort: TranscriptSort): number {
  switch (sort) {
    case "oldest": return a.modifiedMs - b.modifiedMs;
    case "size":   return b.sizeBytes - a.sizeBytes;
    // localeCompare with numeric so "Episode 2" sorts before "Episode 10",
    // which is the whole reason a name sort is worth having on episodic work.
    case "name":   return a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" });
    default:       return b.modifiedMs - a.modifiedMs;
  }
}

export type TranscriptGroup = { folder: string; label: string; items: LibraryTranscript[] };

/**
 * The panel's list, filtered, sorted and grouped.
 *
 * Grouping is SUPPRESSED while searching. A query is a request to see matches,
 * and splitting three of them across three month headings buries the answer in
 * chrome — Finder does the same thing when you type in the search box.
 */
export function organizeTranscripts(
  list: LibraryTranscript[],
  f: TranscriptFilter,
): { groups: TranscriptGroup[]; shown: number; total: number; searching: boolean } {
  const q = f.query.trim().toLowerCase();
  const filtered = list.filter((t) => {
    if (f.speakersOnly && !t.hasDiarization) return false;
    if (f.analyzedOnly && !t.hasAnalysis) return false;
    if (q && !haystack(t).includes(q)) return false;
    return true;
  });
  const sorted = [...filtered].sort((a, b) => compare(a, b, f.sort));

  if (q) {
    return {
      groups: sorted.length ? [{ folder: "__results__", label: `${sorted.length} match${sorted.length === 1 ? "" : "es"}`, items: sorted }] : [],
      shown: sorted.length,
      total: list.length,
      searching: true,
    };
  }

  const byFolder = new Map<string, LibraryTranscript[]>();
  for (const t of sorted) {
    const arr = byFolder.get(t.folder);
    if (arr) arr.push(t);
    else byFolder.set(t.folder, [t]);
  }
  const groups = [...byFolder.entries()].map(([folder, items]) => ({
    folder, label: folderLabel(folder), items,
  }));
  // Group order follows the chosen sort via each group's leading item, so
  // "By name" does not leave the headings in date order and look broken.
  groups.sort((a, b) => compare(a.items[0], b.items[0], f.sort));
  return { groups, shown: sorted.length, total: list.length, searching: false };
}

/**
 * Add the projects that exist on disk but hold nothing yet.
 *
 * A project is created empty and filled afterwards, so without this the Create
 * button appears to do nothing: the folder is made, the scan finds no
 * transcripts in it, and the grouping - which is built FROM transcripts - has
 * nothing to hang a heading on. An empty shelf you can drop things onto is the
 * whole point of making one.
 *
 * They go at the top, because an empty project is one you just made and are
 * about to fill. Suppressed while searching, for the same reason grouping is:
 * a query asks for matches, and an empty project can never be one.
 */
export function withEmptyProjects(
  groups: TranscriptGroup[],
  projectFolders: readonly string[],
  searching: boolean,
): TranscriptGroup[] {
  if (searching) return groups;
  const present = new Set(groups.map((g) => g.folder));
  const empties = projectFolders
    .filter((f) => !present.has(f))
    .map((folder) => ({ folder, label: folderLabel(folder), items: [] as LibraryTranscript[] }));
  return empties.length ? [...empties, ...groups] : groups;
}
