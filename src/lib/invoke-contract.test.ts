import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Invoke-boundary type contract.
 *
 * Every `invoke<T>()` is a promise about a shape Rust owns. When T is written
 * out at the call site instead of imported from `src/bindings/`, the promise is
 * a copy — and a copy of a struct is a struct that drifts, silently, because
 * nothing type-checks TypeScript against Rust.
 *
 * Three of these were found and fixed by hand on consecutive passes
 * (`YtdlpStatus`, `LatestRelease`, `LocalFileMeta`). All three were CORRECT at
 * the moment they were found — which is the whole problem: a mirror is right
 * until the day it isn't, and the day it isn't looks like a runtime undefined,
 * not a build failure. The hand sweep that found them also MISSED two of six,
 * because it grepped for a pattern that assumed the type argument and the
 * command name sat on the same line. Hence a test rather than more grepping.
 *
 * The rule: an inline object literal as an invoke type argument must be listed
 * below with a reason. The list is a ratchet — it may shrink, and an addition
 * to it should be argued for, not appended to get green.
 *
 * What this CAN catch: a new hand-written shape at the boundary, and a listed
 * exception that got fixed but stayed listed. What it CANNOT catch: a NAMED
 * type that is itself a hand-written mirror (`type Foo = { … }` next to an
 * `invoke<Foo>`). That residual is real; the named cases are at least greppable
 * by name against `src/bindings/`, which is how `DirectStream` was found.
 */

const ROOT = resolve(__dirname, "../..");

/**
 * Call sites allowed to declare their own shape, and why each one is not
 * simply an unfixed mirror.
 *
 * The three `serde_json::Value` entries are the same finding wearing three
 * hats: those commands were never typed on the RUST side, so there is no
 * binding to prefer. Fixing them means introducing structs in Rust and is a
 * deliberate change, not a sweep. They are listed here so that work has a
 * visible home rather than living in a commit message nobody re-reads.
 */
