import { describe, it, expect, beforeEach } from "vitest";
import { webPosterFor, setWebPoster } from "./web-poster-store";

function installLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  } as Storage;
  return store;
}

describe("web-poster-store", () => {
  beforeEach(() => { installLocalStorage(); });

  it("stores and reads a poster per url", () => {
    expect(webPosterFor("https://vimeo.com/1")).toBeNull();
    setWebPoster("https://vimeo.com/1", "data:image/jpeg;base64,AAA");
    expect(webPosterFor("https://vimeo.com/1")).toBe("data:image/jpeg;base64,AAA");
    expect(webPosterFor("https://vimeo.com/2")).toBeNull();
  });

  it("ignores empty url or empty data url", () => {
    setWebPoster("", "data:image/jpeg;base64,AAA");
    setWebPoster("https://x/1", "");
    expect(webPosterFor("https://x/1")).toBeNull();
    expect(webPosterFor(null)).toBeNull();
  });

  it("re-storing a url refreshes its value without duplicating it", () => {
    setWebPoster("https://x/a", "data:one");
    setWebPoster("https://x/a", "data:two");
    expect(webPosterFor("https://x/a")).toBe("data:two");
  });

  it("LRU-evicts the oldest once over the cap, keeping recents", () => {
    for (let i = 0; i < 90; i++) setWebPoster(`https://x/${i}`, `data:${i}`);
    // MAX = 80, so the 10 oldest (0..9) are gone; the newest survive.
    expect(webPosterFor("https://x/0")).toBeNull();
    expect(webPosterFor("https://x/9")).toBeNull();
    expect(webPosterFor("https://x/10")).toBe("data:10");
    expect(webPosterFor("https://x/89")).toBe("data:89");
  });
});
