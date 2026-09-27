/**
 * Transcript Editor prototype: which side panes fit, and how wide each one is.
 *
 * The window is a row of panes over a full-width timeline. The EDIT (record)
 * pane is the document and never collapses; the other three are optional and
 * each has a minimum, an ideal and a maximum width. When the window is too
 * narrow for everything that is open, panes leave in priority order rather
 * than all shrinking into uselessness. The pane the user opened LAST has the
 * highest priority, so asking for a pane always shows it: something else
 * steps aside instead. By default the left column goes first, then the right,
 * then the source column. A column that steps aside FOLDS: its tabs join the
 * edit column's tab strip, so nothing it held becomes unreachable.
 *
 * Pure so it can be tested; the numbers are the ones in
 * docs/TRANSCRIPT-EDITOR-UX.md.
 */

export type TePane = "left" | "source" | "right";
export type TePaneLimits = { min: number; ideal: number; max: number };

export const tePaneLimits: Record<TePane, TePaneLimits> = {
  left: { min: 180, ideal: 220, max: 320 },
  source: { min: 280, ideal: 320, max: 480 },
  right: { min: 240, ideal: 270, max: 360 },
};

/** About sixty characters of the edit's prose at its reading size. */
export const TE_RECORD_MIN = 440;
/** Each divider between panes is a 1px hairline. */
const DIVIDER = 1;

/** Transport plus a ruler and five lanes; below the minimum the lanes scroll. */
export const teTimelineLimits = { min: 160, ideal: 264 };

export type TeLayout = {
  shown: Record<TePane, boolean>;
  widths: Record<TePane, number>;
  record: number;
  /** Open columns with no room: their tabs join the edit column's strip. */
  folded: TePane[];
};

const clamp = (value: number, { min, max }: TePaneLimits) => Math.max(min, Math.min(max, value));

export function layoutPanes(width: number, open: Record<TePane, boolean>, sizes: Record<TePane, number>, priority: TePane[]): TeLayout {
  const wanted = priority.filter((pane) => open[pane]);
  const room = (panes: TePane[]) => width - TE_RECORD_MIN - panes.length * DIVIDER;
  let kept = wanted;
  while (kept.length && kept.reduce((sum, pane) => sum + tePaneLimits[pane].min, 0) > room(kept)) kept = kept.slice(0, -1);
  const widths = { left: 0, source: 0, right: 0 } as Record<TePane, number>;
  for (const pane of kept) widths[pane] = clamp(sizes[pane], tePaneLimits[pane]);
  // Too wide at the chosen sizes: take the excess from the lowest priority first.
  let excess = kept.reduce((sum, pane) => sum + widths[pane], 0) - room(kept);
  for (const pane of [...kept].reverse()) {
    if (excess <= 0) break;
    const give = Math.min(excess, widths[pane] - tePaneLimits[pane].min);
    widths[pane] -= give;
    excess -= give;
  }
  const shown = { left: kept.includes("left"), source: kept.includes("source"), right: kept.includes("right") };
  const record = width - kept.reduce((sum, pane) => sum + widths[pane] + DIVIDER, 0);
  return { shown, widths, record, folded: wanted.filter((pane) => !kept.includes(pane)) };
}

/** Timeline height: at least its minimum, at most half the window. */
export function clampTimeline(height: number, total: number) {
  return Math.max(teTimelineLimits.min, Math.min(Math.max(teTimelineLimits.min, total / 2), height));
}
