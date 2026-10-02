import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { secondsToFrames, secondsToTc } from "./timecode";

it("transcript clicks and search results seek to the same frame their timecode displays", () => {
  const source = readFileSync(new URL("../App.tsx", import.meta.url), "utf8");
  // Both second-based transcript entry points must use the common conversion.
  // A bare floor loses a frame when a serialized timestamp rounds down.
  const drawer = source.slice(source.indexOf("onTranscriptSeek={(seconds) => {"));
  const search = source.slice(source.indexOf("onOpenAt={(path, seconds) => {"));
  for (const handler of [drawer, search]) {
    expect(handler.length).toBeGreaterThan(0);
    expect(handler.slice(0, handler.indexOf("onSeek(") + 50))
      .toContain("onSeek(secondsToFrames(seconds, fps))");
  }
  for (const fps of [24000 / 1001, 30000 / 1001, 60000 / 1001]) {
    const seconds = Math.round(1e6 / fps) / 1e6;
    expect(secondsToTc(seconds, fps)).toBe("00:00:00:01");
    expect(secondsToFrames(seconds, fps)).toBe(1);
  }
});
