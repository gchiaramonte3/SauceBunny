/**
 * Moving a file's identity when the file itself moves.
 *
 * WHY RENAME IS DANGEROUS HERE AND NOT IN FINDER. Four separate records are
 * keyed by a file's absolute path or its name, and none of them live inside
 * the file:
 *
 *   · the chosen poster frame       (path -> seconds)
 *   · the source start timecode     (path -> "HH:MM:SS:FF")
 *   · the review document           (resolved through a fingerprint that
 *                                    CONTAINS the filename stem)
 *   · the transcript history entry  (sourcePath -> its .srt)
 *
 * Rename the file and every one of them silently detaches. The review is the
 * bad one: the notes are still on disk, the clip is still on disk, and they no
 * longer find each other — which looks exactly like the app lost the notes.
 * That is why the rename engine sat finished and unwired until this existed.
 *
 * PURE, AND KEYED BY VALUE. Each function takes a map and returns a new one, so
 * the whole re-key is decidable and testable without touching localStorage or
 * the filesystem. The caller does the IO, in the same transaction as the
 * rename, so a failed rename never leaves the records pointing at a file that
 * was not created.
 */

/**
 * Move one key in a record, if it is there.
 *
 * Returns the SAME object when nothing moved, so a caller can skip a write.
 * An existing entry at `to` is overwritten — the file at that path is being
 * replaced by this one, so its old poster/timecode is stale by definition.
 */
export function repathKey<T>(
  map: Record<string, T>, from: string, to: string,
): Record<string, T> {
  if (from === to) return map;
  if (!Object.prototype.hasOwnProperty.call(map, from)) return map;
  const next = { ...map };
  next[to] = next[from];
  delete next[from];
  return next;
}

/** Move many keys at once, for a bulk rename. Pairs are applied in order. */
export function repathKeys<T>(
  map: Record<string, T>, pairs: readonly (readonly [string, string])[],
): Record<string, T> {
  let out = map;
  for (const [from, to] of pairs) out = repathKey(out, from, to);
  return out;
}

/**
 * The directory part of a path, and the filename part.
 *
 * A rename changes only the last component; the plan produces filenames, not
 * paths, so this is how a new full path is built.
 */
export function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(0, i) : "";
}

/** Full path for a renamed file: same folder, new filename. */
export function repathTo(oldPath: string, newFilename: string): string {
  const dir = dirOf(oldPath);
  return dir ? `${dir}/${newFilename}` : newFilename;
}

/**
 * Whether a rename actually needs the identity work.
 *
 * A no-op rename (same name) must not churn four stores and re-link a
 * fingerprint, and a case-only rename MUST, because the filesystem is
 * case-preserving and the stores are case-SENSITIVE — so "clip.mp4" and
 * "Clip.mp4" are one file on disk and two different keys in localStorage.
 */
export function needsRepath(oldPath: string, newPath: string): boolean {
  return oldPath !== newPath;
}
