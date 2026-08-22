/**
 * Projects: the shelf a set of transcripts belongs to.
 *
 * The Transcripts panel groups by the folder a file sits in, and until now that
 * folder was almost always `YYYY-MM` — a bucket the app created for you on the
 * day you hit transcribe. That is filing by accident. Somebody cutting a series
 * wants "Marry Harry", not "August 2026", and wants to recognise it by its
 * poster the way every other shelf in this app works.
 *
 * A project IS a directory under the transcript library. That is deliberate:
 * moving a transcript into one is `mv`, the files stay browsable in Finder, and
 * nothing is lost if this JSON is deleted — you get the folder names back and
 * only the posters and colours go. The metadata is decoration over the
 * filesystem, never the source of truth for what exists.
 *
 * ONE FILE, like casts. A shelf of projects is a few KB and the panel needs all
 * of them at once, so sharding would buy nothing and cost a read per group.
 */

/** A month bucket the app made, not a project someone named. */
const MONTH_FOLDER = /^\d{4}-\d{2}$/;

export type TranscriptProject = {
  /** Directory name under the library root. The identity — never renamed in
   *  place without moving the directory too. */
  folder: string;
  /** What to show. Defaults to the folder name; a rename can diverge from it
   *  only when the directory rename failed, which the UI surfaces. */
  title: string;
  /**
   * Poster source, in preference order:
   *   `posterPath`  — an image the user picked
   *   `posterFrom`  — a transcript in this project; its video's frame is used
   *   neither       — the panel falls back to the newest transcript's thumb
   */
  posterPath: string | null;
  posterFrom: string | null;
  /** Accent for the group header. Null = the neutral default. */
  color: string | null;
  createdMs: number;
};

export function makeProject(folder: string, now: number): TranscriptProject {
  return { folder, title: folder, posterPath: null, posterFrom: null, color: null, createdMs: now };
}

/**
 * True when a folder is a project rather than a month bucket.
 *
 * The month folders are the app's own filing and should not appear as projects
 * to rename, colour or delete — deleting "2026-08" would take a month of work
 * with it, and it is not a thing anybody made.
 */
export function isProjectFolder(folder: string): boolean {
  return folder !== "" && !MONTH_FOLDER.test(folder);
}

/**
 * Parse whatever was on disk into a clean list.
 *
 * Tolerant on purpose: this file is hand-editable and sits in the user's
 * Documents. A malformed entry is dropped rather than taking the shelf with it,
 * and unknown fields survive nothing — they are simply not read, so an older
 * build writing this file back cannot be blamed for losing them.
 */
export function parseProjects(raw: unknown): TranscriptProject[] {
  if (!Array.isArray(raw)) return [];
  const out: TranscriptProject[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (typeof r !== "object" || r === null) continue;
    const o = r as Partial<TranscriptProject>;
    const folder = typeof o.folder === "string" ? o.folder.trim() : "";
    if (!folder || seen.has(folder) || !isProjectFolder(folder)) continue;
    seen.add(folder);
    out.push({
      folder,
      title: typeof o.title === "string" && o.title.trim() ? o.title.trim() : folder,
      posterPath: typeof o.posterPath === "string" && o.posterPath ? o.posterPath : null,
      posterFrom: typeof o.posterFrom === "string" && o.posterFrom ? o.posterFrom : null,
      color: typeof o.color === "string" && o.color ? o.color : null,
      createdMs: typeof o.createdMs === "number" && o.createdMs > 0 ? o.createdMs : 0,
    });
  }
  return out;
}

/**
 * Reconcile stored metadata against the folders that actually exist.
 *
 * The filesystem wins. A folder deleted in Finder must not linger as a ghost
 * project, and a folder created in Finder should appear without ceremony —
 * otherwise the panel and the disk tell two different stories, which is exactly
 * the drift the queued-marks bug was.
 */
export function reconcileProjects(
  stored: TranscriptProject[],
  foldersOnDisk: readonly string[],
  now: number,
): TranscriptProject[] {
  const real = foldersOnDisk.filter(isProjectFolder);
  const byFolder = new Map(stored.map((p) => [p.folder, p]));
  return real.map((f) => byFolder.get(f) ?? makeProject(f, now));
}

/** The project for a folder, or null when it is a month bucket or unknown. */
export function projectFor(projects: readonly TranscriptProject[], folder: string): TranscriptProject | null {
  return projects.find((p) => p.folder === folder) ?? null;
}

/**
 * Which transcript's frame should stand in for a project with no chosen poster.
 *
 * The newest, because a shelf reads best as "what am I working on" and the most
 * recent transcript is the answer more often than the first one filed.
 */
export function fallbackPosterSource(
  items: readonly { path: string; modifiedMs: number }[],
): string | null {
  if (items.length === 0) return null;
  return [...items].sort((a, b) => b.modifiedMs - a.modifiedMs)[0].path;
}

/** Apply an edit, keeping the list stable and the identity untouched. */
export function updateProject(
  projects: readonly TranscriptProject[],
  folder: string,
  patch: Partial<Omit<TranscriptProject, "folder">>,
): TranscriptProject[] {
  return projects.map((p) => (p.folder === folder ? { ...p, ...patch } : p));
}
