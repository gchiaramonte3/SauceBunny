import { describe, it, expect } from "vitest";
import { TAB_IDS, isTabId, normalizeActiveTab, mergeTabOrder, type TabId } from "./tab-state";

describe("isTabId / normalizeActiveTab", () => {
  it("accepts every known tab id", () => {
    for (const id of TAB_IDS) {
      expect(isTabId(id)).toBe(true);
      expect(normalizeActiveTab(id)).toBe(id);
    }
  });

  it("falls back to queue for junk and removed tabs", () => {
    expect(normalizeActiveTab(null)).toBe("queue");
    expect(normalizeActiveTab(undefined)).toBe("queue");
    expect(normalizeActiveTab(42)).toBe("queue");
    expect(normalizeActiveTab("")).toBe("queue");
    expect(normalizeActiveTab("clips")).toBe("queue"); // retired tab in old storage
    expect(normalizeActiveTab("settings")).toBe("queue");
  });
});

describe("mergeTabOrder", () => {
  const defaults: readonly TabId[] = ["queue", "transcript", "ai", "review"];

  it("returns defaults for junk input", () => {
    expect(mergeTabOrder(null, defaults)).toEqual([...defaults]);
    expect(mergeTabOrder("nope", defaults)).toEqual([...defaults]);
    expect(mergeTabOrder({ a: 1 }, defaults)).toEqual([...defaults]);
  });

  it("keeps a valid stored order", () => {
    expect(mergeTabOrder(["review", "queue", "transcript", "ai"], defaults))
      .toEqual(["review", "queue", "transcript", "ai"]);
  });

  it("drops removed ids and appends new ones", () => {
    // Stored order from a build that still had the Clips tab…
    expect(mergeTabOrder(["clips", "review", "queue"], defaults))
      .toEqual(["review", "queue", "transcript", "ai"]);
  });

  it("dedupes repeated stored ids", () => {
    expect(mergeTabOrder(["ai", "ai", "queue"], defaults))
      .toEqual(["ai", "queue", "transcript", "review"]);
  });

  it("ignores non-string entries", () => {
    expect(mergeTabOrder([7, null, "transcript"], defaults))
      .toEqual(["transcript", "queue", "ai", "review"]);
  });

  it("never loses a tab", () => {
    const out = mergeTabOrder(["review"], defaults);
    expect([...out].sort()).toEqual([...defaults].sort());
  });
});
