/**
 * Premiere-style J-K-L shuttle ladder — the pure rate math, no DOM.
 *
 * App.tsx feeds the current signed rate + the pressed direction through
 * `nextShuttleRate` and routes the result to the live player's setShuttle.
 * Keeping this a standalone module means the ladder semantics are unit-tested
 * independently of any player/media plumbing.
 */

export const SHUTTLE_LADDER = [1, 2, 4, 8] as const;

/** Nearest ladder magnitude to |m| (ties break DOWN, e.g. 3 → 2). */
function snapMagnitude(m: number): number {
  let best: number = SHUTTLE_LADDER[0];
  let bestDist = Infinity;
  for (const step of SHUTTLE_LADDER) {
    const d = Math.abs(step - m);
    if (d < bestDist) { best = step; bestDist = d; }
  }
  return best;
}

/** Largest ladder magnitude ≤ cap (a cap below 1 still yields 1 — a shuttle must move). */
function capMagnitude(cap: number): number {
  let best: number = SHUTTLE_LADDER[0];
  for (const step of SHUTTLE_LADDER) {
    if (step <= cap) best = step;
  }
  return best;
}

/**
 * Premiere-style JKL ladder. `rate` is the current signed shuttle rate
 * (0 = stopped/normal-pause; +1 = normal play). `direction`: +1 for L,
 * -1 for J.
 *
 * Rules:
 *   • rate 0 → direction × 1.
 *   • Same sign → double magnitude up the ladder, capped at `cap`.
 *   • Opposite sign with |rate| > 1 → halve magnitude keeping sign (step back down).
 *   • Opposite sign with |rate| === 1 → flip to direction × 1.
 *
 * Non-ladder inputs are snapped to the nearest ladder magnitude first, and the
 * result is always a ladder value ≤ cap — so a garbage rate can never escape
 * the ladder.
 */
export function nextShuttleRate(rate: number, direction: 1 | -1, cap = 8): number {
  const maxMag = capMagnitude(cap);
  if (rate === 0) return direction; // stopped → 1× in the pressed direction
  const sign = rate > 0 ? 1 : -1;
  const ladder = SHUTTLE_LADDER as readonly number[];
  const idx = ladder.indexOf(snapMagnitude(Math.abs(rate)));
  if (sign === direction) {
    // Same direction → next rung up, capped.
    const up = ladder[Math.min(idx + 1, ladder.length - 1)];
    return direction * Math.min(up, maxMag);
  }
  // Opposite direction → step back down toward 0; at 1× flip direction.
  if (idx === 0) return direction;
  return sign * Math.min(ladder[idx - 1], maxMag);
}
