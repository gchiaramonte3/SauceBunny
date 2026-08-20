import { describe, expect, it } from "vitest";
import {
  looksUnextractable, pickMediaUrl, rankMediaUrl, rankMediaUrls, SNIFF_SCRIPT,
} from "./media-sniff";

/**
 * Fixtures are the REAL requests a real page made.
 *
 * Captured from runway.com's contest page in a live browser — the one that made
 * yt-dlp say "Unsupported URL" because its served HTML contains no media at
 * all. These are the four media URLs that appeared once JavaScript ran, and the
 * ranking exists because three of them are traps.
 */
const CANONICAL = "https://stream.mux.com/todqVbVRatvWi34s5qYP8m3vY585c00kMUc02fjRefcT00.m3u8";
const SIGNED_RENDITION =
  "https://manifest-oci-us-ashburn-1-vop1.fastly.mux.com/pKLUc001SWqKkg2lwmrkV0000O0100HHv14HZiTXCBqPD6UVs01wzhLwdMZBZiyF502t02D3lRZ6NrHP02y0101a3Sq4dj4o4dxbJL6kIRNhoL9mUPJ4rU/rendition.m3u8?cdn=fastly&expires=1787846400&skid=default&signature=NmE5MDYxOWFf";
const SIGNED_CHUNK =
  "https://chunk-oci-us-ashburn-1-vop1.fastly.mux.com/v1/chunk/Oq13iMIXt5zbZ02aTOn902YIlgyPfqubZTueQWMHDmd7GixUqBdpZ8H5RzUoOEfVOrkcmc3MPkV202liKdfsL3hLCFsl8Khqj01WD6Qt5028tdBg/0.ts?skid=default&signature=NmE5MDVmMDBf";
const DECOR_MP4 = "https://runway-static-assets.s3.amazonaws.com/site/videos/404_003.mp4";

const REAL_PAGE = [
  "https://runway.com/_next/static/chunks/main.js",
  "https://fonts.gstatic.com/s/x.woff2",
  SIGNED_CHUNK,
  SIGNED_RENDITION,
  CANONICAL,
  DECOR_MP4,
];

describe("picking media out of what a page fetched", () => {
  it("finds the canonical manifest in a real page's requests", () => {
    expect(pickMediaUrl(REAL_PAGE)).toBe(CANONICAL);
  });

  it("prefers the unsigned URL over the signed one that plays just as well", () => {
    // Both work RIGHT NOW. Only one still works tomorrow: the signed pair carry
    // expires+signature, and we persist what we resolve into review docs and
    // queue entries, where it would come back a 403 nobody can explain.
    expect(rankMediaUrl(CANONICAL)).toBeGreaterThan(rankMediaUrl(SIGNED_RENDITION));
  });

  it("never picks a segment", () => {
    // A .ts chunk downloads happily and yields two seconds of video with no
    // error — the silent wrong result, not a failure.
    expect(rankMediaUrl(SIGNED_CHUNK)).toBe(-1);
    expect(pickMediaUrl([SIGNED_CHUNK])).toBeNull();
    for (const seg of ["https://x/0.ts", "https://x/seg-12.m4s", "https://x/segment_3.aac"]) {
      expect(rankMediaUrl(seg), seg).toBe(-1);
    }
  });

  it("prefers a manifest over a single-quality mp4", () => {
    // The manifest carries the whole ladder; the mp4 is one rung, and on this
    // page the only mp4 was site decoration.
    expect(rankMediaUrl(CANONICAL)).toBeGreaterThan(rankMediaUrl(DECOR_MP4));
    expect(pickMediaUrl([DECOR_MP4, CANONICAL])).toBe(CANONICAL);
  });

  it("prefers a master manifest over one rendition of it", () => {
    const master = "https://cdn.example.com/v/abc.m3u8";
    const rung = "https://cdn.example.com/v/abc/rendition.m3u8";
    expect(rankMediaUrl(master)).toBeGreaterThan(rankMediaUrl(rung));
  });

  it("ignores everything that is not media", () => {
    expect(pickMediaUrl(["https://x/main.js", "https://x/a.woff2", "https://x/p.png"])).toBeNull();
    expect(pickMediaUrl([])).toBeNull();
  });

  it("is deterministic on ties, so one page does not resolve two ways", () => {
    // Two identical-scoring URLs must not produce two cache entries for one
    // video depending on request order.
    const a = "https://a.example.com/v.m3u8";
    const b = "https://b.example.com/v.m3u8";
    expect(pickMediaUrl([a, b])).toBe(pickMediaUrl([b, a]));
  });

  it("ranks the whole set for a page carrying several videos", () => {
    const ranked = rankMediaUrls(REAL_PAGE);
    expect(ranked[0]).toBe(CANONICAL);
    expect(ranked).not.toContain(SIGNED_CHUNK);
    expect(new Set(ranked).size).toBe(ranked.length); // deduped
  });

  it("treats query strings and fragments as not part of the extension", () => {
    expect(rankMediaUrl("https://x/v.m3u8?token=1")).toBeGreaterThanOrEqual(0);
    expect(rankMediaUrl("https://x/v.mp4#t=10")).toBeGreaterThanOrEqual(0);
    expect(rankMediaUrl("https://x/mp4-explainer.html")).toBe(-1);
  });
});

