import { expect, test, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import type { VideoRequest } from "../src/bindings/VideoRequest";
import type { VideoAudioWindow } from "../src/bindings/VideoAudioWindow";

const proxyManifestPath = process.env.SCENE_PROXY_MANIFEST;
const audioHelperPath = process.env.SCENE_AUDIO_HELPER;
test.use({ browserName: process.env.SCENE_BROWSER === "webkit" ? "webkit" : "chromium",
  channel: proxyManifestPath && process.env.SCENE_BROWSER !== "webkit" ? "chrome" : undefined });

async function boot(page: Page, enabled = true, live = false) {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(({ enabled, live }) => {
    if (enabled) localStorage.setItem("saucebunny.shotIntelligence.preview", "1");
    localStorage.setItem("saucebunny.ai.provider", "openai"); // Fake cloud IPC; prevents unrelated local pre-warm.
    localStorage.setItem("saucebunny.panelSnapshot", JSON.stringify({ sourceIdentity: "source-a", programInputActive: live,
      transcriptPath: "/clip.srt", aiVideoPath: "/clip.mp4", hasSource: true, durationSec: 12, chapterSourceKey: "source-a" }));
    localStorage.setItem("e2e.files", JSON.stringify({ "/clip.srt": "1\n00:00:00,000 --> 00:00:01,000\nA supplied line.\n" }));
    const app = window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };
    const original = app.__TAURI_INTERNALS__.invoke;
    app.__TAURI_INTERNALS__.invoke = (cmd, args) => {
      if (cmd === "list_llm_models") return Promise.resolve([{ id: "qwen3-4b-instruct", name: "Local text model", downloaded: true, recommended: true, ctx: 8192, size_bytes: 1, blurb: "" }]);
      if (cmd === "cloud_chat") return Promise.resolve("The supplied transcript says: A supplied line.");
      if (cmd === "video_intelligence_run") {
        const requests = JSON.parse(localStorage.getItem("e2e.shotRequests") ?? "[]");
        localStorage.setItem("e2e.shotRequests", JSON.stringify([...requests, args?.request]));
        return Promise.resolve({ models: [], sources: [], hits: [], answers: [] });
      }
      return original(cmd, args);
    };
  }, { enabled, live });
  await page.goto("/?window=panel");
  await page.getByRole("tab", { name: "AI Summary" }).click();
}

test("the rollout defaults to the unchanged text workflow", async ({ page }) => {
  await boot(page, false);
  await expect(page.getByRole("switch", { name: "Advanced Intelligence" })).toHaveCount(0);
  await expect(page.getByText("Chat with this transcript")).toBeVisible();
});

