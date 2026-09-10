import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const script = readFileSync(new URL("../../scripts/verify-bundle.sh", import.meta.url), "utf8");
const classification = script.match(/SIGNED_FOR_REAL=0\n[\s\S]*?\nesac/)?.[0];

describe("packaged certificate signature classification", () => {
  it("exercises the actual shell classification block", () => {
    expect(classification).toContain('case "${SIGINFO}"');
  });

  it.each([
    ["Signature size=4798\nAuthority=Apple Development: Test\nAuthority=Apple Root CA", "1:0"],
    ["Signature size=9000\nAuthority=Developer ID Application: Test", "1:0"],
    ["Signature=adhoc", "0:0"],
    ["Signature size=4798", "0:1"],
    ["", "0:1"],
  ])("classifies the macOS signature output without waiving deep verification", (signature, expected) => {
    if (!classification) throw new Error("Production signature classification block missing");
    const result = execFileSync("bash", ["-c", `
      pass() { :; }; warn() { :; }; fail() { FAILED=1; }
      FAILED=0; ALLOW_STUBS=0
      ${classification}
      printf '%s:%s' "$SIGNED_FOR_REAL" "$FAILED"
    `], { encoding: "utf8", env: { ...process.env, SIGINFO: signature } });
    expect(result).toBe(expected);
    expect(script).toContain('codesign --verify --deep --strict "${APP}"');
  });
});
