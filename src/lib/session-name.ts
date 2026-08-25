/**
 * Every screening gets its own name.
 *
 * The lobby restores the last session's title (`saucebunny.sessionTitle`) and
 * nothing stopped you pressing Start on it again, so a week of reviews came
 * back as five rows all called "Test Session 4" - a history you cannot read,
 * because the one field that distinguishes a session was the same in all of
 * them. The record on disk is fine; it is the NAME that collides, and the
 * name is the only thing shown.
 *
 * Pure, and here rather than in the lobby, because "is this taken" and "what
 * is the next free one" are rules worth pinning: the numbering has to survive
 * a name that already ends in a number, one that ends in something that only
 * looks like a number, and a list that is not in order.
 */

/** Compare the way a person would: case and surrounding space do not make
 *  two sessions different things. */
export function normalizeSessionName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

export function isSessionNameTaken(name: string, taken: readonly string[]): boolean {
  const n = normalizeSessionName(name);
  if (!n) return false; // An empty name is not a COLLISION; it is just empty.
  return taken.some((t) => normalizeSessionName(t) === n);
}

/**
 * `base` if it is free, otherwise the same name with the next unused number.
 *
 * A trailing number is CONTINUED rather than appended to, so "Test Session 4"
 * suggests "Test Session 5" and not "Test Session 4 2" - the second reads as
 * a mistake and is what makes people give up and reuse the old name.
 */
export function nextFreeSessionName(base: string, taken: readonly string[]): string {
  const trimmed = base.trim().replace(/\s+/g, " ");
  if (!trimmed) return trimmed;
  if (!isSessionNameTaken(trimmed, taken)) return trimmed;

  // Split a trailing integer off the stem. `\s+` so "Review 2" and "Review2"
  // both continue their own numbering rather than one inventing a space.
  const m = /^(.*?)(\s*)(\d+)$/.exec(trimmed);
  const stem = m ? m[1] : trimmed;
  // `m[2]` verbatim, NOT `m[2] || " "`: an empty gap is a real answer here
  // ("Review2"), and the falsy-default turned it into "Review 3".
  const gap = m ? m[2] : " ";
  let n = m ? Number(m[3]) + 1 : 2;
  // Bounded: a list this long is pathological, and an unbounded loop here
  // would hang the lobby rather than fail it.
  for (let guard = 0; guard < 10_000; guard++, n++) {
    const candidate = `${stem}${gap}${n}`;
    if (!isSessionNameTaken(candidate, taken)) return candidate;
  }
  return trimmed;
}
