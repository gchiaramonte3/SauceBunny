import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * One version, declared in four places, and a build number that is shown.
 *
 * Two separate failures produced this file, both invisible until someone tried
 * to tell two builds apart.
 *
 * The first: `scripts/set-version.sh` is the single source of the version and
 * nothing requires anyone to run it. Four DMGs went out over three weeks as
 * "Sauce Bunny_0.2.0_aarch64.dmg" with CFBundleVersion 2026072401 — the same
 * filename and the same build number on four different commits, so the only
 * way to know which one was installed was to remember.
 *
 * The second: the About tab's own comment said "the build number distinguishes
 * two DMGs of the same version" and the JSX below it rendered `v{appVersion}`,
 * the semver alone. The number named as the distinguishing one was never on
 * screen. That is the sixth time in this codebase a description of a behaviour
 * has stood in for the behaviour.
 *
 * So: the four declarations must agree, and the one surface that reports the
 * version to a user must include the build number.
 */

const ROOT = resolve(__dirname, "../..");
const read = (p: string) => readFileSync(resolve(ROOT, p), "utf8");

describe("the release version", () => {
  const pkg = JSON.parse(read("package.json")) as { version: string; scripts: Record<string, string> };
  const conf = JSON.parse(read("src-tauri/tauri.conf.json")) as {
    version: string; bundle?: { macOS?: { bundleVersion?: string } };
  };
  const cargo = read("src-tauri/Cargo.toml");

  it("is the same semver in all three manifests", () => {
    const pkgVer = pkg.version;
    // Only the [package] version, never a dependency's.
    const cargoVer = cargo.split(/^\[/m).find((s) => s.startsWith("package]"))
      ?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    expect(conf.version, "tauri.conf.json disagrees with package.json").toBe(pkgVer);
    expect(cargoVer, "Cargo.toml disagrees with package.json").toBe(pkgVer);
  });

  it("carries a dated CFBundleVersion, so same-semver builds differ", () => {
    const bv = conf.bundle?.macOS?.bundleVersion;
    expect(bv, "no bundleVersion — run npm run set-version").toBeDefined();
    // YYYYMMDDNN. The shape is the point: a plain counter would not tell you
    // WHEN, and "when" is what identifies a build you were handed.
    expect(bv, `bundleVersion "${bv}" is not YYYYMMDDNN`).toMatch(/^\d{10}$/);
  });

  it("has a build command that stamps before it bundles", () => {
    // The recurrence guard. `tauri build` on its own is what shipped four
    // identical DMGs; the stamp has to be attached to the build, not to
    // somebody's memory.
    const dmg = pkg.scripts["build:dmg"] ?? "";
    expect(dmg, "no build:dmg script").not.toBe("");
    expect(dmg, "build:dmg must run set-version first").toMatch(/set-version\.sh\s*&&/);
  });

  it("shows the build number in About, not just the semver", () => {
    const about = read("src/components/SettingsModal.tsx");
    // The version line must interpolate the injected build number. Asserted on
    // the source because the value is a vite `define`, and the bug being
    // guarded is a rendering omission, not a value.
    // The line that actually PRINTS the version, not the wrapper div above it.
    const line = about.split("\n").find((l) => l.includes("`v${appVersion}"));
    expect(about, "__BUILD_NUMBER__ is never referenced in Settings").toContain("__BUILD_NUMBER__");
    expect(line ?? "", "the About version line dropped the build number")
      .toMatch(/__BUILD_NUMBER__/);
  });

  it("injects the build number from tauri.conf.json, not a second copy", () => {
    // Two hand-maintained numbers would drift, and the drift would be silent.
    const vite = read("vite.config.ts");
    expect(vite).toContain("__BUILD_NUMBER__");
    expect(vite, "the injected value must come from tauri.conf.json")
      .toContain("tauri.conf.json");
  });
});
