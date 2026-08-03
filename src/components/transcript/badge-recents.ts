/**
 * The badge icons this user actually reaches for.
 *
 * WHY NOT A FIXED SHORTLIST. The icon row in the rename popover has room for
 * about four entries beyond the four non-speech kinds, and there is no honest
 * way to guess which four matter: a documentary cut wants Host, Phone and
 * Narrator; a scripted read wants Actor, Take and Careful. Picking for the user
 * means most people see four slots of decoration they never press, which is how
 * the row ended up looking like filler in the first place. Recents make the row
 * converge on whatever this person keeps using, and the sheet behind the plus
 * stays the full vocabulary.
 *
 * THE FOUR KINDS ARE DELIBERATELY EXCLUDED. They are permanent members of the
 * row, so letting them into recents would push a genuinely-used icon out every
 * time somebody tagged a music bed, and the row would reshuffle for no visible
 * reason.
 */

const KEY = "saucebunny.badgeIconRecents";
const MAX = 4;

/** Already permanent in the row; see above. */
const PINNED = new Set(["music", "lyric", "sfx", "inaudible"]);

/**
 * What the row shows before this user has picked anything.
 *
 * A plausible first four rather than an empty gap: Host and Phone are the two
 * roles a diarized interview reliably contains, Starred is the mark people
 * reach for first, and Group covers the panel case.
 */
export const DEFAULT_BADGE_RECENTS: readonly string[] = ["mic", "phone", "star", "people"];

export function readBadgeRecents(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [...DEFAULT_BADGE_RECENTS];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...DEFAULT_BADGE_RECENTS];
    const ids = parsed.filter((x): x is string => typeof x === "string" && !PINNED.has(x));
    // A short list is padded from the defaults rather than left ragged, so the
    // row is the same width on the first pick as on the fiftieth.
    const out = ids.slice(0, MAX);
    for (const d of DEFAULT_BADGE_RECENTS) {
      if (out.length >= MAX) break;
      if (!out.includes(d)) out.push(d);
    }
    return out;
  } catch {
    // A quota error or a hand-mangled value costs the default row, not a crash.
    return [...DEFAULT_BADGE_RECENTS];
  }
}

/** Record a pick. Returns the new row so the caller can render it at once. */
export function noteBadgeIconUsed(id: string): string[] {
  const next = readBadgeRecents();
  if (PINNED.has(id)) return next;
  const out = [id, ...next.filter((x) => x !== id)].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(out));
  } catch {
    // Persisting is a convenience; failing to must not lose the pick itself.
  }
  return out;
}
