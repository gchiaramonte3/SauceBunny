/**
 * Which tabs of a strip are drawn and which go behind its "N more" button.
 *
 * A tab strip in this app never scrolls sideways. On a Mac set to always show
 * scrollbars (the default with a mouse, and on older machines) a scrolling
 * strip grows a permanent scrollbar under the tabs, and on every Mac it hides
 * tabs behind a gesture nobody goes looking for. Instead the strip keeps what
 * fits, in order, and lists the rest in a menu. The chosen tab is always drawn
 * so the strip never hides where you are.
 *
 * `widths` are measured tab widths in order; `available` is the strip's width
 * and `more` the width the "N more" button needs. An unmeasured strip (no
 * layout yet, or a test DOM) draws everything rather than nothing.
 */
export function visibleTabs(widths: readonly number[], available: number, more: number, selected: number): number[] {
  const all = widths.map((_, index) => index);
  if (available <= 0 || widths.every((width) => width <= 0)) return all;
  const total = widths.reduce((sum, width) => sum + width, 0);
  if (total <= available) return all;
  const room = available - more;
  const pinned = selected >= 0 && selected < widths.length ? selected : -1;
  let used = pinned >= 0 ? widths[pinned] : 0;
  const shown: number[] = [];
  for (const index of all) {
    if (index === pinned) continue;
    if (used + widths[index] > room) break;
    shown.push(index); used += widths[index];
  }
  if (pinned >= 0) shown.push(pinned);
  return shown.sort((a, b) => a - b);
}
