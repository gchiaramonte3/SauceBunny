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
  // SHIFT AND COMMAND ARE NOT THE SAME GESTURE. Both used to union, which made
  // ⌘ a slower Shift and left no way to take something OUT of a selection with
  // a band. Finder: Shift = union with the pre-drag selection; Command =
  // toggle, so an already-selected item the band sweeps becomes deselected.
  // That is the whole point of ⌘ — sweep back over a mistake to undo it.
  if (mods.meta) {
    const out = new Set(base);
    for (const p of hit) {
      if (out.has(p)) out.delete(p); else out.add(p);
    }
    return out;
  }
  if (mods.shift) return new Set([...base, ...hit]);
  return new Set(hit);
}

/**
 * How far to scroll per frame when a band's pointer nears the container edge,
 * as a signed pixel step (negative = up). Zero when the pointer is comfortably
 * inside.
 *
 * Pure, and separate from the hook, because it is the part with the arithmetic
 * and the part worth pinning: the hook around it is a frame loop and a
 * scrollTop assignment. Same split as `marqueeRect` and `pathsInRect` above.
 *
 * Ramped rather than constant — the further past the edge, the faster — so a
 * long list can be crossed quickly without making a small overshoot lurch.
 */
export function edgeScrollStep(
  pointerY: number,
  top: number,
  bottom: number,
  edge = 48,
  maxStep = 24,
): number {
  const above = top + edge - pointerY;
  if (above > 0) return -Math.min(maxStep, above / 2);
  const below = pointerY - (bottom - edge);
  if (below > 0) return Math.min(maxStep, below / 2);
  return 0;
}
