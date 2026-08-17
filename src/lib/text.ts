/**
 * Decode HTML entities (`&#39;` → `'`, `&amp;` → `&`, `&quot;` → `"`, etc.)
 * in a string. Used for source titles returned by yt-dlp extractors that
 * scrape page HTML and don't always decode (LinkedIn is the worst
 * offender — every apostrophe comes back as `&#39;`). Uses the browser's
 * built-in parser so we don't have to maintain an entity table.
 *
 * Falsy input (including `null`, `undefined` and `""`) returns `""`. Non-string
 * input is NOT coerced — it throws on `.includes`. The doc used to claim
 * coercion, which was never true; the signature is the guarantee, and every
 * caller passes a `Metadata.title`, which ts-rs types as `string`. Adding a
 * `String(s)` would be defensive code for an input the types forbid.
 *
 * The decode is the HTML parser's, so its sharp edges are the parser's:
 * semicolon-less legacy entities decode mid-word (`&notareal;` → `¬areal;`),
 * and it decodes exactly one level (`&amp;amp;` → `&amp;`). Both are pinned in
 * text.test.ts, along with the `</textarea>` case that looks like truncation
 * and is not.
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
