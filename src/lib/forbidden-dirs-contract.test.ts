import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * The directory names CLAUDE.md forbids stay absent.
 *
 * It names them outright: no `utils/`, `helpers/`, `shared/`, `common/`, `core/`
 * ("put things where they're used"), no `services/` ("Tauri commands are the
 * service layer"), no `store/`, `state/`, `context/` ("hooks + Tauri events
 * handle state"), and no standalone `types/` directory (types are colocated;
 * `src/types.ts` as a single file is the sanctioned convention).
 *
 * The tree obeys all of it today. The guard exists because this is a rule that
 * only ever gets broken once — a `utils/` folder is never proposed, it just
 * appears in a diff alongside the thing that needed a helper, and by the time
 * anyone notices there are nine files in it and moving them is its own project.
 * A test is cheaper than that conversation.
 *
 * Directory NAMES only. Whether a given module is well-placed is a judgment call
 * and stays with the reviewer; this checks the one part that is mechanical.
 */

const ROOT = resolve(__dirname, "../..");
const SRC = resolve(ROOT, "src");

/** Parsed from CLAUDE.md so the guard and the doc cannot drift apart. */
function forbiddenNames(): string[] {
  const claude = readdirSync(ROOT).includes("CLAUDE.md")
    ? require("node:fs").readFileSync(join(ROOT, "CLAUDE.md"), "utf8") as string
    : "";
  const start = claude.indexOf("### Do not create these directories");
  if (start < 0) return [];
  const end = claude.indexOf("\n---", start);
  const section = claude.slice(start, end === -1 ? undefined : end);
  // Entries look like `` `utils/` `` — a backticked name ending in a slash.
  return [...new Set([...section.matchAll(/`([a-z]+)\/`/g)].map((m) => m[1]))];
}

const forbidden = forbiddenNames();

function allDirs(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const full = join(dir, e.name);
    out.push(full);
    allDirs(full, out);
  }
  return out;
}

const dirs = allDirs(SRC);

describe("forbidden directory names", () => {
  it("are readable from CLAUDE.md, and there are directories to check", () => {
    // Canary on both halves. An empty forbidden list would make the assertion
    // below pass while checking nothing, which is the failure this repo keeps
    // finding in its own scanners.
    expect(forbidden.length, "no forbidden names parsed from CLAUDE.md").toBeGreaterThan(6);
    expect(forbidden, "the list should still name utils/").toContain("utils");
    expect(dirs.length, "no directories found under src/ - the walk broke").toBeGreaterThan(3);
  });

  it("do not exist under src/", () => {
    const hits = dirs
      .filter((d) => forbidden.includes(d.split("/").pop() ?? ""))
      .map((d) => relative(ROOT, d));
    expect(hits, "a directory CLAUDE.md forbids by name").toEqual([]);
  });

  it("permits src/types.ts as a FILE, which is the sanctioned convention", () => {
    // The distinction matters: the rule bans a types/ directory, not the shared
    // types module. A guard that conflated them would push someone to delete the
    // file the doc explicitly blesses.
    const fs = require("node:fs") as typeof import("node:fs");
    expect(fs.existsSync(join(SRC, "types.ts")), "src/types.ts went missing").toBe(true);
    expect(fs.existsSync(join(SRC, "types")), "src/types/ exists as a directory").toBe(false);
  });
});
