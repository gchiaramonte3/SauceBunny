import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * A `text-decoration` shorthand says one thing: which line, or none.
 *
 * WebKit accepts the shorthand's style and colour parts only from Safari 26.2.
 * The app's floor is macOS 14, whose WKWebView can be Safari 17, and there a
 * declaration like `text-decoration: underline dotted` is invalid as a whole,
 * so the underline itself disappears, silently. It shipped twice: a dotted
 * underline in the AI panel, and the strike-through on words the Transcript
 * Editor prototype removes. Style and colour go in their longhands, which
 * WebKit has read since Safari 12.1.
 */
const ROOT = resolve(__dirname, "../..");
const sheets = ["src/styles", "design-system"].flatMap((dir) =>
  readdirSync(join(ROOT, dir)).filter((name) => name.endsWith(".css")).map((name) => join(dir, name)));
const LINE = /^(none|underline|overline|line-through|inherit|initial|unset|revert)$/;

describe("text-decoration shorthand", () => {
  it("names only the line, so older WebKit keeps it", () => {
    const found: string[] = [], bad: string[] = [];
    for (const sheet of sheets) {
      const css = readFileSync(join(ROOT, sheet), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
      for (const match of css.matchAll(/(?:^|[;{\s])text-decoration\s*:\s*([^;}]+)/g)) {
        const value = match[1].trim().replace(/\s*!important$/, "");
        found.push(value);
        if (!value.split(/\s+/).every((part) => LINE.test(part))) bad.push(`${sheet}: text-decoration: ${value}`);
      }
    }
    expect(found.length).toBeGreaterThan(10);
    expect(bad).toEqual([]);
  });
});
