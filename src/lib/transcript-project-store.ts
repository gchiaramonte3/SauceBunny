import { invoke } from "@tauri-apps/api/core";
import {
  parseProjects, reconcileProjects, updateProject,
  type TranscriptProject,
} from "./transcript-projects";
import { futureVersionIn, reportFutureVersion } from "./store-schema";

/**
 * Where a project's metadata lives, and the one rule that matters.
 *
 * `projects.json` sits beside the transcripts it describes, holding titles,
 * posters and colours. The DIRECTORIES are the truth about what exists; this
 * file only decorates them, so deleting it costs posters and nothing else.
 *
 * Modelled on cast-store, including the guard that store exists to document:
 * a write is REFUSED until hydration has read the disk copy. An empty list at
 * boot means "not loaded yet", not "no projects", and writing it would erase
 * the file with a subset of itself — the one failure in a store like this that
 * cannot be recovered from.
 *
 * Uses only the existing invoke surface, exactly as cast-store does, so this
 * needed no new Rust command.
 */

const FILE = "projects.json";
const READ_CAP = 2 * 1024 * 1024;
const WRITE_DEBOUNCE_MS = 400;

let projects: TranscriptProject[] = [];
let dir: string | null = null;
let dirEnsured = false;
let hydrated = false;
let hydrating = false;
let pendingWrite = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
/** Set if projects.json is newer than this build. Closes every write path;
 *  see store-schema.ts. Losing this file costs posters and titles, but it
 *  costs them just as permanently as anything else in Documents. */
let futureVersion: number | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const l of listeners) l();
}

export function subscribeProjects(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getProjects(): TranscriptProject[] {
  return projects;
}

function save(): void {
  pendingWrite = true;
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => { void flush(); }, WRITE_DEBOUNCE_MS);
}

async function flush(): Promise<void> {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  // See the header. `pendingWrite` deliberately STAYS set so hydration knows a
  // write is owed once the disk copy has been accounted for.
  if (!hydrated || !dir) return;
  // Newer file on disk: read it, never overwrite it.
  if (futureVersion !== null) { pendingWrite = false; return; }
  pendingWrite = false;
  try {
    if (!dirEnsured) {
      await invoke("ensure_dir_exists", { path: dir });
      dirEnsured = true;
    }
    const text = JSON.stringify({ version: 1, projects }, null, 2);
    await invoke("write_text_to_path", { path: `${dir}/${FILE}`, text, atomic: true });
  } catch {
    // Re-arm rather than dropping the edit; a transient write failure should
    // not cost a rename the user already saw take effect.
    pendingWrite = true;
  }
}

/**
 * Read the file and reconcile it against the folders that actually exist.
 *
 * `foldersOnDisk` comes from the caller because the panel has already scanned
 * the library for its grouping — asking Rust again would be a second walk of
 * the same directory for the same answer.
 */
/**
 * @param libraryPath The transcript library actually in use.
 *
 * This used to ask Rust for `default_transcript_library_path`, which returns
 * `~/Documents/Sauce Bunny/Transcripts` unconditionally - it is the DEFAULT,
 * and the frontend holds the user's override (Settings picks a directory and
 * stores it in `defaults.transcriptLibrary`). So anyone who pointed their
 * library at an external drive got their project folders in one place and
 * `projects.json` written to another, where it described folders that were
 * not there: every project reconciled away, every poster and colour lost, and
 * a metadata file left behind in a directory the app no longer reads.
 */
export async function hydrateProjects(
  libraryPath: string,
  foldersOnDisk: readonly string[],
): Promise<void> {
  if (hydrated || hydrating) return;
  hydrating = true;
  try {
    dir = libraryPath.replace(/\/+$/, "");
    let stored: TranscriptProject[] = [];
    try {
      const text = await invoke<string>("read_text_file_capped", {
        path: `${dir}/${FILE}`, maxBytes: READ_CAP,
      });
      const fv = futureVersionIn(text);
      if (fv !== null) { futureVersion = fv; reportFutureVersion("projects", fv); }
      const doc: unknown = JSON.parse(text);
      stored = parseProjects((doc as { projects?: unknown })?.projects);
    } catch {
      // No file yet, or unreadable. Either way the folders on disk are enough
      // to rebuild a usable shelf, which is the point of keeping the JSON
      // subordinate to the directories.
    }
    projects = reconcileProjects(stored, foldersOnDisk, Date.now());
  } finally {
    hydrated = true;
    hydrating = false;
    notify();
    // A save that bailed out during hydration is owed; run it now.
    if (pendingWrite) void flush();
  }
}

/** Re-run reconciliation after a scan, so a folder made in Finder appears. */
export function syncProjectFolders(foldersOnDisk: readonly string[]): void {
  if (!hydrated) return;
  const next = reconcileProjects(projects, foldersOnDisk, Date.now());
  const changed =
    next.length !== projects.length ||
    next.some((p, i) => p.folder !== projects[i]?.folder);
  if (!changed) return;
  projects = next;
  save();
  notify();
}

/**
 * Carry a project's metadata across a folder rename.
 *
 * Without this the poster and colour are lost the moment someone renames a
 * project: the folder IS the key, so the old entry stops matching anything on
 * disk and reconciliation replaces it with a blank one. The rename on disk has
 * already happened by the time this is called - that is what makes it a
 * carry-over rather than a request.
 *
 * `title` follows the folder unless the person had set a title that already
 * diverged from it, which is the only case where the displayed name was a
 * deliberate choice rather than a default.
 */
export function renameProject(from: string, to: string): void {
  const p = projects.find((x) => x.folder === from);
  if (!p || from === to) return;
  const renamedTitle = p.title === from ? to : p.title;
  projects = projects
    .filter((x) => x.folder !== to)
    .map((x) => (x.folder === from ? { ...x, folder: to, title: renamedTitle } : x));
  save();
  notify();
}

/** Drop a project's metadata once its folder is gone from disk. */
export function forgetProject(folder: string): void {
  if (!projects.some((p) => p.folder === folder)) return;
  projects = projects.filter((p) => p.folder !== folder);
  save();
  notify();
}

export function editProject(
  folder: string,
  patch: Partial<Omit<TranscriptProject, "folder">>,
): void {
  projects = updateProject(projects, folder, patch);
  save();
  notify();
}

/** Test seam: reset module state between cases. */
export function __resetProjectStore(): void {
  projects = [];
  dir = null;
  dirEnsured = false;
  hydrated = false;
  hydrating = false;
  pendingWrite = false;
  futureVersion = null;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  listeners.clear();
}
