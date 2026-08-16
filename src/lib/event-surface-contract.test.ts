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
  .filter((f) => !/\.test\.tsx?$/.test(f))
  // use-tauri-listeners DEFINES the `on(...)` helper rather than calling it,
  // and its docstring shows the call shape in prose. Scanning it reports the
  // example as a live subscription to an event nothing emits.
  .filter((f) => !f.endsWith("use-tauri-listeners.ts"));

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
  // `listen(...)` OR the `on(...)` handed out by use-tauri-listeners. Four
  // hooks moved onto that primitive and this contract found out the honest
  // way: its "no listens found" canary fired rather than the sweep quietly
  // reporting ten orphaned events.
  for (const m of text.matchAll(/\b(?:listen|on)\s*(?:<[^>]*>)?\(\s*"([a-z][a-z0-9:_-]*)"/g)) {
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

  it("names every listener handler after the event it handles", () => {
    // The mis-wire guard. `dcaef9d` kept these registrations sequential
    // because "several handlers share event shapes" - DoneEvent serves five
    // channels, LogEvent five, ProgressEvent three - so attaching the wrong
    // handler to the wrong event name type-checks perfectly and fails only at
    // runtime. That made the effect unsafe to restructure.
    //
    // Naming the handlers after their events turns that invisible mistake into
    // a visible one: `listen("captions-done", onClipDone)` fails here. It is
    // what makes splitting the 264-line listener effect by domain a reviewable
    // change rather than a leap.
    const pascal = (event: string) =>
      "on" + event.split(/[-:_]/).map((w) => w[0].toUpperCase() + w.slice(1)).join("");

    let checked = 0;
    const wrong: string[] = [];
    for (const f of tsFiles) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(/\b(?:listen|on)\s*(?:<[^>]*>)?\(\s*"([a-z][a-z0-9:_-]*)"\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
        const [, event, handler] = m;
        checked++;
        if (handler !== pascal(event)) {
          wrong.push(`${f.slice(ROOT.length + 1)}: listen("${event}", ${handler}) — expected ${pascal(event)}`);
        }
      }
    }
    expect(checked, "no named-handler registrations found").toBeGreaterThan(10);
    expect(wrong, "a listener is wired to a handler named for a different event").toEqual([]);
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
