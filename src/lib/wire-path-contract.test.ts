import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { sanitizeDocForWire, emptyDoc, isHostLocalKey } from "./review";

/**
 * No filesystem path leaves this machine in a review doc.
 *
 * This is CLAUDE.md's rule for the co-review wire, and it is here because it
 * was broken once: a locally-keyed doc shipped the host's absolute path twice,
 * as `sourceKey` and inside every version's `path`, so guests received and
 * then PERSISTED strings like `/Users/<name>/Clients/<project>/cut.mov`.
 * sanitizeDocForWire exists to stop that and both current send sites use it.
 *
 * What nothing checked is the next send site. `session_broadcast` takes an
 * arbitrary message, so a third `kind: "reviewDoc"` written in a hurry -
 * during a merge, or by someone adding a "resend to a late joiner" path -
 * compiles, passes every test in review.test.ts, and quietly puts the host's
 * directory layout on somebody else's disk. The existing tests cover the
 * sanitiser. This covers the call sites.
 *
 * Proximity rather than dataflow: the sanitiser must appear within a few lines
 * of the send. That is enough for both real sites and cheap to reason about;
 * a send whose sanitisation happens somewhere distant would need to say so
 * here, which is the right amount of friction for this particular rule.
 */

const ROOT = resolve(__dirname, "../..");
const LOOKBACK = 6;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

function unsanitisedSends(): string[] {
  const bad: string[] = [];
  for (const file of walk(join(ROOT, "src"))) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!/kind:\s*"reviewDoc"/.test(line)) return;
      // BACKWARD only, and inclusive of the send line. The first version of
      // this looked forward too, and a careless send written immediately
      // above a correct one borrowed its neighbour's sanitiser and passed.
      // Sanitisation has to happen BEFORE the thing it sanitises.
      const window = lines.slice(Math.max(0, i - LOOKBACK), i + 1).join("\n");
      if (!window.includes("sanitizeDocForWire")) {
        bad.push(`${file.slice(ROOT.length + 1)}:${i + 1}`);
      }
    });
  }
  return bad;
}

describe("review docs on the wire carry no local paths", () => {
  it("sanitises at every reviewDoc send site", () => {
    expect(
      unsanitisedSends(),
      `A review doc is going on the wire without sanitizeDocForWire. That ships ` +
        `the host's absolute file path to every guest, who then persists it.`,
    ).toEqual([]);
  });

  it("still finds the send sites, so a pass means something", () => {
    // The failure mode of a scraper is matching nothing and reporting success.
    //
    // The floor is ONE, not the current count. There are two sends today, and
    // an earlier version of this asserted two - which would have failed the
    // build for consolidating them into a single helper, a change this guard
    // has no business having an opinion about. What it needs to catch is a
    // matcher that stopped matching, and one is enough for that.
    let sends = 0;
    for (const file of walk(join(ROOT, "src"))) {
      sends += (readFileSync(file, "utf8").match(/kind:\s*"reviewDoc"/g) ?? []).length;
    }
    expect(sends).toBeGreaterThanOrEqual(1);
  });

  it("strips the path shapes the guard is written for", () => {
    // POSIX, Windows and file:// - the three isHostLocalKey recognises. A key
    // it does NOT recognise passes through, which is correct for a URL and is
    // the reason this list is worth restating next to the sanitiser.
    for (const local of ["/Users/ada/cut.mov", "C:\\\\Clients\\\\cut.mov", "file:///Users/ada/cut.mov"]) {
      expect(isHostLocalKey(local)).toBe(true);
      expect(sanitizeDocForWire(emptyDoc(local), "fp-abc").sourceKey).toBe("fp-abc");
    }
    const url = "https://youtube.com/watch?v=x";
    expect(isHostLocalKey(url)).toBe(false);
    expect(sanitizeDocForWire(emptyDoc(url), "fp-abc").sourceKey).toBe(url);
  });

  it("falls back to a placeholder rather than the path when there is no wire key", () => {
    // The dangerous default: no fingerprint yet (a first review) is exactly
    // when sourceKey is still the raw local path.
    expect(sanitizeDocForWire(emptyDoc("/Users/ada/cut.mov"), null).sourceKey).toBe("shared-local");
    expect(sanitizeDocForWire(emptyDoc("/Users/ada/cut.mov"), "").sourceKey).toBe("shared-local");
  });
});
