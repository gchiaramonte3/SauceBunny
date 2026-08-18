import { describe, expect, it } from "vitest";
import { buildSourcePrefix, fitTranscript, transcriptBudget } from "./prompt-prefix";
import { buildChapterPrompt } from "./chapters";

/**
 * One transcript ingestion should serve every feature.
 *
 * llama-server reuses the KV cache for whatever PREFIX a new prompt shares with
 * the last one. On this machine a feature-length transcript is ~10k tokens at
 * ~180 tok/s, so getting that reuse is the difference between 56 seconds and
 * nothing at all — per summary, per chapter run, per chat question.
 *
 * These pin the property that makes it possible and is otherwise invisible: the
 * expensive block is byte-identical across features and nothing variable is
 * allowed in front of it. A regression here breaks no behaviour at all. It just
 * makes the app slow again, which reads as "local models are slow".
 */

const LINES = Array.from({ length: 400 }, (_, i) => `[${i}:00] Speaker: line number ${i} of the talk.`);

describe("the shared source prefix", () => {
  it("is identical for the same source and context window", () => {
    expect(buildSourcePrefix(LINES, 8192).system).toBe(buildSourcePrefix(LINES, 8192).system);
  });

  it("is what chapters sends as its system message, verbatim", () => {
    // The whole point. If chapters wraps or prepends anything, the summary's
    // ingestion stops counting and the transcript is read twice.
    const { system } = buildSourcePrefix(LINES, 8192);
    const msgs = buildChapterPrompt(system, 3600, false);
    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content, "chapters altered the shared prefix").toBe(system);
  });

  it("keeps the chapter rules in the user turn, after the transcript", () => {
    const { system } = buildSourcePrefix(LINES, 8192);
    const msgs = buildChapterPrompt(system, 3600, false);
    expect(msgs[1].role).toBe("user");
    expect(msgs[1].content).toContain("Segment this transcript into chapters");
    expect(msgs[1].content, "the rules dragged the transcript along with them")
      .not.toContain("=== TRANSCRIPT ===");
  });

  it("holds nothing that varies between runs", () => {
    // A timestamp, a style, a question — anything per-run in here costs the
    // whole ingestion. Checked as a property: two prefixes built from the same
    // inputs at different moments must not differ.
    const a = buildSourcePrefix(LINES, 8192).system;
    const b = buildSourcePrefix([...LINES], 8192).system;
    expect(a).toBe(b);
    expect(a).not.toMatch(/bullet|numbered|prose|brief|detailed/i);
  });

  it("samples evenly rather than truncating the end away", () => {
    // Head-truncation is what the summary used to do, so on a two-hour video it
    // answered from the first hour and could not know the rest existed.
    const { text, sampled } = fitTranscript(LINES, 600);
    expect(sampled).toBe(true);
    const kept = text.split("\n");
    expect(kept.length).toBeGreaterThan(1);
    const lastKept = Number(kept[kept.length - 1].match(/\[(\d+):00\]/)![1]);
    expect(lastKept, "sampling never reached the back half of the video")
      .toBeGreaterThan(LINES.length / 2);
  });

  it("does not sample at all when the whole thing fits", () => {
    const { text, sampled } = fitTranscript(LINES, 10_000_000);
    expect(sampled).toBe(false);
    expect(text.split("\n")).toHaveLength(LINES.length);
  });

  it("stays inside the budget it was given", () => {
    for (const budget of [200, 1000, 5000]) {
      expect(fitTranscript(LINES, budget).text.length).toBeLessThanOrEqual(budget);
    }
  });

  it("scales the budget with the context window", () => {
    expect(transcriptBudget(40960)).toBeGreaterThan(transcriptBudget(8192));
  });
});
