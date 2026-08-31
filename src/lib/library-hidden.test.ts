// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetHiddenCache, clearHidden, hiddenCount, hidePaths, isHidden,
  subscribeHidden, unhidePaths, withoutHidden,
} from "./library-hidden";

beforeEach(() => { localStorage.clear(); __resetHiddenCache(); });
afterEach(() => { localStorage.clear(); __resetHiddenCache(); });

describe("library exclusions", () => {
  it("hides and shows a path", () => {
    expect(isHidden("/a/b.mov")).toBe(false);
    hidePaths(["/a/b.mov"]);
    expect(isHidden("/a/b.mov")).toBe(true);
    unhidePaths(["/a/b.mov"]);
    expect(isHidden("/a/b.mov")).toBe(false);
  });

  it("matches across macOS's two spellings of the same name", () => {
    // The whole reason this is keyed by pathKey(). The disk stores the name
    // DECOMPOSED and a text field hands back COMPOSED, so a set keyed on the
    // raw string hides a file that reappears under its other spelling.
    const composed = "/a/café.mov";        // é
    const decomposed = "/a/café.mov";     // e + combining acute
    expect(composed).not.toBe(decomposed);
    hidePaths([composed]);
    expect(isHidden(decomposed), "the same file under its other spelling is still shown").toBe(true);
  });

  it("stays case sensitive, because a case-only rename is a real rename", () => {
    hidePaths(["/a/Clip.mov"]);
    expect(isHidden("/a/clip.mov")).toBe(false);
  });

  it("filters a scanned list", () => {
    const items = [{ path: "/a/1.mov" }, { path: "/a/2.mov" }, { path: "/a/3.mov" }];
    hidePaths(["/a/2.mov"]);
    expect(withoutHidden(items).map((i) => i.path)).toEqual(["/a/1.mov", "/a/3.mov"]);
  });

  it("returns a copy when nothing is hidden, not the same array", () => {
    // The fast path must not hand back the caller's array: a consumer that
    // sorts the result in place would reorder the scan itself.
    const items = [{ path: "/a/1.mov" }];
    expect(withoutHidden(items)).not.toBe(items);
  });

  it("is idempotent, so hiding twice is not two entries to undo", () => {
    hidePaths(["/a/1.mov"]);
    hidePaths(["/a/1.mov"]);
    expect(hiddenCount()).toBe(1);
  });

  it("notifies subscribers, so a list re-filters without a rescan", () => {
    const seen = vi.fn();
    const off = subscribeHidden(seen);
    hidePaths(["/a/1.mov"]);
    expect(seen).toHaveBeenCalledTimes(1);
    unhidePaths(["/a/1.mov"]);
    expect(seen).toHaveBeenCalledTimes(2);
    off();
    hidePaths(["/a/2.mov"]);
    expect(seen, "unsubscribed and still called").toHaveBeenCalledTimes(2);
  });

  it("survives a mangled stored value", () => {
    localStorage.setItem("saucebunny.libraryHidden", "{not json");
    __resetHiddenCache();
    expect(hiddenCount()).toBe(0);
    expect(() => hidePaths(["/a/1.mov"])).not.toThrow();
  });

  it("clears the whole set", () => {
    hidePaths(["/a/1.mov", "/a/2.mov"]);
    clearHidden();
    expect(hiddenCount()).toBe(0);
  });
});
