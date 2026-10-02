import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import type { VideoSceneProxy } from "../src/bindings/VideoSceneProxy";

// Explicit output of the generated 48-frame packaged-worker smoke, not a
// replacement for the user's separately reviewed 705-frame acceptance clip.
const reportPath = process.env.SCENE_GENERATED_SMOKE_REPORT;
test.use({ browserName: process.env.SCENE_BROWSER === "webkit" ? "webkit" : "chromium",
  channel: reportPath && process.env.SCENE_BROWSER !== "webkit" ? "chrome" : undefined });

test("packaged fractional-rate proxy retains native PTS through the real browser worker", async ({ page }) => {
  test.skip(!reportPath, "Supply the explicit generated packaged-worker smoke report");
  const report = JSON.parse(readFileSync(reportPath!, "utf8")) as { status: string; frames: number; proxy: VideoSceneProxy };
  expect(report.status).toBe("passed");
  expect(report.frames).toBe(48);
  const proxy = report.proxy;
  await page.route("**/scene-roundtrip-test", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><input type=file>" }));
  await page.goto("/scene-roundtrip-test");
  await page.locator("input").setInputFiles({ name: "generated-proxy.mp4", mimeType: "video/mp4", buffer: readFileSync(proxy.path) });
  const result = await page.evaluate(async proxy => {
    const clientUrl = "/src/lib/scene-analysis/client.ts";
    const evidenceUrl = "/src/lib/scene-analysis/evidence.ts";
    const { startSceneAnalysis }: typeof import("../src/lib/scene-analysis/client") = await import(clientUrl);
    const { createSceneEvidence }: typeof import("../src/lib/scene-analysis/evidence") = await import(evidenceUrl);
    const file = document.querySelector("input")!.files![0];
    const job = startSceneAnalysis("/generated/proxy.mp4", undefined, undefined, {
      size: async () => file.size,
      read: async (_path, start, end) => file.slice(start, end).arrayBuffer(),
    });
    const detection = await job.result;
    const evidence = await createSceneEvidence(proxy, detection, []);
    return { frames: detection.source.frameCount, pts: detection.source.ptsSha256,
      cuts: detection.boundaries.map(cut => [cut.afterFrameIndex, cut.afterPtsUs]),
      sensitivity: detection.analysis.config.sensitivity,
      shots: evidence.shots.map(shot => [shot.start_us, shot.end_us]),
      mapVersion: evidence.proxy.time_map_version };
  }, proxy);
  expect(result.frames).toBe(48);
  expect(result.pts).toBe(proxy.pts_sha256);
  expect(result.cuts).toEqual([[24, 1_001_000]]);
  expect(result.shots).toEqual([[0, 1_001_000], [1_001_000, 2_002_000]]);
  expect(result.sensitivity).toBe(95);
  expect(result.mapVersion).toBe("relative-pts-us-v1");
});
