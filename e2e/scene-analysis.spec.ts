import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

// The reviewed reference clip is supplied explicitly, never found by scanning a media library.
const fixture = process.env.SCENE_REVIEWED_FIXTURE;
// Playwright's headless Chromium cannot configure this H.264 fixture with the
// reference hardware preference. Run the reviewed fixture in installed Chrome.
test.use({ browserName: process.env.SCENE_BROWSER === "webkit" ? "webkit" : "chromium",
  channel: fixture && process.env.SCENE_BROWSER !== "webkit" ? "chrome" : undefined });
const expectedCuts = [26, 61, 90, 121, 166, 340, 355, 374, 390, 513, 621];

test.beforeEach(async ({ page }) => {
  await page.route("**/scene-worker-test", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><input type=file>" }));
  await page.goto("/scene-worker-test");
});

test("malformed local bytes produce a typed terminal error, not empty success", async ({ page }) => {
  const outcome = await page.evaluate(async () => {
    const url = "/src/lib/scene-analysis/client.ts";
    const { startSceneAnalysis }: typeof import("../src/lib/scene-analysis/client") = await import(url);
    const job = startSceneAnalysis("/fixture/broken.mp4", undefined, undefined,
      { size: async () => 100, read: async (_path, start, end) => new ArrayBuffer(end - start) });
    try { await job.result; return "unexpected success"; }
    catch (cause) { return (cause as { code: string }).code; }
  });
  expect(outcome).toBe("PIPELINE_ERROR");
});

test.describe("reviewed full-frame fixture", () => {
  test.skip(!fixture, "Set SCENE_REVIEWED_FIXTURE to the supplied reviewed MP4");
  test.beforeEach(async ({ page }) => {
    expect(isAbsolute(fixture!)).toBe(true);
    await page.locator("input").setInputFiles({ name: "reviewed.mp4", mimeType: "video/mp4", buffer: readFileSync(fixture!) });
  });

  test("native-range worker preserves all 705 presentation frames and exactly 11 cuts", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const result = await page.evaluate(async () => {
      const url = "/src/lib/scene-analysis/client.ts";
      const { startSceneAnalysis }: typeof import("../src/lib/scene-analysis/client") = await import(url);
      const file = document.querySelector("input")!.files![0];
      let reads = 0, largestRead = 0;
      const job = startSceneAnalysis("/fixture/reviewed.mp4", undefined, undefined, {
        size: async () => file.size,
        read: async (_path, start, end) => { reads++; largestRead = Math.max(largestRead, end - start); return file.slice(start, end).arrayBuffer(); },
      });
      const result = await job.result;
      return { result, reads, largestRead };
    });
    expect(result.result.source.frameCount).toBe(705);
    expect(result.result.boundaries.map(cut => cut.afterFrameIndex)).toEqual(expectedCuts);
    expect(result.result.analysis.config.sensitivity).toBe(95);
    expect(result.result.analysis.libraryVersion).toBe("1.52.3");
    expect(result.reads).toBeGreaterThan(0);
    expect(result.result.boundaries.every(cut => Number.isSafeInteger(cut.afterPtsUs))).toBe(true);
    expect(errors).toEqual([]);
  });

  test("Stop acknowledges real decoder disposal within one second without an uncaught error", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const result = await page.evaluate(async () => {
      const url = "/src/lib/scene-analysis/client.ts";
      const { startSceneAnalysis }: typeof import("../src/lib/scene-analysis/client") = await import(url);
      const file = document.querySelector("input")!.files![0];
      let stoppedAt = 0;
      const job = startSceneAnalysis("/fixture/reviewed.mp4", progress => {
        if (progress.phase === "decode" && !stoppedAt) { stoppedAt = performance.now(); job.cancel(); }
      }, undefined, { size: async () => file.size, read: async (_path, start, end) => file.slice(start, end).arrayBuffer() });
      try { await job.result; return { code: "unexpected success", elapsed: Infinity }; }
      catch (cause) { return { code: (cause as { code: string }).code, elapsed: performance.now() - stoppedAt }; }
    });
    expect(result.code).toBe("ABORTED"); expect(result.elapsed).toBeLessThan(1000);
    expect(errors).toEqual([]);
  });

  test("an unsupported codec is explicit and never invokes a sampled fallback", async ({ page }) => {
    const result = await page.evaluate(async () => {
      const url = "/src/lib/scene-analysis/client.ts";
      const { startSceneAnalysis }: typeof import("../src/lib/scene-analysis/client") = await import(url);
      const file = document.querySelector("input")!.files![0];
      const workerUrl = new URL("/src/lib/scene-analysis/worker.ts", location.origin).href;
      const bootstrap = URL.createObjectURL(new Blob([`
        const queued = [];
        self.onmessage = event => queued.push(event);
        Object.defineProperty(VideoDecoder, 'isConfigSupported', {value: async () => ({supported: false})});
        await import(${JSON.stringify(workerUrl)});
        for (const event of queued) self.onmessage(event);
      `], { type: "text/javascript" }));
      try {
        const job = startSceneAnalysis("/fixture/reviewed.mp4", undefined, () => new Worker(bootstrap, { type: "module" }),
          { size: async () => file.size, read: async (_path, start, end) => file.slice(start, end).arrayBuffer() });
        try { await job.result; return "unexpected success"; }
        catch (cause) { return (cause as { code: string }).code; }
      } finally { URL.revokeObjectURL(bootstrap); }
    });
    expect(result).toBe("UNSUPPORTED_CODEC");
  });
});
