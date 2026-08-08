/**
 * What a click does to the Library's selection — Finder's rules, decided here.
 *
 * WHY THIS IS NOT IN THE COMPONENT. It is four interacting inputs (the click,
 * the modifiers, the existing selection, the anchor) producing two outputs
 * (the new selection, the new anchor), and most of the subtlety is in the
 * anchor — the piece with no visual representation at all. A wrong anchor
 * looks like nothing until the user's second shift-click lands somewhere
 * baffling, which is exactly the class of bug that does not get noticed in
 * review and does not get reported clearly.
 *
 * THE ANCHOR RULE, stated once: a shift-click does NOT move the anchor. That
 * is what lets you shift-click repeatedly to grow and shrink one range from
 * where you started. Moving it — the obvious implementation — turns the second
 * shift-click into a new range starting from the first one's end, so the
 * selection crawls down the window instead of resizing. Every other gesture
 * sets the anchor to what was clicked.
 *
 * RANGES FOLLOW DISPLAY ORDER. `paths` is the list as SORTED ON SCREEN, not
 * the scan order. Shift-clicking two rows selects what lies between them as
 * the user sees it; running the range over the underlying order would select a
 * set that looks arbitrary the moment anyone sorts by size or date.
 */

export type ClickMods = {
  /** Shift — extend a range from the anchor. */
  shift: boolean;
  /** Command on macOS — toggle one item, keeping the rest. */
  meta: boolean;
};

export type SelectionState = {
  selected: ReadonlySet<string>;
  /** Where a range extends FROM. Null when there is nothing to extend. */
  anchor: string | null;
};

export const EMPTY_SELECTION: SelectionState = { selected: new Set(), anchor: null };

/**
 * The selection after clicking `path`.
 *
 * Returns the SAME state object when nothing changes, so a caller can skip a
 * re-render cheaply and a test can assert "this click did nothing".
 */
export function clickSelect(
  cur: SelectionState,
  paths: readonly string[],
  path: string,
  mods: ClickMods,
): SelectionState {
  const idx = paths.indexOf(path);
  // A click on something not in the current list (a stale card mid-rescan)
  // must not wipe the selection or strand the anchor somewhere invisible.
  if (idx < 0) return cur;

  // Shift with a live anchor: replace with the span, and LEAVE THE ANCHOR.
  const anchorIdx = cur.anchor == null ? -1 : paths.indexOf(cur.anchor);
  if (mods.shift && anchorIdx >= 0) {
    const lo = Math.min(anchorIdx, idx);
    const hi = Math.max(anchorIdx, idx);
    const span = paths.slice(lo, hi + 1);
    // Command+Shift adds the span to what is already selected; Shift alone
    // replaces. Both keep the anchor so the range can be resized.
    const next = mods.meta ? new Set([...cur.selected, ...span]) : new Set(span);
    return { selected: next, anchor: cur.anchor };
  }

  // Command: toggle this one, keep the rest, and move the anchor here so a
  // following shift-click extends from the item just touched.
  if (mods.meta) {
    const next = new Set(cur.selected);
    if (next.has(path)) next.delete(path); else next.add(path);
    return { selected: next, anchor: path };
  }

  // Plain click, and shift with no usable anchor (nothing selected yet, or the
  // anchor has been sorted/filtered away): select exactly this, anchor here.
  if (cur.selected.size === 1 && cur.selected.has(path) && cur.anchor === path) return cur;
  return { selected: new Set([path]), anchor: path };
}

/**
 * Drop anything no longer on screen, after a rescan, filter or sort.
 *
 * Without this a selection silently keeps paths the user cannot see, and a
 * batch action would then run over files that are not in front of them — the
 * worst possible surprise for an operation that renames or transcribes.
 */
export function pruneSelection(
  cur: SelectionState, paths: readonly string[],
): SelectionState {
  const live = new Set(paths);
  const kept = [...cur.selected].filter((p) => live.has(p));
  if (kept.length === cur.selected.size && (cur.anchor == null || live.has(cur.anchor))) {
    return cur; // nothing to do — keep identity so React can skip
  }
  return {
    selected: new Set(kept),
    anchor: cur.anchor != null && live.has(cur.anchor) ? cur.anchor : null,
  };
}

/** Select everything on screen. Anchor goes to the first item so a following
 *  shift-click narrows from the top rather than from nowhere. */
export function selectAll(paths: readonly string[]): SelectionState {
  return { selected: new Set(paths), anchor: paths[0] ?? null };
}

/** The selected paths in DISPLAY order — what any batch action should iterate.
 *  A Set has insertion order, which is click order, which is not what the user
 *  sees or means by "these three". */
export function selectedInOrder(
  cur: SelectionState, paths: readonly string[],
): string[] {
  return paths.filter((p) => cur.selected.has(p));
}
