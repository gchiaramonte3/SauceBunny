import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = readFileSync(new URL("../../scripts/check-notarization-ready.sh", import.meta.url), "utf8");
const presenceCheck = script.match(/REQUIRED_SIDECARS="[^"]+"\nfor req in \$REQUIRED_SIDECARS; do[\s\S]*?\ndone/)?.[0];
const config = JSON.parse(readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8")) as {
  bundle: { externalBin: string[] };
};
const bundled = config.bundle.externalBin.map(path => path.replace(/^binaries\//, ""));
// A minimal arm64 Mach-O header, only inspected with file(1), never executed.
const macho = Buffer.alloc(32);
macho.writeUInt32LE(0xfeedfacf, 0);
macho.writeUInt32LE(0x0100000c, 4);
macho.writeUInt32LE(2, 12);

function checkDeno(contents: Buffer | null) {
  if (!presenceCheck) throw new Error("Production required-sidecar check missing");
  const root = mkdtempSync(join(tmpdir(), "sauce-release-sidecars-"));
  try {
    const binaries = join(root, "src-tauri/binaries");
    mkdirSync(binaries, { recursive: true });
    for (const name of bundled) {
      const bytes = name === "deno" ? contents : macho;
      if (bytes !== null) writeFileSync(join(binaries, `${name}-aarch64-apple-darwin`), bytes);
    }
    // Exercise the real shell block, not the rest of the release script: no
    // binaries run, no credentials are read, and the checkout stays untouched.
    return spawnSync("bash", ["-c", `
      set -uo pipefail
      fail=0
      pass() { printf '%s\\n' "$1"; }
      fatal() { printf '%s\\n' "$1"; fail=$((fail + 1)); }
      ${presenceCheck}
      exit "$fail"
    `], { encoding: "utf8", env: { PATH: process.env.PATH, ROOT_DIR: root, LC_ALL: "C" } });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

describe("release required-sidecar preflight", () => {
  it("requires every configured sidecar, including Deno", () => {
    expect(bundled).toContain("deno");
    const required = presenceCheck?.match(/REQUIRED_SIDECARS="([^"]+)"/)?.[1].split(/\s+/);
    expect(required?.sort()).toEqual([...bundled].sort());
  });

  it.each([
    ["missing", null, "deno MISSING"],
    ["empty", Buffer.alloc(0), "deno is a 0-byte stub"],
    ["non-executable text", Buffer.from("not a binary\n"), "deno is not a Mach-O executable"],
  ] as const)("rejects %s Deno before pin or signing checks", (_label, contents, expected) => {
    const result = checkDeno(contents);
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(expected);
  });

  it("accepts present Mach-O inputs at the presence stage", () => {
    const result = checkDeno(macho);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("deno present + non-empty Mach-O");
  });
});
