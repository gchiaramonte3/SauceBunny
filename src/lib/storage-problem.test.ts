// @vitest-environment jsdom
//
// jsdom, not the default node environment, and the reason is the finding
// itself. Under node `localStorage` exists as a global that THROWS on use
// ("localStorage is not available because --localstorage-file was not
// provided"), so EVERY saveJson reports a problem and the "stays quiet on
// success" case fails for a reason that has nothing to do with the code.
// CLAUDE.md records this exact class - a Storage.prototype spy that worked
// on one side and intercepted nothing on the other.
import { afterEach, describe, expect, it, vi } from "vitest";
import { onStorageProblem, reportStorageProblem, resetStorageProblemsForTests, saveJson } from "./storage";

/**
 * FIVE FAMILIES OF REAL WORK PRODUCT LIVE ONLY IN localStorage - speaker
 * renames, chapters, in/out marks, source timecodes and the export queue - and
 * the function that writes all of them caught the quota and called
 * console.warn. In a packaged .app that reaches nobody: the WKWebView console
 * needs Safari's inspector attached, which CLAUDE.md states outright.
 *
 * So past the quota the app kept working perfectly and stopped remembering.
 * Rename twelve speakers, set chapters, mark a range, relaunch, and it is all
 * gone with no error, no banner, and nothing in any log the user can open.
 *
 * docs/DATA-MODEL.md F2 records this work product as living in evictable
 * storage and asks for a product decision about moving it to files. This is
 * not that decision. It is the smaller thing that needs no decision: when a
 * write is lost, say so.
 */

afterEach(() => { resetStorageProblemsForTests(); vi.restoreAllMocks(); });

describe("a lost write is reported", () => {
  it("tells a subscriber which key failed", () => {
    const seen: string[] = [];
    onStorageProblem(({ key }) => seen.push(key));
    // The INSTANCE, not Storage.prototype. Spying the prototype intercepts
    // nothing here - jsdom's localStorage does not dispatch through it - so
    // the spy installs cleanly, the write succeeds, and the test fails while
    // the code is correct. CLAUDE.md records this exact spy behaving
    // differently on two sides; this is that, met head on.
    vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });

    saveJson("saucebunny.chapters.abc", [{ time: 1, title: "One" }]);
    expect(seen, "a failed save must reach a subscriber").toEqual(["saucebunny.chapters.abc"]);
  });

  it("stays quiet when the write succeeds", () => {
    // CANARY for the case above: a reporter that fires unconditionally would
    // satisfy it while crying wolf on every keystroke.
    const seen: string[] = [];
    onStorageProblem(({ key }) => seen.push(key));
    saveJson("saucebunny.test.ok", { a: 1 });
    expect(seen).toEqual([]);
  });

  it("rate-limits, because a full quota fails on every keystroke", () => {
    // Without this, one notification per persisted keystroke is its own kind
    // of unusable - and a full disk fails on all of them.
    const seen: string[] = [];
    onStorageProblem(({ key }) => seen.push(key));
    for (let i = 0; i < 20; i += 1) reportStorageProblem(`k${i}`, new Error("full"));
    expect(seen.length, "should report once, not twenty times").toBe(1);
  });

  it("lets a subscriber leave", () => {
    const seen: string[] = [];
    const off = onStorageProblem(({ key }) => seen.push(key));
    off();
    reportStorageProblem("k", new Error("full"));
    expect(seen).toEqual([]);
  });
});
