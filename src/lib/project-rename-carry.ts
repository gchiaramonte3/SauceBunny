/**
 * What a project-folder rename has to drag along with it.
 *
 * Renaming a project moves the DIRECTORY, so every transcript inside it gets a
 * new absolute path. Two stores are keyed by that path and neither notices:
 *
 *   · transcript history — holds the link back to the source video, the title,
 *     and the review fingerprint. Orphan it and the transcript opens
 *     standalone, no longer follows its video, AND the stale entry keeps
 *     rendering as a second row that points at a file which is not there.
 *   · speaker overrides — the names someone typed over SPEAKER_00. Hours of
 *     work, no undo, and the fingerprint bridge cannot recover them because
 *     that needs the source media loaded, which it no longer is.
 *
 * The rename dialog promises "the transcripts inside it move with it and keep
 * working". This is the part that makes that true.
 *
 * Pure so the path arithmetic can be tested without a filesystem: it works out
 * WHICH paths move, and the caller applies the moves through the existing
 * per-path helpers.
 */

/** One transcript's path, before and after the folder rename. */
export type CarriedPath = { from: string; to: string };

/**
 * Every path under `oldDir` rewritten to sit under `newDir`.
 *
 * Only direct membership counts, and matching is on a path SEGMENT rather than
 * a string prefix: renaming "Rush" must not rewrite paths inside "Rushes".
 */
export function carriedPaths(
  paths: readonly string[],
  oldDir: string,
  newDir: string,
): CarriedPath[] {
  const from = oldDir.replace(/\/+$/, "");
  const to = newDir.replace(/\/+$/, "");
  if (!from || !to || from === to) return [];
  const prefix = `${from}/`;
  return paths
    .filter((p) => p.startsWith(prefix))
    .map((p) => ({ from: p, to: `${to}/${p.slice(prefix.length)}` }));
}
