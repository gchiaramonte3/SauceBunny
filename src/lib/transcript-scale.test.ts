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
 * This file DELIBERATELY contains no timing assertion any more.
 *
 * It had one — a ratio, 8,000 cues against 1,000, bounded at 20x on the
 * argument that noise could not reach that when linear is 8x and quadratic is
 * ~64x. CI measured 23.7x and went red. At these magnitudes (1,000 cues is
 * ~2ms) a shared runner's noise dominates the signal, so the bound was
 * measuring the runner, not the code.
 *
 * It was also aimed at the wrong layer. The O(turns²) scan CLAUDE.md records
 * lived in the karaoke RENDER inside TranscriptViewer, not in parse/derive,
 * which was linear all along. A guard that is unreliable and points away from
 * the bug it names is worse than none: it trains people to re-run CI.
 *
 * What remains is what this file can assert honestly — that a multi-hour
 * transcript parses completely, in order, with every speaker derived.
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

});
