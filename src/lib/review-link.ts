/**
 * The `saucebunny://` review link, and the message a host actually pastes.
 *
 * One place, because three things have to agree about the shape: the Rust
 * parser in `commands/review_link.rs`, this builder, and the copy that goes on
 * a clipboard. Two of them being literals in different languages is how a
 * scheme quietly diverges.
 */

/** Where a recipient without the app is sent. */
export const DOWNLOAD_URL = "https://github.com/gchiaramonte3/SauceBunny/releases/latest";

/**
 * `saucebunny://review/<code>`.
 *
 * The code and NOTHING else. It is tempting to add `?from=Ana&t=Cut%2003` so
 * the recipient sees who sent it and what it is, and that would put a person's
 * name and, very often, a client's name into a string that travels through
 * Slack, clipboard managers, MDM logging and crash reports. The host can say
 * who they are in the message they are already writing.
 */
export function reviewLink(code: string, grantSecret?: string | null): string {
  const base = `saucebunny://review/${encodeURIComponent(code.trim())}`;
  const g = grantSecret?.trim();
  // In the PATH, not a fragment or a query. A fragment buys nothing here -
  // LaunchServices is not HTTP, so there is no Referer to leak to and the
  // whole string is logged either way - and a query string is an open
  // invitation to add the sender name and cut title that must never be in a
  // link.
  return g ? `${base}/${encodeURIComponent(g)}` : base;
}

/** Split a link back into its parts. The inverse of reviewLink, and the
 *  frontend half of Rust's parse_review_url. */
export function splitReviewCode(delivered: string): { code: string; grant: string | null } {
  const [code, grant] = delivered.split("/");
  return { code: (code ?? "").trim(), grant: grant?.trim() || null };
}

/**
 * What goes on the clipboard: the link, then where to get the app.
 *
 * Two lines because of how the link FAILS. A `saucebunny://` URL on a Mac
 * without Sauce Bunny does nothing at all - no error, no App Store prompt,
 * nothing - and that is the majority case for a first-time reviewer. A bare
 * link would read to them as "he sent me a broken link". The second line costs
 * one line of a message and removes the whole failure.
 */
export function reviewInviteMessage(code: string, grantSecret?: string | null): string {
  return `${reviewLink(code, grantSecret)}\n\nNo Sauce Bunny yet? ${DOWNLOAD_URL}`;
}
