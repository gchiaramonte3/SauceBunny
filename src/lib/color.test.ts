import { describe, it, expect } from "vitest";
import {
  hsvToRgb, rgbToHsv, rgbToHex, hsvToHex, parseHex, SPEAKER_PRESETS,
} from "./color";

describe("hex parsing", () => {
  it("parses #rrggbb with and without #", () => {
    expect(parseHex("#4dabf7")).toEqual({ r: 0x4d, g: 0xab, b: 0xf7 });
    expect(parseHex("4DABF7")).toEqual({ r: 0x4d, g: 0xab, b: 0xf7 });
  });
  it("expands #rgb shorthand", () => {
    expect(parseHex("#f0a")).toEqual({ r: 0xff, g: 0x00, b: 0xaa });
  });
  it("returns null on garbage", () => {
    expect(parseHex("nope")).toBeNull();
    expect(parseHex("#12")).toBeNull();
    expect(parseHex("#1234567")).toBeNull();
  });
});

describe("rgb <-> hex round-trip", () => {
  it("is stable for the curated presets", () => {
    for (const hex of SPEAKER_PRESETS) {
      const rgb = parseHex(hex)!;
      expect(rgbToHex(rgb)).toBe(hex.toLowerCase());
    }
  });
});

describe("hsv <-> rgb", () => {
  it("maps primaries correctly", () => {
    expect(hsvToRgb({ h: 0, s: 1, v: 1 })).toEqual({ r: 255, g: 0, b: 0 });
    expect(hsvToRgb({ h: 120, s: 1, v: 1 })).toEqual({ r: 0, g: 255, b: 0 });
    expect(hsvToRgb({ h: 240, s: 1, v: 1 })).toEqual({ r: 0, g: 0, b: 255 });
  });
  it("black and white", () => {
    expect(hsvToRgb({ h: 0, s: 0, v: 0 })).toEqual({ r: 0, g: 0, b: 0 });
    expect(hsvToRgb({ h: 0, s: 0, v: 1 })).toEqual({ r: 255, g: 255, b: 255 });
  });
  it("wraps negative/over-360 hue", () => {
    expect(hsvToRgb({ h: 360, s: 1, v: 1 })).toEqual({ r: 255, g: 0, b: 0 });
    expect(hsvToRgb({ h: -120, s: 1, v: 1 })).toEqual({ r: 0, g: 0, b: 255 });
  });
  it("round-trips the presets through HSV within 1/255", () => {
    for (const hex of SPEAKER_PRESETS) {
      const rgb = parseHex(hex)!;
      const back = hsvToRgb(rgbToHsv(rgb));
      expect(Math.abs(back.r - rgb.r)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.g - rgb.g)).toBeLessThanOrEqual(1);
      expect(Math.abs(back.b - rgb.b)).toBeLessThanOrEqual(1);
    }
  });
  it("hsvToHex composes the two", () => {
    expect(hsvToHex({ h: 0, s: 1, v: 1 })).toBe("#ff0000");
  });
});

