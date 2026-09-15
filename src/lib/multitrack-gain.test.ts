import { describe, expect, it } from "vitest";
import { clampTrackGain, formatTrackGain, parseTrackGain, trackDbToGain, trackGainToDb, TRACK_GAIN_MAX, TRACK_GAIN_OFF } from "./multitrack-gain";

describe("multitrack audition decibels", () => {
  it.each([-60, -24, -0.5, 0, 0.5, 12, 36])("round-trips %s dB using amplitude gain", db => {
    expect(trackGainToDb(trackDbToGain(db))).toBeCloseTo(db);
    expect(parseTrackGain(formatTrackGain(trackDbToGain(db)))).toBeCloseTo(10 ** (db / 20));
  });
  it.each(["+10", "+10 dB", "10db", "  +10 DB  "])("accepts %s", text => {
    expect(parseTrackGain(text)).toBeCloseTo(Math.sqrt(10));
    expect(formatTrackGain(parseTrackGain(text)!)).toBe("+10 dB");
  });
  it.each(["", "+", "-", ".", "10oops", "1e2", "NaN", "Infinity", "+10%", "1,2", "10 dB!"])("rejects %s without prefix parsing", text => {
    expect(parseTrackGain(text)).toBeNull();
  });
  it("distinguishes silence from attenuation and caps boosts safely", () => {
    expect(trackDbToGain(TRACK_GAIN_OFF)).toBe(0); expect(trackGainToDb(0)).toBe(TRACK_GAIN_OFF);
    expect(formatTrackGain(0)).toBe("−∞ dB"); expect(trackDbToGain(-60)).toBe(.001);
    expect(parseTrackGain("+99 dB")).toBe(TRACK_GAIN_MAX); expect(parseTrackGain("-99")).toBe(.001);
    expect(clampTrackGain(1e10)).toBe(TRACK_GAIN_MAX); expect(clampTrackGain(-1)).toBe(0);
    for (const value of [NaN, Infinity, -Infinity]) expect(clampTrackGain(value)).toBe(1);
    expect(formatTrackGain(1)).toBe("0 dB");
  });
});
