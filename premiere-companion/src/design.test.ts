import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { manifest } from "../uxp.config";

describe("native companion design contract", () => {
  const css = readFileSync(new URL("./panel.css", import.meta.url), "utf8");
  const tokens = readFileSync(new URL("../../src/styles/tokens.css", import.meta.url), "utf8");
  it("uses the actual application palette, typography and bevels without a second theme", () => {
    expect(css).toContain('@import "../../src/styles/tokens.css"');
    const referenced = [...css.matchAll(/var\((--[\w-]+)\)/g)].map(match => match[1]);
    expect(referenced.length).toBeGreaterThan(25);
    for (const name of referenced) expect(tokens, name).toContain(`${name}:`);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    for (const name of ["--bevel-raised", "--bevel-raised-hover", "--bevel-pressed", "--font-sans", "--danger-text"])
      expect(referenced).toContain(name);
  });
  it("keeps compact checkbox art within a full target and uses neutral focus", () => {
    expect(css).toMatch(/cp-companion-toggle[^}]*min-height: 30px/);
    expect(css).toMatch(/cp-companion-toggle input[^}]*width: 13px; height: 13px/);
    expect(css).toContain("accent-color: var(--bg-5)");
    expect(css).toContain("outline: 2px solid var(--fg-0)");
    expect(css).not.toMatch(/\b(?:animation|transition)\s*:/);
    expect(manifest.featureFlags.CSSNextSupport).toEqual(["boxShadow"]);
  });
  it("does not layer a second contour over native UXP fields and buttons", () => {
    expect(css).toMatch(/cp-companion-native input\[type="password"\][^{]*\{[^}]*border: none;[^}]*padding: 0/);
    expect(css).toMatch(/cp-companion-native button\s*\{[^}]*border: none;[^}]*box-shadow: none/);
    expect(css).toMatch(/cp-companion-section\s*\{[^}]*margin-top:/);
    expect(css).not.toMatch(/cp-companion-section\s*\{[^}]*border/);
  });
});
