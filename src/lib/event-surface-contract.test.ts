import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Tauri EVENT names, across the Rust/TS boundary.
 *
 * `ipc-surface-contract` does this for commands — every registered command is
 * called, every invoked command is registered. Events had no equivalent, and
 * they fail more quietly: an `invoke` of a missing command rejects, while an
 * emit nobody listens to is simply silence. Nothing rejects, nothing logs,
 * the feature just does not happen.
 *
 * That is not hypothetical. `llm-log` was emitted by Rust from the day the AI
 * Summary feature landed — with a comment stating it drains llama-server's
 * stderr to the Pipeline log — and the listener was never written. Model load
 * progress and the reason a server refused to start went nowhere for the
 * feature's whole life, which made a slow first summary look identical to a
 * hung one.
 *
 * Frontend-only channels are excluded by prefix, not by name: `panel:*` is the
 * main window talking to the panel window, so Rust legitimately never emits it.
 */

const ROOT = resolve(__dirname, "../..");

/** Channels both ends of which are the frontend (cross-window bus). */
const FRONTEND_ONLY = /^panel:/;

function walk(dir: string, test: (f: string) => boolean, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "target" || entry === ".build") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, test, out);
    else if (test(entry)) out.push(full);
  }
  return out;
}

const rustFiles = walk(join(ROOT, "src-tauri/src"), (f) => f.endsWith(".rs"));
const tsFiles = walk(join(ROOT, "src"), (f) => /\.tsx?$/.test(f))
  .filter((f) => !/\.test\.tsx?$/.test(f));

/** Event names Rust emits. */
const emitted = new Map<string, string[]>();
for (const f of rustFiles) {
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(/\.emit(?:_to)?\(\s*(?:[A-Za-z_:.]+\s*,\s*)?"([a-z][a-z0-9:_-]*)"/g)) {
    const at = emitted.get(m[1]) ?? [];
    at.push(f.slice(ROOT.length + 1));
    emitted.set(m[1], at);
  }
}

/** Event names the frontend listens for. */
const listened = new Map<string, string[]>();
for (const f of tsFiles) {
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(/\blisten\s*(?:<[^>]*>)?\(\s*"([a-z][a-z0-9:_-]*)"/g)) {
    const at = listened.get(m[1]) ?? [];
    at.push(f.slice(ROOT.length + 1));
    listened.set(m[1], at);
  }
}

describe("the Tauri event surface", () => {
  it("scanned both sides", () => {
    // Either half reading zero would make every assertion below vacuous.
    expect(rustFiles.length, "no Rust sources scanned").toBeGreaterThan(5);
    expect(tsFiles.length, "no TS sources scanned").toBeGreaterThan(80);
    expect(emitted.size, "no emits found — the matcher stopped working").toBeGreaterThan(10);
    expect(listened.size, "no listens found — the matcher stopped working").toBeGreaterThan(10);
  });

  it("has a listener for every event Rust emits", () => {
    const orphans = [...emitted.keys()]
      .filter((name) => !listened.has(name))
      .map((name) => `${name}  (emitted from ${emitted.get(name)!.join(", ")})`);
    expect(orphans, "emitted with nobody listening — the work is done and thrown away").toEqual([]);
  });

  it("listens only for events something actually emits", () => {
    const ghosts = [...listened.keys()]
      .filter((name) => !emitted.has(name) && !FRONTEND_ONLY.test(name))
      .map((name) => `${name}  (listened in ${listened.get(name)!.join(", ")})`);
    expect(ghosts, "listening for a channel nothing sends — a dead handler").toEqual([]);
  });

  it("keeps the cross-window bus namespaced", () => {
    // The exclusion above is a prefix rule, so it only stays honest while the
    // frontend-only channels keep using it.
    const frontendOnly = [...listened.keys()].filter((n) => !emitted.has(n));
    expect(frontendOnly.length).toBeGreaterThan(0);
    for (const name of frontendOnly) {
      expect(FRONTEND_ONLY.test(name), `${name} is frontend-only but not under panel:`).toBe(true);
    }
  });
});
