import { describe, expect, it } from "vitest";
import { framesToTc, tcToFrames, tcToSeconds } from "./timecode";

// Frames↔timecode math drives the playhead, marks, exports, and the
// transcript click-to-seek (whose floor-rounding produced the r85
// "click 'Know', highlight 'Let's roll it'" bug).

describe("framesToTc", () => {
  it("round-trips zero", () => {
    expect(framesToTc(0, 30)).toBe("00:00:00:00");
  });

  it("carries frames into seconds at the fps boundary", () => {
    expect(framesToTc(29, 30)).toBe("00:00:00:29");
    expect(framesToTc(30, 30)).toBe("00:00:01:00");
  });

  it("formats hours", () => {
    expect(framesToTc(30 * 3661 + 5, 30)).toBe("01:01:01:05");
  });

  it("clamps negatives and survives a 0 fps divisor", () => {
    expect(framesToTc(-10, 30)).toBe("00:00:00:00");
    expect(framesToTc(10, 0)).toBe("00:00:10:00"); // fps floor of 1
  });
});

describe("tcToFrames", () => {
  it("parses full HH:MM:SS:FF", () => {
    expect(tcToFrames("00:00:01:00", 30)).toBe(30);
    expect(tcToFrames("01:01:01:05", 30)).toBe(30 * 3661 + 5);
  });

  it("pads short forms from the left (SS:FF, MM:SS:FF)", () => {
    expect(tcToFrames("01:00", 30)).toBe(30);        // 1s 0f
    expect(tcToFrames("01:00:00", 30)).toBe(1800);   // 1m
  });

  it("rejects out-of-range fields and garbage", () => {
    expect(tcToFrames("00:61:00:00", 30)).toBeNull(); // minutes >= 60
    expect(tcToFrames("00:00:00:30", 30)).toBeNull(); // frame >= fps
    expect(tcToFrames("abc", 30)).toBeNull();
    expect(tcToFrames("", 30)).toBeNull();
  });

  it("round-trips with framesToTc", () => {
    for (const frames of [0, 1, 29, 30, 1799, 1800, 108000]) {
      expect(tcToFrames(framesToTc(frames, 30), 30)).toBe(frames);
    }
  });
});

describe("tcToSeconds", () => {
  it("converts via frames", () => {
    expect(tcToSeconds("00:00:01:15", 30)).toBeCloseTo(1.5, 5);
    expect(tcToSeconds("garbage", 30)).toBeNull();
  });
});
