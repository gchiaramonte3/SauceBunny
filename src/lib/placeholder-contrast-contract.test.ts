import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * PLACEHOLDER TEXT IS TEXT, AND NEITHER CONTRAST SWEEP CAN SEE IT.
 *
 * `e2e/contrast.spec.ts` builds its population from elements that have their
 * own child TEXT NODES, then reads `getComputedStyle(e).color`. An `<input>`
 * has no child text nodes, and that call never reports a pseudo-element - so
 * no ::placeholder can enter the set, by construction. `deep-state-contrast`
 * carries a verbatim copy of the same loop and inherits the hole exactly.
 *
 * This is CLAUDE.md's documented failure #4 in a new place: "a transform
 * comparison that found zero transforms because getComputedStyle(el) never
 * reports pseudo-elements". The lesson was learned once, in one function, and
 * not carried to its siblings.
 *
 * Two placeholders were below AA behind that blindness - and one of them lives
 * in the command palette, a dialog contrast.spec.ts opens ON PURPOSE for a
 * test named "the command palette meets AA".
 *
 * A source contract rather than a rendered one, because the rendered tool is
 * the thing that cannot look. This computes the ratio from the tokens, so it
 * also fails if the PALETTE is retuned under a rule that currently passes.
 */

const STYLES = join(__dirname, "..", "styles");

function srgb(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
}
function ratio(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** `--name: #rrggbb;` pairs from tokens.css. */
function tokens(): Map<string, string> {
  const src = readFileSync(join(STYLES, "tokens.css"), "utf8");
  const out = new Map<string, string>();
  for (const m of src.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out.set(m[1], m[2]);
  return out;
}

/** Every `…::placeholder { … color: var(--x) … }` in the stylesheets. */
function placeholderColours(): { where: string; token: string }[] {
  const out: { where: string; token: string }[] = [];
  for (const file of readdirSync(STYLES).filter((f) => f.endsWith(".css"))) {
    const src = readFileSync(join(STYLES, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of src.matchAll(/([^{}]*::placeholder[^{}]*)\{([^}]*)\}/g)) {
      const colour = /(?:^|[;\s])color:\s*var\((--[\w-]+)\)/.exec(m[2]);
      if (colour) out.push({ where: `${file} ${m[1].trim()}`, token: colour[1] });
    }
  }
  return out;
}

describe("placeholder text meets AA", () => {
  const t = tokens();
  const rules = placeholderColours();

  it("finds the placeholder rules and the tokens", () => {
    // CANARY on both halves. A changed token syntax empties the map and every
    // ratio below becomes unmeasurable; a changed rule shape empties the list
    // and the suite reports conformance over nothing.
    expect(t.size, "no colour tokens parsed").toBeGreaterThan(20);
    expect(rules.length, "no ::placeholder rules parsed").toBeGreaterThanOrEqual(12);
  });

  it("every placeholder colour clears 4.5:1 on the surface it sits on", () => {
    // --bg-2 is the input surface for these fields, and it is what the two
    // failures were measured against. Checking one representative background
    // rather than every possible one keeps the claim honest: this is the
    // surface these inputs actually use.
    const bg = t.get("--bg-2");
    expect(bg, "--bg-2 not found").toBeTruthy();
    const bad = rules
      .map((r) => ({ ...r, hex: t.get(r.token) }))
      .filter((r) => r.hex && ratio(r.hex, bg as string) < 4.5)
      .map((r) => `${r.where} uses ${r.token} = ${ratio(r.hex as string, bg as string).toFixed(2)}:1`);
    expect(bad, "placeholder text below AA (4.5:1)").toEqual([]);
  });
});
