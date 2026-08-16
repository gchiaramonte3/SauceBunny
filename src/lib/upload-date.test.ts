import { describe, expect, it } from "vitest";
import { formatUploadDate, formatViewCount } from "./upload-date";

/**
 * Display helpers for yt-dlp metadata, which is third-party data from ~1800
 * sites. Neither had a test, and both render straight into the sidebar.
 *
 * The rule they follow is worth stating: return null rather than guess. The
 * caller renders nothing at all for null, so a missing or malformed field
 * costs the user a line of metadata, never a line of nonsense.
 */

describe("formatUploadDate", () => {
  it("renders yt-dlp's YYYYMMDD", () => {
    expect(formatUploadDate("20260424")).toBe("Apr 24, 2026");
    expect(formatUploadDate("20260101")).toBe("Jan 1, 2026");
    expect(formatUploadDate("19991231")).toBe("Dec 31, 1999");
  });

  it("returns null for anything that is not that shape", () => {
    // Absent, empty, ISO, short, long, non-numeric — all real possibilities
    // across 1800 extractors.
    for (const bad of [null, "", "2026-04-24", "2026042", "202604244", "abcdefgh", " 20260424"]) {
      expect(formatUploadDate(bad), `${JSON.stringify(bad)} should be rejected`).toBeNull();
    }
  });

  it("rejects an out-of-range month or day rather than printing it", () => {
    // The month was already checked; the day was not, so "20260400" rendered
    // as "Apr 0, 2026".
    expect(formatUploadDate("20261324")).toBeNull(); // month 13
    expect(formatUploadDate("20260024")).toBeNull(); // month 0
    expect(formatUploadDate("20260400")).toBeNull(); // day 0
    expect(formatUploadDate("20260432")).toBeNull(); // day 32
  });

  it("does NOT know how many days a month has, on purpose", () => {
    // "Feb 31" survives, and that is the documented limit: this is display
    // hygiene for third-party metadata, not a date library. Pinned so the gap
    // is a decision someone can find rather than a surprise — if a real feed
    // ever produces such a date, this test is where to start.
    expect(formatUploadDate("20260231")).toBe("Feb 31, 2026");
  });
});

describe("formatViewCount", () => {
  it("counts singular and plural correctly", () => {
    expect(formatViewCount(1)).toBe("1 view");
    expect(formatViewCount(0)).toBe("0 views");
    expect(formatViewCount(2)).toBe("2 views");
    expect(formatViewCount(999)).toBe("999 views");
  });

  it("abbreviates at each threshold", () => {
    expect(formatViewCount(1000)).toBe("1K views");
    expect(formatViewCount(1500)).toBe("1.5K views");
    expect(formatViewCount(999_999)).toBe("1000K views");
    expect(formatViewCount(1_000_000)).toBe("1M views");
    expect(formatViewCount(1_250_000)).toBe("1.3M views");
    expect(formatViewCount(1_000_000_000)).toBe("1B views");
  });

  it("drops a trailing .0 so it reads as a round number", () => {
    expect(formatViewCount(2_000)).toBe("2K views");
    expect(formatViewCount(3_000_000)).toBe("3M views");
  });

  it("returns null when the field is absent", () => {
    expect(formatViewCount(null)).toBeNull();
  });
});
