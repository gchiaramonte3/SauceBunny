/**
 * The version number every file store stamps, and the rule that makes it
 * mean something.
 *
 * All four stores (`casts.json`, `projects.json`, `Reviews/index.json`,
 * `Screenings/index.json`) have always WRITTEN `{ version: 1, ... }`. Until
 * this module, none of them READ it, which made the field decorative and the
 * failure it was there to prevent silent:
 *
 *   A newer Sauce Bunny writes version 2 with a field this build has never
 *   heard of. This build parses it under version-1 rules, its sanitizer drops
 *   the unknown field on the floor, and the next debounced save writes the
 *   truncated result back over the file. The user's work is gone from their
 *   Documents folder with nothing said. Downgrades, a second Mac, a rollback
 *   after a beta: all ordinary ways to get there.
 *
 * So: a file whose version is HIGHER than this build understands is loaded
 * best-effort but never written. Read-only is recoverable (update the app);
 * a silent rewrite is not. Older or absent versions load and write normally,
 * because a missing field means "written before the field existed", which is
 * ours to upgrade, not to refuse.
 *
 * Bumping STORE_SCHEMA_VERSION is what a real schema change costs: do it in
 * the same commit that adds the field, and older builds will decline to
 * clobber the file instead of quietly eating it.
 */

/** What this build can read and write. Bump with any on-disk shape change. */
export const STORE_SCHEMA_VERSION = 1;

/**
 * The version stamped on a store file, if it is newer than this build.
 *
 * Returns null for everything we can handle: our own version, an older one,
 * a file with no version field, unparseable text, or a non-object. Those are
 * all the existing tolerant-parse paths and none of them should change
 * behaviour. Only a number strictly greater than ours locks a store.
 */
export function futureVersionIn(text: unknown): number | null {
  if (typeof text !== "string" || !text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const v = (parsed as { version?: unknown }).version;
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v > STORE_SCHEMA_VERSION ? v : null;
}

export type FutureStoreVersion = {
  /** Plural noun for the message, e.g. "casts". */
  label: string;
  found: number;
  message: string;
};

const listeners = new Set<(p: FutureStoreVersion) => void>();

/**
 * Subscribe to "a store file on disk is newer than this build".
 *
 * One bridge for all four stores rather than four, because the user needs to
 * be told once per store and App is the only thing that can tell them. Modelled
 * on `onReviewStoreProblem`, which exists for the same reason: this app ships
 * with no console, so a console.warn is the same as saying nothing.
 */
export function onFutureStoreVersion(cb: (p: FutureStoreVersion) => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** The sentence the user sees. Also the value stores keep as their lock. */
export function futureVersionMessage(label: string, found: number): string {
  return (
    `Your ${label} file was written by a newer Sauce Bunny (format ${found}, ` +
    `this one reads ${STORE_SCHEMA_VERSION}). Nothing will be saved to it, so ` +
    `the newer copy stays intact. Update Sauce Bunny to edit ${label} again.`
  );
}

/** Announce a locked store. Stores call this once, when they lock. */
export function reportFutureVersion(label: string, found: number): void {
  const message = futureVersionMessage(label, found);
  console.warn(`store-schema: ${message}`);
  for (const cb of listeners) cb({ label, found, message });
}

/** Test-only: drop subscribers so each vitest case starts cold. */
export function resetFutureVersionListenersForTests(): void {
  listeners.clear();
}
