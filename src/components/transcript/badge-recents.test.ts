// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_BADGE_RECENTS, noteBadgeIconUsed, readBadgeRecents } from "./badge-recents";

beforeEach(() => localStorage.clear());

/**
 * The row in front of the sheet has exactly four self-selecting slots, and the
 * failure modes are all about WIDTH: a short list leaves a visible gap, a long
 * one overflows the popover, and a kind sneaking in reshuffles the row every
 * time somebody tags a music bed.
 */

describe("readBadgeRecents", () => {
  it("starts from the defaults rather than empty", () => {
    // An empty row on first open is the gap this whole feature exists to close.
    expect(readBadgeRecents()).toEqual([...DEFAULT_BADGE_RECENTS]);
  });

  it("always returns exactly four, padding a short list from the defaults", () => {
    localStorage.setItem("saucebunny.badgeIconRecents", JSON.stringify(["crown"]));
    const out = readBadgeRecents();
    expect(out).toHaveLength(4);
    expect(out[0]).toBe("crown");
    expect(new Set(out).size).toBe(4); // padding never duplicates
  });

  it("never returns more than four, so the row cannot overflow", () => {
    localStorage.setItem(
      "saucebunny.badgeIconRecents",
      JSON.stringify(["a", "b", "c", "d", "e", "f"]),
    );
    expect(readBadgeRecents()).toHaveLength(4);
  });

  it("falls back to the defaults on a mangled value instead of throwing", () => {
    localStorage.setItem("saucebunny.badgeIconRecents", "{not json");
    expect(readBadgeRecents()).toEqual([...DEFAULT_BADGE_RECENTS]);
    localStorage.setItem("saucebunny.badgeIconRecents", JSON.stringify({ nope: 1 }));
    expect(readBadgeRecents()).toEqual([...DEFAULT_BADGE_RECENTS]);
    localStorage.setItem("saucebunny.badgeIconRecents", JSON.stringify([1, 2, null]));
    expect(readBadgeRecents()).toEqual([...DEFAULT_BADGE_RECENTS]);
  });

  it("drops a kind that got into storage somehow", () => {
    localStorage.setItem("saucebunny.badgeIconRecents", JSON.stringify(["music", "crown"]));
    expect(readBadgeRecents()).not.toContain("music");
    expect(readBadgeRecents()[0]).toBe("crown");
  });
});

describe("noteBadgeIconUsed", () => {
  it("puts the newest pick first and persists it", () => {
    expect(noteBadgeIconUsed("crown")[0]).toBe("crown");
    expect(readBadgeRecents()[0]).toBe("crown");
  });

  it("promotes rather than duplicating a pick already in the row", () => {
    noteBadgeIconUsed("crown");
    noteBadgeIconUsed("flag");
    const out = noteBadgeIconUsed("crown");
    expect(out[0]).toBe("crown");
    expect(out.filter((x) => x === "crown")).toHaveLength(1);
    expect(out).toHaveLength(4);
  });

  it("pushes the oldest out once four are in", () => {
    noteBadgeIconUsed("crown");
    noteBadgeIconUsed("flag");
    noteBadgeIconUsed("heart");
    noteBadgeIconUsed("pin");
    const out = noteBadgeIconUsed("bolt");
    expect(out).toEqual(["bolt", "pin", "heart", "flag"]);
    expect(out).not.toContain("crown");
  });

  it("ignores a non-speech kind, which is permanently in the row already", () => {
    // Otherwise tagging a music bed would evict a genuinely-used icon and the
    // row would reorder for no reason the user can see.
    const before = readBadgeRecents();
    expect(noteBadgeIconUsed("music")).toEqual(before);
    expect(readBadgeRecents()).toEqual(before);
  });
});
