import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A transition names the properties it animates, and does not animate layout.
 *
 * Reported as "the slider buttons work, but the animations can be smoother and
 * more responsive". The switch thumb travelled on `left` under
 * `transition: all`, so every frame of a 30px slide went through layout and
 * paint on the main thread. That is the stutter. It also ran at --dur-base
 * (180ms) when the token's own comment reserves --dur-fast for "small state
 * changes on a control", which is the lag.
 *
 * Two rules, and the first is the one that would have prevented the second:
 *
 *   1. No `transition: all`. It makes the browser watch every animatable
 *      property to find the two that change, and it silently animates whatever
 *      a state class adds later -- which is exactly how `left` on the thumb
 *      became animated without anyone deciding it should be.
 *
 *   2. No transition on a layout property, except a progress fill. A bar that
 *      grows genuinely wants `width`: scaleX distorts its radius and its
 *      contents, and it ticks a few times a second rather than per frame.
 *
 * Both are shrink-only ratchets. Existing entries are listed by name so this
 * cannot be satisfied by adding to an allowlist without reading it, and an
 * entry that stops matching fails -- so a fixed one has to be removed here
 * rather than left as cover for the next.
 */

const DIR = join(__dirname, "../styles");
const LAYOUT = ["left", "right", "top", "bottom", "width", "height", "margin", "padding"];

/** Progress fills. A bar that grows is the one honest use of animated width. */
const FILL_ALLOWED = [
  "src/styles/ai.css .cp-ai-dl-fill",
  "src/styles/buttons.css .cp-gen-fill",
  "src/styles/logs.css .cp-logs-header .progress-bar",
  "src/styles/room.css .cp-transfer-fill",
  "src/styles/settings.css .cp-model-progress .bar > span",
  "src/styles/transcript.css .cp-tx-insights-bar-fill",
];

/** Not fills, and not yet converted. Shrink this list; never grow it. */
const LAYOUT_REMAINING = [
  "src/styles/logs.css .cp-logs",
  "src/styles/shell.css .cp-reader-pin::before",
  "src/styles/transport.css .cp-ghost-playhead",
  "src/styles/transport.css .cp-track-chapter",
  "src/styles/transport.css .cp-track-comment",
];

type Hit = { where: string; props: string[] };

function scan(): { all: Hit[]; layout: Hit[]; rules: number } {
  const all: Hit[] = [];
  const layout: Hit[] = [];
  let rules = 0;
  for (const name of readdirSync(DIR).filter((f) => f.endsWith(".css"))) {
    const css = readFileSync(join(DIR, name), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      rules++;
      const sel = m[1].trim().replace(/\s+/g, " ");
      const t = m[2].match(/(?:^|;)\s*transition:\s*([^;]+)/);
      if (!t) continue;
      const where = `src/styles/${name} ${sel}`;
      const props = t[1]
        .replace(/\s+/g, " ")
        .split(",")
        .map((p) => p.trim().split(" ")[0])
        .filter(Boolean);
      if (props.includes("all")) all.push({ where, props });
      const bad = props.filter((p) => LAYOUT.includes(p));
      if (bad.length) layout.push({ where, props: bad });
    }
  }
  return { all, layout, rules };
}

const RESULT = scan();

describe("transitions", () => {
  it("scanned the stylesheets", () => {
    // The canary. Every assertion below is "this filtered list is empty",
    // which is what a scan that found no rules at all also reports.
    expect(RESULT.rules, "no CSS rules were parsed").toBeGreaterThan(500);
  });

  it("none says `all`", () => {
    expect(
      RESULT.all.map((h) => h.where),
      "`transition: all` animates whatever a state class adds later. Name the properties.",
    ).toEqual([]);
  });

  it("layout properties are transitioned only where listed", () => {
    const known = new Set([...FILL_ALLOWED, ...LAYOUT_REMAINING]);
    const surprises = RESULT.layout.map((h) => h.where).filter((w) => !known.has(w));
    expect(
      surprises,
      "a layout property animates every frame on the main thread. Use transform, or list it here with a reason.",
    ).toEqual([]);
  });

  it("every listed exception still exists", () => {
    // The other half of a ratchet: an entry that no longer matches is cover
    // for the next offender, so a fixed site must be deleted from the list.
    const live = new Set(RESULT.layout.map((h) => h.where));
    for (const entry of [...FILL_ALLOWED, ...LAYOUT_REMAINING]) {
      expect(live.has(entry), `${entry} no longer transitions a layout property; remove it`).toBe(true);
    }
  });
});
