import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RUNGS, RUNG_HEIGHTS } from "./stream-rung";

const RUST = resolve(__dirname, "../../src-tauri/src/commands/rung.rs");

/** The `RUNGS` table out of rung.rs, snake_case fields and all. */
function rustRungs(): Array<{ height: number; videoKbps: number; audioKbps: number }> {
  const src = readFileSync(RUST, "utf8");
  const block = /pub\(crate\) const RUNGS: \[Rung; \d+\] = \[([\s\S]*?)\];/.exec(src);
  if (!block) throw new Error("RUNGS not found in rung.rs — the matcher broke, not the code");
  return [...block[1].matchAll(
    /Rung \{\s*height:\s*(\d+),\s*video_kbps:\s*(\d+),\s*audio_kbps:\s*(\d+)\s*\}/g,
  )].map((m) => ({ height: +m[1], videoKbps: +m[2], audioKbps: +m[3] }));
}

/**
 * The streaming quality ladder, which exists three times.
 *
 * rung.rs says it outright: "MUST stay identical to `RUNGS` in
 * src/lib/stream-rung.ts. The guest sends [the rung] and the host serves it."
 * That MUST is in capitals and enforced by nothing, which is the condition
 * this loop keeps finding on the losing side of a drift.
 *
 * What a mismatch costs is specific rather than cosmetic. CLAUDE.md's
 * co-review rule is that playback is "a fixed, known-quality stream — never a
 * real-time encode that degrades to fit the link", and that the ladder "picks
 * ONE known height and reports which the guest actually got". If the two
 * tables disagree, the guest asks for a rung by index and is served a
 * different bitrate, then TELLS THE REVIEWER the wrong one — and a reviewer
 * judging a grade has to know whether the compression they can see is in the
 * source or in the transport. Wrong metadata there is worse than a wrong
 * picture, because nothing looks broken.
 *
 * Identical at four rungs when this went in. It is the fifth, or a retune of
 * one bitrate on one side, that this exists for.
 */
describe("the rung ladder agrees across the boundary", () => {
  it("matches the Rust table rung for rung", () => {
    expect([...RUNGS]).toEqual(rustRungs());
  });

  it("really parsed the Rust table", () => {
    // A scraper that matches nothing reports perfect agreement.
    expect(rustRungs().length).toBeGreaterThan(2);
  });

  it("keeps RUNG_HEIGHTS in step with RUNGS", () => {
    // A third copy, in the same file as the second. The rung machine steps by
    // index, so these drifting apart would downshift to a height the table
    // does not describe.
    expect([...RUNG_HEIGHTS]).toEqual(RUNGS.map((r) => r.height));
  });

  it("is ordered best first, which is what stepping by index means", () => {
    const heights = RUNGS.map((r) => r.height);
    expect([...heights].sort((a, b) => b - a)).toEqual(heights);
  });

  it("drops bitrate as it drops height, or the ladder buys nothing", () => {
    // A rung that is smaller but not cheaper cannot help a struggling link,
    // and downshifting into it would stall twice for no reason.
    for (let i = 1; i < RUNGS.length; i += 1) {
      expect(RUNGS[i].videoKbps).toBeLessThan(RUNGS[i - 1].videoKbps);
      expect(RUNGS[i].audioKbps).toBeLessThanOrEqual(RUNGS[i - 1].audioKbps);
    }
  });
});
