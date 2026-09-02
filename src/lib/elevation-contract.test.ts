import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Elevation is two tiers, two tokens.
 *
 * tokens.css said so in r99: shadows are for FLOATING layers, tight and
 * dark, and --shadow-card is the one to use. Twenty-six rules followed it.
 * About twenty floating surfaces did not, with twelve distinct values - four
 * popovers on ONE monitor bar carried four different shadows - and the
 * dialog tier had no token at all, so eight dialogs shipped six shadows.
 * Nothing read box-shadow: token-usage-contract sees only hex duplicates,
 * design-tokens-contract sees only radii and type. A hand-typed shadow was
 * the one kind of literal no guard could meet.
 *
 * The rule: a popover, menu, toast or HUD floats on `--shadow-card`; a
 * dialog sits on `--shadow-modal`; `--shadow-soft` is the hairline lift for
 * a small in-flow element. A literal outer shadow with 8px or more of blur is
 * one of those tiers being retyped, unless it is on the short list below of
 * things that are not a floating layer at all.
 */

const STYLES = join(__dirname, "../styles");

/** Literal outer shadows that are NOT a floating surface. Shrink-only, and
 *  every entry must still match something (the ratchet's other half). */
const ALLOWED: Record<string, string[]> = {
  // A stacked-thumbnail depth cue: the shadow IS the stack.
  "library.css": [".cp-lib-stack"],
  // The drag ghost, lifted while it moves - a state, not a surface.
  "queue-drawer.css": [".cp-tab.dragging"],
  // Hover/focus lift on a video tile in the people spine (the contract
  // compares the WHOLE comma list, so the entry is the whole comma list).
  "room.css": [".cp-people.spine .cp-person:hover video, .cp-people.spine .cp-person:focus-within video"],
  // Hover lift on a comment pin.
  "transport.css": [".cp-track-comment:hover"],
};

type Decl = { file: string; line: number; sel: string; value: string };

function sheets(): Array<[string, string]> {
  return readdirSync(STYLES)
    .filter((f) => f.endsWith(".css") && f !== "tokens.css")
    .map((f) => [f, readFileSync(join(STYLES, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "")]);
}

/** Every box-shadow declaration, multi-line values included, with the
 *  selector of the rule it sits in. */
function shadows(): Decl[] {
  const out: Decl[] = [];
  for (const [file, text] of sheets()) {
    const re = /box-shadow:\s*([^;]+);/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const before = text.slice(0, m.index);
      const open = before.lastIndexOf("{");
      const prev = Math.max(before.lastIndexOf("}", open), before.lastIndexOf(";", open));
      const sel = before.slice(prev + 1, open).replace(/\s+/g, " ").trim();
      const line = before.split("\n").length;
      out.push({ file, line, sel, value: m[1].replace(/\s+/g, " ").trim() });
    }
  }
  return out;
}

/** Split a box-shadow value on the commas between layers, not the ones
 *  inside rgba()/color-mix(). */
function layers(value: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** A retyped tier: a non-inset black layer with 8px or more of blur. */
function isRetypedTier(layer: string): boolean {
  const m = /^0 (\d+)px (\d+)px(?: (\d+)px)? rgba\(0,\s*0,\s*0,/.exec(layer);
  return !!m && Number(m[2]) >= 8;
}

describe("elevation-contract", () => {
  const all = shadows();
  const tokenUses = all.filter((d) => /var\(--shadow-(card|modal|soft)\)/.test(d.value));

  it("finds the shadows it is policing, so the rules below cannot pass vacuously", () => {
    expect(all.length, "no box-shadow declarations found at all - the scan broke").toBeGreaterThan(60);
    expect(tokenUses.length, "the tokens are barely used - did they get renamed?").toBeGreaterThan(40);
    const tokens = readFileSync(join(STYLES, "tokens.css"), "utf8");
    for (const t of ["--shadow-soft", "--shadow-card", "--shadow-modal"]) {
      expect(tokens, `${t} is no longer defined`).toMatch(new RegExp(`${t}:\\s*0 `));
    }
  });

  it("a floating surface takes its shadow from a tier token, never retypes one", () => {
    const stray = all.filter((d) => {
      if (!layers(d.value).some(isRetypedTier)) return false;
      return !(ALLOWED[d.file] ?? []).some((sel) => d.sel === sel);
    });
    expect(
      stray.map((s) => `${s.file}:${s.line}  ${s.sel}  { box-shadow: ${s.value} }`),
      "a hand-typed outer shadow. A popover, menu, toast or HUD is var(--shadow-card); a dialog is\n" +
        "var(--shadow-modal). Keep any hairline ring as a second layer. If it is genuinely not a\n" +
        "floating surface (a hover lift, a drag ghost, a depth cue), add the exact selector to ALLOWED:",
    ).toEqual([]);
  });

  it("keeps every allowlist entry earning its place", () => {
    const dead: string[] = [];
    for (const [file, sels] of Object.entries(ALLOWED)) {
      for (const sel of sels) {
        const live = all.some((d) => d.file === file && d.sel === sel && layers(d.value).some(isRetypedTier));
        if (!live) dead.push(`${file}  ${sel}`);
      }
    }
    expect(dead, "allowlisted literal shadow that no longer exists - delete the entry:").toEqual([]);
  });
});