const ALLOWED: ReadonlyArray<readonly [file: string, why: string]> = [
  ["src/App.tsx", "peer_media_register_remote returns serde_json::Value — Rust never typed it"],
  ["src/components/PeerStreamSpike.tsx", "peer_media_register returns serde_json::Value — Rust never typed it"],
  ["src/hooks/use-co-review.ts", "session_offer_file returns serde_json::Value — Rust never typed it"],
  [
    "src/lib/media-devices.ts",
    "av_permission_status widens `screen` to optional ON PURPOSE, to tolerate a " +
      "Rust binary older than the field. AvAuthStatus has it required, so importing " +
      "the binding would delete that tolerance. Reading past this comment is the " +
      "only thing that stopped it being 'fixed'.",
  ],
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Files containing an inline object literal as an invoke type argument. */
function offenders(): string[] {
  const hits = new Set<string>();
  for (const file of walk(join(ROOT, "src"))) {
    const rel = file.slice(ROOT.length + 1);
    if (rel.startsWith("src/bindings/") || /\.test\.tsx?$/.test(rel)) continue;
    // `invoke<{` is the whole signature: the type argument opens with a brace
    // rather than an identifier. Multi-line literals match too, which the hand
    // sweep did not.
    if (/\binvoke<\s*\{/.test(readFileSync(file, "utf8"))) hits.add(rel);
  }
  return [...hits].sort();
}

describe("invoke boundary types", () => {
  it("declares no shape inline that Rust already generates", () => {
    const allowed = new Set(ALLOWED.map(([f]) => f));
    const unexpected = offenders().filter((f) => !allowed.has(f));
    expect(
      unexpected,
      `These declare an invoke shape inline. If src/bindings/ has the type, import it. ` +
        `If Rust returns serde_json::Value, or the widening is deliberate, add it to ` +
        `ALLOWED with the reason — the reason is the point, not the entry.`,
    ).toEqual([]);
  });

  it("keeps the exception list honest as sites get fixed", () => {
    // A stale entry is worse than none: it reads as "considered and allowed"
    // when it actually means "fixed, and nobody told the list".
    const actual = new Set(offenders());
    const stale = ALLOWED.map(([f]) => f).filter((f) => !actual.has(f));
    expect(stale, "listed as an allowed exception but no longer has one").toEqual([]);
  });

  it("gives every exception a reason someone can disagree with", () => {
    for (const [file, why] of ALLOWED) {
      expect(why.length, `${file} needs a real reason, not a placeholder`).toBeGreaterThan(30);
    }
  });
});

/**
 * Large payloads cross the boundary as a RAW body, never as a number array.
 *
 * `invoke(cmd, { bytes: Array.from(new Uint8Array(buf)) })` decimal-prints
 * every byte into a JSON string, synchronously, on the WKWebView main thread.
 * The clip exporter measured it at ~2s of frozen UI and ~2.2 GB peak for a
 * 100 MB clip, which is why `write_raw_to_path` exists. Two more sites kept
 * doing it anyway - the frame snapshot and the prepared WAV - because nothing
 * connected the fix to the pattern.
 *
 * The raw form is `invoke(cmd, uint8array, { headers: { ... } })`: a straight
 * buffer copy, with the small arguments riding in headers.
 */
describe("byte payloads use the raw IPC body", () => {
  const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  it("never marshals a buffer into a JS number array", () => {
    const bad = walk(join(ROOT, "src"))
      .map((f) => [f.slice(ROOT.length + 1), strip(readFileSync(f, "utf8"))] as const)
      .filter(([rel]) => rel !== "src/lib/invoke-contract.test.ts")
      .filter(([, code]) => /Array\.from\(\s*new\s+Uint8Array|\[\s*\.\.\.\s*new\s+Uint8Array/.test(code))
      .map(([rel]) => rel);
    expect(
      bad,
      "Pass the Uint8Array as the invoke payload with the small args in headers, " +
        "the way write_raw_to_path and stage_prepared_wav take it.",
    ).toEqual([]);
  });

  it("really is scanning files", () => {
    expect(walk(join(ROOT, "src")).length).toBeGreaterThan(50);
  });
});

/**
 * Files the user keeps are written atomically.
 *
 * `write_text_to_path` truncates the destination before writing unless it is
 * told otherwise, so a crash, a full disk or a yanked drive part-way through
 * leaves a short file wearing the name the user chose. The overwrite case is
 * the sharp one: export over a file you already have and the previous good
 * copy is gone before the new bytes land.
 *
 * The clip exporter was fixed for exactly this reason. Seven siblings were
 * not, and were found only by re-reading that change rather than trusting it:
 * transcript exports, the AI summary, review exports, the settings export, the
 * diagnostics report, and a .bak whose whole job is to be the good copy.
 *
 * The stores (review, screening, cast) already passed atomic. Now everything
 * does, so this has no exception list - if one is ever needed, the reason
 * belongs here next to the rule.
 */
describe("durable writes", () => {
  const CALL = /invoke\s*(?:<[^>]*>)?\s*\(\s*"write_text_to_path"\s*,/g;

  it("passes atomic on every write_text_to_path call", () => {
    const offenders: string[] = [];
    for (const file of walk(join(ROOT, "src"))) {
      const rel = file.slice(ROOT.length + 1);
      if (/\.test\.tsx?$/.test(rel)) continue;
      const code = readFileSync(file, "utf8");
      for (const m of code.matchAll(CALL)) {
        // Brace-match the argument object rather than reading to end of line:
        // several of these calls span five lines, and a line-based check
        // reported two false positives when I first ran it.
        let depth = 0, i = m.index! + m[0].length;
        for (; i < code.length; i += 1) {
          if (code[i] === "{") depth += 1;
          else if (code[i] === "}") { depth -= 1; if (depth === 0) break; }
        }
        const arg = code.slice(m.index! + m[0].length, i + 1);
        if (!arg.includes("atomic")) {
          offenders.push(`${rel}: ${arg.trim().slice(0, 60)}`);
        }
      }
    }
    expect(
      offenders,
      "Pass `atomic: true`. Without it the destination is truncated first, so " +
        "a failed write destroys the copy that was already there.",
    ).toEqual([]);
  });

  it("really found the calls", () => {
    const total = walk(join(ROOT, "src"))
      .filter((f) => !/\.test\.tsx?$/.test(f))
      .reduce((n, f) => n + [...readFileSync(f, "utf8").matchAll(CALL)].length, 0);
    expect(total, "no write_text_to_path calls found at all").toBeGreaterThan(5);
  });
});
