/**
 * Every "don't show me this again" the app honours, and the one way back.
 *
 * Each of these is a one-way door the moment it is written. A user ticks
 * "Don't ask again" on the rename warning once, six months later renames a
 * folder of masters expecting the confirmation, and there is no confirmation —
 * and nothing anywhere offers to bring it back. The only route was opening the
 * web inspector and deleting a localStorage key, which is not a route.
 *
 * The same shape as the WebCodecs decoder toggle that shipped promising an
 * escape hatch it did not implement: a setting the user is invited to change
 * and then cannot change back. Suppression is a good feature; suppression
 * without a restore is a trap.
 *
 * ONE LIST, and `hidden-notices-contract` fails if a suppression key appears in
 * the source without being on it. A new notice added without a way back would
 * otherwise be invisible until somebody wanted it back, which is precisely too
 * late to notice.
 */

/** A suppression key, or a prefix when the notice is stored per file. */
type NoticeKey = {
  /** Exact key, or the prefix shared by a family of per-path keys. */
  key: string;
  /** True when `key` is a prefix and every key starting with it is a notice. */
  prefix?: boolean;
  /** What the user gets back, for the Settings row. */
  label: string;
};

export const HIDDEN_NOTICE_KEYS: NoticeKey[] = [
  { key: "saucebunny.renameDiskAck", label: "Rename writes to disk" },
  { key: "saucebunny.onboarding", label: "First-run tips" },
  { key: "saucebunny.noticeDismissed.", prefix: true, label: "Transcript notices" },
  { key: "saucebunny.timingFixDismissed.", prefix: true, label: "Transcript timing fixes" },
];

/** Keys currently set, oldest concern first. Read-only. */
export function hiddenNoticeKeys(store: Storage = localStorage): string[] {
  const found: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (!k) continue;
    const hit = HIDDEN_NOTICE_KEYS.some((n) => (n.prefix ? k.startsWith(n.key) : k === n.key));
    if (hit) found.push(k);
  }
  return found;
}

/** How many notices the user has hidden. Drives the Settings row's count. */
export function countHiddenNotices(store: Storage = localStorage): number {
  return hiddenNoticeKeys(store).length;
}

/**
 * Bring them all back. Returns how many were cleared.
 *
 * Collect first, delete second: removeItem during a `store.key(i)` walk
 * reindexes the store underneath the loop and silently skips every other
 * match, which would leave a "restored" user still missing half their
 * warnings — a failure that looks exactly like success.
 */
export function restoreHiddenNotices(store: Storage = localStorage): number {
  const keys = hiddenNoticeKeys(store);
  for (const k of keys) store.removeItem(k);
  return keys.length;
}
