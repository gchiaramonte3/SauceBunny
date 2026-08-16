import type { RecentClip } from "../types";

/**
 * The sidebar's Recent-exports list keeps EVERY export, capped, newest first.
 * Grouping by source happens at render time — storage stays flat and dumb.
 *
 * Twelve because the sidebar groups by source and a group can be several
 * exports deep: cap it much tighter and re-exporting one clip a few times
 * evicts every other source from the list.
 */
export const RECENT_CLIP_CAP = 12;

export function pushRecentClip(prev: RecentClip[], r: RecentClip): RecentClip[] {
  return [r, ...prev].slice(0, RECENT_CLIP_CAP);
}
