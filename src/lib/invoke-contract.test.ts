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
