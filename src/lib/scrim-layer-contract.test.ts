import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * A scrim is a full-viewport layer, or it is nothing.
 *
 * `.cp-modal-scrim` is the backdrop class on the transcript search, the library
 * rename dialog and Quick Look. No stylesheet declared it. Three components,
 * three separate commits, and the name never once matched a rule - the working
 * one next door is `.cp-modal-backdrop`.
 *
 * Nothing in the toolchain notices. A className is a string; React renders any
 * string, tsc has no opinion about CSS, and the dialog inside keeps its own
 * width and background so it still looks like a dialog in a screenshot. What
 * goes missing is the LAYER: position, inset, centering, z-index, the dim.
 * Measured in the e2e harness at 1280x800 before the fix, the search dialog
 * sat at y=739 - bottom-left corner, a third of it under the fold, on a
 * transparent static div.
 *
 * The check is per-ELEMENT rather than per-class, because composing is legal
 * and used: Quick Look writes `className="cp-modal-scrim cp-ql-scrim"`, where
 * the first supplies the layer and the second only darkens it. Requiring every
 * scrim-ish class to be independently fixed would flag that correctly-written
 * pair. What must hold is that SOME class on the element makes it a layer.
 *
 * e2e/scrim-layout.spec.ts measures one of these for real in a browser. This
 * covers the ones no e2e path reaches, which is why both exist.
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

/**
 * Selector/body pairs, with CSS comments stripped FIRST.
 *
 * Not optional. An earlier version left them in, and the comment written to
 * explain this very bug mentions `.cp-ql-scrim` by name - so the scan paired
 * the name in the prose with the neighbouring rule's body and reported the
 * class as styled. Comments describing a thing are not the thing; that mistake
 * has now been made three separate ways in this codebase.
 */
function cssRules(): Array<[string, string]> {
  const raw = walk(resolve(ROOT, "src/styles"), /\.css$/)
    .map((f) => readFileSync(resolve(ROOT, f), "utf8"))
    .join("\n");
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, " ");
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => [m[1], m[2]]);
}

const RULES = cssRules();

/** Does any rule naming this class make it a fixed, inset layer? */
function isLayer(cls: string): boolean {
  return RULES.some(
    ([sel, body]) =>
      new RegExp(`\\.${cls}(?![a-z0-9-])`).test(sel) && /position:\s*fixed/.test(body),
  );
}

/** Every className attribute value that mentions a scrim or a backdrop. */
function scrimElements(): Array<{ file: string; classes: string[] }> {
  const out: Array<{ file: string; classes: string[] }> = [];
  for (const f of walk(resolve(ROOT, "src"), /\.tsx$/)) {
    const src = readFileSync(resolve(ROOT, f), "utf8");
    for (const m of src.matchAll(/className=(\{[^}]*\}|"[^"]*")/g)) {
      const classes = [...m[1].matchAll(/\bcp-[a-z0-9-]+/g)].map((c) => c[0]);
      if (classes.some((c) => c.endsWith("-scrim") || c.endsWith("-backdrop"))) {
        out.push({ file: f, classes });
      }
    }
  }
  return out;
}

const elements = scrimElements();

describe("scrims", () => {
  it("are found, and the stylesheets parsed", () => {
    // Canary on both inputs. Either one silently empty makes the assertion
    // below vacuous, which is the failure mode this repo keeps shipping.
    expect(elements.length, "no scrim elements found - the JSX scan broke").toBeGreaterThan(5);
    expect(RULES.length, "no CSS rules parsed - the stylesheet scan broke").toBeGreaterThan(500);
    expect(isLayer("cp-modal-backdrop"), "the known-good layer reads as unstyled").toBe(true);
  });

  it("each get their layer from at least one of their own classes", () => {
    const bad = elements
      .filter((e) => !e.classes.some(isLayer))
      .map((e) => `${e.file}: className="${e.classes.join(" ")}" - no class makes this a layer`);
    expect(bad, "scrims that are not full-viewport layers").toEqual([]);
  });
});