test("compact mode switch preserves the conversation and draft, and never auto-downloads", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 440, height: 800 });
  await boot(page);
  await page.getByRole("button", { name: "Summarize this transcript in a few bullet points." }).click();
  await expect(page.getByText("The supplied transcript says: A supplied line.")).toBeVisible();
  const input = page.locator(".cp-ai-composer input");
  await input.fill("Keep this unfinished question");
  const mode = page.getByRole("switch", { name: "Advanced Intelligence" });
  await mode.click();
  await expect(mode).toBeChecked();
  await expect(page.getByText("Understand the cut, shot by shot.")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("e2e.shotRequests"))).toBeNull();
  await page.getByRole("button", { name: "Analyze video", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Download the local video reasoning model in Models");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("e2e.shotRequests") ?? "[]"))).toEqual([{ operation: "models" }]);
  const box = (await mode.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(40); expect(box.height).toBeGreaterThanOrEqual(24);
  await page.screenshot({ path: "/private/tmp/sauce-ai-summary-switch.png" });
  await mode.click();
  await expect(input).toHaveValue("Keep this unfinished question");
  await expect(page.getByText("The supplied transcript says: A supplied line.")).toBeVisible();
  expect(errors).toEqual([]);
});

test("a live input cannot analyze a retained file from the detached panel", async ({ page }) => {
  await boot(page, true, true);
  await page.getByRole("switch", { name: "Advanced Intelligence" }).click();
  await expect(page.getByRole("button", { name: "Analyze video", exact: true })).toBeDisabled();
  await expect(page.getByText(/Live inputs are not analyzed/)).toBeVisible();
});

test("verified native proxy travels through the actual controller to exactly twelve visible shots", async ({ page }) => {
  test.skip(!proxyManifestPath, "Supply the manifest from the native reviewed-fixture proxy test");
  const manifest = JSON.parse(readFileSync(proxyManifestPath!, "utf8"));
  const encoded = readFileSync(manifest.path).toString("base64");
  await boot(page);
  // Optional real helper, only for the explicitly supplied reviewed fixture.
  // Visual inference and Tauri IPC stay mocked; this is not a packaged-app test.
  if (audioHelperPath) await page.exposeFunction("runFixtureAudio", (request: Extract<VideoRequest, { operation: "analyze-audio" }>) => {
    expect(request.path).toBe(manifest.source.path);
    expect(request.source_sha256).toBe(manifest.source.sha256);
    expect(request.origin_us).toBe(manifest.source.origin_us);
    expect(request.duration_us).toBe(manifest.source.duration_us);
    expect(request.audio_track_index).toBe(0);
    expect(request.analysis_id).toMatch(/^[a-f0-9]{64}$/);
    const process = spawnSync(audioHelperPath, [], { input: JSON.stringify(request) + "\n", encoding: "utf8", timeout: 30_000 });
    expect(process.status, process.stderr || process.stdout).toBe(0);
    const packets = process.stdout.trim().split("\n").map(line => JSON.parse(line));
    const terminal = packets.at(-1);
    expect(terminal.type).toBe("complete");
    expect(terminal.analysis_id).toBe(request.analysis_id);
    expect(terminal.source_sha256).toBe(request.source_sha256);
    const windows: VideoAudioWindow[] = packets.filter(packet => packet.type === "window")
      .map(({ type: _type, ...window }) => window);
    expect(windows).toHaveLength(terminal.windows);
    return { audio_analysis: { analysis_id: terminal.analysis_id, source: manifest.source,
      audio_track_index: terminal.audio_track_index, classifier: terminal.classifier, os: terminal.os,
      preprocessing_version: terminal.preprocessing_version, status: terminal.status, windows } };
  });
  await page.evaluate(({ manifest, encoded, realAudio }) => {
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    const app = window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };
    const original = app.__TAURI_INTERNALS__.invoke;
    app.__TAURI_INTERNALS__.invoke = (cmd, args) => {
      if (cmd === "get_file_size") return Promise.resolve(bytes.length);
      if (cmd === "read_file_range") return Promise.resolve(bytes.slice(Number(args?.offset), Number(args?.offset) + Number(args?.length)).buffer);
      if (cmd === "video_intelligence_run") {
        const request = args?.request as { operation: string; analysis_id: string; shots: { id: number; start_us: number; end_us: number; transcript: string }[] };
        if (request.operation === "models") return Promise.resolve({ models: [{ id: "qwen3.5-9b-video", ready: true }] });
        if (request.operation === "prepare-shot-proxy") return Promise.resolve({ scene_proxy: manifest });
        if (request.operation === "inspect-video") return Promise.resolve({ analysis_source: manifest.source });
        if (request.operation === "analyze-shots") return Promise.resolve({ shot_analysis: { analysis_id: request.analysis_id,
          source: manifest.source, model_id: "qwen3.5-9b-video", model_revision: "test", sampling_version: "shot-spread-8frames-384-v1", audio_analyzed: false,
          shots: request.shots.map(shot => ({ ...shot, frame_pts_us: [shot.start_us], text: `Visible description for shot ${shot.id}.` })) } });
        if (request.operation === "analyze-audio") {
          if (realAudio) return (window as unknown as { runFixtureAudio: (request: unknown) => Promise<unknown> }).runFixtureAudio(request);
          return Promise.resolve({ audio_analysis: { analysis_id: request.analysis_id, source: manifest.source,
            audio_track_index: 0, classifier: "apple-soundanalysis-version1", os: "fixture", preprocessing_version: "pcm48k-mono-3s-nonoverlap-v1",
            status: "no-audio", windows: [] } });
        }
      }
      return original(cmd, args);
    };
  }, { manifest, encoded, realAudio: !!audioHelperPath });
  await page.setViewportSize({ width: 440, height: 800 });
  await page.getByRole("switch", { name: "Advanced Intelligence" }).click();
  await page.getByRole("button", { name: "Analyze video", exact: true }).click();
  await expect(page.getByText("12 shots · 11 detected cuts")).toBeVisible();
  await expect(page.locator(".cp-shot-list > li")).toHaveCount(12);
  await expect(page.getByRole("button", { name: "00:00.000 to 00:00.867", exact: true })).toBeVisible();
  await expect(page.getByText("Visible description for shot 12.")).toBeAttached();
  if (audioHelperPath) {
    await expect(page.getByText(/Source audio analyzed/)).toBeVisible();
    await expect(page.getByText(/Music type is not yet verified/)).toBeVisible();
    const disclosure = page.getByText("Audio evidence · 8 windows");
    await disclosure.focus(); await page.keyboard.press("Enter");
    await expect(page.locator(".cp-shot-audio-windows > li")).toHaveCount(8);
    await expect(page.getByText("Short tail. Not classified.")).toBeAttached();
    await expect(page.locator(".cp-shot-audio-windows > li").last()).toContainText("00:21.000 to 00:23.500");
    for (const enlarged of [false, true]) {
      if (enlarged) await page.evaluate(() => {
        const root = document.documentElement, computed = getComputedStyle(root);
        const values = ["xs", "sm", "base", "md", "lg", "xl"].map(size => {
          const name = `--text-${size}`;
          return [name, `${parseFloat(computed.getPropertyValue(name)) * 1.25}px`];
        });
        for (const [name, value] of values) root.style.setProperty(name, value);
      });
      for (const width of [360, 440]) {
        await page.setViewportSize({ width, height: 800 });
        expect(await page.locator(".cp-shot-audio").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
        expect((await disclosure.boundingBox())!.height).toBeGreaterThanOrEqual(24);
      }
    }
    await page.screenshot({ path: `/private/tmp/sauce-ai-audio-${process.env.SCENE_BROWSER ?? "chrome"}.png`, animations: "disabled" });
  } else await expect(page.getByText("This video has no audio track.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Analyze video", exact: true })).toBeEnabled();
  const saved = await page.evaluate(() => new Promise<number>((resolve, reject) => {
    const request = indexedDB.open("sauce-scene-evidence", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const count = db.transaction("detections").objectStore("detections").count();
      count.onsuccess = () => { db.close(); resolve(count.result); };
      count.onerror = () => { db.close(); reject(count.error); };
    };
  }));
  expect(saved).toBe(1);
  await page.screenshot({ path: "/private/tmp/sauce-ai-summary-shots.png" });
});