describe("the sniffing script", () => {
  it("reads the resource list, not just the DOM", () => {
    // The page that prompted this had NO <video> element when sampled, so a
    // DOM-only sniff would have found nothing at all.
    expect(SNIFF_SCRIPT).toContain("getEntriesByType('resource')");
  });

  it("still checks video elements, for pages that do have them", () => {
    expect(SNIFF_SCRIPT).toContain("querySelectorAll('video')");
    expect(SNIFF_SCRIPT).toContain("currentSrc");
  });

  it("cannot throw into the host, whatever the page does", () => {
    // It runs inside somebody else's page; an exception escaping would take
    // the resolve with it and report nothing.
    expect(SNIFF_SCRIPT).toContain("try");
    expect(SNIFF_SCRIPT).toContain("catch");
  });

  it("is valid JavaScript that returns the expected shape", () => {
    // Evaluated here rather than trusted: the script is a string, so a typo in
    // it is invisible to tsc and would only fail inside a webview.
    const fakeDoc = { querySelectorAll: () => [], title: "T" };
    const fn = new Function("performance", "document", `return ${SNIFF_SCRIPT}`);
    const out = JSON.parse(fn({ getEntriesByType: () => [{ name: "https://x/v.m3u8" }] }, fakeDoc));
    expect(out.urls).toContain("https://x/v.m3u8");
    expect(out.title).toBe("T");
  });
});

describe("deciding when a browser can help", () => {
  it("fires on yt-dlp saying it looked and found nothing", () => {
    // The real message from the page that prompted this.
    expect(looksUnextractable("ERROR: Unsupported URL: https://runway.com/x")).toBe(true);
    expect(looksUnextractable("ERROR: No video could be found in this webpage")).toBe(true);
  });

  it("does NOT steal an error another path already owns", () => {
    // Rendering the page fixes none of these, and each has its own surface:
    // the sign-in prompt, the cookie hint, the update-yt-dlp offer.
    for (const other of [
      "Sign in to confirm you're not a bot",
      "Use --cookies-from-browser",
      "Private video. Sign in if you've been granted access",
      "unable to download video data: HTTP Error 403: Forbidden",
    ]) {
      expect(looksUnextractable(other), other).toBe(false);
    }
  });

  it("ignores empty and unrelated failures", () => {
    for (const s of ["", "Network is unreachable", "ffmpeg not found"]) {
      expect(looksUnextractable(s), s).toBe(false);
    }
  });
});
