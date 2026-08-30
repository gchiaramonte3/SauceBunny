import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A CHOSEN SEGMENT THAT EXISTS ONLY AS A CSS CLASS IS INVISIBLE.
 *
 * Seven `.cp-segmented` pickers - export format, quality, frame rate, summary
 * format and length, browser cookies, preview quality - rendered as a bare
 * `<div>` over plain `<button>`s whose selected state was `className="active"`
 * and a `::before` pill sliding behind them. No role, no aria-checked, no
 * group name. Every button announced identically whether it was the chosen one
 * or not, and nothing said the seven belonged together (WCAG 4.1.2).
 *
 * The app already had the right pattern in-house: AiApiSettings' provider
 * picker is `role="radiogroup"` over `role="radio" aria-checked`. These seven
 * predated it.
 *
 * SCOPED PER CONTAINER, and that is not fussiness. The first version counted
 * `aria-checked` across the whole FILE, and Sidebar has a `role="switch"`
 * elsewhere - so deleting the segment's aria-checked left the count intact and
 * the mutation passed. A guard that counts the right things in the wrong scope
 * is a guard that cannot fail.
 */

const COMPONENTS = join(__dirname, "..", "components");

/** The JSX of each `.cp-segmented` element, from its opening tag to its
 *  matching close - so an assertion about a picker cannot be satisfied by an
 *  unrelated control elsewhere in the file. */
function segmentedBlocks(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/className="cp-segmented"/g)) {
    // Back up to the opening `<div`.
    let start = m.index;
    while (start > 0 && !(src[start] === "<" && src.startsWith("<div", start))) start--;
    // Forward to the matching `</div>`, counting nested divs.
    let i = start, depth = 0, end = src.length;
    while (i < src.length) {
      if (src.startsWith("<div", i)) { depth++; i += 4; continue; }
      if (src.startsWith("</div>", i)) { depth--; i += 6; if (depth === 0) { end = i; break; } continue; }
      i++;
    }
    out.push(src.slice(start, end));
  }
  return out;
}

function files() {
  return readdirSync(COMPONENTS)
    .filter((n) => n.endsWith(".tsx") && !n.includes(".test."))
    .map((file) => ({
      file,
      src: readFileSync(join(COMPONENTS, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, ""),
    }))
    .flatMap(({ file, src }) => segmentedBlocks(src).map((block) => ({ file, block })));
}

describe("a segmented picker says which segment is chosen", () => {
  const pickers = files();

  it("finds the pickers", () => {
    // CANARY: a renamed class, or a block extractor that stops working, empties
    // this and every assertion below passes over nothing.
    expect(pickers.length, "no .cp-segmented pickers found").toBeGreaterThanOrEqual(7);
    // And the blocks are real JSX, not zero-length slices.
    expect(Math.min(...pickers.map((p) => p.block.length)), "a picker block came back empty")
      .toBeGreaterThan(120);
  });

  it("each is a named radiogroup", () => {
    const bad = pickers
      .filter((p) => !/role="radiogroup"/.test(p.block) || !/aria-label=/.test(p.block))
      .map((p) => p.file);
    expect(bad, ".cp-segmented without a named role=radiogroup").toEqual([]);
  });

  it("each segment states whether it is the chosen one", () => {
    const bad = pickers.filter((p) => !/aria-checked=/.test(p.block)).map((p) => p.file);
    expect(bad, "segment buttons never say whether they are selected").toEqual([]);
  });
});
