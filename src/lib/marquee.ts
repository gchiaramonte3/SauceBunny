/**
 * Rubber-band selection: the geometry, and how a drag composes with what was
 * already selected.
 *
 * THE RULE THAT MATTERS MOST IS THE SMALLEST ONE. A drag under a few pixels is
 * a CLICK, not a marquee. Without that threshold every ordinary click becomes a
 * zero-area band that selects nothing, so clicking a file would clear the
 * selection you just made — and it would do it only sometimes, because whether
 * the pointer moved one pixel depends on the mouse, the surface and the hand.
 * That is the worst kind of bug to be told about and the easiest to prevent.
 *
 * INTERSECTS, NOT CONTAINS. Finder selects everything the band TOUCHES, so you
 * can sweep a thin line down a column and take the whole column. Requiring
 * containment means a band has to fully swallow a wide row, which at list
 * widths is almost never what the hand did.
 *
 * A MODIFIED DRAG ADDS TO WHAT WAS THERE. Shift or command starts the band from
 * the selection you already had rather than replacing it, so a marquee can
 * extend a set built by clicking. Plain drag replaces, which is the common case.
 */

export type Point = { x: number; y: number };
export type Rect = { left: number; top: number; right: number; bottom: number };

/** Below this many pixels of travel, the gesture is a click. */
export const MARQUEE_THRESHOLD = 4;

/** Normalised rect from two corners, in any drag direction. */
export function marqueeRect(a: Point, b: Point): Rect {
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    right: Math.max(a.x, b.x),
    bottom: Math.max(a.y, b.y),
  };
}

/** Did the pointer travel far enough to mean a band rather than a click? */
export function isDrag(a: Point, b: Point): boolean {
  return Math.abs(b.x - a.x) >= MARQUEE_THRESHOLD
    || Math.abs(b.y - a.y) >= MARQUEE_THRESHOLD;
}

/** Do two rects overlap at all? Touching edges count as a miss. */
export function intersects(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** Paths whose box the band touches, in the order the boxes were given
 *  (which callers set to display order). */
export function pathsInRect(
  band: Rect, boxes: readonly { path: string; rect: Rect }[],
): string[] {
  return boxes.filter((b) => intersects(band, b.rect)).map((b) => b.path);
}

/**
 * The selection a finished (or in-progress) band produces.
 *
 * `base` is the selection as it was when the drag STARTED — not the live one —
 * so dragging back and forth keeps producing the same answer instead of
 * accumulating everything the band ever swept over.
 */
export function marqueeSelection(
  base: ReadonlySet<string>,
  hit: readonly string[],
  mods: { shift: boolean; meta: boolean },
): Set<string> {
  return (mods.shift || mods.meta) ? new Set([...base, ...hit]) : new Set(hit);
}
