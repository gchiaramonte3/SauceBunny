/**
 * Decode HTML entities (`&#39;` → `'`, `&amp;` → `&`, `&quot;` → `"`, etc.)
 * in a string. Used for source titles returned by yt-dlp extractors that
 * scrape page HTML and don't always decode (LinkedIn is the worst
 * offender — every apostrophe comes back as `&#39;`). Uses the browser's
 * built-in parser so we don't have to maintain an entity table.
 *
 * Falsy input returns empty string. Non-string input is coerced.
 */
export function decodeHtmlEntities(s: string | null | undefined): string {
  if (!s) return "";
  // Cheap fast path — most strings have no entities at all.
  if (!s.includes("&")) return s;
  // textarea round-trip is the canonical safe decode: any tags in the
  // source are treated as literal text (we never touch innerHTML on a
  // live element, only on the detached textarea).
  const ta = document.createElement("textarea");
  ta.innerHTML = s;
  return ta.value;
}
