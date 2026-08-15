import type { CaptionFontKey } from "../components/SettingsModal";

/**
 * Bring a stored `captionFont` preference forward to a current key.
 *
 * Old builds stored "sans" / "serif" / "mono"; current ones store named system
 * fonts. A pref that predates the change still means something, so it is
 * translated rather than discarded, and anything unrecognised falls back to
 * "verdana" (the legibility default) rather than leaving the caption unstyled.
 *
 * The input is whatever is in localStorage, which is to say `unknown`: a value
 * a user or a half-finished migration wrote by hand is as real as one the app
 * wrote, and this function is the only thing standing between it and the
 * caption renderer.
 *
 * LOOKUP IS A MAP, NOT AN OBJECT, and that is the whole reason this lives in
 * its own file with tests. The original spelled the legacy table as an object
 * literal and tested membership with `raw in legacy` — and `in` walks the
 * prototype chain, so "toString", "constructor", "valueOf" and every other
 * Object.prototype member reported as present and returned the inherited
 * FUNCTION. From a function annotated `: CaptionFontKey`. TypeScript cannot
 * catch it, because indexing a `Record<string, CaptionFontKey>` is assumed to
 * produce a CaptionFontKey. A Map has no prototype chain to walk.
 */

/** Every key a current build may store. */
export const CAPTION_FONT_KEYS: readonly CaptionFontKey[] = [
  "verdana", "helvetica", "arial", "tahoma", "trebuchet", "georgia", "courier", "nunito",
];

/** Pre-rename prefs, mapped to their nearest current equivalent. */
const LEGACY: ReadonlyMap<string, CaptionFontKey> = new Map([
  ["sans", "nunito"],
  ["serif", "georgia"],
  ["mono", "courier"],
] as const);

/** The default when a pref is missing, unrecognised, or not a string. */
export const CAPTION_FONT_FALLBACK: CaptionFontKey = "verdana";

export function migrateCaptionFont(raw: unknown): CaptionFontKey {
  if (typeof raw !== "string") return CAPTION_FONT_FALLBACK;
  const mapped = LEGACY.get(raw);
  if (mapped) return mapped;
  return (CAPTION_FONT_KEYS as readonly string[]).includes(raw)
    ? (raw as CaptionFontKey)
    : CAPTION_FONT_FALLBACK;
}
