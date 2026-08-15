import type { CachedWebItem } from "../bindings/CachedWebItem";

/**
 * Which site a cached web video came from.
 *
 * The Library's cached-web shelf is a pile of clips pulled from wherever the
 * user was working, and "wherever" is the only thing that makes the pile
 * navigable: a YouTube lecture, a LinkedIn post and a Reddit clip are
 * different kinds of thing to a person even though they are all mp4s to us.
 *
 * MAPPED BY HOST, NOT BY GUESSING AT THE PATH. Every one of these names comes
 * from a host that actually appears in a real cache — including `lnkd.in`,
 * which is LinkedIn's shortener and would otherwise show up as its own
 * "site" and split LinkedIn's clips across two shelves.
 *
 * An unknown host is NOT an error and must not become "Other": the domain
 * itself is a better label than a bucket, because the user recognises the
 * place they got the file from even when we have never heard of it.
 */

/** Host suffixes → the name a person would use. Longest match wins, so
 *  `music.youtube.com` and `youtube.com` both land on YouTube. */
const SITES: ReadonlyArray<readonly [string, string]> = [
  ["youtube.com", "YouTube"],
  ["youtu.be", "YouTube"],
  ["linkedin.com", "LinkedIn"],
  ["lnkd.in", "LinkedIn"],
  ["reddit.com", "Reddit"],
  ["redd.it", "Reddit"],
  ["vimeo.com", "Vimeo"],
  ["twitter.com", "X"],
  ["x.com", "X"],
  ["tiktok.com", "TikTok"],
  ["instagram.com", "Instagram"],
  ["facebook.com", "Facebook"],
  ["fb.watch", "Facebook"],
  ["twitch.tv", "Twitch"],
  ["dailymotion.com", "Dailymotion"],
  ["loom.com", "Loom"],
  ["frame.io", "Frame.io"],
  ["drive.google.com", "Google Drive"],
  ["dropbox.com", "Dropbox"],
];

/** The bare host, lowercased, with the `www.` / `m.` noise removed. */
export function hostOf(url: string): string {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h.replace(/^(www|m|mobile)\./, "");
  } catch {
    return "";
  }
}

/**
 * A display name for the site a URL came from.
 *
 * Falls back to the host itself rather than to a catch-all, and returns "Web"
 * only when there is no host at all to show — a malformed entry should still
 * land somewhere rather than vanish from the shelf.
 */
export function siteName(url: string): string {
  const host = hostOf(url);
  if (!host) return "Web";
  // Suffix match so a subdomain (music.youtube.com, v.redd.it) resolves to its
  // parent rather than becoming a site of its own.
  let best: string | null = null;
  let bestLen = 0;
  for (const [suffix, name] of SITES) {
    if ((host === suffix || host.endsWith("." + suffix)) && suffix.length > bestLen) {
      best = name;
      bestLen = suffix.length;
    }
  }
  return best ?? host;
}

/** Stable key for grouping — the display name, so two hosts that mean one
 *  site (linkedin.com and lnkd.in) share a shelf. */
export function siteKey(url: string): string {
  return siteName(url).toLowerCase();
}

/**
 * Re-exported from the generated binding rather than restated here. The shape
 * is owned by the Rust struct (ts-rs writes src/bindings/), and a hand-written
 * twin is how the two silently drift apart — the first draft of this file had
 * one, in camelCase against a snake_case wire format, and every field access
 * was wrong.
 */
export type { CachedWebItem };

/**
 * Group cached clips by site, biggest shelf first.
 *
 * Ties break alphabetically so the order is stable between launches — a shelf
 * that reshuffles because two sites have the same count reads as a bug.
 */
export function groupBySite(items: readonly CachedWebItem[]): Array<{ site: string; items: CachedWebItem[] }> {
  const byKey = new Map<string, { site: string; items: CachedWebItem[] }>();
  for (const it of items) {
    const key = siteKey(it.url);
    const bucket = byKey.get(key) ?? { site: siteName(it.url), items: [] };
    bucket.items.push(it);
    byKey.set(key, bucket);
  }
  return [...byKey.values()].sort(
    (a, b) => b.items.length - a.items.length || a.site.localeCompare(b.site),
  );
}
