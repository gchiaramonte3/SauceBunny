import { describe, expect, it } from "vitest";
import {
  DEFAULT_MARKER_SETTINGS,
  RATE_TABLE,
  durationFrames,
  frameIndex,
  framesToRational,
  framesToTc,
  secondsToRational,
  tcStartRational,
  tcToFrames,
  totalFrames,
  type MarkerExportSettings,
} from "./marker-time";

// The whole point of this module: playhead seconds are real elapsed <video>
// time, but NLEs place markers by frame. The spec §3 sample (three notes at
// 38s / 60→90s / 253s, Start TC 01:00:00:00) is the golden fixture — 23.976
// NDF drifts, 24.000p is clean. These vectors are exact by contract.

const S976: MarkerExportSettings = {
  frameRate: "23.976",
  sequenceStartTc: "01:00:00:00",
  dropFrame: false,
};
const S24: MarkerExportSettings = { ...S976, frameRate: "24" };

describe("rate table", () => {
  it("carries two rates per key and marks drop-frame only for the NTSC broadcast rates", () => {
    expect(RATE_TABLE["23.976"].fpsExact).toEqual({ num: 24000, den: 1001 });
    expect(RATE_TABLE["29.97"].fpsExact).toEqual({ num: 30000, den: 1001 });
    expect(RATE_TABLE["23.976"].timebase).toBe(24);
    expect(RATE_TABLE["23.976"].ntsc).toBe(true);
    expect(RATE_TABLE["24"].ntsc).toBe(false);
    expect(RATE_TABLE["29.97"].dropAllowed).toBe(true);
    expect(RATE_TABLE["59.94"].dropAllowed).toBe(true);
    // Everything else is non-drop.
    for (const k of ["23.976", "24", "25", "30", "50", "60"] as const) {
      expect(RATE_TABLE[k].dropAllowed).toBe(false);
    }
  });

  it("defaults to 23.976 / 01:00:00:00 / non-drop", () => {
    expect(DEFAULT_MARKER_SETTINGS).toEqual({
      frameRate: "23.976",
      sequenceStartTc: "01:00:00:00",
      dropFrame: false,
    });
  });
});

describe("spec §3 sample — 23.976 NDF, Start TC 01:00:00:00 (startFrames 86400)", () => {
  it("resolves the sequence Start TC to 86400 frames", () => {
    expect(tcToFrames("01:00:00:00", "23.976", false)).toBe(86400);
  });

  it("note a — point at 38.000s → 01:00:37:23 (NTSC drift, not a bug)", () => {
    expect(frameIndex(38, "23.976")).toBe(911);
    expect(totalFrames(38, S976)).toBe(87311);
    expect(framesToTc(87311, "23.976", false)).toBe("01:00:37:23");
  });

  it("note b — span 60.000→90.000s → 01:00:59:23, 719 frames long", () => {
    expect(frameIndex(60, "23.976")).toBe(1439);
    expect(totalFrames(60, S976)).toBe(87839);
    expect(framesToTc(87839, "23.976", false)).toBe("01:00:59:23");
    expect(durationFrames(60, 90, "23.976")).toBe(719);
  });

  it("note b out — 90.000s → 01:01:29:22", () => {
    expect(frameIndex(90, "23.976")).toBe(2158);
    expect(totalFrames(90, S976)).toBe(88558);
    expect(framesToTc(88558, "23.976", false)).toBe("01:01:29:22");
  });

  it("note c — point at 253.000s → 01:04:12:18", () => {
    expect(frameIndex(253, "23.976")).toBe(6066);
    expect(totalFrames(253, S976)).toBe(92466);
    expect(framesToTc(92466, "23.976", false)).toBe("01:04:12:18");
  });
});

describe("FCPXML rational time (23.976, numerator = frames × 1001)", () => {
  it("frame counts become frame-aligned rationals", () => {
    expect(framesToRational(911, "23.976")).toBe("911911/24000s");
    expect(framesToRational(durationFrames(60, 90, "23.976"), "23.976")).toBe("719719/24000s");
  });

  it("Start TC becomes the tcStart rational", () => {
    expect(tcStartRational(S976)).toBe("86486400/24000s");
  });

  it("secondsToRational gives the clip-local marker start", () => {
    expect(secondsToRational(38, S976)).toBe("911911/24000s");
    expect(secondsToRational(60, S976)).toBe("1440439/24000s");
  });
});

describe("24.000p (exact) — the same notes land on clean frames", () => {
  it("no NTSC drift", () => {
    expect(framesToTc(totalFrames(38, S24), "24", false)).toBe("01:00:38:00");
    expect(framesToTc(totalFrames(60, S24), "24", false)).toBe("01:01:00:00");
    expect(framesToTc(totalFrames(90, S24), "24", false)).toBe("01:01:30:00");
    expect(framesToTc(totalFrames(253, S24), "24", false)).toBe("01:04:13:00");
  });
});

describe("29.97 drop-frame vs non-drop", () => {
  it("round-trips valid drop-frame timecodes (';' before frames)", () => {
    for (const tc of [
      "01:00:00;00",
      "01:00:59;29",
      "01:10:00;00",
      "00:01:00;02",
      "02:00:00;00",
    ]) {
      const frames = tcToFrames(tc, "29.97", true);
      expect(frames).not.toBeNull();
      expect(framesToTc(frames as number, "29.97", true)).toBe(tc);
    }
  });

  it("applies the drop correction: frame 1800 is ;02 in DF but :00 in NDF", () => {
    expect(framesToTc(1800, "29.97", true)).toBe("00:01:00;02");
    expect(framesToTc(1800, "29.97", false)).toBe("00:01:00:00");
  });

  it("the same wall-clock timecode parses to different frame counts", () => {
    // At the minute mark, DF has skipped two labels, so it lands two frames earlier.
    expect(tcToFrames("00:01:00;02", "29.97", true)).toBe(1800);
    expect(tcToFrames("00:01:00:02", "29.97", false)).toBe(1802);
  });

  it("non-drop 29.97 uses colons and straightforward math", () => {
    const f = tcToFrames("01:00:37:23", "29.97", false);
    expect(f).toBe((1 * 3600) * 30 + 37 * 30 + 23);
    expect(framesToTc(f as number, "29.97", false)).toBe("01:00:37:23");
  });

  it("59.94 drop-frame also round-trips", () => {
    for (const tc of ["01:00:00;00", "00:01:00;04", "01:10:00;00"]) {
      const frames = tcToFrames(tc, "59.94", true);
      expect(frames).not.toBeNull();
      expect(framesToTc(frames as number, "59.94", true)).toBe(tc);
    }
  });
});
