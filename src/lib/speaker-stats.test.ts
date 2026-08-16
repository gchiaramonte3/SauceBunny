import { describe, expect, it } from "vitest";
import { speakerStats, speakerLanes, fmtTalkSeconds, fmtTalkTime } from "./speaker-stats";
import type { Cue } from "./srt";

// Speaker analytics feed two visible surfaces — the header Insights popover
// and the timeline speaker lanes — so the merging/splitting rules and the
// share math are pinned here against the Cue[] contract (start/end in
// SECONDS, speaker nullable).

let nextIndex = 1;
function cue(start: number, end: number, speaker: string | null, text = "hello there world"): Cue {
  return { index: nextIndex++, start, end, text, speaker };
}

describe("speakerStats", () => {
  it("returns [] for empty cues", () => {
    expect(speakerStats([])).toEqual([]);
  });

  it("computes talk time, share, turns and wpm for two alternating speakers", () => {
    const cues = [
      cue(0, 10, "SPEAKER_00", "one two three four"),
      cue(10, 20, "SPEAKER_01", "five six"),
      cue(20, 30, "SPEAKER_00", "seven eight nine"),
      cue(30, 40, "SPEAKER_01", "ten"),
    ];
    const stats = speakerStats(cues);
    expect(stats).toHaveLength(2);

    const s0 = stats.find((s) => s.speaker === "SPEAKER_00")!;
    const s1 = stats.find((s) => s.speaker === "SPEAKER_01")!;
    // 20s each of a 40s conversation.
    expect(s0.talkMs).toBe(20_000);
    expect(s1.talkMs).toBe(20_000);
    expect(s0.sharePct).toBeCloseTo(50, 5);
    expect(s1.sharePct).toBeCloseTo(50, 5);
    expect(s0.sharePct + s1.sharePct).toBeCloseTo(100, 5);
    // Alternation means every cue is its own turn.
    expect(s0.turns).toBe(2);
    expect(s1.turns).toBe(2);
    // Words counted from cue text; wpm over own talk time.
    expect(s0.words).toBe(7);
    expect(s1.words).toBe(3);
    expect(s0.wpm).toBeGreaterThan(0);
    expect(s1.wpm).toBeGreaterThan(0);
    // 7 words in 20s = 21 wpm exactly.
    expect(s0.wpm).toBeCloseTo(21, 5);
  });

  it("tracks the longest single turn per speaker", () => {
    const cues = [
      cue(0, 10, "A"),   // turn 1: 10s
      cue(15, 19, "A"),  // ≥1.5s gap → turn 2: 4s
    ];
    const stats = speakerStats(cues);
    expect(stats).toHaveLength(1);
    expect(stats[0].turns).toBe(2);
    expect(stats[0].longestTurnMs).toBe(10_000);
    expect(stats[0].talkMs).toBe(14_000);
  });
});

describe("speakerLanes", () => {
  it("returns [] for empty cues", () => {
    expect(speakerLanes([])).toEqual([]);
  });

  it("merges consecutive same-speaker cues and bridges sub-1.5s gaps", () => {
    const cues = [
      cue(0, 2, "A"),
      cue(3, 5, "A"), // 1.0s gap → bridged into the same lane
    ];
    const lanes = speakerLanes(cues);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toEqual({ speaker: "A", startMs: 0, endMs: 5000 });
  });

  it("splits on a speaker change", () => {
    const cues = [
      cue(0, 2, "A"),
      cue(2, 4, "B"),
      cue(4, 6, "A"),
    ];
    const lanes = speakerLanes(cues);
    expect(lanes).toHaveLength(3);
    expect(lanes.map((l) => l.speaker)).toEqual(["A", "B", "A"]);
  });

  it("splits the same speaker on a gap of 1.5s or more", () => {
    const cues = [
      cue(0, 2, "A"),
      cue(3.6, 5, "A"), // 1.6s gap → new lane
    ];
    const lanes = speakerLanes(cues);
    expect(lanes).toHaveLength(2);
    expect(lanes[0].endMs).toBe(2000);
    expect(lanes[1].startMs).toBe(3600);
  });
});

describe("fmtTalkTime", () => {
  it("formats seconds-only durations", () => {
    expect(fmtTalkTime(42_000)).toBe("42s");
  });

  it("formats minutes with zero-padded seconds", () => {
    expect(fmtTalkTime(725_000)).toBe("12m 05s");
  });

  it("formats hours with zero-padded minutes", () => {
    expect(fmtTalkTime(3_720_000)).toBe("1h 02m");
  });
});

describe("fmtTalkSeconds", () => {
  it("reads in seconds under a minute", () => {
    expect(fmtTalkSeconds(0)).toBe("0s");
    expect(fmtTalkSeconds(1.4)).toBe("1s");
    expect(fmtTalkSeconds(59)).toBe("59s");
  });

  it("switches to whole minutes, then hours", () => {
    expect(fmtTalkSeconds(60)).toBe("1m");
    expect(fmtTalkSeconds(3599)).toBe("59m");
    expect(fmtTalkSeconds(3600)).toBe("1h");
    expect(fmtTalkSeconds(3600 + 30 * 60)).toBe("1h 30m");
  });

  it("drops the redundant minutes on a whole hour", () => {
    // One of the four copies printed "2h" and the rest "2h 0m", for the same
    // speaker on the same screen.
    expect(fmtTalkSeconds(7200)).toBe("2h");
    expect(fmtTalkSeconds(7260)).toBe("2h 1m");
  });

  it("clamps a negative to zero", () => {
    // The other drift: the roster row had no clamp, so a cue whose end
    // precedes its start rendered "-3s" there and "0s" in the three panels
    // beside it.
    expect(fmtTalkSeconds(-3)).toBe("0s");
    expect(fmtTalkSeconds(-0.4)).toBe("0s");
  });

  it("is not the millisecond one", () => {
    // Two helpers, different units. 5000 here is 83 minutes, not 5 seconds —
    // pinned so a caller that passes the wrong unit fails loudly in review
    // rather than quietly on screen.
    expect(fmtTalkSeconds(5000)).toBe("1h 23m");
    expect(fmtTalkTime(5000)).toBe("5s");
  });
});

