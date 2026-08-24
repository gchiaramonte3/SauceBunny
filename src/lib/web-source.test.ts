import { describe, expect, it } from "vitest";
import {
  filterCachedWeb, groupBySite, hostOf, siteKey, siteName, sortCachedWeb,
  type CachedWebItem,
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

describe("sortCachedWeb", () => {
  const item = (over: Partial<CachedWebItem>): CachedWebItem => ({
    url: "https://youtube.com/watch?v=x", title: null, thumbnail: null,
    uploader: null, duration_seconds: null, fetched_at: 0, path: null,
    size_bytes: null, ...over,
  });

  it("sorts names numerically and case-insensitively, like the folder pane", () => {
    const out = sortCachedWeb([
      item({ url: "u1", title: "clip10" }),
      item({ url: "u2", title: "Clip2" }),
      item({ url: "u3", title: "alpha" }),
    ], "name", "asc");
    expect(out.map((i) => i.title)).toEqual(["alpha", "Clip2", "clip10"]);
  });

  it("an untitled entry sorts by its URL", () => {
    const out = sortCachedWeb([
      item({ url: "https://z.example/v", title: null }),
      item({ url: "u", title: "alpha" }),
    ], "name", "asc");
    expect(out[0].title).toBe("alpha");
  });

  it("keeps the name tiebreak ascending under date desc — Finder's rule", () => {
    const out = sortCachedWeb([
      item({ url: "u1", title: "zeta", fetched_at: 100 }),
      item({ url: "u2", title: "alpha", fetched_at: 100 }),
      item({ url: "u3", title: "mid", fetched_at: 200 }),
    ], "date", "desc");
    expect(out.map((i) => i.title)).toEqual(["mid", "alpha", "zeta"]);
  });

  it("treats a metadata-only entry as size 0, so largest-first shows real disk use", () => {
    const out = sortCachedWeb([
      item({ url: "u1", title: "no copy", size_bytes: null }),
      item({ url: "u2", title: "big", size_bytes: 5000 }),
    ], "size", "desc");
    expect(out[0].title).toBe("big");
  });

  it("does not mutate its input", () => {
    const input = [item({ url: "u1", title: "b" }), item({ url: "u2", title: "a" })];
    const before = [...input];
    sortCachedWeb(input, "name", "asc");
    expect(input).toEqual(before);
  });
});

describe("filterCachedWeb", () => {
  const item = (over: Partial<CachedWebItem>): CachedWebItem => ({
    url: "https://youtube.com/watch?v=x", title: null, thumbnail: null,
    uploader: null, duration_seconds: null, fetched_at: 0, path: null,
    size_bytes: null, ...over,
  });

  it("matches title, uploader, and the URL itself", () => {
    const items = [
      item({ url: "u1", title: "Grading masterclass" }),
      item({ url: "u2", uploader: "Novella Films" }),
      item({ url: "https://vimeo.com/secret-cut" }),
    ];
    expect(filterCachedWeb(items, "grading")).toHaveLength(1);
    expect(filterCachedWeb(items, "novella")).toHaveLength(1);
    expect(filterCachedWeb(items, "secret-cut")).toHaveLength(1);
  });

  it("an empty or whitespace needle means no filter", () => {
    const items = [item({ url: "u1" }), item({ url: "u2" })];
    expect(filterCachedWeb(items, "")).toHaveLength(2);
    expect(filterCachedWeb(items, "   ")).toHaveLength(2);
  });

  it("returns a copy even when not filtering", () => {
    const items = [item({ url: "u1" })];
    expect(filterCachedWeb(items, "")).not.toBe(items);
  });
});
