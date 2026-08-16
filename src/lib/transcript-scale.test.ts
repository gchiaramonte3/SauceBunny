import { describe, expect, it } from "vitest";
import { parseSrt } from "./srt";
import { speakerStats, speakerLanes } from "./speaker-stats";

/**
 * The transcript pipeline at the sizes this app actually meets.
 *
 * A 2-hour interview is roughly 1,400 Whisper cues and a full-day shoot or a
 * deposition several thousand, so "does it still work at 4,000" is a product
 * question here, not a hypothetical.
 *
 * It does, comfortably: parse + derive is LINEAR and 8,000 cues (about eleven
 * hours of speech) costs ~10ms. Measured across 500/1000/2000/4000/8000 the
 * time doubles as the input doubles, with no bend.
 *
 * The reason to keep measuring is that this exact path used to be quadratic —
 * CLAUDE.md records the karaoke render's O(turns²) cue-offset scan being
 * replaced with memos keyed on turns/overrides. A quadratic regression would
 * be invisible on the 20-cue fixtures every other test uses, and would show up
 * for users as a transcript panel that stalls on long recordings.
 *
 * The guard is a RATIO with a very wide bound, not a wall-clock budget: 8,000
 * cues is 8x the work of 1,000, so anything under 20x is linear-ish on any
 * machine, while a return to O(n²) would be ~64x. A millisecond budget here
 * would flake on a loaded CI runner and teach everyone to ignore it.
 */

const tc = (x: number) => {
  const h = Math.floor(x / 3600);
  const m = Math.floor((x % 3600) / 60);
  const s = Math.floor(x % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},000`;
};

/** A transcript of `n` cues across six speakers, five seconds apart. */
function makeSrt(n: number): string {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const start = i * 5;
    out.push(
      `${i + 1}\n${tc(start)} --> ${tc(start + 4)}\n` +
      `[SPEAKER_${String(i % 6).padStart(2, "0")}]: line ${i} of dialogue here\n`,
    );
  }
  return out.join("\n");
}

function timeRun(n: number): number {
  const text = makeSrt(n);
  const t0 = performance.now();
  const cues = parseSrt(text);
  speakerStats(cues);
  speakerLanes(cues);
  return performance.now() - t0;
}

describe("a long transcript", () => {
  it("parses every cue of a multi-hour recording", () => {
    // 4,000 cues is ~5.5 hours at this spacing. Nothing may be silently
    // dropped: parseSrt skips cues it cannot read, so a fixture bug or a
    // narrowed timestamp matcher shows up here as a short count rather than
    // as missing dialogue on someone's screen.
    const cues = parseSrt(makeSrt(4000));
    expect(cues).toHaveLength(4000);
    expect(cues[0].start).toBe(0);
    expect(cues[3999].start).toBe(3999 * 5);
  });

  it("keeps cues in order and derives every speaker", () => {
    const cues = parseSrt(makeSrt(4000));
    for (let i = 1; i < cues.length; i++) {
      expect(cues[i].start).toBeGreaterThanOrEqual(cues[i - 1].start);
    }
    expect(speakerStats(cues)).toHaveLength(6);
    expect(speakerLanes(cues)).toHaveLength(4000);
  });

  it("scales linearly, not quadratically", () => {
    // Warm the JIT so the first sample is not the slow one, which would flip
    // the ratio the wrong way and fail for the wrong reason.
    timeRun(1000);
    const small = Math.max(timeRun(1000), 0.5);
    const large = timeRun(8000);
    const ratio = large / small;
    expect(
      ratio,
      `8000 cues took ${ratio.toFixed(1)}x the time of 1000 (8x is linear, ~64x is quadratic)`,
    ).toBeLessThan(20);
  });
});
