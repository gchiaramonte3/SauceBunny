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
export type NewFolder = { path: string } | { error: string };

export function newFolderPath(dir: string, name: string): NewFolder {
  const trimmed = name.trim();
  // A leading dot hides the folder from the scanner that is about to look for
  // it, so the user would make one and watch nothing appear.
  if (!trimmed || trimmed.includes("/") || trimmed.startsWith(".")) {
    return { error: "Use a plain folder name." };
  }
  if (!dir) return { error: "Open a folder first." };
  return { path: `${dir.replace(/\/+$/, "")}/${trimmed}` };
}
