import { describe, expect, it } from "vitest";
import { base64UrlEncode, buildProxyUrl } from "./stream-proxy";

/**
 * A cross-language wire format, and the two guards that keep the loopback
 * proxy from being pointed somewhere it should not go.
 *
 * The encoding is not a detail: Rust decodes these paths with
 * `URL_SAFE_NO_PAD` (stream_proxy.rs `decode_after` / `parse_audio_query`),
 * and a mismatch fails as a 404 on a URL that looks perfectly reasonable in
 * the log. Standard base64 would emit `+`, `/` and `=` — the first two change
 * meaning inside a URL path and the third is rejected outright by a NO_PAD
 * decoder. So the substitutions are the contract, not a style choice.
 *
 * The UTF-8 step matters for the same reason and is easier to lose: `btoa`
 * throws on any code point above 255, so encoding a resolved CDN URL carrying
 * a non-ASCII query parameter would raise instead of returning a path. The
 * TextEncoder dance is what makes that work, and Rust's `String::from_utf8`
 * on the other side is what requires it to be UTF-8 specifically.
 */

/** Decode with the same rules Rust uses, so a round-trip means what it says. */
function decodeUrlSafeNoPad(b64: string): string {
  const padded = b64.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

describe("base64UrlEncode mirrors Rust's URL_SAFE_NO_PAD", () => {
  it("emits no character that changes meaning in a URL path", () => {
    // `+` and `/` are the two standard-base64 characters that do, and `=` is
    // what a NO_PAD decoder refuses.
    const noisy = "https://r5---sn-abc.googlevideo.com/videoplayback?a=1&b=2%3F%2F+x";
    const out = base64UrlEncode(noisy);
    expect(out).not.toMatch(/[+/=]/);
    expect(out).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("round-trips through the decoder Rust uses", () => {
    for (const url of [
      "https://example.com/a",
      "https://r5---sn-4g5e6nez.googlevideo.com/videoplayback?expire=1&ip=2&sig=AAA/BBB+CCC",
      "http://127.0.0.1:9/x?y=z&w=1",
    ]) {
      expect(decodeUrlSafeNoPad(base64UrlEncode(url))).toBe(url);
    }
  });

  it("survives a non-ASCII URL, which bare btoa cannot", () => {
    // btoa throws InvalidCharacterError above U+00FF; the TextEncoder step is
    // what keeps a unicode query parameter from crashing the player.
    const unicode = "https://example.com/watch?title=Café_日本語_🎬";
    expect(() => base64UrlEncode(unicode)).not.toThrow();
    expect(decodeUrlSafeNoPad(base64UrlEncode(unicode))).toBe(unicode);
  });

  it("encodes empty input as empty, which the Rust side rejects", () => {
    // Rust's decode_after returns None for an empty b64 rather than decoding
    // to an empty URL, so this pairing is what makes a malformed path 404.
    expect(base64UrlEncode("")).toBe("");
  });
});

describe("buildProxyUrl", () => {
  const BASE = "http://127.0.0.1:52431";

  it("wraps an http(s) upstream in the /v1/ route", () => {
    const out = buildProxyUrl(BASE, "https://cdn.example/v.mp4");
    expect(out.startsWith(`${BASE}/v1/`)).toBe(true);
    expect(decodeUrlSafeNoPad(out.slice(`${BASE}/v1/`.length))).toBe("https://cdn.example/v.mp4");
  });

  it("passes the upstream through untouched when there is no proxy yet", () => {
    // The base arrives from a runtime command; before it resolves the caller
    // decides whether to fall back to a download, so this must not invent a
    // URL against a port that is not listening.
    for (const base of [null, undefined, ""]) {
      expect(buildProxyUrl(base, "https://cdn.example/v.mp4")).toBe("https://cdn.example/v.mp4");
    }
  });

  it("refuses to proxy anything that is not http(s)", () => {
    // The guard that matters. The loopback server fetches whatever it decodes,
    // so handing it a file:// or asset:// path would turn a media proxy into a
    // local-file reader for any process that can reach the port.
    for (const bad of [
      "file:///etc/passwd",
      "asset://localhost/Users/me/x.mov",
      "/Users/me/Movies/a.mov",
      "blob:http://localhost/abc",
      "javascript:alert(1)",
    ]) {
      expect(buildProxyUrl(BASE, bad)).toBe(bad);
    }
  });

  it("accepts either scheme case, since yt-dlp does not normalise", () => {
    expect(buildProxyUrl(BASE, "HTTPS://cdn.example/v.mp4")).toContain("/v1/");
  });
});
