import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathKey, samePath } from "./repath";

/**
 * One implementation of path identity, not one per store.
 *
 * This guard exists because of a specific, repeated failure — mine. macOS
 * stores filenames decomposed and a text field returns them composed, and
 * three stores each learned that separately and grew their own normaliser.
 * Each was written while looking at ONE direction of the problem, so each
 * needed a second pass to fix the other:
 *
 *   · canonicalising the poster/timecode maps on load fixed renaming TO an
 *     accented name and broke renaming AWAY from one, because repathKey was
 *     still handed a raw scanned path;
 *   · normalising the transcript-history COMPARISON while still writing the
 *     raw path moved the mismatch one step later rather than ending it.
 *
 * Both shipped green. Both were caught only by reverting the fix and watching
 * a test fail. A private normaliser per store is what made two bugs out of one
 * mistake, so there is now one, and this stops the fourth from appearing.
 */

const ROOT = resolve(__dirname, "../..");
const HOME = "src/lib/repath.ts";

/**
 * Normalising a string that is NOT a filesystem path. Each needs a reason,
 * because "it looked like a path" is how the private copies started.
 */
const ALLOWED: ReadonlyArray<readonly [file: string, why: string]> = [
  ["src/lib/review.ts", "normalises a TITLE inside reviewFingerprint, and a composite fingerprint string on lookup — neither is a path"],
  ["src/lib/library.ts", "searchLibrary folds case as well as normalising; matching text is a different job from identifying a file"],
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function inlineNormalisers(): string[] {
  const hits = new Set<string>();
  for (const file of walk(join(ROOT, "src"))) {
    const rel = file.slice(ROOT.length + 1);
    if (rel === HOME) continue;
    if (/normalize\(\s*["']NFC["']\s*\)/.test(readFileSync(file, "utf8"))) hits.add(rel);
  }
  return [...hits].sort();
}

describe("path identity lives in one place", () => {
  it("normalises no path outside repath.ts", () => {
    const allowed = new Set(ALLOWED.map(([f]) => f));
    expect(
      inlineNormalisers().filter((f) => !allowed.has(f)),
      `Import pathKey/samePath from lib/repath instead of normalising here. If ` +
        `the string is not a filesystem path, add the file to ALLOWED with the ` +
        `reason — the reason is the point.`,
    ).toEqual([]);
  });

  it("keeps the exception list honest", () => {
    const actual = new Set(inlineNormalisers());
    expect(
      ALLOWED.map(([f]) => f).filter((f) => !actual.has(f)),
      "listed as an exception but no longer normalises anything",
    ).toEqual([]);
  });

  it("identifies a file across either encoding", () => {
    const composed = "/lib/café.mov";
    const decomposed = composed.normalize("NFD");
    expect(composed).not.toBe(decomposed);
    expect(samePath(composed, decomposed)).toBe(true);
    expect(pathKey(decomposed)).toBe(pathKey(composed));
  });

  it("still treats case and diacritics as significant", () => {
    // repath's own needsRepath turns on case mattering, so a case-only rename
    // does its identity work. And folding diacritics would make か match が.
    expect(samePath("/lib/Clip.mov", "/lib/clip.mov")).toBe(false);
    expect(samePath("/lib/cafe.mov", "/lib/café.mov")).toBe(false);
    expect(samePath("/lib/か.mov", "/lib/が.mov")).toBe(false);
  });

  it("says no rather than yes when something is missing", () => {
    // A null on either side must not compare equal to anything, including
    // another null — two entries with no source path are not the same file.
    expect(samePath(null, null)).toBe(false);
    expect(samePath(undefined, "/a")).toBe(false);
    expect(samePath("/a", "")).toBe(false);
  });
});
