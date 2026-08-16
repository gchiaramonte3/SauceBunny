import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * CLAUDE.md: "Use tokens from tokens.css for colors ... Never hardcode hex
 * colors ... that have a token equivalent." Nothing was checking it.
 *
 * Only EXACT duplicates are reported - a literal whose value is already a
 * token. A one-off shade with no token is a judgement call about whether the
 * palette should grow, not a rule violation, and this file deliberately has no
 * opinion on those (there are 41 distinct literals in the stylesheets and most
 * are legitimately one-off).
 *
 * Two exclusions, both learned by getting this wrong first. A naive grep
 * reported six offenders; four were not:
 *
 *  · COMMENTS. `--marker` carries a note explaining it "was orange (#E87826)",
 *    and the export CTA describes its own gradient in prose above the rule.
 *    Reading those as code turns documentation into a defect.
 *  · `var(--token, #fallback)`. The literal there is the fallback for the token
 *    itself, so it is not a hardcode competing with it. (It is a mild drift
 *    hazard if the token is ever retuned, but the fallback only applies when
 *    the token is undefined, which cannot happen while tokens.css loads.)
 *
 * What it did legitimately catch: two dropdown menus in review.css painting
 * `#1a1a1d` while every other elevated surface used
 * `var(--color-surface-elevated)` - the same value - and `--marker` restating
 * the brand violet's hex under a comment that says it uses the brand violet.
 */

const STYLES = resolve(__dirname, "../styles");
const TOKENS = readFileSync(join(STYLES, "tokens.css"), "utf8");

/** value -> the token names that hold it. */
const byValue = new Map<string, string[]>();
for (const [, name, value] of TOKENS.matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
  const v = value.trim().toLowerCase();
  if (!/^#[0-9a-f]{3,8}$/.test(v)) continue;
  byValue.set(v, [...(byValue.get(v) ?? []), name]);
}

/**
 * Literals that duplicate a token on purpose. Keep this list short, and give
 * every entry a reason someone can disagree with.
 */
const ALLOWED: Array<{ file: string; hex: string; why: string }> = [
  {
    file: "buttons.css",
    hex: "#6d52ed",
    why: "middle stop of the export CTA's three-stop brand gradient (#9D7BFF → #6D52ED → #5A39D6). " +
      "The outer two have no tokens, and tokenising only the middle one reads as if the other two " +
      "were unrelated values rather than one gradient.",
  },
];

/** Strip comments, then every `var(--x, <fallback>)` fallback. */
function code(css: string): string {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/var\(\s*--[\w-]+\s*,[^)]*\)/g, "var(--x)");
}

type Hit = { file: string; line: number; hex: string; token: string; text: string };

const hits: Hit[] = [];
for (const file of readdirSync(STYLES).filter((f) => f.endsWith(".css") && f !== "tokens.css")) {
  const lines = code(readFileSync(join(STYLES, file), "utf8")).split("\n");
  lines.forEach((text, i) => {
    for (const m of text.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      const hex = m[0].toLowerCase();
      const token = byValue.get(hex)?.[0];
      if (!token) continue;
      if (ALLOWED.some((a) => a.file === file && a.hex === hex)) continue;
      hits.push({ file, line: i + 1, hex, token, text: text.trim() });
    }
  });
}

describe("colours come from tokens", () => {
  it("found the token table and something to check it against", () => {
    expect(byValue.size, "no hex-valued tokens parsed out of tokens.css").toBeGreaterThan(10);
    expect(readdirSync(STYLES).filter((f) => f.endsWith(".css")).length).toBeGreaterThan(15);
  });

  it("writes no literal that an existing token already holds", () => {
    expect(
      hits.map((h) => `${h.file}:${h.line}  ${h.hex} is var(${h.token})  |  ${h.text}`),
      "use the token",
    ).toEqual([]);
  });

  it("keeps the allowlist honest", () => {
    // An entry that no longer matches anything is stale permission: it reads as
    // a known exception while protecting nothing.
    for (const a of ALLOWED) {
      const raw = readFileSync(join(STYLES, a.file), "utf8").toLowerCase();
      expect(raw, `allowlist entry ${a.file} ${a.hex} matches nothing any more`).toContain(a.hex);
      expect(a.why.length, "every allowlist entry needs a reason").toBeGreaterThan(20);
    }
  });
});
