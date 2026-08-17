import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * No source or test file may use a Node API newer than the version CI pins.
 *
 * This has now cost two round trips through CI for the same reason.
 * `fs.globSync` landed in Node 22; `.github/workflows/ci.yml` pins Node 20.
 * A developer machine on 25 runs the suite green, the push goes out, and six
 * minutes later CI dies with "globSync is not a function". The failure is not
 * subtle and not hard to fix - it is just invisible until the slowest possible
 * moment, which is the whole problem.
 *
 * `duplicated-tables-contract.test.ts` already carried a comment explaining
 * exactly this, written the first time it happened. It did not help, because a
 * lesson recorded in a file you have no reason to open is not a guard. This is
 * the same lesson with a failing test attached, which is the form that works.
 *
 * The list is deliberately short: an API earns a line here by actually having
 * broken a build, not by being new.
 */

const ROOT = resolve(__dirname, "../..");

/** Banned import bindings, with the Node version each one needs. */
const TOO_NEW: Array<{ binding: string; since: string; instead: string }> = [
  { binding: "globSync", since: "22", instead: "a readdirSync walk (see this file, or duplicated-tables-contract)" },
  { binding: "glob", since: "22", instead: "a readdirSync walk" },
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(e.name)) out.push(relative(ROOT, full));
  }
  return out;
}

const files = ["src", "e2e"].flatMap((d) => sourceFiles(resolve(ROOT, d)));

/** The Node major CI actually runs, read from the workflow rather than assumed. */
function ciNodeMajor(): string | null {
  const yml = readFileSync(resolve(ROOT, ".github/workflows/ci.yml"), "utf8");
  return /node-version:\s*"?(\d+)"?/.exec(yml)?.[1] ?? null;
}

describe("the Node baseline CI runs on", () => {
  it("is pinned in the workflow, and there are files to check", () => {
    // Canary on both halves: if the workflow stops pinning a version, or the
    // walk stops finding files, every assertion below is vacuous.
    expect(ciNodeMajor(), "ci.yml no longer pins a node-version").not.toBeNull();
    expect(files.length, "no source files found - the walk broke").toBeGreaterThan(100);
  });

  it("is not exceeded by any node:fs import", () => {
    const bad: string[] = [];
    for (const f of files) {
      const src = readFileSync(resolve(ROOT, f), "utf8");
      // Only the import statement counts. Prose about globSync - including the
      // comment at the top of this file, and the one that recorded the lesson
      // the first time - must not trip it.
      for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']node:fs(?:\/promises)?["']/g)) {
        const names = m[1].split(",").map((n) => n.trim().split(/\s+as\s+/)[0]);
        for (const api of TOO_NEW) {
          if (names.includes(api.binding)) {
            bad.push(`${f}: imports ${api.binding} (needs Node ${api.since}); use ${api.instead}`);
          }
        }
      }
    }
    expect(bad, `CI runs Node ${ciNodeMajor()}; these will fail there and pass locally`).toEqual([]);
  });
});
