/**
 * Persistent playback-speed math — the pure rate list + stepping, no DOM.
 *
 * The transport speed picker, the [ / ] / \ shortcuts, and the ⌘K commands
 * all share this list. Distinct from lib/shuttle.ts: the shuttle is a
 * transient J-K-L override, while this is the user's chosen "watch speed" —
 * persisted in localStorage (`saucebunny.playbackRate`) and re-applied by the
 * players whenever a shuttle settles back to normal play.
 */

export const PLAYBACK_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

export const DEFAULT_PLAYBACK_RATE = 1;

/**
 * Nearest list rate to `r`. Anything unusable — NaN, ≤0, or junk from a
 * corrupt persisted blob — falls back to 1×, so a bad `saucebunny.playbackRate`
 * value can never wedge playback at a garbage speed. Ties break toward 1×.
 */
export function sanitizePlaybackRate(r: unknown): number {
  if (typeof r !== "number" || !isFinite(r) || r <= 0) return DEFAULT_PLAYBACK_RATE;
  let best: number = PLAYBACK_RATES[0];
  let bestDist = Infinity;
  for (const rate of PLAYBACK_RATES) {
    const d = Math.abs(rate - r);
    if (d < bestDist || (d === bestDist && rate === DEFAULT_PLAYBACK_RATE)) {
      best = rate;
      bestDist = d;
    }
  }
  return best;
}

/**
 * One step up (+1) / down (-1) the rate list from `current` (snapped to the
 * list first, so a garbage rate can't escape it). Pinned at 0.5× and 2×.
 */
export function stepPlaybackRate(current: number, direction: 1 | -1): number {
  const rates = PLAYBACK_RATES as readonly number[];
  const idx = rates.indexOf(sanitizePlaybackRate(current));
  return rates[Math.max(0, Math.min(rates.length - 1, idx + direction))];
}

/** Compact badge display: "1×", "0.75×", "1.5×". */
export function formatPlaybackRate(r: number): string {
  return `${r}×`;
}
