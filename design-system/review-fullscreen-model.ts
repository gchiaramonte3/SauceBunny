/**
 * The two rules the full-screen prototype is built on, kept apart from the
 * markup so they can be tested: the picture fills its area at its own shape,
 * and the controls step aside while nobody is using them.
 */

/** The largest box of `aspect` (width over height) inside `area`: edge to edge on one axis, centred on the other. */
export function fitPicture(area: { width: number; height: number }, aspect: number): { width: number; height: number } {
  if (area.width <= 0 || area.height <= 0 || !(aspect > 0)) return { width: 0, height: 0 };
  return area.width / area.height > aspect
    ? { width: Math.round(area.height * aspect), height: area.height }
    : { width: area.width, height: Math.round(area.width / aspect) };
}

/** How long the pointer can rest before the controls and title step aside. */
export const IDLE_MS = 2500;

/**
 * Whether the controls and the title show. A pointer that moved recently,
 * keyboard focus inside them, an open menu, or the reviewer pinning them all
 * keep them up; the picture gets the window only when none of those holds.
 */
export function controlsShown(state: { sinceMoveMs: number; focusInside: boolean; menuOpen: boolean; pinned: boolean }): boolean {
  return state.pinned || state.focusInside || state.menuOpen || state.sinceMoveMs < IDLE_MS;
}

/** A frame count as timecode at 24 fps, for the file source's transport. */
export function frameTimecode(frame: number): string {
  const total = Math.max(0, Math.floor(frame)), f = total % 24, s = Math.floor(total / 24);
  return [Math.floor(s / 3600) + 1, Math.floor(s / 60) % 60, s % 60, f].map((part) => String(part).padStart(2, "0")).join(":");
}
