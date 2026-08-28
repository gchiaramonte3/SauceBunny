import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The streamed fMP4 always carries audio WKWebView can actually decode.
 *
 * Two faults, one silence.
 *
 * FIRST, the remux had no audio map, so ffmpeg's default selection chose the
 * "best" stream, and best means most channels. Big Buck Bunny's h264 build
 * carries stereo mp3 AND 5.1 ac3, so it picked the ac3 - which a fragmented
 * mp4 muxer cannot write at all:
 *
 *     Cannot write moov atom before AC3 packets
 *     Could not write header (incorrect codec parameters ?)
 *
 * The whole remux died. Not "no audio": no stream.
 *
 * SECOND, `-c copy` handed WKWebView whatever the source carried. Its MSE
 * decodes AAC; ac3, opus and some mp3 are silence, with nothing logged.
 *
 * So: map the FIRST audio track explicitly, keep video copied, and transcode
 * audio to stereo AAC. Verified against the bundled ffmpeg both ways.
 */
const PROXY = resolve(__dirname, "../../src-tauri/src/stream_proxy.rs");

/**
 * Rust with LINE comments stripped, and nothing else.
 *
 * The first version also stripped `/* ... *\/` pairs, and a `/*` living
 * inside a string literal in this file swallowed everything to the next
 * `*\/` - the scan then ran over a few hundred newlines and two of four
 * assertions failed for having nothing to read. Rust here comments with
 * `//`, so that pass bought nothing and cost the whole file.
 */
function code(text: string): string {
  return text
    .split("\n")
    .map((l) => {
      const i = l.indexOf("//");
      return i >= 0 ? l.slice(0, i) : l;
    })
    .join("\n");
}

/**
 * `serve_fmp4`'s body ALONE.
 *
 * Scanning the whole file passed for the wrong reason: the screen-share
 * encoder further down also sets `-c:a aac`, so deleting the remux's own
 * transcode left the test green. That is the third whole-file scan written
 * today that found something else and reported success, which is why the
 * body extractor is now the first thing checked.
 */
function serveFmp4Body(text: string): string {
  const i = text.indexOf("fn serve_fmp4");
  if (i < 0) return "";
  const j = text.indexOf("\nfn ", i + 10);
  return text.slice(i, j < 0 ? undefined : j);
}

describe("the streamed remux keeps its audio playable", () => {
  const whole = code(readFileSync(PROXY, "utf8"));
  const src = serveFmp4Body(whole);

  it("reads the proxy, so the rules below cannot pass vacuously", () => {
    // The stripper eating the file, and the extractor returning the whole
    // file, are the two ways this test has already passed while blind.
    expect(whole.length, "the comment stripper ate the source").toBeGreaterThan(20_000);
    expect(src.length, "serve_fmp4 not found — re-derive this contract").toBeGreaterThan(500);
    expect(
      src.length,
      "the extractor swallowed the rest of the file, so this is a file-wide scan again",
    ).toBeLessThan(whole.length * 0.4);
    expect(src, "the fMP4 remux is gone").toContain("frag_keyframe+empty_moov");
  });

  it("never blanket-copies every stream", () => {
    // `-c copy` is what let an ac3 track into an mp4 muxer that cannot write
    // one. Video is copied by name now; audio is not.
    expect(
      src,
      'the remux uses a blanket `-c copy` again, so whatever audio the source\n' +
        "carries goes to WKWebView, which decodes AAC and little else",
    ).not.toMatch(/arg\("-c"\)\s*\.arg\("copy"\)/);
    expect(src, "video should still be copied — that is the expensive part")
      .toMatch(/arg\("-c:v"\)\s*\.arg\("copy"\)/);
  });

  it("transcodes audio to AAC", () => {
    expect(src, "audio is no longer normalised to AAC").toMatch(/arg\("-c:a"\)\s*\.arg\("aac"\)/);
  });

  it("maps the first audio track, and tolerates a silent video", () => {
    // Without the map, "best" means most channels and a 5.1 ac3 beats stereo
    // mp3. Without the `?`, a video with no audio fails to remux at all.
    expect(src).toContain('"0:a:0?"');
  });
});
