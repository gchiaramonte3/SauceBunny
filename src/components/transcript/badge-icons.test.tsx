// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { BADGE_GROUPS, BADGE_ICONS, badgeIcon, searchBadgeIcons } from "./badge-icons";
import { NON_SPEECH_KINDS } from "../../lib/speech-kind";

afterEach(cleanup);

/**
 * Fifty icons drawn by hand in one sitting is fifty chances to paste the same
 * path twice and not notice — two entries that look identical on screen are
 * indistinguishable as badges, which defeats the only thing a badge does. The
 * duplicate check below is the reason this file exists; the rest guards the
 * contract that the ids are persisted and so cannot drift.
 */

describe("the catalogue", () => {
  it("has no duplicate ids", () => {
    const ids = BADGE_ICONS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("draws every icon differently", () => {
    // The one that would ship silently. Two ids pointing at the same drawing
    // give the user two indistinguishable choices and no error anywhere.
    const seen = new Map<string, string>();
    for (const b of BADGE_ICONS) {
      cleanup();
      const { container } = render(<b.Glyph size={16} />);
      const svg = container.querySelector("svg");
      expect(svg, b.id).toBeTruthy();
      const shape = svg!.innerHTML;
      expect(shape.trim().length, `${b.id} draws nothing`).toBeGreaterThan(0);
      const clash = seen.get(shape);
      expect(clash, `${b.id} is drawn identically to ${clash}`).toBeUndefined();
      seen.set(shape, b.id);
    }
  });

  it("gives every entry a label and a real group", () => {
    for (const b of BADGE_ICONS) {
      expect(b.label.trim(), b.id).not.toBe("");
      expect(BADGE_GROUPS, b.id).toContain(b.group);
    }
  });

  it("leaves no group empty, so the sheet has no blank headings", () => {
    for (const g of BADGE_GROUPS) {
      expect(BADGE_ICONS.filter((b) => b.group === g).length, g).toBeGreaterThan(0);
    }
  });

  it("is big enough to be worth a sheet", () => {
    // A stub of four is what this replaced; a floor here keeps a future
    // deletion honest about what it is removing.
    expect(BADGE_ICONS.length).toBeGreaterThanOrEqual(40);
  });

  it("carries the four non-speech kinds under their own kind names", () => {
    // Load-bearing: KindGlyph derives a kind from the tag or the name and then
    // looks THAT string up here. Rename one of these ids and every music bed
    // silently goes back to showing initials.
    for (const k of NON_SPEECH_KINDS) {
      expect(badgeIcon(k), k).toBeTruthy();
    }
  });
});

describe("badgeIcon", () => {
  it("resolves a known id", () => {
    expect(badgeIcon("star")?.label).toBe("Starred");
  });

  it("returns null for nothing, for an unknown id, and for the initials sentinel", () => {
    // Unknown ids reach here from hand-edited review docs and from documents
    // written by a newer build. Both must fall back, never blank a badge.
    expect(badgeIcon(null)).toBeNull();
    expect(badgeIcon(undefined)).toBeNull();
    expect(badgeIcon("banana")).toBeNull();
    expect(badgeIcon("none")).toBeNull();
  });
});

describe("searchBadgeIcons", () => {
  it("returns the whole catalogue for a blank query", () => {
    expect(searchBadgeIcons("")).toHaveLength(BADGE_ICONS.length);
    expect(searchBadgeIcons("   ")).toHaveLength(BADGE_ICONS.length);
  });

  it("puts a label prefix above a label substring", () => {
    // "ph" must find Phone before Headphones, or typing the first letters of
    // what you want walks you away from it.
    const ids = searchBadgeIcons("pho").map((b) => b.id);
    expect(ids.indexOf("phone")).toBeLessThan(ids.indexOf("headphones"));
  });

  it("finds an icon by a word that is not in its label", () => {
    // The label is "Host"; nobody searching for it types that.
    expect(searchBadgeIcons("microphone").map((b) => b.id)).toContain("mic");
    expect(searchBadgeIcons("favourite").map((b) => b.id)).toContain("star");
  });

  it("is case-insensitive", () => {
    expect(searchBadgeIcons("MUSIC").map((b) => b.id)).toContain("music");
  });

  it("returns nothing for a query that matches nothing", () => {
    expect(searchBadgeIcons("zzzzz")).toHaveLength(0);
  });
});
