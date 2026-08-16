import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * No production Rust panics, because a panic here is not an error message.
 *
 * A `.unwrap()` inside a `#[tauri::command]` does not surface as a red toast.
 * It unwinds the command's thread: the invoke never resolves, so the frontend
 * `await` hangs forever with no rejection to catch, and any `Mutex` the thread
 * held is left POISONED, which turns one bad input into every later lock
 * failing. The JobRegistry is a `Mutex<HashMap<..>>`, so a single panic while
 * holding it would take cancellation down for the rest of the session. The
 * whole `AppError` system exists so failures come back as values instead.
 *
 * The surface is genuinely clean today: 211 `.unwrap()`s and 37 `.expect()`s
 * in the tree, and every one of them is test code except the two allowed
 * below. This test is what keeps the next one from being the first real one.
 *
 * TWO MEASUREMENTS OF THIS WERE WRONG BEFORE THIS FILE EXISTED, both in the
 * direction of false comfort, which is why the scoping below is fussy:
 *
 *  1. "First `#[cfg(test)]` in the file, ignore everything after" reported
 *     ZERO panic sites. `lib.rs` declares `#[cfg(test)] mod nightly;` on line
 *     5, so that rule treated the entire application as test code.
 *  2. Matching only inline `#[cfg(test)] mod tests { .. }` blocks then flagged
 *     13 sites in `nightly.rs`, which is gated at its `mod` DECLARATION and
 *     ships in nothing.
 *
 * So both forms are handled: an inline block is skipped by brace matching, and
 * a file gated at its declaration is skipped wholesale. Each rule has a test
 * below proving it still recognises the thing it is supposed to skip - a
 * scoping rule that quietly stops matching would empty this scan and pass.
 */

const ROOT = resolve(__dirname, "../../src-tauri");
const SRC = join(ROOT, "src");

/** Every .rs file under src-tauri/src. */
function rustFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...rustFiles(p));
    else if (name.endsWith(".rs")) out.push(p);
  }
  return out;
}

/** Modules gated at their declaration: `#[cfg(test)] mod foo;` in any file. */
function declarationGatedModules(files: string[]): Set<string> {
  const gated = new Set<string>();
  for (const f of files) {
    const s = readFileSync(f, "utf8");
    for (const m of s.matchAll(/#\[cfg\(test\)\]\s*(?:pub\s+)?mod\s+(\w+)\s*;/g)) {
      gated.add(m[1]);
    }
  }
  return gated;
}

/** Byte spans of inline `#[cfg(test)] mod name { .. }` blocks. */
function inlineTestSpans(s: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const m of s.matchAll(/#\[cfg\(test\)\]\s*(?:pub\s+)?mod\s+\w+\s*\{/g)) {
    let i = m.index! + m[0].length - 1;
    let depth = 0;
    for (; i < s.length; i++) {
      if (s[i] === "{") depth++;
      else if (s[i] === "}" && --depth === 0) break;
    }
    spans.push([m.index!, i]);
  }
  return spans;
}

const PANIC = /\.unwrap\(\)|\.expect\(|(?<![a-z_])panic!\(|unreachable!\(|todo!\(/g;

/**
 * The two that are allowed, each for a stated reason. Adding to this list is
 * the deliberate act; a new panic anywhere else fails.
 */
const ALLOWED: Array<{ file: string; why: string }> = [
  {
    file: "src/lib.rs",
    why: "tauri::Builder::build's own boilerplate. It panics at startup before any window exists, so there is no UI to report into and nothing to poison.",
  },
  {
    file: "src/stream_proxy.rs",
    why: "Header::from_bytes on a CORS value that came out of a PARSED request header and passed cors_origin_for's allowlist, so it is a valid header value by construction.",
  },
];

const files = rustFiles(SRC);
const gatedMods = declarationGatedModules(files);

function productionPanics(): Array<{ file: string; line: number; text: string }> {
  const hits: Array<{ file: string; line: number; text: string }> = [];
  for (const f of files) {
    const rel = relative(ROOT, f);
    const stem = f.split("/").pop()!.replace(/\.rs$/, "");
    if (gatedMods.has(stem)) continue;           // whole file is test-only
    const s = readFileSync(f, "utf8");
    const spans = inlineTestSpans(s);
    const lines = s.split("\n");
    for (const m of s.matchAll(PANIC)) {
      const at = m.index!;
      if (spans.some(([a, b]) => at >= a && at <= b)) continue;
      const line = s.slice(0, at).split("\n").length;
      const text = lines[line - 1].trim();
      if (text.startsWith("//") || text.startsWith("*")) continue;
      hits.push({ file: rel, line, text });
    }
  }
  return hits;
}

describe("production Rust cannot panic", () => {
  it("is actually scanning the tree", () => {
    // Canary. Every assertion here is "found nothing unexpected", which is
    // exactly the shape that passes forever once a scan silently stops.
    expect(files.length, "no .rs files found under src-tauri/src").toBeGreaterThan(10);
    const totalPanicSites = files
      .map((f) => (readFileSync(f, "utf8").match(PANIC) ?? []).length)
      .reduce((a, b) => a + b, 0);
    expect(totalPanicSites, "the panic matcher found nothing in ANY file, including tests")
      .toBeGreaterThan(100);
  });

  it("still recognises both ways a test module is scoped", () => {
    // Rule 1 caught nothing and rule 2 over-caught, in the two earlier
    // versions of this measurement. If either scoping rule stops matching,
    // the scan goes quiet in the direction that passes.
    expect(gatedMods, "no `#[cfg(test)] mod x;` declaration found - rule 2 broke")
      .toContain("nightly");
    const withInline = files.filter((f) => inlineTestSpans(readFileSync(f, "utf8")).length > 0);
    expect(withInline.length, "no inline `#[cfg(test)] mod tests { }` block found - rule 1 broke")
      .toBeGreaterThan(5);
  });

  it("has no panic outside the two allowed sites", () => {
    const allowedFiles = new Set(ALLOWED.map((a) => a.file));
    const offenders = productionPanics().filter((h) => !allowedFiles.has(h.file));
    expect(
      offenders.map((o) => `${o.file}:${o.line}  ${o.text}`),
      "a panic in a command handler hangs the invoke forever and poisons any Mutex it held - return an AppError instead",
    ).toEqual([]);
  });

  it("keeps each allowed site earning its exemption", () => {
    // An allowlist entry that no longer matches anything is a rule that has
    // quietly stopped being enforced. This makes the exemption pay twice.
    const hits = productionPanics();
    for (const a of ALLOWED) {
      expect(
        hits.some((h) => h.file === a.file),
        `${a.file} is allowlisted but has no panic site - drop the entry`,
      ).toBe(true);
    }
    expect(hits.length, "the allowlist should cover exactly the known sites").toBe(2);
  });
});
