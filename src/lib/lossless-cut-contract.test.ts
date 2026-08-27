import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * A stream-copy cut must normalise its timestamps, or the clip desyncs.
 *
 * `-ss` before `-i` is an INPUT seek. With `-c copy` ffmpeg cannot cut
 * mid-GOP, so it keeps the leading keyframe and everything after it, and
 * those packets carry NEGATIVE timestamps. Measured on a 20-second cut of a
 * real h264/mp3 source:
 *
 *     video first packet  -1.066667
 *     audio first packet  -1.024000
 *
 * Negative PTS in an mp4 is resolved differently by different players, and
 * the two streams do not agree about it: the muxer writes an edit list for
 * one and shifts the other, so the sound slides against the picture.
 * `-avoid_negative_ts make_zero` shifts BOTH by the same amount, so the first
 * packet sits at 0 and the true relative offset survives (video 0.096, audio
 * 0.000, durations within 20ms).
 *
 * This exists because the property was there and was removed by accident.
 * yt-dlp's `--download-sections` normalised timestamps for us; dropping that
 * flag for a ~20x speedup took the guard with it, and nothing failed. The cut
 * still produced a file, the file still played, and the sound was off the
 * picture - the worst shape a regression can take.
 */
const MEDIA = resolve(__dirname, "../../src-tauri/src/commands/media.rs");

/** Rust with comments stripped: this rule is discussed at length in one. */
function code(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => {
      const i = l.indexOf("//");
      return i >= 0 ? l.slice(0, i) : l;
    })
    .join("\n");
}

describe("a lossless cut keeps its streams in sync", () => {
  const src = code(readFileSync(MEDIA, "utf8"));

  it("finds the cut helper, so the checks below cannot pass vacuously", () => {
    expect(src, "cut_local is gone — re-derive this contract").toContain("fn cut_local");
    expect(src, "the cut no longer input-seeks").toContain('"-ss"');
  });

  it("normalises timestamps whenever it stream-copies", () => {
    // The pairing is the rule: an input seek plus `-c copy` is exactly the
    // combination that produces negative timestamps.
    expect(src).toContain('"copy"');
    expect(
      src,
      "cut_local stream-copies after an input seek without -avoid_negative_ts.\n" +
        "The leading GOP then carries negative PTS, the mp4 muxer resolves it\n" +
        "per-stream, and the exported clip's audio slides against its video.",
    ).toContain('"-avoid_negative_ts"');
  });

  it("zeroes them rather than dropping them", () => {
    // `make_zero` shifts both streams together. The other modes either drop
    // packets or leave one stream behind, which is the same desync again.
    expect(src, "-avoid_negative_ts is set to something other than make_zero")
      .toContain('"make_zero"');
  });
});
