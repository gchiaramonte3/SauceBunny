/**
 * Where a new library subfolder would go, and whether the name is allowed.
 *
 * Pure and here rather than inline in the browser, because TWO callers need
 * the same answer now: the browse bar's "New folder", and the move dialog's
 * "create one and file these into it". The dialog has to know the resulting
 * PATH to move into, so without this the join would be written twice and the
 * two could disagree about trailing slashes.
 *
 * The validation is the load-bearing half. A separator would escape the folder
 * being browsed and the Rust side joins blind, so this has to refuse before
 * the call rather than after it.
 */
import type { LibraryFolder } from "../types";
import { pathKey } from "./repath";

export type NewFolder = { path: string } | { error: string };

/** Overlay lazy one-level reads without changing Home's bounded scan results. */
export function mergeFolderBranches(trees: LibraryFolder[], branches: ReadonlyMap<string, LibraryFolder>): LibraryFolder[] {
  const visit = (node: LibraryFolder): LibraryFolder => {
    const source = branches.get(pathKey(node.path)) ?? node;
    return { ...source, folders: source.folders.map(visit) };
  };
  return trees.map(visit);
}

export function diskFolderTargets(trees: readonly LibraryFolder[]): { path: string; label: string }[] {
  const found = new Map<string, { path: string; label: string }>();
  const visit = (folder: LibraryFolder) => {
    found.set(pathKey(folder.path), { path: folder.path, label: folder.path });
    folder.folders.forEach(visit);
  };
  trees.forEach(visit);
  return [...found.values()];
}

export function newFolderPath(dir: string, name: string): NewFolder {
  const trimmed = name.trim();
  // A leading dot hides the folder from the scanner that is about to look for
  // it, so the user would make one and watch nothing appear.
  if (!trimmed || /[\/\x00-\x1f\x7f]/.test(trimmed) || trimmed.startsWith(".")) {
    return { error: "Use a plain folder name." };
  }
  if (!dir) return { error: "Open a folder first." };
  return { path: `${dir.replace(/\/+$/, "")}/${trimmed}` };
}
