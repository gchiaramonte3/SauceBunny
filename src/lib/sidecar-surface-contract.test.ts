import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The sidecars, across the four places that have to agree.
 *
 * `tauri.conf.json` decides what SHIPS. Rust decides what is SPAWNED. package.json
 * decides how each one is REBUILT. CLAUDE.md's table is what a human reads
 * before touching any of it — and that table had been two sidecars behind since
 * dictation and screen capture landed: both shipped in every build, both had
 * working build scripts, and neither appeared in the docs that state the
 * self-contained-binary rule and each binary's update path.
 *
 * That drift is invisible from any single file. Every one of them was
 * internally consistent; only the comparison shows it. Same shape as the
 * `llm-log` channel that was emitted to nobody.
 *
 * Binaries themselves are deliberately NOT asserted here: they are gitignored,
 * assembled by `npm run setup`, and stubbed in CI. `scripts/check-release.sh`
 * and `verify-bundle.sh` are where the real files get checked.
 */

const ROOT = resolve(__dirname, "../..");

const conf = JSON.parse(readFileSync(join(ROOT, "src-tauri/tauri.conf.json"), "utf8")) as {
  bundle: { externalBin?: string[] };
};
const shipped = (conf.bundle.externalBin ?? []).map((b) => b.replace(/^binaries\//, ""));

function rustSources(dir = join(ROOT, "src-tauri/src"), out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) rustSources(full, out);
    else if (entry.endsWith(".rs")) out.push(full);
  }
  return out;
}

const rust = rustSources().map((f) => readFileSync(f, "utf8")).join("\n");
const spawned = new Set([...rust.matchAll(/\.sidecar\(\s*"([a-z0-9-]+)"/g)].map((m) => m[1]));

const claude = readFileSync(join(ROOT, "CLAUDE.md"), "utf8");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

describe("the sidecar surface", () => {
  it("found the declarations it compares", () => {
    expect(shipped.length, "no externalBin entries read").toBeGreaterThan(5);
    expect(spawned.size, "no .sidecar() calls found — the matcher broke").toBeGreaterThan(5);
  });

  it("ships nothing it cannot spawn", () => {
    // ffprobe is the documented exception: the app never spawns it. It rides
    // along so yt-dlp can find it beside ffmpeg (`--ffmpeg-location`).
    const NOT_SPAWNED = new Set(["ffprobe"]);
    const orphans = shipped.filter((n) => !spawned.has(n) && !NOT_SPAWNED.has(n));
    expect(orphans, "bundled but never spawned").toEqual([]);
  });

  it("spawns nothing it does not ship", () => {
    const missing = [...spawned].filter((n) => !shipped.includes(n));
    expect(missing, "spawned by name but not bundled — 'sidecar not found' at runtime").toEqual([]);
  });

  it("documents every shipped sidecar in CLAUDE.md's table", () => {
    // The one that was actually broken. A binary with no row has no stated
    // update path and is invisible to anyone auditing what the app ships.
    const undocumented = shipped.filter((n) => !new RegExp(`\\|\\s*\`?${n}\`?\\s*\\|`).test(claude));
    expect(undocumented, "shipped but missing from the sidecar table").toEqual([]);
  });

  it("gives every sidecar we build ourselves an npm script", () => {
    // The bundled third-party binaries are fetched, not built; ours are built
    // from swift-sidecar/ and whisper.cpp/llama.cpp and each needs a recipe.
    // Spelled out, not derived: saucebunny-diariZE is built by build:diariZER.
    // A mechanical rule would have to special-case that anyway, and writing the
    // pairs down is what makes the odd one visible instead of surprising.
    const RECIPE: Record<string, string> = {
      "saucebunny-diarize": "build:diarizer",
      "saucebunny-dictate": "build:dictate",
      "saucebunny-capture": "build:capture",
    };
    const ours = shipped.filter((n) => n.startsWith("saucebunny-"));
    expect(ours.length).toBeGreaterThan(1);
    for (const n of ours) {
      const key = RECIPE[n];
      expect(key, `${n} has no recipe listed in this test`).toBeDefined();
      expect(Object.keys(pkg.scripts), `${n} has no ${key} script`).toContain(key);
    }
  });
});
