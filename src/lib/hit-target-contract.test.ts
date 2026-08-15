import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Pointer-target size ratchet.
 *
 * WCAG 2.2 SC 2.5.8 (AA) puts the minimum pointer target at 24x24 CSS px.
 * Twenty-two button classes in this app declare a square smaller than that,
 * measured rather than guessed, and they are listed below.
 *
 * THIS TEST DOES NOT CLAIM THEY ARE ALL BUGS, and that distinction is the
 * reason it exists in this shape. The success criterion has a SPACING
 * exception: a small target passes anyway when a 24px circle centred on it
 * touches no other target. Whether each of these clears that cannot be decided
 * from a width and a height - it needs layout, and in several cases a look at
 * the thing on screen. A sweep that "fixed" all twenty-two by growing their hit
 * areas would risk the failure that is genuinely worse than a small button:
 * two targets overlapping, so the click lands on the wrong one, intermittently,
 * with nothing on screen to explain it.
 *
 * What the list IS: a floor. It may shrink freely. A NEW sub-24 button fails
 * here, at the moment someone adds it, which is the only moment the spacing
 * question is cheap to answer.
 *
 * Known limitation, stated rather than papered over: `buttonClasses` reads
 * className literals off `<button>` tags, so a class assembled entirely at
 * runtime is invisible to it, and a small target reached by a `role="button"`
 * div is out of scope. It catches the common shape, not every shape.
 */

const ROOT = resolve(__dirname, "../..");
const MIN_PX = 24;

/**
 * Below the minimum today. Shrinking this list is the point; adding to it
 * means someone decided the spacing exception applies, and that decision
 * belongs in the commit message.
 */
const KNOWN_SMALL: ReadonlySet<string> = new Set([
  "cp-mediainfo-info", "cp-tagrow-dot", "cp-tagrow-clear", "cp-lib-search-clear",
  "cp-lib-row-remove", "cp-recents-remove", "cp-review-range-x",
  "cp-review-linkoffer-x", "cp-tx-history-row-remove", "cp-tx-hint-close",
  "cp-spk-pip", "cp-newspk-pip", "cp-ai-chapter-del", "cp-canvas-toast-close",
  "cp-web-forget", "cp-tx-search-nav-btn", "cp-spk-play", "cp-cast-del",
  "cp-tx-rename-icon", "cp-model-info-btn", "cp-recent-reveal", "cp-toggle-switch",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** cp- classes that appear in a className on a real <button>. */
function buttonClasses(): Set<string> {
  const out = new Set<string>();
  for (const f of walk(join(ROOT, "src")).filter((f) => f.endsWith(".tsx"))) {
    const s = readFileSync(f, "utf8");
    const re = /<button\b[^>]*?className=(?:"([^"]+)"|\{[^}]*?"(cp-[\w-]+)")/gs;
    for (const m of s.matchAll(re)) {
      for (const group of [m[1], m[2]]) {
        if (!group) continue;
        for (const c of group.split(/\s+/)) if (c.startsWith("cp-")) out.add(c);
      }
    }
  }
  return out;
}

/** cp- classes whose rule declares an explicit square under the minimum. */
function smallSquares(): Set<string> {
  const out = new Set<string>();
  for (const f of walk(join(ROOT, "src/styles")).filter((f) => f.endsWith(".css"))) {
    const css = readFileSync(f, "utf8");
    for (const m of css.matchAll(/\.(cp-[\w-]+)\s*\{([^}]*)\}/g)) {
      const body = m[2];
      // min-/max- prefixed declarations are a different promise; only a fixed
      // width AND height pins the target box from CSS alone.
      const w = /(?<!min-)(?<!max-)\bwidth:\s*(\d+(?:\.\d+)?)px/.exec(body);
      const h = /(?<!min-)(?<!max-)\bheight:\s*(\d+(?:\.\d+)?)px/.exec(body);
      if (w && h && (Number(w[1]) < MIN_PX || Number(h[1]) < MIN_PX)) out.add(m[1]);
    }
  }
  return out;
}

const offenders = () => {
  const btn = buttonClasses();
  return [...smallSquares()].filter((c) => btn.has(c)).sort();
};

describe("pointer target sizes", () => {
  it("adds no new button below the 24px minimum", () => {
    const fresh = offenders().filter((c) => !KNOWN_SMALL.has(c));
    expect(
      fresh,
      `New sub-${MIN_PX}px button target(s). WCAG 2.2 SC 2.5.8 allows a smaller ` +
        `target only when nothing else sits within a 24px circle of it. If that ` +
        `holds here, add the class to KNOWN_SMALL and say so; if not, grow the ` +
        `hit area (padding, or a transparent ::before) rather than the icon.`,
    ).toEqual([]);
  });

  it("keeps the list honest as targets get fixed", () => {
    // A class that grew past the minimum, or was deleted, must leave the list:
    // a stale entry reads as "reviewed and accepted" when it means neither.
    const actual = new Set(offenders());
    const stale = [...KNOWN_SMALL].filter((c) => !actual.has(c)).sort();
    expect(stale, "listed as under the minimum but no longer is").toEqual([]);
  });

  it("still recognises buttons at all, so the ratchet cannot pass by parsing nothing", () => {
    // The failure mode of a scraper-backed test is scraping zero and reporting
    // success. If the className shape ever changes, this is what says so.
    expect(buttonClasses().size).toBeGreaterThan(100);
  });
});
