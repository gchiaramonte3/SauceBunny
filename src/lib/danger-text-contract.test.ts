import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * One meaning, one red, on text.
 *
 * tokens.css introduced --danger-text with a note that the old #ff8a8a /
 * #ff6b6b copies had been "named once". They had not: error text was still
 * drawn in five reds - --danger (the solid, which the token's own comment
 * says fails as a glyph on dark greys), --danger-text, --color-destructive
 * (a third hex, #FF5C5C, used twice), and literal #ff7a7a / #ff9a9a /
 * #ff5757 plus the retired #ff6b6b as rgba(255, 107, 107, x) eight times.
 * Same-file pairs proved it was drift rather than intent: two error hints
 * four lines apart in review.css, one on each token.
 *
 * token-usage-contract sees only exact duplicates of a token's hex, so a
 * near-miss red was invisible to it. This pins the rule that comment
 * stated: on TEXT or a glyph the red is --danger-text; --danger is for
 * fills, borders and the armed button.
 */

const STYLES = join(__dirname, "../styles");
const COMPONENTS = join(__dirname, "../components");

function css(): Array<[string, string]> {
  return readdirSync(STYLES)
    .filter((f) => f.endsWith(".css") && f !== "tokens.css")
    .map((f) => [f, readFileSync(join(STYLES, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")]);
}

function lineOf(text: string, idx: number): number {
  return text.slice(0, idx).split("\n").length;
}

/** The reds this app has retired, by value. */
const RETIRED = /#ff(5757|5c5c|6b6b|7a7a|8a8a|9a9a)\b|rgba\(\s*255,\s*(87|92|107|122|138|154),\s*\2\s*,/i;

describe("danger-text-contract", () => {
  const sheets = css();

  it("finds the danger tokens it is policing", () => {
    const text = sheets.map(([, t]) => t).join("\n");
    expect((text.match(/var\(--danger-text\)/g) ?? []).length, "--danger-text barely used - renamed?").toBeGreaterThan(15);
    expect((text.match(/var\(--danger\)/g) ?? []).length, "--danger barely used - renamed?").toBeGreaterThan(10);
  });

  it("the third red is gone, in tokens and in every consumer", () => {
    const tokens = readFileSync(join(STYLES, "tokens.css"), "utf8");
    expect(tokens, "--color-destructive is back in tokens.css").not.toMatch(/--color-destructive/);
    const hits: string[] = [];
    for (const [file, text] of sheets) {
      if (/--color-destructive/.test(text)) hits.push(file);
    }
    for (const f of readdirSync(COMPONENTS)) {
      if (!/\.tsx?$/.test(f)) continue;
      if (/--color-destructive/.test(readFileSync(join(COMPONENTS, f), "utf8"))) hits.push(`components/${f}`);
    }
    expect(hits, "--color-destructive referenced; it is --danger-text now").toEqual([]);
  });

  it("no stylesheet retypes a retired red", () => {
    const hits: string[] = [];
    for (const [file, text] of sheets) {
      const re = new RegExp(RETIRED.source, "gi");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) hits.push(`${file}:${lineOf(text, m.index)}  ${m[0]}`);
    }
    expect(hits, "a literal red. Text and glyphs are var(--danger-text); a tint is color-mix(in srgb, var(--danger) N%, transparent):").toEqual([]);
  });

  it("text never takes the solid --danger", () => {
    // `(?<![-a-z])` keeps border-color and background-color out of it: those
    // are fills and borders, where the solid is right.
    const hits: string[] = [];
    for (const [file, text] of sheets) {
      const re = /(?<![-a-z])color:\s*var\(--danger\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) hits.push(`${file}:${lineOf(text, m.index)}`);
    }
    expect(hits, "color: var(--danger) on text - the token's own comment says it fails as a glyph on dark greys; use --danger-text:").toEqual([]);
  });
});
