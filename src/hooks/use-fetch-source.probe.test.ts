import { describe, expect, it } from "vitest";
import { probeLine } from "./use-fetch-source";

/**
 * The probe line has to say WHICH resolution it is quoting.
 *
 * `fetch_metadata` reports the source's best rendition (download.rs walks
 * `formats[]` and takes the max). Playback streams at `previewMaxHeight`,
 * 480 by default. The line printed only the first number, so a report of
 * "3840×2160 · 24 fps" read as "I am streaming 4K and it is struggling"
 * when the app had been streaming 480p the whole time. That cost a real
 * investigation into 4K decode costs that were never being paid.
 */
describe("the probe line", () => {
  const m = { width: 3840, height: 2160, fps: 24, duration: 5756 };

  it("says it is streaming lower than the source when it is", () => {
    expect(probeLine(m, 480)).toContain("streaming ≤480p");
    expect(probeLine(m, 480), "the source rendition is still worth printing").toContain("3840×2160");
  });

  it("says nothing extra when the source is already within the cap", () => {
    // A 360p source under a 480 cap is streamed whole. Claiming otherwise
    // would be the same lie in the other direction.
    expect(probeLine({ width: 640, height: 360, fps: 24, duration: 10 }, 480)).not.toContain("streaming");
  });

  it("does not claim a cap it cannot verify", () => {
    expect(probeLine({ width: null, height: null, fps: null, duration: null }, 480)).not.toContain("streaming");
  });

  it("keeps the fields the line already carried", () => {
    const line = probeLine(m, 1080, " · from cache");
    expect(line).toContain("24 fps");
    expect(line).toContain("5756.0s");
    expect(line).toContain("from cache");
    expect(line, "2160 is above a 1080 cap, so it must say so").toContain("streaming ≤1080p");
  });
});
