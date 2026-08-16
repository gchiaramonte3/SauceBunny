import { describe, expect, it } from "vitest";
import { framesToTc, tcToFrames, tcToSeconds, hmsToSeconds, secondsToClock, tcDigitsToFrames, tcDigitsToDisplay } from "./timecode";

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

describe("the transport HUD's digit entry", () => {
  // 24fps throughout: a round rate keeps the arithmetic readable, and the
  // rounding of 23.976 is covered separately below.
  const F = (digits: string, fps = 24) => tcDigitsToFrames(digits, fps);

  it("fills right-to-left, the way an NLE timecode field does", () => {
    // The whole grammar in four lines. Typing "1" then "3" then "0" walks
    // 00:00:00:01 → 00:00:00:13 → 00:00:01:30, so every intermediate state has
    // to mean something rather than being rejected as malformed.
    expect(F("1")).toBe(1);
    expect(F("13")).toBe(13);
    expect(F("130")).toBe(24 + 30);          // 00:00:01:30
    expect(F("1000")).toBe(10 * 24);         // 00:00:10:00
    expect(F("10000")).toBe(60 * 24);        // 00:01:00:00
    expect(F("1000000")).toBe(3600 * 24);    // 01:00:00:00
  });

  it("treats an empty entry as frame zero rather than NaN", () => {
    // Return pressed on an open-but-empty HUD. `+"" ` is 0 but `+"  "` is not,
    // and the padding is what keeps this arithmetic away from NaN.
    expect(F("")).toBe(0);
    expect(F("0")).toBe(0);
  });

  it("keeps only the last eight digits typed", () => {
    // The HUD slices as you type, so this is belt and braces: a paste or a
    // held key cannot walk the hours field off the end.
    expect(F("9910000000")).toBe(F("10000000"));
    expect(tcDigitsToDisplay("9910000000")).toBe("10:00:00:00");
  });

  it("NORMALISES overflow instead of rejecting it", () => {
    // The deliberate difference from tcToFrames, and the reason both exist.
    // 90 frames at 24fps is 3s18f; 90 seconds is a minute and a half.
    expect(F("90")).toBe(90);                      // 00:00:00:90 → 3s 18f
    expect(F("9000")).toBe(90 * 24);               // 00:00:90:00 → 1m 30s
    expect(F("00990000")).toBe(99 * 60 * 24);      // 00:99:00:00 → 1h 39m
  });

  it("disagrees with tcToFrames on purpose, and only about validity", () => {
    // Same digits, same rate. The strict parser refuses; the HUD lands on a
    // frame. If someone ever "fixes" this divergence, a half-typed timecode
    // stops being enterable - so it is pinned rather than left to judgement.
    expect(tcToFrames("00:99:00:00", 24)).toBeNull();
    expect(F("00990000")).toBeGreaterThan(0);

    // ...and they AGREE wherever the input is a legal timecode, which is what
    // makes the divergence a deliberate narrowing rather than two rival
    // implementations that have drifted.
    for (const tc of ["00:00:00:00", "00:00:01:12", "00:01:30:07", "01:23:45:21"]) {
      expect(F(tc.replace(/:/g, ""))).toBe(tcToFrames(tc, 24));
    }
  });

  it("rounds a fractional rate the same way the rest of the module does", () => {
    // 23.976 and 29.97 are the rates this app actually meets. Frame counts are
    // integers, so the entry rounds to 24 and 30 exactly as framesToTc does.
    expect(F("100", 23.976)).toBe(24);   // 00:00:01:00
    expect(F("100", 29.97)).toBe(30);
    expect(F("100", 0)).toBe(1);         // an unknown rate must not divide by zero
  });

  it("paints what was typed, padded but never reformatted", () => {
    expect(tcDigitsToDisplay("")).toBe("00:00:00:00");
    expect(tcDigitsToDisplay("7")).toBe("00:00:00:07");
    expect(tcDigitsToDisplay("130")).toBe("00:00:01:30");
    // Not normalised for display: the user sees the digits they typed, and the
    // jump to a legal timecode happens on Return. Showing 00:00:03:18 while
    // they are still typing "90" would move the target as they aim at it.
    expect(tcDigitsToDisplay("90")).toBe("00:00:00:90");
  });

  it("round-trips through framesToTc for every legal entry", () => {
    for (const frames of [0, 1, 23, 24, 25, 1439, 1440, 86_399, 2_073_599]) {
      const tc = framesToTc(frames, 24);
      expect(F(tc.replace(/:/g, ""))).toBe(frames);
    }
  });
});
