import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The opening frame is fetched where the TRACK says it starts, never at a
 * hardcoded zero.
 *
 * A video stream is not obliged to begin at 0. Big Buck Bunny's h264/mp3
 * build starts at 0.066667s - two frames at 30fps - which ffprobe prints as
 * `start 0.066667`. `CanvasSink.getCanvas(0)` has nothing at or before 0 on
 * such a file and returns null, and that null was being read as proof the
 * platform could not decode the codec.
 *
 * The consequences were as large as a mistake gets here: an ordinary H.264
 * file reported "WebCodecs doesn't support avc" at the user, mediabunny - the
 * entire local playback engine - was skipped, and the file was handed to
 * ffmpeg for a ten-minute h264_videotoolbox re-encode it never needed. H.264
 * is the most widely supported codec WebCodecs has; the claim was never
 * plausible, and nothing in the suite disagreed with it.
 *
 * `harness-firstframe` proves the behaviour against a real decode of a real
 * fixture with a real start offset. This is the cheap half: it stops the
 * source drifting back, and runs in milliseconds on every gate.
 */
const SRC = resolve(__dirname, "../components/MediaBunnyPlayer.tsx");

/**
 * Source with comments stripped.
 *
 * This rule is ABOUT a call that is now described at length in a comment, so
 * a raw scan matches the explanation and fails on the fix. Caught on this
 * file's own first run, which is the point of break-testing a guard before
 * trusting it.
 */
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

describe("the first frame is fetched where the track begins", () => {
  const src = code(readFileSync(SRC, "utf8"));

  it("reads the file at all, so the checks below cannot pass vacuously", () => {
    expect(src.length).toBeGreaterThan(1000);
    expect(src, "the first-frame paint is gone — re-derive this contract")
      .toContain("getCanvas(");
  });

  it("asks the track for its first timestamp", () => {
    expect(
      src,
      "MediaBunnyPlayer no longer calls getFirstTimestamp(), so the opening " +
      "frame is being guessed at rather than looked up",
    ).toContain("getFirstTimestamp()");
  });

  it("never paints the opening frame from a hardcoded zero", () => {
    // The exact call that caused it. A file whose first frame is not at 0
    // returns null here, and the null used to be read as an unsupported codec.
    expect(
      src,
      "getCanvas(0) is back. On a file with a non-zero start PTS this returns " +
      "null, which was mistaken for 'this platform cannot decode this codec'.",
    ).not.toMatch(/getCanvas\(\s*0\s*\)/);
  });

  it("does not claim a codec is unsupported when it only failed to get a frame", () => {
    // The message asserted a verdict about the platform from one failed grab,
    // and printed "WebCodecs doesn't support avc" at a user whose Mac decodes
    // H.264 in hardware.
    const app = code(readFileSync(resolve(__dirname, "../App.tsx"), "utf8"));
    expect(app, "the log is asserting a codec is unsupported again")
      .not.toContain('"WebCodecs doesn\'t support"');
  });
});
