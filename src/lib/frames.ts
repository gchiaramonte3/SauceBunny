import type { FrameItem } from "../bindings/FrameItem";
import type { LibrarySortDir, LibrarySortKey } from "./library";

export type { FrameItem };

/**
 * Grabbed frames, grouped and ordered for the Library's Frames shelf.
 *
 * The pure half of the shelf, kept beside web-source.ts and shaped exactly
 * like it: a grouper, a sorter and a filter with the folder pane's own
 * semantics, so a user who has learned one shelf has learned all three.
 */

/** Group frames by the source they were grabbed from, biggest group first.
 *
 *  Ties break alphabetically so the order is stable between launches - a
 *  shelf that reshuffles because two films have the same number of frames
 *  reads as a bug. This is groupBySite's rule, for the same reason. */
export function groupBySource(items: readonly FrameItem[]): Array<{ source: string; items: FrameItem[] }> {
  const byKey = new Map<string, { source: string; items: FrameItem[] }>();
  for (const it of items) {
    const key = it.source.toLowerCase();
    const bucket = byKey.get(key) ?? { source: it.source, items: [] };
    bucket.items.push(it);
    byKey.set(key, bucket);
  }
  return [...byKey.values()].sort(
    (a, b) => b.items.length - a.items.length || a.source.localeCompare(b.source),
  );
}

/**
 * Sort a copy of `items` - the folder pane's exact semantics again: a
 * locale- and numeric-aware name compare, the direction applied to the
 * PRIMARY key only so the name tiebreak stays ascending in both directions
 * (Finder's rule), and ties falling back to name so nothing jitters.
 *
 * Name is the FILENAME here rather than the source, because within a group
 * every frame shares a source and the filename's timecode tail is what
 * distinguishes them - so "sort by name" reads as "in timecode order",
 * which is what someone scanning a film's frames wants.
 */
export function sortFrames(
  items: readonly FrameItem[],
  key: LibrarySortKey,
  dir: LibrarySortDir,
): FrameItem[] {
  const byName = (a: FrameItem, b: FrameItem) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  const sign = dir === "desc" ? -1 : 1;
  const cmp = (a: FrameItem, b: FrameItem): number => {
    if (key === "date") return sign * (a.created_at - b.created_at) || byName(a, b);
    if (key === "size") return sign * (a.size_bytes - b.size_bytes) || byName(a, b);
    return sign * byName(a, b);
  };
  return [...items].sort(cmp);
}

/** Case-insensitive substring over the filename and the source - the two
 *  things a person knows about a frame they are looking for. An empty or
 *  whitespace needle means "no filter", as in the folder pane. */
export function filterFrames(items: readonly FrameItem[], needle: string): FrameItem[] {
  const q = needle.trim().toLowerCase();
  if (!q) return [...items];
  return items.filter((i) =>
    i.name.toLowerCase().includes(q) || i.source.toLowerCase().includes(q),
  );
}

/**
 * "00012304" -> "00:01:23:04", for display.
 *
 * The grabber writes the timecode with its colons stripped, so putting them
 * back is a pure formatting step. A tail that is not a whole number of
 * two-digit fields is shown as-is rather than sliced into a lie.
 */
export function formatFrameTimecode(tc: string | null): string | null {
  if (!tc || tc.length % 2 !== 0 || tc.length < 6) return tc;
  return (tc.match(/.{2}/g) ?? []).join(":");
}
