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

/**
 * THE CAP COUNTED ENTRIES WHILE ENTRIES WERE 44 KB.
 *
 * The sizing note said "an ~480px JPEG at q0.7 is ~15-30 KB, xMAX ~ a couple
 * MB worst case" - forgetting the stored value is a base64 DATA URL, about a
 * third larger than the JPEG. Measured against a real store: mean 44,300
 * characters, max 87,371. At the old cap of 80 that is 3.5M characters against
 * a 5 MiB ceiling: a REGENERABLE picture cache taking two thirds of the quota
 * that irreplaceable work shares, and at the observed maximum exceeding it
 * alone. The work it would have evicted came to 0.81% of the same quota.
 */
describe("the poster cache is capped by size, not by count", () => {
  beforeEach(() => localStorage.clear());

  const big = (n: number) => "data:image/jpeg;base64," + "A".repeat(n);

  it("evicts on the byte budget long before the entry count", () => {
    // Ten posters at ~44 KB is well under MAX=80 and well over the budget.
    for (let i = 0; i < 10; i += 1) setWebPoster(`https://x/${i}`, big(44_000));
    const raw = localStorage.getItem("saucebunny.webPosters") ?? "";
    expect(raw.length, "the store must stay inside its character budget")
      .toBeLessThanOrEqual(300 * 1024);
    // CANARY: it kept something. A cap that evicted everything would also
    // satisfy the assertion above.
    expect(webPosterFor("https://x/9"), "the newest poster must survive").toBeTruthy();
  });

  it("still evicts oldest-first", () => {
    for (let i = 0; i < 10; i += 1) setWebPoster(`https://x/${i}`, big(44_000));
    expect(webPosterFor("https://x/0"), "the oldest should have gone").toBeNull();
  });

  it("never evicts the only poster it has", () => {
    // One entry larger than the whole budget is still the only picture there
    // is; dropping it would leave the cache permanently empty for that source.
    setWebPoster("https://only", big(400_000));
    expect(webPosterFor("https://only")).toBeTruthy();
  });
});
