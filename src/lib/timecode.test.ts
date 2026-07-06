import { describe, expect, it } from "vitest";
import { framesToTc, tcToFrames, tcToSeconds, hmsToSeconds, secondsToClock } from "./timecode";

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

describe("hmsToSeconds", () => {
  it("parses m:ss and h:mm:ss (the AI summary's clickable timecodes)", () => {
    expect(hmsToSeconds("7:23")).toBe(7 * 60 + 23);
    expect(hmsToSeconds("0:42")).toBe(42);
    expect(hmsToSeconds("1:02:03")).toBe(3600 + 123);
    expect(hmsToSeconds("12")).toBe(12);
  });
  it("rejects out-of-range fields and garbage", () => {
    expect(hmsToSeconds("7:99")).toBeNull(); // seconds >= 60
    expect(hmsToSeconds("1:99:00")).toBeNull(); // minutes >= 60
    expect(hmsToSeconds("a:bc")).toBeNull();
    expect(hmsToSeconds("1:2:3:4")).toBeNull();
  });
  it("permissiveMinutes allows minutes > 59 in the TWO-part form only (chapter lines)", () => {
    expect(hmsToSeconds("90:00", { permissiveMinutes: true })).toBe(90 * 60);
    expect(hmsToSeconds("90:00")).toBeNull(); // strict by default
    expect(hmsToSeconds("1:99:00", { permissiveMinutes: true })).toBeNull(); // 3-part stays strict
    expect(hmsToSeconds("90:99", { permissiveMinutes: true })).toBeNull(); // seconds still clocked
  });
});

describe("secondsToClock", () => {
  it("formats M:SS by default, rolling to H:MM:SS past an hour", () => {
    expect(secondsToClock(0)).toBe("0:00");
    expect(secondsToClock(75)).toBe("1:15");
    expect(secondsToClock(3723)).toBe("1:02:03");
  });
  it("pads minutes with padMinutes (chapter/YouTube shape)", () => {
    expect(secondsToClock(0, { padMinutes: true })).toBe("00:00");
    expect(secondsToClock(75, { padMinutes: true })).toBe("01:15");
    expect(secondsToClock(3723, { padMinutes: true })).toBe("1:02:03"); // hours form unaffected
  });
  it("forceHours emits H:MM:SS even under an hour", () => {
    expect(secondsToClock(75, { forceHours: true })).toBe("0:01:15");
    expect(secondsToClock(0, { forceHours: true })).toBe("0:00:00");
  });
  it("clamps negatives and floors fractions", () => {
    expect(secondsToClock(-5)).toBe("0:00");
    expect(secondsToClock(61.9)).toBe("1:01");
  });
});
