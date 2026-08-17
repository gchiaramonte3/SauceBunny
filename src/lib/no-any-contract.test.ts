import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * `any` stays out. CLAUDE.md: "No `any`. Use `unknown` + type narrowing if the
 * type is genuinely unknown."
 *
 * The tree obeys this — zero occurrences in src/ — and NOTHING enforces it.
 * `@typescript-eslint` is registered in eslint.config.js with, in its own words,
 * "NO rules enabled": the plugin is there so that pre-existing
 * `eslint-disable-next-line @typescript-eslint/no-explicit-any` comments do not
 * fail as "Definition for rule was not found". So the rule the disables refer to
 * has never actually run. One `any` would sail through tsc (it is legal
 * TypeScript), through lint, and through review.
 *
 * That is the whole case for this being a test rather than a lint rule flip:
 * enabling `no-explicit-any` would activate those dormant disable comments and
 * change what several files are permitted to do, which is a bigger decision than
 * pinning a property the tree already has.
 *
 * Comments and strings are excluded. `unknown` is the sanctioned escape hatch and
 * appears throughout; the point is that `any` opts out of checking silently while
 * `unknown` forces a narrowing the reader can see.
 */

const ROOT = resolve(__dirname, "../..");
const SRC = resolve(ROOT, "src");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

/** Strip block comments, line comments and string literals. */
function code(text: string): string[] {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, "").replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, '""'));
}

/** `any` used as a TYPE: after a colon, in a generic, or in an assertion. */
const AS_TYPE = /(?::\s*any\b|<\s*any\s*[,>]|,\s*any\s*[,>]|\bas\s+any\b|Array<any>|Promise<any>)/;

type Hit = { file: string; line: number; text: string };

function anyHits(includeTests: boolean): Hit[] {
  const out: Hit[] = [];
  for (const f of sourceFiles(SRC)) {
    const isTest = f.includes(".test.");
    if (isTest !== includeTests) continue;
    // A guard cannot scan its own pattern. The regex literal below contains
    // `Array<any>` as TEXT, which the regex matches - the sixth time in this
    // codebase a scanner has read a description of a thing as the thing, and the
    // first time one has done it to itself.
    if (f.endsWith("no-any-contract.test.ts")) continue;
    code(readFileSync(f, "utf8")).forEach((line, i) => {
      if (AS_TYPE.test(line)) out.push({ file: relative(ROOT, f), line: i + 1, text: line.trim() });
    });
  }
  return out;
}

describe("the `any` type", () => {
  it("is being looked for in real files", () => {
    // Canary. The matcher is a regex over stripped code; if the strip or the walk
    // broke, "no hits" would mean "nothing read" rather than "nothing there".
    expect(sourceFiles(SRC).length, "no source files found").toBeGreaterThan(100);
    // And prove the matcher fires at all, on a line built here rather than found.
    expect(AS_TYPE.test("const x: any = 1;")).toBe(true);
    expect(AS_TYPE.test("const x = y as any;")).toBe(true);
    expect(AS_TYPE.test("function f(v: unknown) {}"), "unknown must NOT match").toBe(false);
  });

  it("appears nowhere in shipped source", () => {
    const hits = anyHits(false).map((h) => `${h.file}:${h.line}  ${h.text.slice(0, 88)}`);
    expect(hits, "`any` in shipped source - use `unknown` and narrow").toEqual([]);
  });

  it("appears nowhere in tests either", () => {
    // Separate assertion rather than one combined list, because the arguments
    // differ: a test may legitimately construct a hostile value, but it can do
    // that with `unknown` and a cast to the specific shape. Kept strict while it
    // costs nothing; if a real case ever needs it, this is the line to argue with.
    const hits = anyHits(true).map((h) => `${h.file}:${h.line}  ${h.text.slice(0, 88)}`);
    expect(hits, "`any` in a test - cast through `unknown` to a specific type").toEqual([]);
  });
});
