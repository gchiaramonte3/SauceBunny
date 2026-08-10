import { invoke } from "@tauri-apps/api/core";
import { formatError } from "./error-format";
import { needsRepath, repathTo } from "./repath";
import { loadChosenPosters, loadSourceTimecodes, saveChosenPosters, saveSourceTimecodes } from "./library";
import { repathKey } from "./repath";
import { linkFingerprint, resolveByFingerprint, reviewFingerprint } from "./review";
import { getHistory, renameEntryPath } from "./transcript-history";
import type { RenamePlanRow } from "./rename-pattern";

/**
 * Perform a rename, and carry the file's identity across with it.
 *
 * THE ORDER IS THE WHOLE DESIGN. The file is renamed FIRST, and the records
 * only move once that succeeded. Doing it the other way round means a rename
 * that fails (permissions, a file that vanished, a full disk) leaves four
 * stores pointing at a path that does not exist, which is worse than not
 * renaming at all: the clip is where it was and its notes are not.
 *
 * WHAT MOVES, and why each one would otherwise detach:
 *
 *   · chosen poster       keyed by absolute path
 *   · source timecode     keyed by absolute path
 *   · review document     resolved through a fingerprint containing the stem
 *   · transcript history  entry.sourcePath points at the clip
 *
 * The review is the one that matters. Its fingerprint is
 * `nameStem|duration|WxH|size`, so a rename changes the fingerprint and the
 * notes stop resolving — the .json is still on disk, the clip is still on disk,
 * and the app looks like it lost the notes. Linking the NEW fingerprint to the
 * key the old one resolved to is what keeps them together.
 */

export type RenameOutcome = {
  from: string;
  to: string;
  ok: boolean;
  error?: string;
};

/** Metadata needed to rebuild the review fingerprint. Absent for a file we
 *  never probed, in which case the review link is skipped rather than guessed
 *  at with wrong numbers. */
export type RenameIdentity = {
  durationSec?: number | null;
  width?: number | null;
  height?: number | null;
  sizeBytes?: number | null;
};

/**
 * Move the app's records from one path to another. Call ONLY after the file
 * itself has been renamed.
 */
export function repathIdentity(
  oldPath: string, newPath: string, id: RenameIdentity,
): void {
  if (!needsRepath(oldPath, newPath)) return;

  saveChosenPosters(repathKey(loadChosenPosters(), oldPath, newPath));
  saveSourceTimecodes(repathKey(loadSourceTimecodes(), oldPath, newPath));

  // The review. Without duration and dimensions the fingerprint cannot be
  // rebuilt, and a fingerprint made from guessed numbers would point the new
  // name at somebody else's review — far worse than leaving it unlinked.
  const oldName = oldPath.split("/").pop() ?? oldPath;
  const newName = newPath.split("/").pop() ?? newPath;
  if (id.durationSec != null) {
    const oldFp = reviewFingerprint(oldName, id.durationSec, id.width ?? null, id.height ?? null, id.sizeBytes ?? null);
    const newFp = reviewFingerprint(newName, id.durationSec, id.width ?? null, id.height ?? null, id.sizeBytes ?? null);
    // Whatever the old name resolved to is the review this file owns; if it
    // never had one, the old PATH is the key a review would be created under.
    linkFingerprint(newFp, resolveByFingerprint(oldFp) ?? oldPath);
  }

  // Transcript history: the entry that knows which .srt belongs to this clip.
  for (const e of getHistory()) {
    if (e.sourcePath === oldPath) renameEntryPath(oldPath, newPath, newName.replace(/\.[^.]+$/, ""));
  }
}

/**
 * Rename one file and carry its identity. Never throws; the outcome says what
 * happened so a batch can report per file.
 */
export async function applyRename(
  oldPath: string, newFilename: string, id: RenameIdentity,
): Promise<RenameOutcome> {
  const newPath = repathTo(oldPath, newFilename);
  if (!needsRepath(oldPath, newPath)) return { from: oldPath, to: newPath, ok: true };
  try {
    await invoke<string>("rename_path", { from: oldPath, to: newPath });
  } catch (err) {
    // Records untouched: the file is still where it was, and so are its notes.
    return { from: oldPath, to: newPath, ok: false, error: formatError(err) };
  }
  repathIdentity(oldPath, newPath, id);
  return { from: oldPath, to: newPath, ok: true };
}

/**
 * Apply a whole plan, in order, stopping for nothing.
 *
 * One failure does not abort the rest — same rule as the transcribe batch, and
 * for the same reason: aborting halfway through leaves the user with a folder
 * half-renamed and no list of which half.
 */
export async function applyRenamePlan(
  rows: readonly RenamePlanRow[],
  identityOf: (path: string) => RenameIdentity,
): Promise<RenameOutcome[]> {
  const out: RenameOutcome[] = [];
  for (const row of rows) {
    if (row.problem) {
      out.push({ from: row.path, to: row.to, ok: false, error: row.problem });
      continue;
    }
    out.push(await applyRename(row.path, row.to, identityOf(row.path)));
  }
  return out;
}
