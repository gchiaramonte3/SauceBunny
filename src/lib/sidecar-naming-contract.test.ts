import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Every sidecar path a build script writes carries the platform triple.
 *
 * ARCHITECTURE.md: the eight executables in `src-tauri/binaries/` use "the
 * platform-tuple naming convention (`<name>-aarch64-apple-darwin`)". That is not
 * decoration — Tauri's `externalBin` resolves a sidecar by appending the target
 * triple, so a binary installed as plain `binaries/ffmpeg` is invisible to the
 * bundler and to `app.shell().sidecar()`. It is also how yt-dlp finds ffprobe: it
 * derives `ffprobe-<triple>` from the `--ffmpeg-location` path it is handed.
 *
 * `sidecar-surface-contract` already checks the four places that must agree about
 * WHICH sidecars exist — tauri.conf.json, the Rust sources, CLAUDE.md's table and
 * package.json's scripts. It never reads `scripts/` itself, so nothing checked how
 * the scripts NAME what they install. A script that dropped the suffix would
 * produce a build that looks fine until the sidecar is spawned, at which point the
 * app reports a missing binary for a file that is plainly sitting in the folder.
 *
 * Variable-named installs (`binaries/$1-aarch64-apple-darwin`) count: the suffix
 * is what is being checked, not the name in front of it.
 */

const ROOT = resolve(__dirname, "../..");
const SCRIPTS = resolve(ROOT, "scripts");

/** `<something>-<arch>-apple-darwin`, the only shape Tauri will resolve. */
const TRIPLE = /-(?:aarch64|x86_64)-apple-darwin\b/;

type Hit = { file: string; line: number; text: string };

/**
 * Every sidecar install target a script writes, comments excluded.
 *
 * Both spellings are needed and finding that out was the point of the canary
 * below. The scripts assign `BIN_DIR="${ROOT_DIR}/src-tauri/binaries"` and then
 * write `"${BIN_DIR}/<name>-<triple>"`, so a scan for the literal string
 * `binaries/` sees the variable DEFINITION and the explanatory comments and none
 * of the actual installs - four matches where there are a dozen writes. A guard
 * measuring the wrong thing while reporting success is the failure this file is
 * meant to prevent, so the canary insists on a realistic count.
 */
function binaryPaths(): Hit[] {
  const out: Hit[] = [];
  for (const f of readdirSync(SCRIPTS).filter((n) => n.endsWith(".sh"))) {
    readFileSync(join(SCRIPTS, f), "utf8").split("\n").forEach((raw, i) => {
      // Comments name paths while explaining them; a description is not a write.
      const line = raw.trimStart().startsWith("#") ? "" : raw.split("#")[0];
      // `${BIN_DIR}/leaf` is how every install is written; `binaries/leaf`
      // catches the few scripts that spell the directory out.
      for (const m of line.matchAll(/(?:\$\{BIN_DIR\}|binaries)\/([A-Za-z0-9_${}.\-]+)/g)) {
        out.push({ file: f, line: i + 1, text: `binaries/${m[1]}` });
      }
    });
  }
  return out;
}

const paths = binaryPaths();

describe("sidecar paths in build scripts", () => {
  it("are being found at all", () => {
    // Canary. Every assertion below filters this list; empty would pass forever.
    expect(readdirSync(SCRIPTS).filter((n) => n.endsWith(".sh")).length).toBeGreaterThan(5);
    expect(paths.length, "no binaries/ paths found in scripts - the scan broke").toBeGreaterThan(8);
  });

  it("all carry a platform triple", () => {
    // A directory reference (`binaries/` alone, or `binaries/` + a var that holds
    // a full name) is not a file install; only a concrete leaf is checked.
    const bad = paths
      .filter((h) => !TRIPLE.test(h.text) && !h.text.endsWith("/") && !/\$\{?\w+\}?$/.test(h.text))
      .map((h) => `${h.file}:${h.line}  ${h.text}`);
    expect([...new Set(bad)], "a sidecar path without the -<arch>-apple-darwin suffix").toEqual([]);
  });

  it("name only sidecars the app actually declares", () => {
    // Guards the other direction: a script installing something externalBin does
    // not list produces a binary nothing ships, which is dead weight nobody sees.
    const conf = JSON.parse(readFileSync(join(ROOT, "src-tauri/tauri.conf.json"), "utf8")) as {
      bundle?: { externalBin?: string[] };
    };
    const declared = new Set(
      (conf.bundle?.externalBin ?? []).map((p) => p.split("/").pop() ?? p),
    );
    expect(declared.size, "externalBin is empty - tauri.conf.json parse is wrong").toBeGreaterThan(5);
    const stray = [...new Set(
      paths
        .map((h) => h.text.replace("binaries/", "").replace(TRIPLE, ""))
        .filter((n) => n && !n.includes("$") && !n.includes("{") && !declared.has(n)),
    )];
    expect(stray, "a script installs a binary tauri.conf.json does not declare").toEqual([]);
  });
});
