import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Every `cp-` class a stylesheet styles must be a class some component
 * actually renders.
 *
 * WHY THIS EXISTS. `room.css` styled `.cp-person-tile:hover .cp-person-grant`.
 * No element in the app has ever had the class `cp-person-tile` — the wrapper
 * `PeoplePanel` renders is `cp-person`, as every one of its sibling rules
 * already knew. The rule therefore never matched, and since
 * `.cp-person-grant` is `opacity: 0` at rest, the hover half of its reveal
 * never ran: "Let them present", the host's only way to hand over presenter
 * control, was invisible to anyone using a mouse. It appeared solely on
 * `:focus-visible`, i.e. only if you happened to Tab onto an invisible button.
 *
 * A typo in a selector is silent by construction — no error, no warning, no
 * red in any build step, and the control simply is not there. That is exactly
 * the failure a cheap contract test should own, and when it was written there
 * was precisely ONE violation in 1,011 classes, so the signal is clean.
 *
 * The match is deliberately loose (substring, not a parsed class attribute):
 * classes are composed at runtime from template literals and conditionals, so
 * anything stricter would flag working code. That makes this conservative —
 * it can miss a dead class whose name is a prefix of a live one — and
 * conservative is the right bias for a test nobody should have to argue with.
 */

const STYLES = join(process.cwd(), "src/styles");
const SRC = join(process.cwd(), "src");

/**
 * Tests are excluded from the "is it rendered" scan, and that exclusion is
 * load-bearing rather than tidiness: without it THIS FILE defeats the check,
 * because the doc comment above names the dead class and so proves it alive.
 * It is also just correct — a class only a test mentions is not a class any
 * component renders.
 */
function readAll(dir: string, exts: string[]): string {
  let out = "";
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out += readAll(path, exts);
    else if (/\.test\.tsx?$/.test(entry.name)) continue;
    else if (exts.some((e) => entry.name.endsWith(e))) out += readFileSync(path, "utf8");
  }
  return out;
}

describe("CSS class contract", () => {
  it("styles no cp- class that no component renders", () => {
    const css = readAll(STYLES, [".css"]);
    const code = readAll(SRC, [".ts", ".tsx"]);

    const styled = new Set<string>();
    for (const m of css.matchAll(/\.(cp-[a-z0-9-]+)/g)) styled.add(m[1]);

    const orphans = [...styled].filter((c) => !code.includes(c)).sort();
    expect(orphans, `styled but never rendered: ${orphans.join(", ")}`).toEqual([]);
  });

  it("is actually capable of failing", () => {
    // The guard against this becoming a tautology. If the scan ever stops
    // finding classes — a moved directory, a changed prefix — the assertion
    // above passes vacuously and the whole file becomes decoration.
    const css = readAll(STYLES, [".css"]);
    const styled = new Set([...css.matchAll(/\.(cp-[a-z0-9-]+)/g)].map((m) => m[1]));
    expect(styled.size).toBeGreaterThan(500);
    expect(styled.has("cp-person")).toBe(true);
  });
});
