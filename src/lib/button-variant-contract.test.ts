import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A button variant may change its STATE. It may not change its outline.
 *
 * The captions button sat in a row with Mark in, Mark out, Clear marks and
 * Snapshot. Those are 30x28 and borderless; captions and snapshot were 32x30
 * with `border: 1px solid var(--line-1)` — five buttons, one row, two
 * treatments. It read as a mistake because it was one: nothing about
 * "captions" or "snapshot" needs a box around it, and being ON is what
 * `.active` already means.
 *
 * The rule is narrow on purpose, because some size variants are legitimate
 * and this must not forbid them. An audit of every button modifier that
 * redefines geometry found five, and four are defensible:
 *
 *   .btn.btn-compact          height, padding   — "compact" IS a size
 *   .cp-icon-btn.speed        width, padding    — it carries text ("1x")
 *   .cp-transport-btn.play    width, height     — the primary control
 *   .cp-reader-tbtn.primary   width, height     — a base that already
 *                                                 has a border; only size
 *                                                 changes, so the family
 *                                                 stays consistent
 *   .cp-icon-btn.cc/.snapshot border + size     — the defect
 *
 * What separates the last one is the BORDER: it appears on a base that
 * declares `border: none`, so two siblings are outlined and three are not.
 * A size difference can be emphasis. An outline on one of five is drift.
 */
const STYLES = join(__dirname, "../../src/styles");

type Rule = { file: string; selector: string; body: string };

function rules(): Rule[] {
  const out: Rule[] = [];
  for (const f of readdirSync(STYLES).filter((n) => n.endsWith(".css"))) {
    const text = readFileSync(join(STYLES, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of text.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
      out.push({ file: f, selector: m[1].trim().replace(/\s+/g, " "), body: m[2] });
    }
  }
  return out;
}

/** Bases that declare `border: none`, so any bordered modifier of them drifts. */
function borderlessBases(all: Rule[]): Set<string> {
  const set = new Set<string>();
  for (const r of all) {
    if (!/border\s*:\s*none/.test(r.body)) continue;
    for (const sel of r.selector.split(",")) {
      const m = /^\.(cp-[a-z-]*btn|btn)$/.exec(sel.trim());
      if (m) set.add("." + m[1]);
    }
  }
  return set;
}

describe("button variants stay in one family", () => {
  const all = rules();

  it("reads the stylesheets, so the rule below cannot pass vacuously", () => {
    expect(all.length).toBeGreaterThan(200);
    expect(borderlessBases(all).size, "no borderless button base found — the scan broke")
      .toBeGreaterThan(0);
  });

  it("no modifier gives a border to a base that declares none", () => {
    const bases = borderlessBases(all);
    const offenders: string[] = [];
    for (const r of all) {
      // Only a real border, not `border-color` on an already-bordered state.
      if (!/(^|;)\s*border\s*:\s*(?!none)/.test(r.body)) continue;
      for (const sel of r.selector.split(",")) {
        const s = sel.trim();
        // `.base.modifier`, and not a pseudo-state of the base itself.
        const m = /^(\.(?:cp-[a-z-]*btn|btn))\.[a-z][a-z0-9-]*$/.exec(s);
        if (m && bases.has(m[1])) offenders.push(`${r.file}  ${s}`);
      }
    }
    expect(
      offenders,
      "a button variant is outlined while its siblings are not. That is what made\n" +
        "the captions button look broken beside Mark in and Clear marks. Use .active\n" +
        "for state; the base owns the outline:",
    ).toEqual([]);
  });
});
