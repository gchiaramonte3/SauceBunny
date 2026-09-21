import { expect, test, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";
import { readFileSync } from "node:fs";
import { execFile, spawnSync } from "node:child_process";
import { isAbsolute } from "node:path";
import type { VideoRequest } from "../src/bindings/VideoRequest";
import type { VideoAudioWindow } from "../src/bindings/VideoAudioWindow";
import type { VideoMusicAnalysis } from "../src/bindings/VideoMusicAnalysis";
import type { VideoShotAnalysis } from "../src/bindings/VideoShotAnalysis";

const proxyManifestPath = process.env.SCENE_PROXY_MANIFEST;
const generatedReportPath = process.env.SCENE_GENERATED_SMOKE_REPORT;
const audioHelperPath = process.env.SCENE_AUDIO_HELPER;
const musicReportPath = process.env.SCENE_MUSIC_REPORT;
const videoWorkerPath = process.env.SCENE_VIDEO_WORKER;
const videoRoot = process.env.SCENE_VIDEO_ROOT;

// Match the deliberately small production Markdown renderer's text contract.
// Keep every word/punctuation mark; remove only its supported markup syntax.
function renderedDescriptionText(source: string): string {
  return source.replace(/\r\n/g, "\n")
    .replace(/^\s*(?:#{1,3}\s+|[-*+]\s+|\d+\.\s+)/gm, "")
    .replace(/`([^`]+)`/g, "$1").replace(/\*/g, "")
    .replace(/\s+/g, " ").trim();
}

test("description assertion retains all prose across supported Markdown layouts", () => {
  expect(renderedDescriptionText("Visible blue.\n\nNo supplied transcript.")).toBe("Visible blue. No supplied transcript.");
  expect(renderedDescriptionText("### Visual Observations:\n- **Solid blue**.\n\n### Transcript Summary:\n- No transcript.")).toBe("Visual Observations: Solid blue. Transcript Summary: No transcript.");
  expect(renderedDescriptionText("1. `source_frame` at [00:01].\n2. +12 dB; no text.")).toBe("source_frame at [00:01]. +12 dB; no text.");
});

test.use({ browserName: process.env.SCENE_BROWSER === "webkit" ? "webkit" : "chromium",
  channel: (proxyManifestPath || generatedReportPath) && process.env.SCENE_BROWSER !== "webkit" ? "chrome" : undefined });

test.beforeEach(async ({ page }) => {
  if (process.env.SAUCE_PACKAGED_FRONTEND !== "1") return;
  // A production bundle without its CSP is still weaker evidence than the
  // desktop path. Apply the configured policy to the browser document too.
  // The custom Tauri origin/IPC remains a separate packaged-desktop gate.
  const policy: unknown = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).app.security.csp;
  expect(typeof policy).toBe("string");
  await page.route("**/*", async route => {
    if (route.request().resourceType() !== "document") return route.continue();
    const response = await route.fetch();
    await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": String(policy) } });
  });
  await page.addInitScript(() => {
    localStorage.removeItem("e2e.cspViolations");
    document.addEventListener("securitypolicyviolation", event => {
      const violations = JSON.parse(localStorage.getItem("e2e.cspViolations") ?? "[]");
      violations.push({ directive: event.effectiveDirective, blocked: event.blockedURI });
      localStorage.setItem("e2e.cspViolations", JSON.stringify(violations));
    });
  });
});

test.afterEach(async ({ page }) => {
  if (process.env.SAUCE_PACKAGED_FRONTEND !== "1" || page.isClosed() || page.url() === "about:blank") return;
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("e2e.cspViolations") ?? "[]"))).toEqual([]);
});

async function boot(page: Page, enabled = true, live = false, videoPath = "/clip.mp4") {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(({ enabled, live, videoPath }) => {
    if (enabled) localStorage.setItem("saucebunny.shotIntelligence.preview", "1");
    localStorage.setItem("saucebunny.ai.provider", "openai"); // Fake cloud IPC; prevents unrelated local pre-warm.
    localStorage.setItem("saucebunny.panelSnapshot", JSON.stringify({ sourceIdentity: "source-a", programInputActive: live,
      transcriptPath: "/clip.srt", aiVideoPath: videoPath, hasSource: true, durationSec: 12, chapterSourceKey: "source-a" }));
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
  }, { enabled, live, videoPath });
  await page.goto("/?window=panel");
  await page.getByRole("tab", { name: "AI Summary" }).click();
}

test("the rollout defaults to the unchanged text workflow", async ({ page }) => {
  await boot(page, false);
  await expect(page.getByRole("switch", { name: "Advanced Intelligence" })).toHaveCount(0);
  await expect(page.getByText("Chat with this transcript")).toBeVisible();
});

test("an explicitly opted-in build exposes Advanced without changing saved preferences", async ({ page }) => {
  test.skip(process.env.VITE_SHOT_INTELLIGENCE_PREVIEW !== "1", "Requires the explicit preview-build flag");
  await boot(page, false);
  const mode = page.getByRole("switch", { name: "Advanced Intelligence" });
  await expect(mode).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("saucebunny.shotIntelligence.preview"))).toBeNull();
  await mode.click();
  await expect(page.getByText("Understand the cut, shot by shot.")).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("e2e.shotRequests"))).toBeNull();
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
  await expect(page.getByRole("button", { name: "Analyze video", exact: true })).toBeDisabled();
  await expect(page.getByRole("combobox", { name: "Picture model" })).toContainText("not installed");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("e2e.shotRequests") ?? "[]"))).toEqual([{ operation: "models" }]);
  const box = (await mode.boundingBox())!;
  await expect(mode).toHaveClass(/cp-toggle-switch on/);
  expect(box.width).toBe(30); expect(box.height).toBe(18);
  const hitArea = await mode.evaluate(element => {
    const style = getComputedStyle(element, "::before");
    return element.getBoundingClientRect().height - parseFloat(style.top) - parseFloat(style.bottom);
  });
  expect(hitArea).toBeGreaterThanOrEqual(24);
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

test("detected cuts keep their action beside the count in narrow and enlarged panels", async ({ page }) => {
  test.skip(process.env.SAUCE_PACKAGED_FRONTEND === "1", "Isolated layout fixture replaces a dev hook, not packaged inference");
  // Production UI, deterministic evidence only. No detection or model job.
  await page.route("**/src/hooks/use-shot-intelligence.ts*", route => route.fulfill({
    contentType: "text/javascript", body: `export function useShotIntelligence() { return {
      busy:false, stopping:false, draining:false, error:"", nativeError:"", audioError:"", phase:"", progress:null,
      audio:{status:"not-started"}, answers:[], start:async()=>{}, stop:()=>{},
      evidence:{id:"layout", detection:{boundaries:[{}]}, shots:[
        {id:"1",start_us:0,end_us:1001000,transcript:""},
        {id:"2",start_us:1001000,end_us:2002000,transcript:""}
      ]}
    }; }`,
  }));
  await page.setViewportSize({ width: 440, height: 800 });
  await boot(page);
  await page.getByRole("switch", { name: "Advanced Intelligence" }).click();
  const summary = page.locator(".cp-shot-summary");
  await expect(summary).toContainText("2 shots · 1 cut");
  for (const width of [440, 360]) {
    await page.setViewportSize({ width, height: 800 });
    for (const scale of [1, 1.25]) {
      await page.locator(".cp-shot-analysis").evaluate((element, value) => {
        (element as HTMLElement).style.zoom = String(value);
      }, scale);
      const countBox = (await summary.locator(".cp-shot-count").boundingBox())!;
      const actionBox = (await summary.getByRole("button", { name: "Add cut markers" }).boundingBox())!;
      expect(Math.abs(countBox.y + countBox.height / 2 - actionBox.y - actionBox.height / 2)).toBeLessThan(2);
      expect(actionBox.x + actionBox.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
  await page.screenshot({ path: `/private/tmp/sauce-shot-summary-${process.env.SCENE_BROWSER ?? "chromium"}.png` });
  await summary.getByRole("button", { name: "Add cut markers" }).click();
  await expect(summary.getByRole("status")).toHaveText("Added 1 cut marker.");
  const cutNotifications = await page.evaluate(() => {
    const mock = (window as unknown as { __TAURI_MOCK__: {
      invoked: () => { cmd: string; args?: { event?: string } }[];
    } }).__TAURI_MOCK__;
    return mock.invoked().filter(call => call.cmd === "plugin:event|emit" && call.args?.event === "panel:action:cutMarkersChanged").length;
  });
  expect(cutNotifications).toBe(1);
});

for (const scenario of [
  { name: "verified native proxy travels through the actual controller to exactly twelve visible shots", generated: false },
  { name: "generated fractional-rate proxy and real Qwen produce two source-bound visible shots", generated: true },
]) test(scenario.name, async ({ page }) => {
  test.skip(scenario.generated ? !generatedReportPath || !videoWorkerPath : !proxyManifestPath,
    scenario.generated ? "Supply SCENE_GENERATED_SMOKE_REPORT and the real Qwen worker/root" : "Supply the manifest from the native reviewed-fixture proxy test");
  if (videoWorkerPath) test.setTimeout(240_000); // Inference-test deadline, not a production readiness delay.
  const generatedReport = scenario.generated ? JSON.parse(readFileSync(generatedReportPath!, "utf8")) : null;
  if (generatedReport) {
    expect(generatedReport.status).toBe("passed");
    expect(generatedReport.frames).toBe(48);
    expect(generatedReport.source.duration_us).toBe(2_002_000);
  }
  const manifest = generatedReport?.proxy ?? JSON.parse(readFileSync(proxyManifestPath!, "utf8"));
  const expectedShots = scenario.generated ? 2 : 12;
  const encoded = readFileSync(manifest.path).toString("base64");
  let recordedMusic: VideoMusicAnalysis | null = null;
  if (musicReportPath && !scenario.generated) {
    // Replay actual source-bound scores through the UI, not a claim that this
    // browser owns the native worker. Its real lifecycle has a separate gate.
    const report = JSON.parse(readFileSync(musicReportPath, "utf8"));
    expect(report.schema).toBe("sauce.music-worker-smoke.v1");
    expect(report.network).toBe("sandbox-denied");
    expect(report.completed.exit_code).toBe(0);
    const packets = report.completed.packets;
    const terminal = packets.at(-1);
    expect(terminal.type).toBe("complete");
    expect(terminal.source_sha256).toBe(manifest.source.sha256);
    expect(terminal.origin_us).toBe(manifest.source.origin_us);
    expect(terminal.duration_us).toBe(manifest.source.duration_us);
    expect(terminal.labels).toHaveLength(527);
    recordedMusic = { analysis_id: terminal.analysis_id, source: manifest.source,
      audio_track_index: terminal.audio_track_index, classifier: terminal.classifier, os: terminal.os,
      preprocessing_version: terminal.preprocessing_version, status: terminal.status, labels: terminal.labels,
      windows: packets.filter((packet: { type: string }) => packet.type === "window")
        .map((packet: { start_us: number; end_us: number; rms: number; peak: number;
          status: "classified"; scores_f32le: string }) => {
          const bytes = Buffer.from(packet.scores_f32le, "base64");
          expect(bytes.length).toBe(527 * 4);
          return { start_us: packet.start_us, end_us: packet.end_us, rms: packet.rms, peak: packet.peak,
            status: packet.status, scores: Array.from({ length: 527 }, (_, index) => bytes.readFloatLE(index * 4)) };
        }) };
    expect(recordedMusic.windows).toHaveLength(terminal.windows);
  }
  let realDescriptions: VideoShotAnalysis | undefined;
  if (videoWorkerPath) {
    expect(isAbsolute(videoWorkerPath)).toBe(true);
    expect(videoRoot && isAbsolute(videoRoot)).toBe(true);
    await page.exposeFunction("runFixtureShots", async (request: Extract<VideoRequest, { operation: "analyze-shots" }>) => {
      expect(request.path).toBe(manifest.source.path);
      expect(request.source_sha256).toBe(manifest.source.sha256);
      expect(request.analysis_id).toMatch(/^[a-f0-9]{64}$/);
      // Real offline model inference on this explicitly supplied source only.
      // The browser/native transport is still a test bridge, not Tauri certification.
      const output = await new Promise<string>((resolve, reject) => {
        const child = execFile("/usr/bin/sandbox-exec", ["-p", "(version 1)(allow default)(deny network*)",
          videoWorkerPath, "--root", videoRoot!], {
          encoding: "utf8", timeout: 180_000,
          env: { ...process.env, PATH: "/usr/bin:/bin", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" },
        }, (error, stdout, stderr) => {
          page.off("close", cancel);
          if (error) reject(new Error(stderr || stdout || error.message, { cause: error }));
          else resolve(stdout);
        });
        const cancel = () => { child.kill("SIGTERM"); };
        page.once("close", cancel);
        child.stdin!.end(JSON.stringify(request) + "\n");
      });
      const packets = output.trim().split("\n").map(line => JSON.parse(line));
      const terminal = packets.at(-1);
      expect(terminal.type).toBe("result");
      const analysis: VideoShotAnalysis = terminal.shot_analysis;
      expect(analysis.analysis_id).toBe(request.analysis_id);
      expect(analysis.source).toEqual(manifest.source);
      expect(analysis.shots.map(({ id, start_us, end_us, transcript }) => ({ id, start_us, end_us, transcript }))).toEqual(request.shots);
      expect(analysis.shots.every(shot => shot.text.trim() && shot.frame_pts_us.length
        && shot.frame_pts_us.every(pts => pts >= shot.start_us && pts < shot.end_us))).toBe(true);
      realDescriptions = analysis;
      return terminal;
    });
  }
  await boot(page, true, false, manifest.source.path);
  // Optional real helper, only for the explicitly supplied reviewed fixture.
  // Without SCENE_VIDEO_WORKER, visual inference stays mocked. Tauri IPC is
  // always a test bridge here; this is not a packaged-app test.
  if (audioHelperPath && !recordedMusic) await page.exposeFunction("runFixtureAudio", (request: Extract<VideoRequest, { operation: "analyze-audio" }>) => {
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
  await page.evaluate(({ manifest, encoded, realAudio, recordedMusic, realVideo }) => {
    const bytes = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
    const app = window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };
    const original = app.__TAURI_INTERNALS__.invoke;
    app.__TAURI_INTERNALS__.invoke = (cmd, args) => {
      if (cmd === "get_file_size") return Promise.resolve(bytes.length);
      if (cmd === "read_file_range") return Promise.resolve(bytes.slice(Number(args?.offset), Number(args?.offset) + Number(args?.length)).buffer);
      if (cmd === "video_intelligence_run") {
        const request = args?.request as { operation: string; analysis_id: string; shots: { id: number; start_us: number; end_us: number; transcript: string }[] };
        if (request.operation === "models") return Promise.resolve({ models: [
          { id: "qwen3.5-9b-video", ready: true }, ...(recordedMusic ? [{ id: "ast-audioset", ready: true }] : []),
        ] });
        if (request.operation === "prepare-shot-proxy") return Promise.resolve({ scene_proxy: manifest });
        if (request.operation === "inspect-video") return Promise.resolve({ analysis_source: manifest.source });
        if (request.operation === "analyze-shots" && realVideo) {
          return (window as unknown as { runFixtureShots: (request: unknown) => Promise<unknown> }).runFixtureShots(request);
        }
        if (request.operation === "analyze-shots") return Promise.resolve({ shot_analysis: { analysis_id: request.analysis_id,
          source: manifest.source, model_id: "qwen3.5-9b-video", model_revision: "test", sampling_version: "shot-spread-8frames-384-display-v2", audio_analyzed: false,
          shots: request.shots.map(shot => ({ ...shot, frame_pts_us: [shot.start_us], text: `Visible description for shot ${shot.id}.` })) } });
        if (request.operation === "analyze-music" && recordedMusic) {
          // The recording predates this browser's scene-evidence ID. Only the
          // mocked IPC envelope changes; actual ranges, energy and scores do not.
          return Promise.resolve({ music_analysis: { ...recordedMusic, analysis_id: request.analysis_id } });
        }
        if (request.operation === "analyze-audio") {
          if (realAudio) return (window as unknown as { runFixtureAudio: (request: unknown) => Promise<unknown> }).runFixtureAudio(request);
          return Promise.resolve({ audio_analysis: { analysis_id: request.analysis_id, source: manifest.source,
            audio_track_index: 0, classifier: "apple-soundanalysis-version1", os: "fixture", preprocessing_version: "pcm48k-mono-3s-nonoverlap-v1",
            status: "no-audio", windows: [] } });
        }
      }
      return original(cmd, args);
    };
  }, { manifest, encoded, realAudio: !!audioHelperPath, recordedMusic, realVideo: !!videoWorkerPath });
  await page.setViewportSize({ width: 440, height: 800 });
  await page.getByRole("switch", { name: "Advanced Intelligence" }).click();
  await page.getByRole("button", { name: "Analyze video", exact: true }).click();
  await expect(page.getByText(`${expectedShots} shots · ${expectedShots - 1} detected cuts`)).toBeVisible();
  await expect(page.locator(".cp-shot-list > li")).toHaveCount(expectedShots);
  await expect(page.getByRole("button", { name: scenario.generated ? "00:00.000 to 00:01.001" : "00:00.000 to 00:00.867", exact: true })).toBeVisible();
  if (videoWorkerPath) {
    await expect(page.getByRole("button", { name: "Analyze video", exact: true })).toBeEnabled({ timeout: 200_000 });
    expect(realDescriptions?.shots).toHaveLength(expectedShots);
    await test.info().attach("actual-shot-descriptions", { body: JSON.stringify(realDescriptions, null, 2), contentType: "application/json" });
    for (const shot of realDescriptions!.shots) {
      // The prior greedy sampler repeated 32 sentences on shot 2. Retain the
      // raw answer above; fail the real-model check instead of hiding a loop.
      const sentences = shot.text.split(/(?<=[.!?])\s+/).map(text => text.trim()).filter(Boolean);
      expect(sentences.length - new Set(sentences).size, `Shot ${shot.id} repeated sentences`).toBeLessThan(3);
      // Verify all rendered prose, not Markdown characters deliberately
      // replaced by headings, list elements and emphasis.
      await expect(page.locator(".cp-shot-list > li").nth(shot.id - 1).locator(".cp-md"))
        .toHaveText(renderedDescriptionText(shot.text), { useInnerText: true });
    }
    if (scenario.generated) {
      expect(realDescriptions!.shots[0].text.toLowerCase()).toContain("red");
      expect(realDescriptions!.shots[1].text.toLowerCase()).toContain("blue");
      expect(realDescriptions!.shots.map(shot => [shot.start_us, shot.end_us])).toEqual([[0, 1_001_000], [1_001_000, 2_002_000]]);
    }
  } else await expect(page.getByText("Visible description for shot 12.")).toBeAttached();
  if (!scenario.generated && (audioHelperPath || recordedMusic)) {
    await expect(page.getByText(/Source audio analyzed/)).toBeVisible();
    const count = recordedMusic ? 3 : 8;
    if (recordedMusic) {
      await expect(page.getByText("Possible music type: Electronic music.")).toBeVisible();
      await expect(page.locator(".cp-shot-audio-windows")).toHaveCount(0);
    } else await expect(page.getByText(/Music type is not yet verified/)).toBeVisible();
    const disclosure = page.getByText(`Audio evidence · ${count} windows`);
    await disclosure.focus(); await page.keyboard.press("Enter");
    await expect(page.locator(".cp-shot-audio-windows > li")).toHaveCount(count);
    if (recordedMusic) {
      await expect(page.locator(".cp-shot-audio-windows > li").nth(0)).toContainText("Music suggested. Type unclear.");
      await expect(page.locator(".cp-shot-audio-windows > li").nth(1)).toContainText("Possible type: Electronic music.");
      await expect(page.locator(".cp-shot-audio-windows > li").last()).toContainText("Short window. Music type unclear.");
      await expect(page.locator(".cp-shot-audio-windows > li").last()).toContainText("00:20.000 to 00:23.500");
      await expect(page.getByText(/not song boundaries/)).toBeAttached();
    } else {
      await expect(page.getByText("Short tail. Not classified.")).toBeAttached();
      await expect(page.locator(".cp-shot-audio-windows > li").last()).toContainText("00:21.000 to 00:23.500");
    }
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
    await page.locator(".cp-ai-thread").last().evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: `/private/tmp/sauce-ai-${recordedMusic ? "music" : "audio"}-${process.env.SCENE_BROWSER ?? "chrome"}.png`, animations: "disabled" });
    await disclosure.click(); // Final screenshot shows the normal compact result, not expanded diagnostics.
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
  await page.getByRole("button", { name: "Add cut markers", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: `Added ${expectedShots - 1} cut marker` })).toBeVisible();
  const cuts = await page.evaluate(() => JSON.parse(localStorage.getItem("saucebunny.cutMarkers.source-a") ?? "[]"));
  expect(cuts).toHaveLength(expectedShots - 1);
  if (scenario.generated) expect(cuts.map((cut: { time: number }) => cut.time)).toEqual([1.001]);
  await page.screenshot({ path: "/private/tmp/sauce-ai-summary-shots.png" });
});
