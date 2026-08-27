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

/**
 * `cut_local`'s body ALONE.
 *
 * Scanning the whole file passed for the wrong reason: another function in
 * media.rs also maps `0:a:0?`, so an assertion that the file "contains" it
 * stayed green while cut_local's own map was mutated to non-optional. That is
 * this repo's recurring failure - a scan that finds something else - and it
 * caught me writing it during the audit that was looking for exactly this.
 */
function cutLocalBody(text: string): string {
  const i = text.indexOf("fn cut_local");
  if (i < 0) return "";
  const j = text.indexOf("\n}", i);
  return text.slice(i, j < 0 ? undefined : j);
}

describe("a lossless cut keeps its streams in sync", () => {
  const whole = code(readFileSync(MEDIA, "utf8"));
  const src = cutLocalBody(whole);

  it("finds the cut helper's body, so the checks below cannot pass vacuously", () => {
    expect(src, "cut_local is gone — re-derive this contract").toContain("fn cut_local");
    expect(src, "the cut no longer input-seeks").toContain('"-ss"');
    expect(src.length, "the body extractor returned almost nothing").toBeGreaterThan(200);
    expect(
      src.length,
      "the extractor swallowed the rest of the file, so these checks are file-wide again",
    ).toBeLessThan(whole.length * 0.5);
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

  it("maps the streams explicitly, or the captions disappear", () => {
    // SECOND regression from the same change, found by auditing rather than
    // by a test. With `-c copy` and no mapping, ffmpeg's default stream
    // selection dropped the mov_text subtitle track: a source exported with
    // Captions on came out with no subtitles at all, and nothing said so.
    // Verified against the bundled ffmpeg both ways.
    expect(src, "cut_local no longer maps streams, so embedded captions are dropped")
      .toContain('"-map"');
    expect(src).toContain('"0:s:0?"');
  });

  it("marks the audio and subtitle maps optional", () => {
    // The `?` is load-bearing. Most sources have no subtitle track, and a
    // hard map on a stream that is not there fails the entire export with
    // "Stream map matches no streams" - trading dropped captions for no
    // clip at all.
    expect(src, "an unconditional subtitle map fails every source without one")
      .not.toMatch(/"0:s:0"/);
    expect(src).toContain('"0:a:0?"');
  });

  it("copies subtitles on the RE-ENCODE path instead of encoding them", () => {
    // THIRD regression from this one change, and caused by the fix for the
    // second. With the subtitle stream mapped and no codec named for it,
    // ffmpeg hunts for a subtitle encoder, finds none, and kills the export:
    // "Error selecting an encoder", no file at all. Verified against the
    // bundled ffmpeg - it fails without this and succeeds with it.
    expect(
      src,
      "the re-encode branch maps subtitles without -c:s copy, so a captioned " +
        "source produces no file at all",
    ).toContain('"-c:s"');
    expect(src).toMatch(/"-c:s"\.into\(\),\s*"copy"/);
  });
});
