import { loadJson, saveJson } from "./storage";
import type { ReviewOp } from "./review";

/**
 * Notes a reviewer wrote that nobody has received yet.
 *
 * Three separate ways an op could be lost before this existed, and all three
 * looked identical to the author: the note appeared on their screen and simply
 * never arrived.
 *
 *   1. `sendSessionMsg` is fire-and-forget with a swallowed `.catch(() => {})`,
 *      so a send that failed was applied locally and dropped.
 *   2. The in-memory queue was wiped on session teardown.
 *   3. Replay ran on the FIRST snapshot adoption only, so a reconnect within
 *      the same session replayed nothing.
 *
 * This is deliberately NOT a general sync engine. It is a list of ops per
 * review, persisted, drained when there is someone to drain to. It works
 * because `ReviewOp` was already built for replay: `add` carries the
 * fully-built comment so inserts are id-idempotent, `resolve`/`like`/`status`
 * are SET rather than toggle, and edits are last-write-wins with a
 * deterministic tiebreak. Re-sending an op the host already has is a no-op, so
 * an over-eager drain costs nothing and a missed one costs a note.
 */

const KEY = "saucebunny.review.outbox";

/**
 * Per review, the most ops that will be kept.
 *
 * A bound is needed because nothing guarantees a host ever comes back, and
 * CLAUDE.md's storage notes are explicit that a store nothing evicts from is a
 * quota failure waiting to happen. 500 is far past a real review - the largest
 * transcript in the perf table is 15,000 cues and a note-heavy pass is dozens
 * of comments - so hitting it means the host has been gone a very long time.
 *
 * The OLDEST are dropped rather than the newest: if a reviewer has written 501
 * notes into the void, the recent ones are the ones they still care about.
 */
export const MAX_PER_REVIEW = 500;

type Outbox = Record<string, ReviewOp[]>;

function load(): Outbox {
  const raw = loadJson<Outbox>(KEY, {});
  return raw && typeof raw === "object" ? raw : {};
}

/** Queue one op for a review. Returns how many are now waiting. */
export function enqueueOp(sourceKey: string, op: ReviewOp): number {
  if (!sourceKey) return 0;
  const box = load();
  const queue = [...(box[sourceKey] ?? []), op];
  // Trim from the FRONT: oldest first.
  box[sourceKey] = queue.length > MAX_PER_REVIEW ? queue.slice(-MAX_PER_REVIEW) : queue;
  saveJson(KEY, box);
  return box[sourceKey].length;
}

/** What is waiting for this review. Empty array when nothing is. */
export function pendingOps(sourceKey: string | null | undefined): ReviewOp[] {
  if (!sourceKey) return [];
  return load()[sourceKey] ?? [];
}

/** How many notes are waiting, across every review. Drives the one bit of UI
 *  this needs: a count the author can see, so "not sent yet" is never silent. */
export function pendingCount(): number {
  return Object.values(load()).reduce((n, q) => n + q.length, 0);
}

/**
 * Drop the ops that have now been delivered.
 *
 * Matched by identity against what was drained rather than by clearing the
 * key, because a note written DURING the drain must not be thrown away with
 * the ones that succeeded. That window is small and it is real: the drain
 * awaits an invoke per op.
 */
export function clearDelivered(sourceKey: string, delivered: readonly ReviewOp[]): void {
  if (!sourceKey || delivered.length === 0) return;
  const box = load();
  const queue = box[sourceKey];
  if (!queue) return;
  const gone = new Set(delivered.map((o) => JSON.stringify(o)));
  const left = queue.filter((o) => !gone.has(JSON.stringify(o)));
  if (left.length) box[sourceKey] = left;
  else delete box[sourceKey];
  saveJson(KEY, box);
}

/** Forget everything queued for a review. For a user who gives up on it. */
export function discardOutbox(sourceKey: string): void {
  const box = load();
  if (!(sourceKey in box)) return;
  delete box[sourceKey];
  saveJson(KEY, box);
}

/** Test seam. */
export function __clearAllOutboxes(): void {
  saveJson(KEY, {});
}
