import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Typography set inline in TSX bypasses every typography contract.
 *
 * design-tokens-contract reads src/styles only: font-size from --text-*,
 * font-weight naming an imported face, line-height from --leading-*,
 * letter-spacing from --track-*. Fourteen `style={{}}` objects carried those
 * keys as literals and none of the four rules could see them. Among them: a
 * `fontWeight: 500` on the sidebar's selection timecode - main.tsx imports
 * 300/400/600/700/800, so it rendered at 400, which is exactly the bug the
 * weight rule was written to stop, one directory over. A `lineHeight: 1.6`
 * minted six times, a rung the leading scale does not have. And two custom
 * properties defined nowhere - `--color-warn` and `--text-muted` - whose
 * fallbacks painted hot pink and #888, invisible to css-var-contract, which
 * also reads stylesheets only.
 *
 * Two rules, then. A typography key in an inline style must be COMPUTED
 * (an avatar sized from a prop, a caption font chosen from a table); a
 * literal belongs in a class. And a `var(--x)` written inside TSX must name
 * a property some stylesheet defines, or one the same file sets inline.
 */

const SRC = join(__dirname, "..");
const STYLES = join(SRC, "styles");
const KEYS = /\b(fontSize|fontWeight|lineHeight|letterSpacing|textTransform|fontFamily)\s*:\s*/g;

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name);
    if (f.isDirectory()) { if (!/^(bindings|styles)$/.test(f.name)) out.push(...tsxFiles(p)); }
    else if (/\.tsx$/.test(f.name) && !/\.test\.tsx$/.test(f.name)) out.push(p);
  }
  return out;
}

/** The text of every `style={{ ... }}` object, brace-balanced. */
function styleObjects(text: string): Array<{ line: number; body: string }> {
  const out: Array<{ line: number; body: string }> = [];
  const re = /style=\{\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let depth = 2, i = m.index + m[0].length;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === "{") depth++;
      else if (text[i] === "}") depth--;
    }
    out.push({ line: text.slice(0, m.index).split("\n").length, body: text.slice(m.index + m[0].length, i - 2) });
  }
  return out;
}

function valueAfter(body: string, idx: number): string {
  // up to the next top-level comma or the end of the object
  let depth = 0, j = idx;
  for (; j < body.length; j++) {
    const c = body[j];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) break;
  }
  return body.slice(idx, j).trim();
}

const LITERAL = /^(-?\d+(\.\d+)?|"[^"]*"|'[^']*'|`[^`$]*`)$/;

describe("inline-typography-contract", () => {
  const files = tsxFiles(SRC).map((p) => [p.slice(SRC.length + 1), readFileSync(p, "utf8")] as const);

  it("finds inline styles at all, so the rules below cannot pass vacuously", () => {
    const n = files.reduce((acc, [, t]) => acc + styleObjects(t).length, 0);
    expect(n, "no style={{}} objects found - the scan broke").toBeGreaterThan(50);
  });

  it("a typography key in an inline style is computed, never a literal", () => {
    const literal: string[] = [];
    const computed: string[] = [];
    for (const [file, text] of files) {
      for (const { line, body } of styleObjects(text)) {
        const re = new RegExp(KEYS.source, "g");
        let m: RegExpExecArray | null;
        while ((m = re.exec(body))) {
          const v = valueAfter(body, m.index + m[0].length);
          (LITERAL.test(v) ? literal : computed).push(`${file}:${line}  ${m[1]}: ${v}`);
        }
      }
    }
    // The exceptions are the population: an avatar sized from its prop and a
    // caption font chosen from a table. If these vanish the rule has nothing
    // to be an exception TO, and the scan is more likely broken than the app.
    expect(computed.length, "no computed typography left - did the scan stop matching?").toBeGreaterThan(1);
    expect(
      literal,
      "a literal typography value inline. Put it in a class: font-size from --text-*, weight from a face\n" +
        "main.tsx imports, line-height from --leading-*, letter-spacing from --track-*. A value computed\n" +
        "at runtime (a prop, a table lookup) is the only reason to set these inline:",
    ).toEqual([]);
  });

  it("every var(--x) written in TSX names a property something defines", () => {
    const defined = new Set<string>();
    for (const f of readdirSync(STYLES)) {
      if (!f.endsWith(".css")) continue;
      for (const m of readFileSync(join(STYLES, f), "utf8").matchAll(/^\s*(--[a-z0-9-]+)\s*:/gim)) defined.add(m[1]);
    }
    const uses: string[] = [];
    const missing: string[] = [];
    for (const [file, text] of files) {
      // Properties this file sets inline: style={{ ["--x" as string]: ... }} or "--x": ...
      const local = new Set([...text.matchAll(/["'](--[a-z0-9-]+)["']\s*(?:as string\s*\])?\s*:/g)].map((m) => m[1]));
      for (const m of text.matchAll(/var\((--[a-z0-9-]+)/g)) {
        uses.push(m[1]);
        if (!defined.has(m[1]) && !local.has(m[1])) {
          missing.push(`${file}:${text.slice(0, m.index).split("\n").length}  ${m[1]}`);
        }
      }
    }
    expect(uses.length, "no var(--x) in any TSX - the scan broke").toBeGreaterThan(8);
    expect(
      missing,
      "var(--x) in TSX naming a property no stylesheet defines. With a fallback it paints the fallback\n" +
        "(this is how an error icon shipped hot pink); without one it paints nothing:",
    ).toEqual([]);
  });
});
