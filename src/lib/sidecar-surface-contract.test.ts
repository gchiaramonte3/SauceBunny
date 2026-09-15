import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The sidecars, across the five places that have to agree.
 *
 * `tauri.conf.json` decides what SHIPS. Rust decides what is SPAWNED. package.json
 * decides how each one is REBUILT. CLAUDE.md's table is what a human reads
 * before touching any of it — and that table had been two sidecars behind since
 * dictation and screen capture landed: both shipped in every build, both had
 * working build scripts, and neither appeared in the docs that state the
 * self-contained-binary rule and each binary's update path.
 *
 * SIDECAR-VERSIONS.md is the fifth, added after an open-source documentation
 * audit found its table listing five of the eight shipped binaries. It was
 * left out when this test was written, and it drifted for exactly the reason
 * the file above it did — which is the argument for guarding a document
 * rather than trusting it. The two tables are checked separately because
 * they are written differently: CLAUDE.md names the binary (`yt-dlp`),
 * SIDECAR-VERSIONS.md names the shipped file (`yt-dlp-aarch64-apple-darwin`).
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
// Capture uses Tokio directly so cancellation owns/reaps the process and both
// output streams are bounded. A path lookup alone is NOT proof of a spawn:
// require that same local binary to reach the bounded capture runner.
function resolvedCaptureSidecars(source: string): string[] {
  return [...source.matchAll(/let\s+binary\s*=\s*(?:super::)*sidecar_path\(\s*"([a-z0-9-]+)"\s*\)\?;/g)]
    .filter(match => /capture_output\(\s*&binary\s*,/.test(source.slice(match.index! + match[0].length).split(/^}/m)[0]))
    .map(match => match[1]);
}
const spawned = new Set([
  ...[...rust.matchAll(/\.sidecar\(\s*"([a-z0-9-]+)"/g)].map((m) => m[1]),
  ...resolvedCaptureSidecars(rust),
  ...[...rust.matchAll(/process::run\(\s*app,\s*job,\s*"[a-z0-9-]+",\s*"([a-z0-9-]+)"/g)].map((m) => m[1]),
]);

const claude = readFileSync(join(ROOT, "CLAUDE.md"), "utf8");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};

describe("the sidecar surface", () => {
  it("rebuilds the AAF reader before packaging rather than shipping a stale copied helper", () => {
    const build = readFileSync(join(ROOT, "scripts/build-app-with-ndi.sh"), "utf8");
    expect(build).toMatch(/bash scripts\/build-aaf\.sh[\s\S]+npx tauri build/);
  });
  it("routes AAF's named worker calls through the cancellable sidecar runner", () => {
    const runner = readFileSync(join(ROOT, "src-tauri/src/commands/aaf/process.rs"), "utf8");
    expect(runner).toContain("app.shell().sidecar(name)");
    expect(runner).toMatch(/command\.args\(args\)[\s\S]*?\.spawn\(\)/);
    expect(runner).toContain("registry.insert(key.clone(), child)");
    expect(runner).toContain("registry.take(&key)");
  });
  it("recognizes resolved capture paths only when the bounded runner spawns them", () => {
    expect(resolvedCaptureSidecars(rust)).toContain("saucebunny-capture");
    expect(resolvedCaptureSidecars(rust.replaceAll("capture_output(&binary,", "capture_output(&other,"))).not.toContain("saucebunny-capture");
    const runner = readFileSync(join(ROOT, "src-tauri/src/commands/capture_thumbnail.rs"), "utf8")
      .split("pub(super) async fn capture_output(")[1].split(/^}/m)[0];
    expect(runner).toMatch(/Command::new\(binary\)[\s\S]*?\.spawn\(\)\?/);
    expect(runner).toContain("kill_on_drop(true)");
  });
  it("found the declarations it compares", () => {
    expect(shipped.length, "no externalBin entries read").toBeGreaterThan(5);
    expect(spawned.size, "no .sidecar() calls found — the matcher broke").toBeGreaterThan(5);
  });

  it("ships nothing it cannot spawn", () => {
    // ffprobe is the documented exception: the app never spawns it. It rides
    // along so yt-dlp can find it beside ffmpeg (`--ffmpeg-location`).
    // Deno is likewise invoked by yt-dlp, through --js-runtimes deno:<bundled path>.
    const NOT_SPAWNED = new Set(["ffprobe", "deno"]);
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

  it("documents every shipped sidecar in SIDECAR-VERSIONS.md's table", () => {
    // That table carries each binary's UPDATE path, so a missing row means a
    // shipped binary nobody knows how to refresh - which for yt-dlp is the
    // difference between a working app and a broken one two months later.
    const versions = readFileSync(join(ROOT, "SIDECAR-VERSIONS.md"), "utf8");
    const undocumented = shipped.filter(
      (n) => !new RegExp(`\\|\\s*\`?${n}(-[a-z0-9_]+)*\`?\\s*\\|`).test(versions),
    );
    expect(undocumented, "shipped but missing from SIDECAR-VERSIONS.md").toEqual([]);
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
      "saucebunny-aaf": "build:aaf",
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
