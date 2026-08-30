import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A DEBOUNCED WRITE THAT ONLY FLUSHES ON A REACT UNMOUNT IS LOST WHEN THE
 * WINDOW CLOSES.
 *
 * Four stores in Documents write through a debounce. Only `review-store`
 * registered a `pagehide` flush. `cast-store` had a `flushCasts` whose own
 * docstring said "called before the window closes" - and its only caller was a
 * `useEffect` cleanup in CastShelf, which does not run on close.
 * `web-collection-store` had a flush nobody called on quit, and
 * `transcript-project-store` had no flush function at all.
 *
 * So the last debounce interval of edits - a renamed cast, a clip filed into a
 * collection, a project's poster - was silently lost by quitting, in stores
 * whose entire job is to survive one.
 *
 * Registered from each store's hydrate rather than from a component, because
 * depending on what happens to be mounted is exactly how the unmount version
 * came to miss the case it was written for.
 */

const LIB = join(__dirname);

/**
 * Stores that debounce a write to a file in Documents.
 *
 * Derived from the SHAPE - a debounce timer plus a write to disk - rather than
 * from a list of filenames, so a fifth store written next year is covered
 * without anyone remembering to add it. That shape is exactly what can lose
 * edits on quit; a store that writes synchronously cannot.
 */
function debouncedStores(): string[] {
  return readdirSync(LIB).filter((n) => {
    if (!n.endsWith(".ts") || n.includes(".test.")) return false;
    const src = readFileSync(join(LIB, n), "utf8");
    return /flushTimer|WRITE_DEBOUNCE_MS|scheduleFlush/.test(src)
      && src.includes("write_text_to_path");
  });
}

describe("every debounced store survives a quit", () => {
  const stores = debouncedStores();

  it("finds the stores", () => {
    // CANARY: a renamed file or a changed debounce idiom empties this and the
    // assertion below passes over nothing.
    expect(stores.length, "no debounced stores found - the scan is not matching")
      .toBeGreaterThanOrEqual(4);
  });

  it("each registers a pagehide flush", () => {
    // COMMENTS STRIPPED. Written without this, deleting the listener from
    // cast-store still left the word "pagehide" in the comment explaining the
    // listener, and the mutation passed. That is the third time in a day a
    // scan in this repo matched its own explanation.
    const code = (n: string) => readFileSync(join(LIB, n), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    const missing = stores.filter((n) => !/addEventListener\(\s*"pagehide"/.test(code(n)));
    expect(missing, "debounced store with no quit flush - its last edits die on close")
      .toEqual([]);
  });

  it("registers it from the store, not from a component", () => {
    // The bug this replaces: a flush wired to a React unmount, which does not
    // run when the window closes. If a component owns the registration, the
    // guarantee depends on that component being mounted.
    const components = join(__dirname, "..", "components");
    const inComponents = readdirSync(components)
      .filter((n) => n.endsWith(".tsx") && !n.includes(".test."))
      .filter((n) => /pagehide[\s\S]{0,80}flush/i.test(readFileSync(join(components, n), "utf8")));
    expect(inComponents, "a store's quit flush is registered by a component").toEqual([]);
  });
});
