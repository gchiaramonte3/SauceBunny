import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Every pane with a lasso agrees on what blank space is.
 *
 * `useMarquee`'s base rule is `e.target === e.currentTarget` - a press on the
 * scroll container itself. Two panes relied on that alone and got it for free
 * only while their empty area really was the container. Frames and the web
 * shelf named their wrappers via `gutterSelector`; the Library browser and
 * Review sessions named nothing, so a band could be drawn on blank space in
 * one section and not in another. Reported exactly that way: "in the review
 * session it does not lasso highlight the same way as the other pages".
 *
 * Nothing about that is visible at the call site. The pane compiles, the hook
 * runs, the band simply never starts - so the failure is a feature that is
 * quietly missing rather than a thing that breaks.
 *
 * The selector itself is shared (LASSO_GUTTER_SELECTOR) so the four panes
 * cannot drift apart on its CONTENTS; this pins that none of them opts out.
 */

const COMPONENTS = resolve(__dirname, "../components");

/** Files that call useMarquee, with their source. */
function marqueeCallers(): { file: string; src: string }[] {
  // readdirSync, not globSync: CI pins Node 20 and globSync is Node 22.
  return readdirSync(COMPONENTS)
    .filter((f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx"))
    .map((f) => ({ file: f, src: readFileSync(join(COMPONENTS, f), "utf8") }))
    .filter((f) => /\buseMarquee\s*\(/.test(f.src));
}

describe("the lasso's idea of blank space", () => {
  it("is declared by every pane that has a lasso", () => {
    const callers = marqueeCallers();
    // Canary. A scan that stops finding call sites reports a perfect result
    // for ever, and this one walks a directory by extension.
    expect(callers.length, "no useMarquee call sites found, so this asserted nothing")
      .toBeGreaterThanOrEqual(4);

    const silent = callers
      .filter((c) => !/gutterSelector\s*:/.test(c.src))
      .map((c) => c.file);
    expect(silent, `these panes have a lasso that cannot start on blank space:\n${silent.join("\n")}`)
      .toEqual([]);
  });

  it("is never the SAME literal typed into two panes", () => {
    // Not "never a literal": TranscriptReader's blank space is
    // `.cp-reader-group, .cp-reader-list`, which is genuinely its own markup
    // and would be nonsense in a library pane. What is not allowed is one
    // string living in two files - Frames and the web shelf carried
    // character-identical copies, and a copy of a selector is a selector that
    // gets extended in one place.
    const byLiteral = new Map<string, string[]>();
    for (const c of marqueeCallers()) {
      const m = c.src.match(/gutterSelector\s*:\s*["'`]([^"'`]+)["'`]/);
      if (!m) continue;
      byLiteral.set(m[1], [...(byLiteral.get(m[1]) ?? []), c.file]);
    }
    const shared = [...byLiteral.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([sel, files]) => `${files.join(" and ")} both type ${sel}`);
    expect(shared, shared.join("\n")).toEqual([]);
  });
});
