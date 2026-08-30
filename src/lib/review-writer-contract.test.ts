import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A FEATURE CAN BE FULLY BUILT AND STILL HAVE NO WRITER.
 *
 * `screening-record-contract` was written after four screening fields turned
 * out to be declared, indexed, rendered and never assigned. This is the same
 * rule for `lib/review.ts`, and it found the same shape one module over.
 *
 * THE SOURCE-LEVEL VERDICT has no writer anywhere in production. `setStatus`
 * exists, the `status` ReviewOp arm applies it with LWW and a deterministic
 * tiebreak, `inverseReviewOps` can undo it, `statusOf` is read by App and by
 * the Markdown exporter, three chips render it, and session.rs carries an
 * anti-spoofing comment that names "stamp the source-level verdict" as the
 * attack its attribution prevents. All of that, for a value no user can set.
 * Every source reads Pending for ever, and the Markdown a client receives says
 * Pending about a cut the room approved.
 *
 * docs/DECISIONS.md says verdicts "already persist correctly". That is true of
 * the MECHANISM and false of the FEATURE: nothing can reach the mechanism.
 *
 * THE SCAN MUST BE IMPORT-AWARE, and this is not a detail. A bare identifier
 * search for `setStatus(` finds three unrelated `useState` setters - in
 * UpdateRow, YouTubeSettings and use-clip-queue - all genuinely called
 * `setStatus`. Written that way this contract reports the verdict as wired and
 * cannot fail. I measured both versions: the naive one flags two functions,
 * the import-aware one flags three, and the third is the finding.
 */

const SRC = join(__dirname, "..");

function mask(s: string): string {
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/** Exported functions of lib/review.ts that return a ReviewDoc. */
function updaters(): string[] {
  const src = readFileSync(join(SRC, "lib", "review.ts"), "utf8");
  const out: string[] = [];
  for (const chunk of src.split("\nexport function ").slice(1)) {
    const name = /^(\w+)/.exec(chunk)?.[1];
    const at = chunk.indexOf("): ReviewDoc {");
    // `\n}` before the signature means the search ran past this declaration.
    if (name && at >= 0 && !chunk.slice(0, at).includes("\n}")) out.push(name);
  }
  return out;
}

/** Names actually CALLED in production, having been imported from review. */
function calledFromReview(): Set<string> {
  const called = new Set<string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      // readdirSync, not globSync: CI pins Node 20.
      const full = join(dir, name);
      if (statSync(full).isDirectory()) { if (name !== "bindings") walk(full); continue; }
      if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
      if (full.endsWith(join("lib", "review.ts"))) continue;
      const src = mask(readFileSync(full, "utf8"));
      // local name -> EXPORTED name. `setStatus as setReviewVerdict` is
      // searched for as setReviewVerdict and recorded as setStatus. Taking
      // only one of the two silently breaks this: recording the local name
      // means `called` never contains the exported one, so an aliased import
      // reads as no caller at all - and searching for the exported name finds
      // nothing, because that identifier does not appear in the file.
      const imported = new Map<string, string>();
      for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"[^"]*\breview"\s*;/g)) {
        for (const part of m[1].split(",")) {
          const [orig, alias] = part.trim().split(/\s+as\s+/);
          const exported = orig?.replace(/^type\s+/, "").trim();
          const local = (alias ?? exported)?.trim();
          if (exported && local) imported.set(local, exported);
        }
      }
      const body = src.replace(/^import[\s\S]*?from\s+"[^"]*";$/gm, "");
      for (const [local, exported] of imported) {
        if (new RegExp(`\\b${local}\\s*\\(`).test(body)) called.add(exported);
      }
    }
  };
  walk(SRC);
  return called;
}

/**
 * Known-unwired, each with the reason. An entry here must still MATCH a real
 * updater, so a rename or a deletion fails rather than leaving a stale excuse.
 */
const UNWIRED: Record<string, string> = {
  // Internal helpers that happen to be exported for their own unit tests.
  // Both are called inside lib/review.ts; neither is part of its API.
  emptyDoc: "internal to review.ts; exported only for its unit tests",
  ensureCommentIds: "internal migration helper; exported only for its unit tests",
  // THE FINDING. Not a helper - a whole feature with no way in.
  setStatus: "NO WRITER: the source-level verdict cannot be set by any user. "
    + "Everything else exists (op, LWW, undo inverse, chips, export line). "
    + "Removing this entry is the acceptance test for wiring the verdict UI.",
};

describe("every review updater can actually be reached", () => {
  const ups = updaters();
  const called = calledFromReview();

  it("finds the updaters and the callers", () => {
    // CANARY on both halves: a changed signature style empties the first, a
    // changed import style empties the second, and either way the assertion
    // below passes over nothing.
    expect(ups.length, "no ReviewDoc updaters parsed").toBeGreaterThanOrEqual(12);
    expect(called.size, "no review imports resolved - the scan is not reading call sites")
      .toBeGreaterThanOrEqual(8);
  });

  it("has a production caller for each, or a stated reason", () => {
    const dead = ups.filter((u) => !called.has(u) && !(u in UNWIRED));
    expect(dead, "exported from lib/review.ts and reachable from nothing in production")
      .toEqual([]);
  });

  it("keeps no stale excuses", () => {
    // An allowlist entry that no longer matches an updater is a note about
    // code that is gone, and it would silently permit a NEW function of the
    // same name. Paying twice for the same list.
    const stale = Object.keys(UNWIRED).filter((n) => !ups.includes(n));
    expect(stale, "listed as unwired but no longer an updater").toEqual([]);

    const wiredNow = Object.keys(UNWIRED).filter((n) => called.has(n));
    expect(wiredNow, "now has a caller - delete its UNWIRED entry").toEqual([]);
  });
});
