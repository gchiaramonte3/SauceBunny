import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(__dirname, "../..");
const script = join(ROOT, "scripts/prepare-ci-sidecars.mjs");
const temporary: string[] = [];
const suffix = "-aarch64-apple-darwin";

function fixture(names = ["yt-dlp", "deno", "saucebunny-capture"]) {
  const root = mkdtempSync(join(tmpdir(), "sauce-ci-sidecars-"));
  temporary.push(root);
  mkdirSync(join(root, "src-tauri/binaries"), { recursive: true });
  writeFileSync(join(root, "src-tauri/tauri.conf.json"), JSON.stringify({ bundle: {
    externalBin: names.map(name => `binaries/${name}`),
  } }));
  const binary = (name: string) => join(root, `src-tauri/binaries/${name}${suffix}`);
  const prepare = (args: string[] = [], ci = "true") => spawnSync(process.execPath, [script, root, ...args], {
    encoding: "utf8", env: { ...process.env, CI: ci }, timeout: 5000,
  });
  return { root, binary, prepare };
}

afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("CI sidecar preparation", () => {
  it("includes Deno and future declarations without another hand-maintained list", () => {
    const f = fixture(["yt-dlp", "deno", "future-capture"]);
    expect(f.prepare().status).toBe(0);
    for (const name of ["yt-dlp", "deno", "future-capture"]) {
      expect(statSync(f.binary(name)).size).toBe(0);
      expect(statSync(f.binary(name)).mode & 0o111).toBe(0o111);
    }
  });

  it("rejects missing or empty real Deno before creating any placeholder", () => {
    const f = fixture();
    for (const empty of [false, true]) {
      if (empty) writeFileSync(f.binary("deno"), "");
      const result = f.prepare(["--require-real", "deno"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Required real sidecar is missing or empty: deno");
      expect(existsSync(f.binary("yt-dlp"))).toBe(false);
    }
  });

  it("preserves real binary content and mode across repeated preparation", () => {
    const f = fixture();
    writeFileSync(f.binary("deno"), "verified-test-binary", { mode: 0o700 });
    for (let n = 0; n < 2; n++) expect(f.prepare(["--require-real", "deno"]).status).toBe(0);
    expect(readFileSync(f.binary("deno"), "utf8")).toBe("verified-test-binary");
    expect(statSync(f.binary("deno")).mode & 0o777).toBe(0o700);
  });

  it("rejects a non-executable required binary without repairing it", () => {
    const f = fixture();
    writeFileSync(f.binary("deno"), "not executable");
    chmodSync(f.binary("deno"), 0o600);
    expect(f.prepare(["--require-real", "deno"]).status).toBe(1);
    expect(statSync(f.binary("deno")).mode & 0o777).toBe(0o600);
    expect(existsSync(f.binary("yt-dlp"))).toBe(false);
  });

  it("cannot stub sidecars accidentally in a development invocation", () => {
    const f = fixture();
    const result = f.prepare([], "false");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("CI-only");
    expect(existsSync(f.binary("deno"))).toBe(false);
  });

  it("rejects unknown required names and invalid declarations", () => {
    const f = fixture();
    expect(f.prepare(["--require-real", "typo"]).stderr).toContain("not declared");
    for (const names of [["../outside"], ["deno", "deno"], []]) {
      const invalid = fixture(names);
      expect(invalid.prepare().status).toBe(1);
      expect(existsSync(invalid.binary("deno"))).toBe(false);
    }
  });

  it("does not follow a binary symlink", () => {
    const f = fixture();
    const target = join(f.root, "outside");
    writeFileSync(target, "unchanged");
    symlinkSync(target, f.binary("deno"));
    expect(f.prepare().status).toBe(1);
    expect(readFileSync(target, "utf8")).toBe("unchanged");
    expect(existsSync(f.binary("yt-dlp"))).toBe(false);
  });
});

describe("workflow sidecar contract", () => {
  it("uses the config-driven preparation in both regular CI native jobs", () => {
    const workflow = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(workflow.match(/node scripts\/prepare-ci-sidecars\.mjs \./g)).toHaveLength(2);
    expect(workflow).not.toMatch(/for (?:name|n) in yt-dlp/);
  });

  it("provisions and requires real Deno before the nightly test run", () => {
    const workflow = readFileSync(join(ROOT, ".github/workflows/nightly-sidecars.yml"), "utf8");
    const fetch = workflow.indexOf("run: bash scripts/fetch-deno.sh");
    const prepare = workflow.indexOf("node scripts/prepare-ci-sidecars.mjs . --require-real yt-dlp deno ffmpeg ffprobe whisper-cli");
    const tests = workflow.indexOf("run: cargo test --lib nightly_");
    expect(fetch).toBeGreaterThan(0);
    expect(prepare).toBeGreaterThan(fetch);
    expect(tests).toBeGreaterThan(prepare);
    expect(workflow).not.toMatch(/for name in yt-dlp/);
  });

  it("parses as a supported Node script", () => {
    expect(() => execFileSync(process.execPath, ["--check", script], { stdio: "pipe" })).not.toThrow();
  });
});
