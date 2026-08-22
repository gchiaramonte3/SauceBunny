import { invoke } from "@tauri-apps/api/core";
import {
  parseProjects, reconcileProjects, updateProject,
  type TranscriptProject,
} from "./transcript-projects";

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
export async function hydrateProjects(foldersOnDisk: readonly string[]): Promise<void> {
  if (hydrated || hydrating) return;
  hydrating = true;
  try {
    dir = await invoke<string>("default_transcript_library_path");
    let stored: TranscriptProject[] = [];
    try {
      const text = await invoke<string>("read_text_file_capped", {
        path: `${dir}/${FILE}`, maxBytes: READ_CAP,
      });
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
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  listeners.clear();
}
