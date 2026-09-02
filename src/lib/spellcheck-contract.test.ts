import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Spell-check is enabled by a user default, not by an HTML attribute.
 *
 * This exists because the opposite belief survived in this codebase for
 * months and got stronger every time it was restated. It began as a comment
 * on the sidebar's filename input - "`lang="en"` is required for WKWebView to
 * actually render the underline (r43)" - was repeated with a hedge in the
 * transcript search bar, then flatly as a platform fact in the review
 * composer, then in a commit message, then in HAND-TEST, then in the
 * CHANGELOG that ships to users. The evidence never grew. Nothing tested it.
 *
 * Measured with a standalone WKWebView probe: three textareas, one with
 * spellcheck + lang="en", one with spellcheck only, one with no attributes.
 * With WebContinuousSpellCheckingEnabled absent, NONE were underlined. With it
 * set, ALL THREE were, including the bare one. WebKit reads that key in
 * TextCheckerMac.mm; an absent key is NO and no markup can override it.
 *
 * `lang` could never have been the cause either way: index.html has declared
 * `<html lang="en">` since the first commit and lang is inherited.
 */

const SRC = join(__dirname, "..");
const RUST = join(SRC, "../src-tauri/src");
const KEY = "WebContinuousSpellCheckingEnabled";

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name);
    if (f.isDirectory()) { if (f.name !== "bindings") out.push(...tsxFiles(p)); }
    else if (/\.tsx?$/.test(f.name) && !/\.test\.tsx?$/.test(f.name)) out.push(p);
  }
  return out;
}

describe("spellcheck-contract", () => {
  const files = tsxFiles(SRC).map((p) => [p.slice(SRC.length + 1), readFileSync(p, "utf8")] as const);
  const system = readFileSync(join(RUST, "commands/system.rs"), "utf8");
  const lib = readFileSync(join(RUST, "lib.rs"), "utf8");

  it("finds the sources it is policing", () => {
    expect(files.length, "no TS sources scanned - the walk broke").toBeGreaterThan(50);
    expect(files.some(([, t]) => /spellCheck/.test(t)), "nothing declares spellCheck any more").toBe(true);
  });

  it("the app turns the WebKit default on, and only when the user has never chosen", () => {
    expect(system, `${KEY} is no longer set anywhere`).toMatch(new RegExp(KEY));
    // Set-if-absent, not set-always: WebKit's own right-click menu writes this
    // same key, so a user who turned it OFF must stay off across relaunches.
    expect(system, "the enabler no longer checks whether the key is absent first")
      .toMatch(/objectForKey\(&key\)\.is_none\(\)/);
    expect(lib, "the enabler is never called from setup").toMatch(/enable_spellcheck_once\(\)/);
  });

  it("no comment claims the lang attribute is what enables spell-check", () => {
    // The exact shape of the folklore: `lang` in the same breath as the
    // underline being rendered/enabled/required.
    const guilty: string[] = [];
    for (const [file, text] of files) {
      for (const m of text.matchAll(/[^\n]*\blang\b[^\n]*/g)) {
        const line = m[0];
        if (!/lang="en"|lang=\{|`lang`/.test(line)) continue;
        if (/\b(required|enables?|makes?|missing piece|inert|nudges)\b/i.test(line)
            && !/NOT\b|not what|never did|no-op|is inherited/i.test(line)) {
          guilty.push(`${file}  ${line.trim().slice(0, 110)}`);
        }
      }
    }
    expect(
      guilty,
      "a comment credits `lang` with enabling spell-check. It does not: WebKit gates the underline on the\n" +
        `${KEY} user default, and index.html has declared lang="en" since the first commit anyway:`,
    ).toEqual([]);
  });

  it("the app's main prose surface does not pin a language", () => {
    // Pinning `lang` on a note field overrides NSSpellChecker's automatic
    // language detection, so a reviewer writing French gets every word
    // flagged. It buys nothing, because <html lang="en"> is inherited.
    const review = files.find(([f]) => f.endsWith("ReviewPanel.tsx"));
    expect(review, "ReviewPanel.tsx not found").toBeTruthy();
    const composer = review![1].slice(review![1].indexOf("function ReviewComposer"));
    expect(composer, "the comment textarea pins a language again").not.toMatch(/^\s*lang="en"$/m);
  });
});
