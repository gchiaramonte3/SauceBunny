import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Two notices over the video may not claim the same corner.
 *
 * Reported twice from live sessions, and both were the same mistake: a box
 * positioning itself by guessing where another box was.
 *
 *   .cp-stream-keep   hardcoded `top: 40px` to clear .cp-stream-rung
 *   .cp-shuttle-badge sat at top:14/left:14, on top of that rung at top:10/left:10
 *   .cp-canvas-toast  read the prep banner's height from a --prep-h custom
 *                     property so it could lift clear of it, and shipped an
 *                     overlap anyway when the 62px fallback was used against a
 *                     banner that had wrapped to 115px
 *
 * The fix is structural: everything in the top-left corner is a child of
 * .cp-monitor-stack, and flow keeps them apart. This test holds two things --
 * that those members stopped positioning themselves, and, more usefully, that
 * no NEW surface quietly claims an occupied corner.
 *
 * It reads declarations rather than rendered boxes on purpose. e2e/ measures
 * what renders; only the stylesheet can tell you that two surfaces agree by
 * accident and are free to drift.
 */

// Comments stripped first: the .cp-monitor-stack note names every selector it
// replaced, so an un-stripped scan reads its own prose and matches the wrong
// rule. That exact failure shipped in this repo's device-state contract.
const css = readFileSync(join(__dirname, "../styles/monitor.css"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

type Rule = { selector: string; body: string };

function rules(): Rule[] {
  const out: Rule[] = [];
  // Top-level rules only: skip @media/@keyframes bodies, which nest.
  const flat = css.replace(/@(?:media|supports|keyframes)[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  for (const m of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({ selector: m[1].trim().replace(/\s+/g, " "), body: m[2] });
  }
  return out;
}

const ALL = rules();
const ruleFor = (sel: string) => ALL.find((r) => r.selector === sel);

/** Members of the top-left stack: they must carry no anchoring of their own. */
const STACK_MEMBERS = [".cp-stream-rung", ".cp-stream-keep", ".cp-shuttle-badge", ".cp-canvas-toast", ".cp-prep-banner"];

/** Surfaces that float over the canvas and anchor themselves to a corner. */
const ANCHORED = [".cp-monitor-stack", ".cp-caption-overlay"];

/** Which edges a rule pins itself to, as a comparable signature. */
function corner(body: string): string {
  const edge = (name: string) => {
    const m = body.match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`));
    return m ? m[1].trim() : null;
  };
  const parts: string[] = [];
  for (const e of ["top", "bottom"]) {
    const v = edge(e);
    // A NEGATIVE offset hangs the element outside the frame rather than
    // placing it inside one of the frame's corners. .cp-eq is bottom:-14px,
    // which is under the video, not in the caption band.
    if (v && !v.startsWith("-")) parts.push(e);
  }
  const l = edge("left");
  // left:50% is centring, a different lane from a left-edge anchor.
  if (l) parts.push(l.startsWith("50%") ? "centre" : "left");
  if (edge("right")) parts.push("right");
  return parts.join("+") || "unanchored";
}

describe("monitor overlay corners", () => {
  it("the selectors under test all exist", () => {
    // The canary. Rename any of these and every assertion below would pass on
    // an empty set, which is how a scanning guard stops guarding in silence.
    expect(ALL.length).toBeGreaterThan(50);
    for (const sel of [...STACK_MEMBERS, ...ANCHORED]) {
      expect(ruleFor(sel), `${sel} has no top-level rule in monitor.css`).toBeTruthy();
    }
  });

  it("stack members do not position themselves", () => {
    for (const sel of STACK_MEMBERS) {
      const body = ruleFor(sel)!.body;
      expect(body, `${sel} is a stack child; the stack places it`).not.toMatch(
        /position:\s*(absolute|fixed)/,
      );
      expect(corner(body), `${sel} pins itself to an edge instead of flowing`).toBe("unanchored");
    }
  });

  it("no two anchored surfaces claim the same corner", () => {
    const seen = new Map<string, string>();
    for (const sel of ANCHORED) {
      const c = corner(ruleFor(sel)!.body);
      const prior = seen.get(c);
      expect(
        prior,
        `${sel} and ${prior} both anchor ${c}. Put one in .cp-monitor-stack, or give it its own corner.`,
      ).toBeUndefined();
      seen.set(c, sel);
    }
    expect(seen.size).toBe(ANCHORED.length);
  });

  it("nothing but captions sits in the bottom-centre band", () => {
    // Captions are max-width 96%, so a long cue crosses the whole frame. Any
    // notice sharing that band is covered by it or covers it.
    const band = ALL.filter(
      (r) => /position:\s*absolute/.test(r.body) && corner(r.body) === "bottom+centre",
    );
    expect(band.map((r) => r.selector)).toEqual([".cp-caption-overlay"]);
  });
});
