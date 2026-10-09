import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

/**
 * The String Outs timeline keeps its lanes, ruler, playhead and scroll bar at
 * one x, whatever the headers hold and whichever view shows. Two shapes broke
 * that, and neither is visible to a test that renders in jsdom:
 *
 * - A header column sized to its content moved everything sideways when the
 *   view switched or someone was patched, and a patch menu wider than it put
 *   the playhead over the headers.
 * - Size containment (`contain: strict` or `size`) on a layer absolutely
 *   placed in the lanes' grid column: WebKit then places it against the whole
 *   grid, so the playhead drew over the headers, 18 px in at a source
 *   playhead 112 s along. Chromium does not, which is how it shipped.
 */
const css = readFileSync(new URL("../styles/transcript-editor.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const rule = (selector: string) => css.match(new RegExp(`(?:^|\\n)${selector.replace(/[.]/g, "\\.")}\\s*\\{([^}]*)\\}`))?.[1] ?? null;

it("gives the track headers one fixed width, and the scroll bar starts where the lanes do", () => {
  expect(rule(".cp-te-tl-grid")).toMatch(/grid-template-columns:\s*var\(--te-head-w\)\s+minmax\(0,\s*1fr\)/);
  expect(rule(".cp-te-timeline")).toMatch(/--te-head-w:\s*\d+px/);
  expect(rule(".cp-te-tl-pan")).toMatch(/margin:[^;]*var\(--te-head-w\)/);
});

it("never size-contains a layer placed over the lanes", () => {
  const layers = [...css.matchAll(/(?:^|\n)(\.cp-te-tl-[\w-]+)\s*\{([^}]*)\}/g)]
    .filter(([, , body]) => /position:\s*absolute/.test(body) && /grid-column:\s*2/.test(body));
  // The playhead's layer, the dead-space layer and the empty card, at least.
  expect(layers.map(([, selector]) => selector)).toEqual(expect.arrayContaining([".cp-te-tl-overlay", ".cp-te-tl-deadlayer", ".cp-te-tl-empty"]));
  for (const [, selector, body] of layers) expect([selector, /contain:[^;]*\b(strict|size)\b/.test(body)]).toEqual([selector, false]);
});
