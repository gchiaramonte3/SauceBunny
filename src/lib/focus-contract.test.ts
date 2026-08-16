import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Focus-contract guard (user directive, 2026-07-18): focus styles NEVER use
 * the green accent. A focused control brightens its outline toward white
 * (`--focus-ring` in base.css); composed fields (wrapper pill + borderless
 * inner input) brighten the wrapper via :focus-within and suppress the inner
 * ring. This test scans every CSS rule whose selector mentions :focus /
 * :focus-visible / :focus-within and fails if its declarations reference any
 * green-accent token or literal. There is no allowlist on purpose: if a
 * focus rule needs green, the design conversation has to happen first.
 */

const STYLES_DIR = path.resolve(__dirname, "../styles");
const GREEN =
  /--accent\b|--accent-rgb|--ella-green|--color-accent-green|108,\s*255,\s*141|#6cff8d|#88f362/i;

type Violation = { file: string; selector: string; decls: string };

function focusViolations(file: string, css: string): Violation[] {
  const out: Violation[] = [];
  // Comments can legally mention accent tokens (history, cross-references).
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  // Rough block parser: each "}"-terminated chunk ends with "selector {decls".
  // Nested @media headers land in the selector part, which is fine here.
  for (const chunk of stripped.split("}")) {
    const brace = chunk.lastIndexOf("{");
    if (brace < 0) continue;
    const selector = chunk.slice(0, brace).split("{").pop()?.trim() ?? "";
    const decls = chunk.slice(brace + 1);
    if (selector.includes(":focus") && GREEN.test(decls)) {
      out.push({ file, selector, decls: decls.trim().replace(/\s+/g, " ") });
    }
  }
  return out;
}

describe("focus contract", () => {
  it("no :focus rule references the green accent", () => {
    const files = fs.readdirSync(STYLES_DIR).filter((f) => f.endsWith(".css"));
    // A scanner that matches nothing certifies everything. Proven, not
    // hypothetical: breaking the file filter left this passing over ZERO
    // files while still reporting the rule as enforced.
    expect(files.length, "no stylesheets scanned").toBeGreaterThan(5);
    const violations = files.flatMap((f) =>
      focusViolations(f, fs.readFileSync(path.join(STYLES_DIR, f), "utf8")),
    );
    expect(
      violations,
      violations
        .map((v) => `${v.file}: "${v.selector}" -> ${v.decls}`)
        .join("\n"),
    ).toEqual([]);
  });

  it("the white focus token exists where the rule says it does", () => {
    const base = fs.readFileSync(path.join(STYLES_DIR, "base.css"), "utf8");
    expect(base).toContain("--focus-ring:");
  });
});
