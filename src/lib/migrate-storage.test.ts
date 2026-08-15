// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { migrateLegacyStorageKeys } from "./migrate-storage";

/**
 * The rebrand migration (clippull.* -> saucebunny.*).
 *
 * It runs at module load, before App renders, once per user, on data they
 * cannot get back if it goes wrong — and it had no tests. That combination is
 * why this file exists rather than any suspicion about the code, which is
 * careful where it matters.
 */
/** Real stored keys. Object.keys(localStorage) also yields the prototype
 *  methods under jsdom, which is how the first version of this lied. */
const keys = () => {
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const k = localStorage.key(i);
    if (k) out.push(k);
  }
  return out.sort();
};

describe("migrateLegacyStorageKeys", () => {
  beforeEach(() => localStorage.clear());

  it("copies a legacy key to its new name", () => {
    localStorage.setItem("clippull.recents", '["a"]');
    migrateLegacyStorageKeys();
    expect(localStorage.getItem("saucebunny.recents")).toBe('["a"]');
  });

  it("does not clobber a value the new build already wrote", () => {
    // The dangerous direction. A user who has run the new build has real data
    // under the new name; the stale legacy copy must lose.
    localStorage.setItem("clippull.recents", '["old"]');
    localStorage.setItem("saucebunny.recents", '["current"]');
    migrateLegacyStorageKeys();
    expect(localStorage.getItem("saucebunny.recents")).toBe('["current"]');
  });

  it("migrates every legacy key in a batch", () => {
    // This does NOT prove the collect-then-write shape, and saying so is the
    // point. The source gathers all the pairs before writing any, which avoids
    // localStorage.key(i) walking a live index while the loop mutates it.
    // I rewrote the source to write mid-iteration to check this test noticed:
    // it did not. jsdom appends new keys, so indices already visited stay put,
    // and the appended names do not start with "clippull." so the loop skips
    // them anyway.
    //
    // The defensive shape still earns its place - the storage spec leaves key
    // order implementation-defined, and this runs in WebKit, not jsdom - but
    // no test here can demonstrate that, and a comment claiming otherwise
    // would be worse than none. What this checks is the ordinary thing: a
    // batch of keys all arrive.
    for (let i = 0; i < 10; i += 1) localStorage.setItem(`clippull.k${i}`, String(i));
    migrateLegacyStorageKeys();
    for (let i = 0; i < 10; i += 1) {
      expect(localStorage.getItem(`saucebunny.k${i}`)).toBe(String(i));
    }
  });

  it("runs twice without changing anything", () => {
    localStorage.setItem("clippull.a", "1");
    migrateLegacyStorageKeys();
    const after = JSON.stringify(localStorage);
    migrateLegacyStorageKeys();
    expect(JSON.stringify(localStorage)).toBe(after);
  });

  it("sweeps the retired Clips tab's keys", () => {
    localStorage.setItem("saucebunny.clips.x", "1");
    localStorage.setItem("saucebunny.clipQueue", "keep");
    migrateLegacyStorageKeys();
    expect(localStorage.getItem("saucebunny.clips.x")).toBe(null);
    expect(localStorage.getItem("saucebunny.clipQueue")).toBe("keep"); // prefix, not substring
  });

  it("sweeps a retired key even when it arrives via the migration", () => {
    localStorage.setItem("clippull.clips.old", "1");
    migrateLegacyStorageKeys();
    expect(localStorage.getItem("saucebunny.clips.old")).toBe(null);
  });

  it("KEEPS the legacy original — recorded, not endorsed", () => {
    // Nothing deletes clippull.*, so every migrated key is stored twice for
    // good. That is defensible as a downgrade escape hatch, but nothing says
    // so, and this module sweeps the retired Clips keys in the very next loop
    // precisely so leftovers do not "accumulate forever". Meanwhile the review
    // store reasons explicitly about the ~5 MB localStorage quota.
    //
    // Pinned so that deleting the originals is a decision someone makes on
    // purpose, with this test to change, rather than a tidy-up.
    localStorage.setItem("clippull.recents", '["a"]');
    migrateLegacyStorageKeys();
    expect(localStorage.getItem("clippull.recents")).toBe('["a"]');
    expect(keys()).toEqual(["clippull.recents", "saucebunny.recents"]);
  });

  it("leaves unrelated keys alone", () => {
    localStorage.setItem("somethingelse.a", "1");
    localStorage.setItem("saucebunny.b", "2");
    migrateLegacyStorageKeys();
    expect(localStorage.getItem("somethingelse.a")).toBe("1");
    expect(localStorage.getItem("saucebunny.b")).toBe("2");
  });

  it("does not throw when localStorage is unavailable", () => {
    // Private-mode quirks. This runs at module load, so a throw here would
    // take the whole app down before it rendered.
    const real = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() { throw new Error("SecurityError"); },
    });
    expect(() => migrateLegacyStorageKeys()).not.toThrow();
    if (real) Object.defineProperty(window, "localStorage", real);
  });
});
