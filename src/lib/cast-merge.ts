import type { Cast } from "./cast";

/**
 * Reconcile this window's casts with what is on disk, before overwriting it.
 *
 * `casts.json` is ONE file holding every cast, and both windows can edit it:
 * the speaker roster lives inside `TranscriptViewer`, which the main window
 * and the popped-out panel both render. Each window hydrates its own
 * in-memory list at boot and then wrote the whole file on every change, so
 * whichever saved last erased anything the other had added since — silently,
 * with no error and no way back. A cast is thirty names, colours and faces
 * built over a season.
 *
 * The fix is not a lock; it is knowing the difference between "I never had
 * this" and "I deleted this". A blind union resurrects deletions; a blind
 * overwrite loses additions. So a window tracks what it TOUCHED:
 *
 *   · `touched`    — ids this window saved. Ours wins, because we stamped
 *                    `updatedAt` when we saved and the newer edit is the one
 *                    the user made last.
 *   · `tombstones` — ids this window deleted, with when. A delete only wins
 *                    over a disk copy that is OLDER than the delete; if the
 *                    other window edited it afterwards, that edit is newer
 *                    intent and the cast comes back.
 *
 * Same grow-set-plus-tombstones shape the review annotations use, for the
 * same reason: it converges without either side having to win a race.
 *
 * Anything on disk this window never touched is carried through untouched.
 * That single line is the actual bug fix.
 */
export function mergeCasts(
  disk: readonly Cast[],
  local: readonly Cast[],
  touched: ReadonlyMap<string, number>,
  tombstones: ReadonlyMap<string, number>,
): Cast[] {
  const byId = new Map<string, Cast>();

  // Start from disk: everything the other window knows about.
  for (const c of disk) byId.set(c.id, c);

  // Our own edits win over the disk copy — we stamped them more recently.
  for (const c of local) {
    if (!touched.has(c.id)) continue;
    const there = byId.get(c.id);
    if (!there || c.updatedAt >= there.updatedAt) byId.set(c.id, c);
  }

  // Deletions apply only against a copy older than the delete itself.
  for (const [id, at] of tombstones) {
    const there = byId.get(id);
    if (there && there.updatedAt <= at) byId.delete(id);
  }

  // Newest first, which is the order the picker shows and the order a fresh
  // save lands in.
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt);
}
