/**
 * Moving one row of a list to a new position, decided here rather than in a
 * pointer handler.
 *
 * The index arithmetic is the whole feature and it is the part that is easy
 * to get subtly wrong: an insertion point is counted BEFORE the dragged row
 * is taken out, so committing it naively lands the row one place off in one
 * direction and correct in the other. A bug like that looks like "dragging
 * down is broken" and is invisible in review.
 *
 * The pointer wiring stays in the component. This is the same split the
 * marquee uses - `marquee.ts` decides, `use-marquee.ts` listens.
 */

/**
 * Where a row dragged to `y` should be inserted, as an index into the list
 * of rows it is being dragged among.
 *
 * `mids` are the vertical midpoints of those rows, in display order. The
 * answer is a boundary, so it ranges 0..mids.length inclusive: past the last
 * midpoint means "after everything".
 *
 * Midpoints rather than edges, because a row is over the position it has
 * covered MOST of - which is what makes the list feel like it is yielding to
 * the pointer rather than snapping when the edges happen to touch.
 */
export function dropIndexAt(mids: readonly number[], y: number): number {
  let i = 0;
  while (i < mids.length && y > mids[i]) i++;
  return i;
}

/**
 * `list` with the item at `from` moved to the insertion boundary `to`.
 *
 * `to` is counted against the list as it looks NOW, before the item is
 * removed. Dropping an item just after itself is therefore `from + 1`, and
 * means nothing moved - the caller does not have to special-case it.
 *
 * Returns a new array; returns a copy unchanged when the move is a no-op, so
 * a caller can always use the result.
 */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  const out = [...list];
  if (from < 0 || from >= out.length) return out;
  if (to === from || to === from + 1) return out;
  const [item] = out.splice(from, 1);
  // Removing the item shifted everything after it down by one, so an
  // insertion point that was beyond it has to come back by one.
  out.splice(to > from ? to - 1 : to, 0, item);
  return out;
}

/**
 * Rewrite `list` so the items whose ids appear in `orderedIds` occupy the
 * positions those items currently hold, in the given order.
 *
 * The queue holds finished, running and waiting clips in one array, and only
 * the WAITING ones may be reordered: a running clip is mid-subprocess and a
 * finished one is a receipt. So the reorder cannot simply rewrite the array
 * - it has to leave every other row exactly where it is and permute only the
 * slots the reorderable rows already occupy.
 *
 * Ids not present in `list` are ignored, and any reorderable item missing
 * from `orderedIds` keeps its relative order after the ones that are named -
 * so a stale id from a list that changed under the drag cannot drop a clip.
 */
export function applyOrderToSlots<T>(
  list: readonly T[],
  isMovable: (item: T) => boolean,
  idOf: (item: T) => string,
  orderedIds: readonly string[],
): T[] {
  const slots: number[] = [];
  const movable: T[] = [];
  list.forEach((item, i) => {
    if (!isMovable(item)) return;
    slots.push(i);
    movable.push(item);
  });
  if (slots.length === 0) return [...list];

  const byId = new Map(movable.map((m) => [idOf(m), m]));
  const taken = new Set<string>();
  const ordered: T[] = [];
  for (const id of orderedIds) {
    const item = byId.get(id);
    if (item && !taken.has(id)) { ordered.push(item); taken.add(id); }
  }
  // Anything the caller did not name keeps its existing relative order,
  // rather than being dropped from the queue.
  for (const m of movable) if (!taken.has(idOf(m))) ordered.push(m);

  const out = [...list];
  slots.forEach((slot, i) => { out[slot] = ordered[i]; });
  return out;
}
