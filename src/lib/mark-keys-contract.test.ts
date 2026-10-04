import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * One marking language, Avid's, in AAF Audio and String Outs.
 *
 * The two views were built separately and drifted: AAF Audio cleared marks
 * with G and String Outs with ⌥X (G did nothing there), String Outs had no Q
 * or W, and neither had D or F. Each keymap is a small table in its own file,
 * so the drift is invisible from either one. This reads both tables and
 * holds them to the same seven keys with the same meanings.
 */

const ROOT = resolve(__dirname, "../..");
const read = (file: string) => readFileSync(resolve(ROOT, file), "utf8");

/** Per file: each key and the text its binding must contain. */
const MAPS: Record<string, Record<string, RegExp>> = {
  "src/hooks/use-edit-keys.ts": {
    i: /\bi:\s*\(run, on\) => run\.mark\("in", on\)/, o: /\bo:\s*\(run, on\) => run\.mark\("out", on\)/,
    g: /\bg:\s*\(run, on\) => run\.clear\("both", on\)/, d: /\bd:\s*\(run, on\) => run\.clear\("in", on\)/, f: /\bf:\s*\(run, on\) => run\.clear\("out", on\)/,
    q: /\bq:\s*\(run, on\) => run\.go\("in", on\)/, w: /\bw:\s*\(run, on\) => run\.go\("out", on\)/,
  },
  "src/hooks/use-multitrack-keyboard.ts": {
    i: /\bi:\s*markIn\b/, o: /\bo:\s*markOut\b/, g: /\bg:\s*clear\b/, d: /\bd:\s*clearIn\b/, f: /\bf:\s*clearOut\b/, q: /\bq:\s*gotoIn\b/, w: /\bw:\s*gotoOut\b/,
  },
};

describe("marking keys", () => {
  for (const [file, keys] of Object.entries(MAPS)) {
    it(`${file} binds I, O, G, D, F, Q and W as Avid does`, () => {
      const source = read(file);
      // Canary: the file is the keymap it claims to be.
      expect(source).toMatch(/keydown/);
      const missing = Object.entries(keys).filter(([, pattern]) => !pattern.test(source)).map(([key]) => key.toUpperCase());
      expect(missing).toEqual([]);
    });
  }

  it("covers the same keys in both views", () => {
    const [first, second] = Object.values(MAPS).map((keys) => Object.keys(keys).sort());
    expect(first).toEqual(second);
    expect(first).toHaveLength(7);
  });
});
