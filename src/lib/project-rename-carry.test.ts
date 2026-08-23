import { describe, expect, it } from "vitest";
import { carriedPaths } from "./project-rename-carry";

const LIB = "/Users/x/Documents/Sauce Bunny/Transcripts";

describe("carriedPaths", () => {
  it("rewrites every transcript under the renamed folder", () => {
    const got = carriedPaths(
      [`${LIB}/Rushes/ep1.srt`, `${LIB}/Rushes/ep2.srt`],
      `${LIB}/Rushes`,
      `${LIB}/Marry Harry`,
    );
    expect(got).toEqual([
      { from: `${LIB}/Rushes/ep1.srt`, to: `${LIB}/Marry Harry/ep1.srt` },
      { from: `${LIB}/Rushes/ep2.srt`, to: `${LIB}/Marry Harry/ep2.srt` },
    ]);
  });

  it("leaves transcripts in other folders alone", () => {
    const got = carriedPaths(
      [`${LIB}/Rushes/a.srt`, `${LIB}/2026-08/b.srt`, `${LIB}/loose.srt`],
      `${LIB}/Rushes`,
      `${LIB}/Renamed`,
    );
    expect(got.map((c) => c.from)).toEqual([`${LIB}/Rushes/a.srt`]);
  });

  it("does not match a folder whose name merely starts the same", () => {
    // A string prefix would rewrite everything in "Rushes" when "Rush" is
    // renamed, moving history entries for transcripts that never moved.
    const got = carriedPaths([`${LIB}/Rushes/a.srt`], `${LIB}/Rush`, `${LIB}/Take`);
    expect(got).toEqual([]);
  });

  it("carries sidecars too, since they are just paths under the folder", () => {
    const got = carriedPaths(
      [`${LIB}/R/a.srt`, `${LIB}/R/a.diarization.json`],
      `${LIB}/R`, `${LIB}/S`,
    );
    expect(got).toHaveLength(2);
    expect(got[1].to).toBe(`${LIB}/S/a.diarization.json`);
  });

  it("is a no-op when nothing actually changed", () => {
    expect(carriedPaths([`${LIB}/R/a.srt`], `${LIB}/R`, `${LIB}/R`)).toEqual([]);
    expect(carriedPaths([`${LIB}/R/a.srt`], `${LIB}/R/`, `${LIB}/R`)).toEqual([]);
  });

  it("tolerates a trailing slash on either side", () => {
    const got = carriedPaths([`${LIB}/R/a.srt`], `${LIB}/R/`, `${LIB}/S/`);
    expect(got).toEqual([{ from: `${LIB}/R/a.srt`, to: `${LIB}/S/a.srt` }]);
  });
});
