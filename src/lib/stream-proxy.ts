/**
 * Frontend wrapper for the localhost media proxy (r58).
 *
 * WKWebView's `<video>` element cannot play YouTube's googlevideo URLs
 * directly (the media engine's headers get gated by the CDN) and r57
 * proved it won't even request a custom URI scheme (`sbstream://`) for a
 * media element. The one thing it WILL stream is a real `http://127.0.0.1`
 * URL, so the Rust side (src-tauri/src/stream_proxy.rs) runs a tiny
 * loopback HTTP server that proxies the upstream CDN URL with full header
 * control + forwarded Range requests.
 *
 * Base URL comes from the `get_stream_proxy_base` command at runtime
 * (random port chosen at startup). Wire format:
 *
 *   http://127.0.0.1:<port>/v1/<urlsafe-base64-of-upstream-url>
 */

/** URL-safe base64, no padding. Mirrors Rust's URL_SAFE_NO_PAD engine. */
function base64UrlEncode(input: string): string {
  const utf8 = new TextEncoder().encode(input);
  let bin = "";
  for (let i = 0; i < utf8.length; i++) bin += String.fromCharCode(utf8[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Build a loopback-proxy `<video src>` for an upstream http(s) URL.
 *
 * @param base   the proxy base from `get_stream_proxy_base`, e.g.
 *               `http://127.0.0.1:52431`. If null/empty, returns the
 *               upstream URL unchanged (caller decides whether to fall
 *               back to the download path).
 * @param upstreamUrl the yt-dlp-resolved CDN URL.
 */
export function buildProxyUrl(base: string | null | undefined, upstreamUrl: string): string {
  if (!base) return upstreamUrl;
  if (!/^https?:\/\//i.test(upstreamUrl)) return upstreamUrl;
  return `${base}/v1/${base64UrlEncode(upstreamUrl)}`;
}
