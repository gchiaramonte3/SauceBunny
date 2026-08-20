/**
 * Pick the playable media URL out of everything a page fetched.
 *
 * WHY THIS EXISTS. yt-dlp's generic extractor reads the HTML a server returns
 * and scans it for media. A modern site returns an empty shell and fetches its
 * video from JavaScript, so there is nothing in that HTML to find and yt-dlp
 * correctly reports "Unsupported URL". Measured on a real page: zero media URLs
 * in 306KB of served HTML, and four the moment a browser actually ran it.
 *
 * The fix is to let a webview render the page and then look at what it
 * REQUESTED — `performance.getEntriesByType("resource")` lists every fetch the
 * document made, including the video. Notably the page had no <video> element
 * at all when sampled, so reading the DOM would have found nothing: the network
 * timing list is the reliable source, not the markup.
 *
 * What is left is choosing between the URLs, and that choice matters more than
 * it looks — see `rankMediaUrl`.
 */

/** Extensions worth handing to yt-dlp, in no particular order. */
const MEDIA_RE = /\.(m3u8|mpd|mp4|webm|mov|m4v)(\?|#|$)/i;
/** A single HLS/DASH segment. Never the thing to download. */
const SEGMENT_RE = /\.(ts|m4s|aac)(\?|#|$)|\/seg(ment)?[-_]?\d+/i;

/**
 * How good a candidate is. Higher wins.
 *
 * The ranking is the whole point, and it came from real data. One page yielded:
 *
 *   stream.mux.com/<id>.m3u8                    ← canonical, stable
 *   manifest-…fastly.mux.com/…/rendition.m3u8?expires=…&signature=…
 *   chunk-…fastly.mux.com/…/0.ts?signature=…
 *
 * All three play right now. Only the first is worth KEEPING: the other two
 * carry an expiry and a signature, so a URL saved into a review doc or a queue
 * entry is dead within hours and comes back as a 403 nobody can explain. A
 * segment is worse still — download it and you get two seconds of video and no
 * error, which is the silent-wrong-result failure this codebase keeps finding.
 */
export function rankMediaUrl(url: string): number {
  if (!MEDIA_RE.test(url)) return -1;
  if (SEGMENT_RE.test(url)) return -1;          // a chunk is not a video
  let score = 0;
  // A manifest describes every rendition; an mp4 is one fixed quality.
  if (/\.(m3u8|mpd)(\?|#|$)/i.test(url)) score += 40;
  // Unsigned beats signed: a signed URL is a lease, and we persist what we
  // resolve.
  if (!/[?&](signature|expires|token|Policy|Key-Pair-Id)=/i.test(url)) score += 30;
  // A master manifest lists the ladder; a rendition is one rung of it.
  if (/rendition|chunklist|media[-_]?\d+\.m3u8/i.test(url)) score -= 15;
  // Shorter paths are the canonical form far more often than not.
  score += Math.max(0, 20 - Math.floor(url.length / 40));
  return score;
}

/**
 * Best playable URL from a set of observed requests, or null.
 *
 * Deterministic on ties (lexical), so resolving the same page twice does not
 * hand back two different URLs and produce two cache entries for one video.
 */
export function pickMediaUrl(urls: readonly string[]): string | null {
  const scored = urls
    .map((u) => ({ u, s: rankMediaUrl(u) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || (a.u < b.u ? -1 : a.u > b.u ? 1 : 0));
  return scored.length ? scored[0].u : null;
}

/** Every distinct media URL seen, best first — for a "which one?" picker when
 *  a page carries several videos. */
export function rankMediaUrls(urls: readonly string[]): string[] {
  const seen = [...new Set(urls)];
  return seen
    .map((u) => ({ u, s: rankMediaUrl(u) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || (a.u < b.u ? -1 : a.u > b.u ? 1 : 0))
    .map((x) => x.u);
}

/**
 * The script a resolving webview runs.
 *
 * Kept as a string constant so the browser-side contract is testable from node
 * and reviewable in one place. It reads the resource timing list rather than
 * the DOM because the DOM may legitimately have no <video> yet — measured on
 * the page that prompted this.
 */
export const SNIFF_SCRIPT = `(() => {
  try {
    var res = performance.getEntriesByType('resource').map(function (e) { return e.name; });
    var vids = [];
    document.querySelectorAll('video').forEach(function (v) {
      if (v.currentSrc) vids.push(v.currentSrc);
      if (v.src) vids.push(v.src);
      v.querySelectorAll('source').forEach(function (s) { if (s.src) vids.push(s.src); });
    });
    return JSON.stringify({ urls: res.concat(vids), title: document.title || null });
  } catch (e) { return JSON.stringify({ urls: [], title: null }); }
})()`;

/**
 * True when yt-dlp failed because the page had no media IN ITS HTML — the
 * failure a browser can actually fix.
 *
 * Deliberately narrow. This is the trigger for opening a webview on a page the
 * user pasted, so it must not fire on a sign-in wall, a private video, a stale
 * extractor or a network blip: none of those are helped by rendering the page,
 * and all of them already have their own surface. "Unsupported URL" and "no
 * video could be found" are yt-dlp saying it looked and there was nothing
 * there, which is exactly the JS-rendered case.
 */
export function looksUnextractable(errText: string): boolean {
  if (!errText) return false;
  const m = errText.toLowerCase();
  // Those other paths own their errors; never steal one.
  if (m.includes("sign in") || m.includes("cookies") || m.includes("private")) return false;
  if (m.includes("http error 403") || m.includes("unable to download video data")) return false;
  return (
    m.includes("unsupported url") ||
    m.includes("no video could be found") ||
    m.includes("no media found")
  );
}
