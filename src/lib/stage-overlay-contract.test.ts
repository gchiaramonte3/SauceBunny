import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * WHAT BROKE.
 *
 * Live co-review reactions (a clap, a thumbs-up) rendered as a SIBLING of
 * Monitor and Transport inside `.cp-monitor-wrap`:
 *
 *   <div className="cp-monitor-wrap">   ← position: static
 *     <Monitor … />
 *     {roomActive && <ReactionLayer />} ← position: absolute
 *     <Transport … />
 *   </div>
 *
 * `.cp-reactions-layer` is `position: absolute`, and its wrapper is
 * `position: static`, so the containing block was some far ancestor spanning
 * the whole column. `bottom: 90px` then measured up from below the transport
 * and a clap surfaced ON THE TIMECODE FIELD - as far from the shot someone was
 * reacting to as the layout allows.
 *
 * The fix is not a nudged offset. It is anchoring: reactions go in
 * `.cp-monitor`, the box `useContainSize` sizes to the video itself, which is
 * `position: relative` and `overflow: hidden` and is already where the caption
 * and annotation overlays live. Monitor exposes it as the `stageOverlay` slot.
 *
 * WHY A TEST. Nothing about the broken version was visibly wrong in the source
 * - `{roomActive && <ReactionLayer />}` beside `<Monitor />` reads perfectly
 * naturally, and the CSS in isolation is correct too. The defect only exists
 * in the RELATIONSHIP between them, which is exactly the kind of thing that
 * gets reintroduced by someone tidying JSX.
 */

const root = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** JSX with block and line comments removed. Without this the scan below
 *  counts the literal `<div>` inside Monitor's own doc comment ("pure CSS
 *  can't do this for a <div>") and never balances - and an unbalanced stack
 *  holds stale entries, which would make the containment check pass for the
 *  WRONG reason. Stripping first is what lets the balance assertion serve as
 *  the canary. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * Walk `<div>` opens and closes, tracking the className stack, and report the
 * stack at each `{stageOverlay}` site plus the residual depth at EOF.
 *
 * Only `<div>` is tracked: components (`<Monitor … />`, `<CaptionOverlay … />`)
 * are self-closing in this file, so the div tags balance on their own.
 */
function scanStageOverlaySites(src: string) {
  const tok = /<div\b([^>]*?)(\/?)>|<\/div>|\{stageOverlay\}/g;
  const stack: string[] = [];
  const sites: string[][] = [];
  for (let m = tok.exec(src); m; m = tok.exec(src)) {
    if (m[0] === "{stageOverlay}") { sites.push([...stack]); continue; }
    if (m[0] === "</div>") { stack.pop(); continue; }
    if (m[2] === "/") continue; // <div … /> opens nothing
    const cls = /className="([^"]*)"/.exec(m[1] ?? "");
    stack.push(cls ? cls[1] : "?");
  }
  return { sites, residual: stack.length };
}

describe("the reaction layer is anchored to the picture", () => {
  it("every stageOverlay slot sits inside .cp-monitor", () => {
    const { sites, residual } = scanStageOverlaySites(stripComments(read("src/components/Monitor.tsx")));

    // CANARY 1: the scan understood the file. An unbalanced stack means a tag
    // was missed, and stale entries would make the containment check below
    // pass without proving anything.
    expect(residual, "div tags did not balance - the scan cannot be trusted").toBe(0);
    // CANARY 2: there is something to check at all. Monitor returns from four
    // status branches and the slot belongs in all of them, so a slot that
    // quietly disappeared from three of them must fail here.
    expect(sites.length, "no {stageOverlay} sites found").toBeGreaterThanOrEqual(4);

    const outside = sites.filter((s) => !s.includes("cp-monitor"));
    expect(outside, "a stageOverlay slot is outside the video box").toEqual([]);
  });

  it("ReactionLayer is only rendered through that slot", () => {
    const app = stripComments(read("src/App.tsx"));
    const uses = [...app.matchAll(/<ReactionLayer\s*\/>/g)];
    // CANARY: the component is still mounted somewhere. A rename that this
    // test did not follow would otherwise leave it asserting over nothing.
    expect(uses.length, "ReactionLayer is not mounted anywhere").toBeGreaterThan(0);

    // Each use must be the value of a stageOverlay prop. This is the exact
    // shape of the original bug: a bare `{roomActive && <ReactionLayer />}`
    // beside <Monitor /> type-checks, renders, and lands on the timecode.
    for (const u of uses) {
      const before = app.slice(Math.max(0, u.index - 200), u.index);
      expect(before, "ReactionLayer rendered outside Monitor's stageOverlay slot")
        .toMatch(/stageOverlay=\{[^}]*$/);
    }
  });

  it("the anchor and the layer agree on how they position", () => {
    // The containment above buys nothing unless .cp-monitor actually
    // establishes a containing block - a static ancestor is precisely how the
    // original bug worked.
    const monitorCss = read("src/styles/monitor.css");
    const monitorRule = /\.cp-monitor\s*\{([^}]*)\}/.exec(monitorCss);
    expect(monitorRule, ".cp-monitor rule not found").toBeTruthy();
    expect(monitorRule?.[1]).toMatch(/position:\s*relative/);

    const roomCss = read("src/styles/room.css");
    const layerRule = /\.cp-reactions-layer\s*\{([^}]*)\}/.exec(roomCss);
    expect(layerRule, ".cp-reactions-layer rule not found").toBeTruthy();
    expect(layerRule?.[1]).toMatch(/position:\s*absolute/);
  });
});
