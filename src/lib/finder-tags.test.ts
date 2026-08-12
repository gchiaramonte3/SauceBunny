import { describe, expect, it } from "vitest";
import {
  clearTagColors, primarySwatch, swatchForTag, tagColor, TAG_COLORS, tagSummary, tagSwatches,
  toggleTagColor,
} from "./finder-tags";
import type { FinderTag } from "../bindings/FinderTag";

const t = (name: string, color: number): FinderTag => ({ name, color });

describe("the palette is macOS's, not ours", () => {
  it("covers exactly indices 1 through 7", () => {
    // Fixed by the format: a tag written with index 6 is red in Finder whatever
    // we think, and there is nowhere in the format for an eighth colour.
    expect(TAG_COLORS.map((c) => c.index)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("treats 0 and out-of-range as no colour", () => {
    expect(tagColor(0)).toBeNull();
    expect(tagColor(8)).toBeNull();
    expect(tagColor(-1)).toBeNull();
  });

  it("never uses the app's accent green for a tag", () => {
    // The accent means "selected" everywhere else; a green-tagged file must not
    // read as a chosen one.
    for (const c of TAG_COLORS) expect(c.hex.toLowerCase()).not.toBe("#6cff8d");
  });
});

describe("swatches", () => {
  it("shows nothing for an untagged file", () => {
    expect(tagSwatches([])).toEqual([]);
    expect(primarySwatch([])).toBeNull();
  });

  it("drops colourless tags rather than drawing an empty dot", () => {
    // A bare label like "Archive" is a real tag with no colour.
    expect(tagSwatches([t("Archive", 0)])).toEqual([]);
    expect(primarySwatch([t("Archive", 0), t("Red", 6)])?.label).toBe("Red");
  });

  it("caps at three, keeping the LAST three like Finder", () => {
    const many = [t("a", 1), t("b", 2), t("c", 3), t("d", 4), t("e", 5)];
    const s = tagSwatches(many);
    expect(s).toHaveLength(3);
    expect(s.map((c) => c.index)).toEqual([3, 4, 5]);
  });

  it("takes the final tag as the one a compact row shows", () => {
    expect(primarySwatch([t("Green", 2), t("Red", 6)])?.label).toBe("Red");
  });
});

describe("toggling a colour", () => {
  it("adds it, named after the colour so Finder can file it", () => {
    // Finder's sidebar groups by tag NAME; a nameless colour would not appear
    // under its own heading there.
    const out = toggleTagColor([], 6);
    expect(out).toEqual([{ name: "Red", color: 6 }]);
  });

  it("REMOVES it when it is already there", () => {
    // What makes the colour row a set of toggles instead of a one-way
    // assignment with no way back.
    const red = toggleTagColor([], 6);
    expect(toggleTagColor(red, 6)).toEqual([]);
  });

  it("leaves other colours alone", () => {
    const two = toggleTagColor(toggleTagColor([], 6), 4);
    expect(two.map((x) => x.color).sort()).toEqual([4, 6]);
    expect(toggleTagColor(two, 6).map((x) => x.color)).toEqual([4]);
  });

  it("keeps a user's named tag when toggling a colour on", () => {
    const out = toggleTagColor([t("Delivered", 0)], 2);
    expect(out.map((x) => x.name)).toEqual(["Delivered", "Green"]);
  });

  it("ignores an index that is not a colour", () => {
    expect(toggleTagColor([], 0 as 1)).toEqual([]);
  });
});

describe("clearing colours", () => {
  it("removes the colour-named tags entirely", () => {
    expect(clearTagColors([t("Red", 6), t("Blue", 4)])).toEqual([]);
  });

  it("KEEPS a tag the user named, dropping only its colour", () => {
    // "No colour" must not silently delete work done in Finder.
    const out = clearTagColors([t("Delivered", 6), t("Red", 6)]);
    expect(out).toEqual([{ name: "Delivered", color: 0 }]);
  });

  it("is a no-op on an untagged file", () => {
    expect(clearTagColors([])).toEqual([]);
  });
});

describe("tagSummary", () => {
  it("lists the names for a tooltip", () => {
    expect(tagSummary([t("Red", 6), t("Delivered", 0)])).toBe("Red, Delivered");
  });

  it("is null when there is nothing to say", () => {
    expect(tagSummary([])).toBeNull();
  });
});

describe("Finder writes the name, not the index", () => {
  const tag = (name: string, color: number) => ({ name, color }) as FinderTag;

  it("colours a real Finder tag by NAME, because its index is a lie", () => {
    // Measured on disk. Four different colours in Finder, every one of them
    // claiming index 1 — which is Grey in the table. Trusting the index painted
    // every Finder-tagged folder grey.
    expect(swatchForTag(tag("Purple", 1))?.label).toBe("Purple");
    expect(swatchForTag(tag("Red", 1))?.label).toBe("Red");
    expect(swatchForTag(tag("Green", 1))?.label).toBe("Green");
    expect(swatchForTag(tag("Blue", 1))?.label).toBe("Blue");
    expect(swatchForTag(tag("Yellow", 1))?.label).toBe("Yellow");
  });

  it("still honours a real Grey tag", () => {
    // The fallback must not swallow the one case where index 1 is the truth.
    expect(swatchForTag(tag("Grey", 1))?.label).toBe("Grey");
  });

  it("falls back to the index for a tag named something else", () => {
    // "Archive" with index 6 is a red tag whose name means something other
    // than its colour; the index is the only thing that can answer.
    expect(swatchForTag(tag("Archive", 6))?.label).toBe("Red");
    expect(swatchForTag(tag("Archive", 0))).toBeNull();
  });

  it("matches the name case- and space-insensitively", () => {
    expect(swatchForTag(tag("  red  ", 1))?.label).toBe("Red");
    expect(swatchForTag(tag("PURPLE", 1))?.label).toBe("Purple");
  });

  it("carries through to the swatch a row actually draws", () => {
    expect(primarySwatch([tag("Purple", 1)])?.hex).toBe("#CB6BD9");
    expect(tagSwatches([tag("Red", 1), tag("Blue", 1)]).map((c) => c.label))
      .toEqual(["Red", "Blue"]);
  });
});
