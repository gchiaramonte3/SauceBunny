import { describe, expect, it } from "vitest";
import {
  groupBySite, hostOf, siteKey, siteName, type CachedWebItem,
} from "./web-source";

const item = (url: string, fetched_at = 0): CachedWebItem => ({
  url, title: null, thumbnail: null, uploader: null,
  duration_seconds: null, fetched_at, path: null, size_bytes: null,
});

describe("hostOf", () => {
  it("strips the noise a user never thinks of as part of the site", () => {
    expect(hostOf("https://www.youtube.com/watch?v=abc")).toBe("youtube.com");
    expect(hostOf("https://m.youtube.com/watch?v=abc")).toBe("youtube.com");
    expect(hostOf("https://YouTube.COM/watch?v=abc")).toBe("youtube.com");
  });

  it("returns empty for something that is not a URL, rather than throwing", () => {
    expect(hostOf("not a url")).toBe("");
    expect(hostOf("")).toBe("");
  });
});

describe("siteName", () => {
  it("names the hosts that actually appear in a real cache", () => {
    // Measured from this machine's cache: 14 YouTube, 2 Reddit, 1 LinkedIn.
    expect(siteName("https://www.youtube.com/watch?v=ZHLhms7ceMs")).toBe("YouTube");
    expect(siteName("https://youtube.com/watch?v=x")).toBe("YouTube");
    expect(siteName("https://www.reddit.com/r/videos/comments/x/")).toBe("Reddit");
    expect(siteName("https://lnkd.in/abc123")).toBe("LinkedIn");
  });

  it("folds a shortener into the site it belongs to", () => {
    // lnkd.in is LinkedIn's own shortener. Left alone it becomes a separate
    // "site" and splits LinkedIn's clips across two shelves.
    expect(siteName("https://lnkd.in/x")).toBe(siteName("https://www.linkedin.com/posts/x"));
    expect(siteName("https://youtu.be/abc")).toBe(siteName("https://youtube.com/watch?v=abc"));
  });

  it("resolves a subdomain to its parent, longest suffix winning", () => {
    expect(siteName("https://music.youtube.com/watch?v=x")).toBe("YouTube");
    expect(siteName("https://v.redd.it/xyz")).toBe("Reddit");
  });

  it("falls back to the DOMAIN, never to a catch-all bucket", () => {
    // A site we have never heard of is still a place the user recognises.
    // "Other" would throw away the only useful thing we know.
    expect(siteName("https://videos.example.org/clip.mp4")).toBe("videos.example.org");
    expect(siteName("https://some-cdn.net/a.mp4")).toBe("some-cdn.net");
  });

  it("puts a malformed entry somewhere rather than losing it", () => {
    expect(siteName("garbage")).toBe("Web");
  });
});

describe("groupBySite", () => {
  it("puts the biggest shelf first", () => {
    const groups = groupBySite([
      item("https://reddit.com/a"),
      item("https://youtube.com/1"),
      item("https://youtube.com/2"),
      item("https://youtube.com/3"),
    ]);
    expect(groups.map((g) => g.site)).toEqual(["YouTube", "Reddit"]);
    expect(groups[0].items).toHaveLength(3);
  });

  it("keeps one site on ONE shelf across its different hosts", () => {
    const groups = groupBySite([
      item("https://www.linkedin.com/posts/a"),
      item("https://lnkd.in/b"),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].site).toBe("LinkedIn");
    expect(groups[0].items).toHaveLength(2);
  });

  it("breaks ties alphabetically, so the order does not reshuffle", () => {
    // Equal counts sorted by insertion order would reorder between launches
    // for no reason the user can see, which reads as a bug.
    const a = groupBySite([item("https://vimeo.com/1"), item("https://reddit.com/1")]);
    const b = groupBySite([item("https://reddit.com/1"), item("https://vimeo.com/1")]);
    expect(a.map((g) => g.site)).toEqual(b.map((g) => g.site));
    expect(a.map((g) => g.site)).toEqual(["Reddit", "Vimeo"]);
  });

  it("preserves the order it was handed, within a shelf", () => {
    // The backend sorts newest-first and this is the only thing carrying that
    // through to the grid. Re-sorting here, or losing the order in the Map,
    // would silently scramble every card on the shelf.
    const groups = groupBySite([
      item("https://youtube.com/c", 300),
      item("https://youtube.com/a", 100),
      item("https://youtube.com/b", 200),
    ]);
    expect(groups[0].items.map((i) => i.fetched_at)).toEqual([300, 100, 200]);
  });

  it("survives an empty shelf", () => {
    expect(groupBySite([])).toEqual([]);
  });
});

describe("siteKey", () => {
  it("is the grouping identity, not the display string", () => {
    expect(siteKey("https://lnkd.in/x")).toBe(siteKey("https://linkedin.com/y"));
    expect(siteKey("https://youtube.com/x")).toBe("youtube");
  });
});
