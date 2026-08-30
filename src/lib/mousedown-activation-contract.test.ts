import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A BUTTON WHOSE ONLY HANDLER IS onMouseDown CANNOT BE PRESSED BY KEYBOARD.
 *
 * Enter and Space on a focused button dispatch a `click`. They do not
 * dispatch `mousedown`. So `<button onMouseDown={…}>` with no `onClick` is
 * operable by pointer alone - WCAG 2.1.1, Level A - and it looks completely
 * ordinary in review, which is why nine of them shipped.
 *
 * The nine: the whole review EXPORT menu (Markdown, Avid, Premiere, Resolve,
 * Final Cut, CSV) and the past-reviews list (open, remove, clear all). A
 * keyboard user could open the menu, tab to "Avid Media Composer", press
 * Enter, and get silence. Confirmed in webkit as well as chromium, webkit
 * being the engine this app actually ships in.
 *
 * THE PARSER IS THE INTERESTING PART. The obvious regex for an opening tag -
 * `<button([^>]*)>` - is WRONG for JSX, because an arrow function contains a
 * `>`. `onMouseDown={(e) => e.stopPropagation()}` ends the tag early, so a
 * button carrying BOTH handlers reads as onMouseDown-only. The first version
 * of this scan reported two false positives for exactly that reason, and a
 * contract that cries wolf gets an allowlist entry rather than a fix. The
 * extractor below tracks brace depth and quotes, so a `>` only closes the tag
 * at depth zero.
 */

const COMPONENTS = join(__dirname, "..", "components");

/** Comments blanked, LENGTH AND NEWLINES PRESERVED, so reported line numbers
 *  still point at the real source. */
function mask(src: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, " ");
  return src
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/^[ \t]*\/\/.*$/gm, blank);
}

/** Opening `<button …>` tags: their attribute text and start offset. */
function buttonTags(src: string): { at: number; attrs: string }[] {
  const out: { at: number; attrs: string }[] = [];
  for (const m of src.matchAll(/<button\b/g)) {
    let i = m.index + m[0].length;
    let depth = 0;
    let quote = "";
    while (i < src.length) {
      const c = src[i];
      if (quote) {
        if (c === quote && src[i - 1] !== "\\") quote = "";
      } else if (c === '"' || c === "'" || c === "`") {
        quote = c;
      } else if (c === "{") { depth += 1; }
      else if (c === "}") { depth -= 1; }
      else if (c === ">" && depth === 0) {
        out.push({ at: m.index, attrs: src.slice(m.index + m[0].length, i) });
        break;
      }
      i += 1;
    }
  }
  return out;
}

describe("no button is pointer-only", () => {
  const files = readdirSync(COMPONENTS).filter((n) => n.endsWith(".tsx") && !n.includes(".test."));

  it("finds buttons to check", () => {
    // CANARY. An empty offender list is the expected result, so the scan must
    // prove it examined a real population - a broken extractor returning
    // nothing would report perfect conformance for ever.
    const total = files.reduce((n, f) =>
      n + buttonTags(mask(readFileSync(join(COMPONENTS, f), "utf8"))).length, 0);
    expect(total, "no <button> tags parsed - the extractor is broken").toBeGreaterThan(200);
  });

  it("every button that handles mousedown also handles click", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = mask(readFileSync(join(COMPONENTS, f), "utf8"));
      for (const { at, attrs } of buttonTags(src)) {
        if (!attrs.includes("onMouseDown") || attrs.includes("onClick")) continue;
        // ONE REASONED EXCEPTION, not a name allowlist. A role="option" inside
        // a combobox listbox is not activated by its own key events at all -
        // the input owns the arrow keys and Enter, and the option uses
        // mousedown with preventDefault precisely so the input does not blur
        // and unmount the list before the pick lands. Keyboard operability
        // lives on the input, and is real.
        if (/role="option"/.test(attrs)) continue;
        offenders.push(`${f}:${src.slice(0, at).split("\n").length}`);
      }
    }
    expect(offenders, "button is operable by pointer only (Enter/Space fire click, not mousedown)")
      .toEqual([]);
  });
});
