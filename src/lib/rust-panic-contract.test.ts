import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const RUST = resolve(__dirname, "../../src-tauri/src");

/**
 * Production Rust does not panic.
 *
 * A panic inside a Tauri command is not a caught error — it unwinds a task in
 * the app's own process, and on this app that costs the user whatever was
 * in flight: a transcription mid-run, an export mid-write, a live co-review
 * session. CLAUDE.md's error-handling section describes the migration to
 * `Result<T, AppError>` as finished, and this is the check that keeps it so.
 *
 * A sweep found the codebase already clean, which is worth recording rather
 * than assuming: 16,000 lines of non-test Rust contain two `.expect()` calls,
 * both listed below, and nothing else.
 *
 * The first version of this sweep reported ZERO, which was wrong. It treated
 * everything after the first `#[cfg(test)]` as test code, so in any file with
 * a test module in the middle - library.rs has one at line 479 - the entire
 * rest of the file went unscanned. The brace-matched version below found
 * sixteen hits the naive one had hidden.
 */

/** Test-support files whose panics are correct: a broken fixture SHOULD stop. */
const TEST_SUPPORT = ["nightly.rs"];

/** Production panics that are argued for rather than overlooked. */
const ALLOWED: ReadonlyArray<readonly [file: string, needle: string, why: string]> = [
  ["lib.rs", "error while building tauri application",
    "Tauri's own startup boilerplate. If the app cannot be built there is no app to return an error to"],
  ["stream_proxy.rs", "static header",
    "constructing a fixed HeaderValue from a literal; it cannot fail, and threading a Result out of it would be noise"],
];

/**
 * Strip `#[cfg(test)] mod ... { }` bodies by brace matching, plus comments,
 * REPLACING each removed line with an empty one.
 *
 * Blanking rather than deleting keeps line numbers aligned with the real file.
 * The first version deleted them, so the offender it reported pointed at a
 * completely different function 80 lines away, and I went and read the wrong
 * code. A finding you cannot locate is barely a finding.
 */
function productionCode(src: string): string {
  const lines = src.split("\n");
  const blank = new Set<number>();
  let i = 0;
  for (;;) {
    const j = src.indexOf("#[cfg(test)]", i);
    if (j === -1) break;
    const k = src.indexOf("{", j);
    if (k === -1) break;
    let depth = 0, m = k;
    for (; m < src.length; m += 1) {
      if (src[m] === "{") depth += 1;
      else if (src[m] === "}") { depth -= 1; if (depth === 0) break; }
    }
    const from = src.slice(0, j).split("\n").length - 1;
    const to = src.slice(0, m).split("\n").length - 1;
    for (let n = from; n <= to; n += 1) blank.add(n);
    i = m + 1;
  }
  return lines
    .map((l, n) => (blank.has(n) ? "" : l))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, (m2) => m2.replace(/[^\n]/g, ""))
    .replace(/\/\/[^\n]*/g, "");
}

function rustFiles(): Array<[rel: string, code: string]> {
  const out: Array<[string, string]> = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith(".rs")) out.push([full.slice(RUST.length + 1), readFileSync(full, "utf8")]);
    }
  };
  walk(RUST);
  return out;
}

const PANICS = [/\.unwrap\(\)/, /\.expect\(/, /\bpanic!\(/, /\bunreachable!\(/, /\btodo!\(/];

function offenders(): string[] {
  const out: string[] = [];
  for (const [rel, raw] of rustFiles()) {
    if (TEST_SUPPORT.includes(rel)) continue;
    const code = productionCode(raw);
    for (const [n, line] of code.split("\n").entries()) {
      const l = line.trim();
      if (!PANICS.some((re) => re.test(l))) continue;
      if (ALLOWED.some(([f, needle]) => rel === f && l.includes(needle))) continue;
      out.push(`${rel}:${n + 1}  ${l.slice(0, 80)}`);
    }
  }
  return out;
}

describe("production Rust cannot panic", () => {
  it("really scanned the crate", () => {
    // A walker that finds nothing certifies everything.
    const files = rustFiles();
    expect(files.length).toBeGreaterThan(8);
    const lines = files.reduce((n, [, c]) => n + productionCode(c).split("\n").length, 0);
    expect(lines, "too little code scanned to be reading the real crate").toBeGreaterThan(8000);
  });

  it("has no unargued unwrap, expect, panic, unreachable or todo", () => {
    expect(
      offenders(),
      "A panic in a command takes the app down with the user's in-flight work. " +
        "Return Result<T, AppError>, or add it to ALLOWED with the reason it cannot fail.",
    ).toEqual([]);
  });

  it("keeps the allowed list honest", () => {
    // An entry that no longer matches anything reads as a considered
    // exception when it actually means the code moved and nobody looked.
    const stale = ALLOWED.filter(([f, needle]) => {
      const hit = rustFiles().find(([rel]) => rel === f);
      return !hit || !productionCode(hit[1]).includes(needle);
    }).map(([f, needle]) => `${f}: ${needle}`);
    expect(stale, "listed as an allowed panic but no longer present").toEqual([]);
  });

  it("excludes test support for a stated reason, not silently", () => {
    // nightly.rs drives the real sidecars; a missing model or a failed spawn
    // SHOULD stop that run loudly. It ships in no user-facing path.
    for (const f of TEST_SUPPORT) {
      const hit = rustFiles().find(([rel]) => rel === f);
      expect(hit, `${f} is excluded but does not exist`).toBeTruthy();
      expect(hit![1]).toMatch(/smoke tests|nightly/i);
    }
  });
});
