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
export function reviewLink(code: string): string {
  return `saucebunny://review/${encodeURIComponent(code.trim())}`;
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
export function reviewInviteMessage(code: string): string {
  return `${reviewLink(code)}\n\nNo Sauce Bunny yet? ${DOWNLOAD_URL}`;
}
