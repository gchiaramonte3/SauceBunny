import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A DRAG-ONLY RESIZE HANDLE HAS NO KEYBOARD PATH AT ALL.
 *
 * The app has four `cp-resize-handle` splitters. Two - the library tree and
 * the transcripts picker - carried tabIndex, an onKeyDown and a title reading
 * "arrow keys to nudge · Home to reset". Two did not: the queue drawer's width
 * and the review composer's height, both `role="separator"` with an
 * aria-label, both operable by pointer alone (WCAG 2.1.1, Level A; also 2.5.7
 * Dragging Movements in WCAG 2.2).
 *
 * The role makes it worse rather than better. A focusable separator is ARIA's
 * window splitter, which is expected to answer arrows - so the markup
 * advertised a control to a screen reader and then offered no way to work it.
 *
 * Nothing caught this, and nothing could: `target-size.spec.ts` reaches the
 * Clip workbench and the Settings modal, and none of the four handles renders
 * in either. So this is a source scan, the tool that fits a population the
 * browser cannot reach.
 */

const COMPONENTS = join(__dirname, "..", "components");

/** Opening tags carrying the shared handle class, brace- and quote-aware: an
 *  arrow function's `>` must not end the tag early. */
function handleTags(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/<div\b/g)) {
    let i = m.index + m[0].length, depth = 0, quote = "";
    while (i < src.length) {
      const c = src[i];
      if (quote) { if (c === quote && src[i - 1] !== "\\") quote = ""; }
      else if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      else if (c === ">" && depth === 0) {
        const tag = src.slice(m.index, i);
        if (tag.includes("cp-resize-handle")) out.push(tag);
        break;
      }
      i += 1;
    }
  }
  return out;
}

describe("every resize handle can be worked from the keyboard", () => {
  const found: { file: string; tag: string }[] = [];
  for (const name of readdirSync(COMPONENTS)) {
    if (!name.endsWith(".tsx") || name.includes(".test.")) continue;
    const src = readFileSync(join(COMPONENTS, name), "utf8");
    for (const tag of handleTags(src)) found.push({ file: name, tag });
  }

  it("finds the handles", () => {
    // CANARY: a renamed class empties this and every assertion below passes
    // over nothing.
    expect(found.length, "no cp-resize-handle elements found").toBeGreaterThanOrEqual(4);
  });

  it("each is focusable and answers keys", () => {
    const bad = found
      .filter((h) => !/tabIndex=\{0\}/.test(h.tag) || !/onKeyDown=/.test(h.tag))
      .map((h) => h.file);
    expect(bad, "resize handle is operable by pointer only").toEqual([]);
  });

  it("each says so, so the affordance is discoverable", () => {
    // A keyboard path nobody can find is only half a fix - and the two that
    // were already correct set the wording.
    const bad = found
      .filter((h) => !/arrow keys to nudge/.test(h.tag))
      .map((h) => h.file);
    expect(bad, "handle does not mention its keyboard path in the title").toEqual([]);
  });
});
