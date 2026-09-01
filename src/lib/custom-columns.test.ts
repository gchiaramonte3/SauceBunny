// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from "vitest";
import {
  addCustomColumn, cleanLabel, customValue, isCustomKey, loadCustomColumns,
  loadCustomValues, pruneCustomValues, removeCustomColumn, renameCustomColumn,
  repathCustomValues, saveCustomColumns, saveCustomValues, setCustomValue,
  COLUMNS_KEY, VALUES_KEY, MAX_VALUE, type CustomColumn, type CustomValues,
} from "./custom-columns";

const cols = (...labels: string[]) => labels.reduce<CustomColumn[]>((a, l) => addCustomColumn(a, l), []);

describe("custom columns", () => {
  beforeEach(() => localStorage.clear());

  it("ids are opaque and prefixed, which is the collision defence", () => {
    // Custom and built-in keys share one namespace so a custom column can be
    // resized, reordered and hidden by the SAME model with no new machinery.
    // The prefix is what stops a user-made "size" column from taking the real
    // one's width and rendering in its place.
    const [c] = cols("Size");
    expect(isCustomKey(c.id)).toBe(true);
    expect(c.id).not.toBe("size");
    for (const builtin of ["name", "kind", "size", "date", "source"]) {
      expect(isCustomKey(builtin), `${builtin} reads as a custom key`).toBe(false);
    }
  });

  it("two ids differ", () => {
    const [a, b] = cols("Scene", "Take");
    expect(a.id).not.toBe(b.id);
  });

  it("refuses an empty or duplicate label", () => {
    const one = cols("Scene");
    expect(addCustomColumn(one, "   ")).toBe(one);
    // Case-insensitive: "Scene" and "scene" are two headings nobody can tell
    // apart, and the second is always a mistake.
    expect(addCustomColumn(one, "scene")).toBe(one);
    expect(addCustomColumn(one, "Take")).toHaveLength(2);
  });

  it("cleans a label rather than storing whatever was typed", () => {
    expect(cleanLabel("  Circle   Take \n")).toBe("Circle Take");
    expect(cleanLabel("x".repeat(99))).toHaveLength(32);
  });

  it("renaming a column keeps everything typed into it", () => {
    // The reason values are keyed by id and not by label. Keyed by label, this
    // rename would silently empty the column.
    let list = cols("Scene");
    let v: CustomValues = {};
    v = setCustomValue(v, "/a.mov", list[0].id, "12A");
    list = renameCustomColumn(list, list[0].id, "Sc.");
    expect(list[0].label).toBe("Sc.");
    expect(customValue(v, "/a.mov", list[0].id)).toBe("12A");
  });

  it("refuses a rename onto another column's label", () => {
    const list = cols("Scene", "Take");
    expect(renameCustomColumn(list, list[1].id, "scene")).toBe(list);
  });

  it("stores a value under an NFC path, so an accented name is one file", () => {
    // macOS hands back a DECOMPOSED filename while a text field produces a
    // COMPOSED one. Untreated, "café.mov" is two different files.
    //
    // The two spellings are CONSTRUCTED rather than typed as literals. Written
    // as literals they look identical in the source, so a formatter that
    // normalised the file would leave this test passing while comparing a
    // string to itself - proving nothing, and looking exactly like proof.
    const composed = "/x/caf\u00E9.mov";      // é as one code point
    const decomposed = "/x/cafe\u0301.mov";   // e + combining acute
    expect(composed).not.toBe(decomposed);
    expect(composed.normalize("NFD")).toBe(decomposed.normalize("NFD"));

    const [c] = cols("Scene");
    const v = setCustomValue({}, composed, c.id, "7");
    expect(customValue(v, decomposed, c.id)).toBe("7");
    // And the other direction: written decomposed, read composed.
    const v2 = setCustomValue({}, decomposed, c.id, "8");
    expect(customValue(v2, composed, c.id)).toBe("8");
  });

  it("clearing a cell removes it instead of storing an empty string", () => {
    const [c] = cols("Scene");
    let v = setCustomValue({}, "/a.mov", c.id, "12A");
    expect(Object.keys(v)).toHaveLength(1);
    v = setCustomValue(v, "/a.mov", c.id, "  ");
    expect(v).toEqual({});
  });

  it("returns the same object when nothing changed, so a caller can skip a write", () => {
    const [c] = cols("Scene");
    const v = setCustomValue({}, "/a.mov", c.id, "12A");
    expect(setCustomValue(v, "/a.mov", c.id, "12A")).toBe(v);
  });

  it("caps a value", () => {
    const [c] = cols("Notes");
    const v = setCustomValue({}, "/a.mov", c.id, "y".repeat(MAX_VALUE + 50));
    expect(customValue(v, "/a.mov", c.id)).toHaveLength(MAX_VALUE);
  });

  it("a renamed file takes its metadata with it", () => {
    const [c] = cols("Scene");
    let v = setCustomValue({}, "/x/old.mov", c.id, "12A");
    v = repathCustomValues(v, "/x/old.mov", "/x/new.mov");
    expect(customValue(v, "/x/new.mov", c.id)).toBe("12A");
    expect(customValue(v, "/x/old.mov", c.id)).toBe("");
  });

  it("deleting a column drops its values rather than leaking them", () => {
    // The store is uncapped and swallows a quota error, so orphans are a leak
    // nobody can see or clear.
    let list = cols("Scene", "Take");
    const [scene, take] = list;
    let v: CustomValues = {};
    v = setCustomValue(v, "/a.mov", scene.id, "12A");
    v = setCustomValue(v, "/a.mov", take.id, "3");
    list = removeCustomColumn(list, scene.id);
    v = pruneCustomValues(v, list);
    expect(customValue(v, "/a.mov", scene.id)).toBe("");
    expect(customValue(v, "/a.mov", take.id)).toBe("3");
  });

  it("prune removes an item left with nothing", () => {
    const list = cols("Scene");
    const v = setCustomValue({}, "/a.mov", list[0].id, "12A");
    expect(pruneCustomValues(v, [])).toEqual({});
  });

  it("survives a round trip through storage", () => {
    const list = cols("Scene", "Take");
    const v = setCustomValue({}, "/a.mov", list[0].id, "12A");
    saveCustomColumns(list);
    saveCustomValues(v);
    expect(loadCustomColumns()).toEqual(list);
    expect(loadCustomValues()).toEqual(v);
  });

  it("drops a stored column whose id would defeat the prefix", () => {
    // A value from no build of this app. Adopting it would let it collide
    // with a built-in column key, which is the one thing the prefix prevents.
    localStorage.setItem(COLUMNS_KEY, JSON.stringify([{ id: "size", label: "Size" }]));
    expect(loadCustomColumns()).toEqual([]);
  });

  it("does not throw on a mangled store", () => {
    localStorage.setItem(COLUMNS_KEY, "{not json");
    localStorage.setItem(VALUES_KEY, "[]");
    expect(loadCustomColumns()).toEqual([]);
    expect(loadCustomValues()).toEqual({});
  });

  it("normalises paths on READ, so an old store migrates itself", () => {
    const [c] = cols("Scene");
    const decomposed = "/x/cafe\u0301.mov";
    const composed = "/x/caf\u00E9.mov";
    localStorage.setItem(VALUES_KEY, JSON.stringify({ [decomposed]: { [c.id]: "7" } }));
    expect(customValue(loadCustomValues(), composed, c.id)).toBe("7");
  });
});
