import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * Every `var(--x)` resolves to something.
 *
 * An unresolvable custom property with no fallback does not fall back to a
 * default - it makes the whole declaration invalid at computed-value time, so
 * the property behaves as `unset`. For `color` that means inherit, which is the
 * most deceptive possible outcome: the text still has A colour, so nothing
 * looks broken, and the value the author wrote never applies.
 *
 * monitor.css referenced `--text-1` and `--text-2` in three declarations. They
 * are not tokens and never were; the file already used `--fg-1` / `--fg-2`
 * thirty-five other times. The casualties were the stream quality chip's colour
 * and - more pointedly - the hover and focus states of the actionable
 * "keep a copy" chip, which were left changing only their border. The comment
 * directly above those rules explains that a chip which takes a click while
 * looking exactly like the label beside it is how people stop trusting either.
 * The brightening meant to prevent that had never once run.
 *
 * Three ways to be legitimate, and the third is why this cannot just diff two
 * lists: a property may be defined in CSS, or carry a fallback, or be set
 * inline from JSX (`style={{ ["--label-color" as string]: color }}`), which is
 * how per-item colours reach the stylesheet here. All three are real patterns
 * in this codebase and all three are fine.
 */

const ROOT = resolve(__dirname, "../..");

function walk(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, ext, out);
    else if (ext.test(e.name) && !e.name.includes(".test.")) out.push(relative(ROOT, full));
  }
  return out;
}

// Comments stripped first. A comment naming a property would otherwise read as
// a definition or a use - the mistake this repo has now made three ways.
const cssFiles = walk(resolve(ROOT, "src/styles"), /\.css$/);
const CSS = cssFiles
  .map((f) => readFileSync(resolve(ROOT, f), "utf8"))
  .join("\n")
  .replace(/\/\*[\s\S]*?\*\//g, " ");

/** Properties assigned anywhere in CSS. */
const definedInCss = new Set([...CSS.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

/** Properties assigned inline from JSX, e.g. `["--label-color" as string]: c`. */
const setFromJsx = new Set<string>();
for (const f of walk(resolve(ROOT, "src"), /\.tsx?$/)) {
  const src = readFileSync(resolve(ROOT, f), "utf8");
  for (const m of src.matchAll(/["'](--[a-z0-9-]+)["']/g)) setFromJsx.add(m[1]);
}

/** Every var() use, with whether it carries its own fallback. */
const uses = [...CSS.matchAll(/var\(\s*(--[a-z0-9-]+)\s*(,)?/g)].map((m) => ({
  name: m[1],
  hasFallback: m[2] === ",",
}));

describe("CSS custom properties", () => {
  it("are read from real stylesheets", () => {
    // Canary. Both halves have to be non-empty or the assertion below passes
    // by finding nothing at all.
    expect(cssFiles.length, "no stylesheets found").toBeGreaterThan(10);
    expect(uses.length, "no var() uses found - the scan broke").toBeGreaterThan(200);
    expect(definedInCss.has("--fg-1"), "the token file did not parse").toBe(true);
  });

  it("all resolve, by definition, fallback, or an inline JSX value", () => {
    const bad = [
      ...new Set(
        uses
          .filter((u) => !u.hasFallback && !definedInCss.has(u.name) && !setFromJsx.has(u.name))
          .map((u) => u.name),
      ),
    ];
    expect(bad, "var() with no definition, no fallback, and no inline setter").toEqual([]);
  });
});
