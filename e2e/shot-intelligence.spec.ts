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
import { secondsToTc } from "../src/lib/timecode";
import { AUDIOSET_CLASSIFIER, AUDIOSET_PREPROCESSING } from "../src/lib/scene-analysis/music-summary";

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

async function boot(page: Page, enabled = true, live = false, videoPath = "/clip.mp4", fps = 30) {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(({ enabled, live, videoPath, fps }) => {
    if (enabled) localStorage.setItem("saucebunny.shotIntelligence.preview", "1");
    localStorage.setItem("saucebunny.ai.provider", "openai"); // Fake cloud IPC; prevents unrelated local pre-warm.
    localStorage.setItem("saucebunny.panelSnapshot", JSON.stringify({ sourceIdentity: "source-a", programInputActive: live,
      transcriptPath: "/clip.srt", aiVideoPath: videoPath, fps, hasSource: true, durationSec: 12, chapterSourceKey: "source-a" }));
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
  }, { enabled, live, videoPath, fps });
  await page.goto("/?window=panel");
  await page.getByRole("tab", { name: "AI Summary" }).click();
}

test("shot corrections edit every column, reopen, and remain compact at narrow widths", async ({ page }) => {
  test.skip(process.env.SAUCE_PACKAGED_FRONTEND === "1", "Correction UI fixture uses mocked native persistence, not packaged inference");
  await page.setViewportSize({ width: 440, height: 820 });
  await page.route("**/src/hooks/use-shot-intelligence.ts*", route => route.fulfill({ contentType: "text/javascript", body: `
    export function useShotIntelligence() {
      const restored = !!localStorage.getItem("e2e.analysisCorrections");
      return { busy:false, stopping:false, draining:false, error:"", nativeError:"", audioError:"", phase:"", progress:null,
        audio:{status:"not-started"}, dialogue:{status:"ready",text:{},error:""}, complete:true, modelUsed:"qwen3.5-9b-video",
        evidence: restored ? null : {id:"fixture",proxy:{source:{path:"/clip.mp4",sha256:"${"a".repeat(64)}",duration_us:4000000,origin_us:0}},
          shots:[{id:1,start_us:0,end_us:2000000,transcript:"Original dialogue"},{id:2,start_us:2000000,end_us:4000000,transcript:""}],detection:{boundaries:[{}]}},
        answers:[{id:1,picture_description:"Original picture",transcript_summary:"Original summary"}], start:async()=>{},stop:()=>{}};
    }` }));
  await boot(page, true, false, "/clip.mp4", 24000 / 1001);
  const mockCorrectionPersistence = () => {
    const app = window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };
    const invoke = app.__TAURI_INTERNALS__.invoke;
    app.__TAURI_INTERNALS__.invoke = async (cmd, args) => {
      const stored = JSON.parse(localStorage.getItem("e2e.analysisCorrections") ?? "null");
      if (cmd === "load_analysis_corrections") return stored;
      if (cmd === "save_analysis_correction") {
        if (localStorage.getItem("e2e.correctionFailure")) throw new Error("Cannot save: disk full");
        const snapshot = args?.snapshot as Record<string, unknown>, key = String(args?.key);
        const doc = { ...snapshot, revision: (stored?.revision ?? 0) + 1, corrections: { ...stored?.corrections,
          [key]: { ...(args?.edit as Record<string, unknown>), revision: Number(args?.expectedRevision) + 1 } } };
        localStorage.setItem("e2e.analysisCorrections", JSON.stringify(doc)); return doc;
      }
      return invoke(cmd, args);
    };
  };
  await page.addInitScript(mockCorrectionPersistence);
  await page.evaluate(mockCorrectionPersistence);
  await page.getByRole("switch", { name: "Advanced Intelligence" }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByRole("button", { name: "Edit shot 1 picture", exact: true }).click();
  await page.getByRole("textbox", { name: "Picture", exact: true }).fill("Corrected picture: 東京 é");
  const bounds = (await page.getByRole("dialog").boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(8); expect(bounds.x + bounds.width).toBeLessThanOrEqual(432);
  await page.screenshot({ path: `/private/tmp/sauce-analysis-editor-${process.env.SCENE_BROWSER ?? "chromium"}.png`, animations: "disabled" });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText("Corrected picture: 東京 é", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit shot 1 end", exact: true }).click();
  const end = page.getByRole("textbox", { name: "End", exact: true });
  await end.fill("abc"); await expect(end).not.toHaveValue("abc");
  await end.fill("100"); await end.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit shot 1 end", exact: true })).toHaveText("00:00:01:00");
  await page.getByRole("button", { name: "Edit shot 1 start", exact: true }).click();
  await page.getByRole("textbox", { name: "Start", exact: true }).fill("1");
  await page.getByRole("textbox", { name: "Start", exact: true }).press("Enter");
  await page.getByRole("button", { name: "Edit shot 1 duration", exact: true }).click();
  await page.getByRole("textbox", { name: "Duration", exact: true }).fill("100");
  await page.getByRole("textbox", { name: "Duration", exact: true }).press("Enter");
  await expect(page.getByRole("button", { name: "Edit shot 1 end", exact: true })).toHaveText("00:00:01:01");
  await page.getByText("Transcript summary", { exact: true }).first().click();
  await page.getByRole("button", { name: "Edit shot 1 transcript summary", exact: true }).click();
  await page.getByRole("textbox", { name: "Transcript summary", exact: true }).fill("Corrected summary");
  await page.getByRole("textbox", { name: "Transcript summary", exact: true }).press("Control+Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Edit shot 1 dialogue", exact: true }).click();
  await page.getByRole("textbox", { name: "Dialogue", exact: true }).fill("");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit shot 1 dialogue", exact: true })).toHaveText("Empty");
  await page.getByRole("button", { name: "Edit shot 1 shot", exact: true }).click();
  await page.getByRole("textbox", { name: "Shot", exact: true }).fill("1B");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: "Edit shot 1B picture", exact: true })).toBeVisible();
  await page.evaluate(() => localStorage.setItem("e2e.correctionFailure", "1"));
  await page.getByRole("button", { name: "Edit shot 1B picture", exact: true }).click();
  await page.getByRole("textbox", { name: "Picture", exact: true }).fill("Unsaved draft");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("Cannot save: disk full");
  await expect(page.getByRole("textbox", { name: "Picture", exact: true })).toHaveValue("Unsaved draft");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  // Reopen the production analysis panel. The live hook has no evidence;
  // the persisted document must supply the corrected rows without inference.
  await page.reload();
  await page.getByRole("tab", { name: "AI Summary", exact: true }).click();
  const mode = page.getByRole("switch", { name: "Advanced Intelligence" });
  if (!(await mode.isChecked())) await mode.click();
  await expect(page.getByText("Corrected picture: 東京 é", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Shot 1B end at 00:00:01:01", exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("e2e.analysisCorrections") ?? "{}").corrections["0:2000000"].end_us)).toBe(1042708);
  expect(await page.evaluate(() => localStorage.getItem("saucebunny.cutMarkers.source-a"))).toBeNull();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("e2e.shotRequests") ?? "[]").filter((request: { operation: string }) => request.operation !== "models"))).toEqual([]);
});

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
  await expect(page.getByText("Analyze picture, dialogue, and audio.")).toBeVisible();
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
  await expect(page.getByText("Analyze picture, dialogue, and audio.")).toBeVisible();
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

test("analysis footer keeps every busy phase on one unclipped line beside Stop", async ({ page }) => {
  test.skip(process.env.SAUCE_PACKAGED_FRONTEND === "1", "Layout fixture replaces a dev hook, not packaged inference");
  await page.route("**/src/hooks/use-shot-intelligence.ts*", route => route.fulfill({
    contentType: "text/javascript", body: `import React from "/node_modules/.vite/deps/react.js";
      const {useEffect, useState} = React;
      export function useShotIntelligence() {
        const [phase, setPhase] = useState("");
        const [stopping, setStopping] = useState(false);
        useEffect(() => {
          const change = event => {setPhase(event.detail); setStopping(false);};
          window.addEventListener("test:analysis-phase", change);
          return () => window.removeEventListener("test:analysis-phase", change);
        }, []);
        return {busy:!!phase, stopping, draining:false, error:"", nativeError:"", audioError:"",
          phase, progress:42, audio:{status:"not-started"}, answers:[], evidence:null,
          start:async()=>{}, stop:()=>setStopping(true)};
      }`,
  }));
  await page.setViewportSize({ width: 360, height: 560 });
  await boot(page);
  await page.getByRole("switch", { name: "Advanced Intelligence" }).click();
  const footer = page.locator(".cp-shot-actions");
  const action = footer.locator(".cp-gen-btn");
  const label = action.locator(".cp-gen-load");
  const stop = footer.getByRole("button", { name: "Stop", exact: true });
  for (const width of [360, 440, 680]) {
    await page.setViewportSize({ width, height: 560 });
    for (const scale of [1, 1.25]) {
      await page.locator(".cp-shot-analysis").evaluate((element, value) => {
        (element as HTMLElement).style.zoom = String(value);
      }, scale);
      let firstHeight = 0;
      for (const phase of ["Preparing analysis video…", "Detecting shots…", "Checking source and transcript…",
        "Describing 0 of 1000 shots…", "Described 999 of 1000 shots", "Analyzing source audio…"]) {
        await page.evaluate(value => window.dispatchEvent(new CustomEvent("test:analysis-phase", { detail: value })), phase);
        await expect(action).toHaveAccessibleName(phase);
        await expect(label).toHaveText(phase);
        const geometry = await label.evaluate(element => {
          const range = document.createRange(); range.selectNodeContents(element);
          const style = getComputedStyle(element);
          return { text: range.getBoundingClientRect().toJSON(), whiteSpace: style.whiteSpace };
        });
        const buttonBox = (await action.boundingBox())!;
        const stopBox = (await stop.boundingBox())!;
        firstHeight ||= buttonBox.height;
        expect(buttonBox.height).toBeCloseTo(firstHeight, 1);
        expect(geometry.whiteSpace).toBe("nowrap");
        expect(geometry.text.y).toBeGreaterThan(buttonBox.y);
        expect(geometry.text.bottom).toBeLessThan(buttonBox.y + buttonBox.height);
        expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(stopBox.x - 7);
        expect(stopBox.x + stopBox.width).toBeLessThanOrEqual(width);
        expect(stopBox.y + stopBox.height).toBeLessThanOrEqual(560);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
    }
  }
  await page.setViewportSize({ width: 360, height: 560 });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("test:analysis-phase", { detail: "Preparing analysis video…" })));
  await expect(action).toHaveAccessibleName("Preparing analysis video…");
  await page.screenshot({ path: `/private/tmp/sauce-analysis-footer-${process.env.SCENE_BROWSER ?? "chromium"}.png` });
  await stop.click();
  await expect(action).toHaveAccessibleName("Stopping…");
  await expect(stop).toBeDisabled();
});

for (const fps of [24000 / 1001, 60000 / 1001]) test(`analysis uses source-frame timecode at ${fps} fps in the detached panel`, async ({ page, browserName }) => {
  test.skip(process.env.SAUCE_PACKAGED_FRONTEND === "1", "Uses deterministic evidence, not packaged inference");
  const startUs = Math.round((Math.round(fps) * 58 + 15) / fps * 1e6);
  const endUs = Math.round((Math.round(fps) * 59 + 15) / fps * 1e6);
  await page.route("**/src/hooks/use-shot-intelligence.ts*", route => route.fulfill({
    contentType: "text/javascript", body: `export function useShotIntelligence() { return {
      busy:false, stopping:false, draining:false, error:"", nativeError:"", audioError:"", phase:"", progress:null,
      audio:{status:"not-started"}, answers:[], start:async()=>{}, stop:()=>{},
      evidence:{id:"frame-clock", detection:{boundaries:[{}]}, shots:[
        {id:1,start_us:0,end_us:${startUs},transcript:""},
        {id:2,start_us:${startUs},end_us:${endUs},transcript:"Supplied dialogue."}
      ]}
    }; }`,
  }));
  await page.setViewportSize({ width: 440, height: 800 });
  await boot(page, true, false, "/fractional.mp4", fps);
  await page.getByRole("switch", { name: "Advanced Intelligence" }).click();
  const time = page.getByRole("button", { name: "Shot 2 start at 00:00:58:15", exact: true });
  const end = page.getByRole("button", { name: "Shot 2 end at 00:00:59:15", exact: true });
  await expect(time).toBeVisible();
  await expect(end).toBeVisible();
  await expect(page.locator(".cp-shot-duration").last()).toHaveText("00:00:01:00");
  const appearance = await time.evaluate(element => {
    const css = getComputedStyle(element);
    return { border: css.borderTopWidth, style: css.borderTopStyle, cursor: css.cursor, height: element.getBoundingClientRect().height };
  });
  expect(appearance).toMatchObject({ border: "1px", style: "solid", cursor: "pointer" });
  expect(appearance.height).toBeGreaterThanOrEqual(24);
  await time.click();
  const seeks = () => page.evaluate(() => (window as unknown as { __TAURI_MOCK__: {
    invoked: () => { args?: { event?: string; payload?: unknown } }[];
  } }).__TAURI_MOCK__.invoked().filter(call => call.args?.event === "panel:action:seek"));
  expect(JSON.stringify((await seeks()).at(-1))).toContain(String(startUs / 1e6));
  await time.press(browserName === "webkit" ? "Alt+Tab" : "Tab");
  await expect(end).toBeFocused();
  expect(await end.evaluate(element => getComputedStyle(element).outlineStyle)).toBe("solid");
  await end.press("Enter");
  expect(JSON.stringify((await seeks()).at(-1))).toContain(String(endUs / 1e6));
  await time.focus();
  await time.press("Space");
  expect(JSON.stringify((await seeks()).at(-1))).toContain(String(startUs / 1e6));
  for (const width of [360, 440, 680]) {
    await page.setViewportSize({ width, height: 800 });
    for (const scale of [1, 1.25]) {
      await page.locator(".cp-shot-analysis").evaluate((element, value) => (element as HTMLElement).style.zoom = String(value), scale);
      expect(await time.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
      expect(await end.evaluate(element => {
        const button = element.getBoundingClientRect(), cell = element.closest("td")!.getBoundingClientRect();
        return button.left >= cell.left && button.right <= cell.right;
      })).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
  await page.setViewportSize({ width: 680, height: 800 });
  await page.locator(".cp-shot-analysis").evaluate(element => (element as HTMLElement).style.zoom = "1");
  await page.screenshot({ path: `/private/tmp/sauce-frame-timecode-${Math.round(fps)}-${process.env.SCENE_BROWSER ?? "chromium"}.png` });
});

test("live shot and dialogue cells update in place without changing column widths", async ({ page }) => {
  test.skip(process.env.SAUCE_PACKAGED_FRONTEND === "1", "Uses deterministic progressive evidence");
  await page.route("**/src/hooks/use-shot-intelligence.ts*", route => route.fulfill({
    contentType: "text/javascript", body: `import React from '/node_modules/.vite/deps/react.js'; const {useState,useEffect}=React;
      export function useShotIntelligence() {
        const [step,setStep]=useState(0);
        useEffect(()=>{const update=e=>setStep(e.detail);window.addEventListener('test:shot-update',update);return()=>window.removeEventListener('test:shot-update',update)},[]);
        return {busy:true, stopping:false, draining:false, error:'', nativeError:'', audioError:'', phase:'Describing shots…', progress:step*25,
          audio:{status:'not-started'}, dialogue:{status:step>1?'ready':'analyzing',error:'',text:step?{1:step>1?'SPEAKER_00: Hello there.':'Hello there.'}:{}},
          answers:step>2?[{id:1,picture_description:'A person walks through a warmly lit room and pauses beside a window.'}]:[],
          start:async()=>{},stop:()=>{},evidence:{id:'live',detection:{boundaries:[{}]},shots:[
            {id:1,start_us:0,end_us:1000000,transcript:''},{id:2,start_us:1000000,end_us:2000000,transcript:''}]}};
      }`,
  }));
  await page.setViewportSize({ width: 680, height: 800 });
  await boot(page);
  await page.getByRole("switch", { name: "Advanced Intelligence" }).click();
  const table = page.locator(".cp-shot-table"), first = table.locator("tbody tr").first();
  await expect(first).toContainText("Transcribing…");
  const widths = () => table.locator("thead th").evaluateAll(cells => cells.map(cell => cell.getBoundingClientRect().width));
  const before = await widths();
  await first.evaluate(element => element.setAttribute("data-retained-row", "yes"));
  for (const step of [1, 2, 3]) {
    await page.evaluate(value => window.dispatchEvent(new CustomEvent("test:shot-update", { detail: value })), step);
    await expect(first).toContainText(step > 1 ? "SPEAKER_00: Hello there." : "Hello there.");
    expect(await widths()).toEqual(before);
    await expect(first).toHaveAttribute("data-retained-row", "yes");
  }
  await expect(first).toContainText("A person walks");
  await expect(table.locator("tbody tr").last()).toContainText("Pending");
  await expect(table.locator("tbody tr").last()).toContainText("No dialogue");
  await page.setViewportSize({ width: 360, height: 640 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("cut markers sit beside Audio and wrap safely in narrow and enlarged panels", async ({ page }) => {
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
  const toolbar = page.locator(".cp-shot-toolbar");
  const action = toolbar.getByRole("button", { name: "Add cut markers" });
  for (const width of [680, 440, 360]) {
    await page.setViewportSize({ width, height: 800 });
    for (const scale of [1, 1.25]) {
      await page.locator(".cp-shot-analysis").evaluate((element, value) => {
        (element as HTMLElement).style.zoom = String(value);
      }, scale);
      const audioBox = (await toolbar.getByRole("tab", { name: "Audio" }).boundingBox())!;
      const actionBox = (await action.boundingBox())!;
      if (width === 680) {
        expect(Math.abs(audioBox.y + audioBox.height / 2 - actionBox.y - actionBox.height / 2)).toBeLessThan(2);
        expect(actionBox.x).toBeGreaterThan(audioBox.x + audioBox.width + 7);
      } else expect(actionBox.y >= audioBox.y + audioBox.height || actionBox.x >= audioBox.x + audioBox.width).toBe(true);
      expect(actionBox.x + actionBox.width).toBeLessThanOrEqual(width);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
  await page.screenshot({ path: `/private/tmp/sauce-shot-summary-${process.env.SCENE_BROWSER ?? "chromium"}.png` });
  await action.click();
  await expect(toolbar.getByRole("status")).toHaveCount(0);
  const cutNotifications = await page.evaluate(() => {
    const mock = (window as unknown as { __TAURI_MOCK__: {
      invoked: () => { cmd: string; args?: { event?: string } }[];
    } }).__TAURI_MOCK__;
    return mock.invoked().filter(call => call.cmd === "plugin:event|emit" && call.args?.event === "panel:action:cutMarkersChanged");
  });
  expect(cutNotifications).toHaveLength(1);
  expect(cutNotifications[0].args).toMatchObject({ payload: { sourceKey: "source-a", addedCount: 1 } });
});

test("audio content uses compact icons, frame-based seeks and opt-in diagnostics at narrow widths", async ({ page }) => {
  test.skip(process.env.SAUCE_PACKAGED_FRONTEND === "1", "Deterministic audio evidence fixture, not packaged inference");
  const audio: VideoMusicAnalysis = {
    analysis_id: "audio-layout", source: { path: "/audio-fixture.mp4", sha256: "test", origin_us: 3e6, duration_us: 40e6 },
    audio_track_index: 0, classifier: AUDIOSET_CLASSIFIER, preprocessing_version: AUDIOSET_PREPROCESSING, os: "Test OS",
    status: "decoded", labels: ["Speech", "Music", "Explosion", "Throbbing"], windows: [
      { start_us: 0, end_us: 13, peak: .1, rms: .1, status: "insufficient-context", scores: [] },
      ...[[.8, .1, 0, 0], [.6, .7, .1, .32], [.1, .9, 0, 0], [.1, .1, .8, 0]].map((scores, index) => ({
        start_us: index ? index * 10e6 : 13, end_us: (index + 1) * 10e6, peak: .5, rms: .2, status: "classified" as const, scores,
      })),
    ],
  };
  await page.route("**/src/hooks/use-shot-intelligence.ts*", route => route.fulfill({ contentType: "text/javascript", body: `
    export function useShotIntelligence() { return {
      busy:false, complete:true, stopping:false, draining:false, error:"", nativeError:"", audioError:"", phase:"", progress:null,
      modelUsed:"qwen3.5-4b-video", audio:{status:"ready",evidence:${JSON.stringify(audio)}}, answers:[], start:async()=>{}, stop:()=>{},
      evidence:{id:"audio-layout", detection:{boundaries:[]}, shots:[{id:"one",start_us:0,end_us:40000000,transcript:""}]}
    }; }` }));
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  const fps = 24000 / 1001;
  await page.setViewportSize({ width: 680, height: 800 });
  await boot(page, true, false, "/audio-fixture.mp4", fps);
  await page.getByRole("switch", { name: "Advanced Intelligence" }).click();
  await expect(page.getByRole("list", { name: "Audio content" })).toHaveCount(0);
  await page.getByRole("tab", { name: "Audio", exact: true }).click();
  const list = page.getByRole("list", { name: "Audio content" });
  const rows = list.getByRole("listitem");
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(0)).toContainText("Speech");
  await expect(rows.nth(1)).toContainText("Speech + Music");
  await expect(rows.nth(1).locator("svg")).toHaveCount(2);
  await expect(rows.nth(2)).toContainText("Music");
  await expect(rows.nth(3)).toContainText("SFXExplosion");
  await expect(page.getByText(/score|Throbbing|Type unclear|Short tail|Audio evidence/i)).toHaveCount(0);
  const start = rows.nth(1).getByRole("button", { name: /start at/ });
  const end = rows.nth(1).getByRole("button", { name: /end at/ });
  await expect(start).toHaveText(secondsToTc(10, fps));
  await expect(end).toHaveText(secondsToTc(20, fps));
  const seekPayloads = () => page.evaluate(() => (window as unknown as { __TAURI_MOCK__: {
    invoked: () => { args?: { event?: string; payload?: unknown } }[];
  } }).__TAURI_MOCK__.invoked().filter(call => call.args?.event === "panel:action:seek").map(call => call.args?.payload));
  await start.focus(); await page.keyboard.press("Enter");
  expect(JSON.stringify((await seekPayloads()).at(-1))).toContain(String(Math.floor(10 * fps) / fps));
  await end.focus(); await page.keyboard.press("Space");
  expect(JSON.stringify((await seekPayloads()).at(-1))).toContain(String(Math.floor(20 * fps) / fps));
  const originalSizes = await page.evaluate(() => Object.fromEntries(["base", "sm", "md", "lg", "xl"].map(size => [size, parseFloat(getComputedStyle(document.documentElement).getPropertyValue(`--text-${size}`))])));
  for (const width of [680, 440, 360]) for (const scale of [1, 1.25]) {
    await page.setViewportSize({ width, height: 800 });
    await page.evaluate(({ sizes, scale }) => { for (const [name, size] of Object.entries(sizes)) document.documentElement.style.setProperty(`--text-${name}`, `${size * scale}px`); }, { sizes: originalSizes, scale });
    expect(await list.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const box = (await start.boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(24); expect(box.height).toBeGreaterThanOrEqual(24);
    expect(await rows.nth(1).locator("svg").first().evaluate(element => getComputedStyle(element).color)).toBe(
      await rows.nth(1).locator("svg").last().evaluate(element => getComputedStyle(element).color));
  }
  const info = page.getByRole("button", { name: "Analysis info", exact: true });
  await info.click();
  const details = page.getByRole("dialog", { name: "Analysis info" });
  await expect(details.getByText(/Speech \(0.600\)/)).toHaveCount(0);
  await details.getByText("Audio details", { exact: true }).click();
  await expect(details.getByText(/Speech \(0.600\)/)).toBeAttached();
  await expect(details.getByText(/not necessarily at every frame/)).toBeAttached();
  await expect(details.getByText(/1 sub-frame fragment is/)).toBeAttached();
  await page.keyboard.press("Escape");
  await expect(details).toHaveCount(0); await expect(info).toBeFocused();
  await page.setViewportSize({ width: 680, height: 800 });
  await page.evaluate(sizes => { for (const [name, size] of Object.entries(sizes)) document.documentElement.style.setProperty(`--text-${name}`, `${size}px`); }, originalSizes);
  await page.screenshot({ path: `/private/tmp/sauce-audio-content-${process.env.SCENE_BROWSER ?? "chromium"}.png` });
  await page.getByRole("tab", { name: "All", exact: true }).click();
  await expect(list).toHaveCount(0);
  await page.getByText("Audio · 4 ranges", { exact: true }).click();
  await expect(list).toBeVisible();
  const requests = await page.evaluate(() => JSON.parse(localStorage.getItem("e2e.shotRequests") ?? "[]"));
  expect(requests.every((request: VideoRequest) => request.operation === "models")).toBe(true);
  expect(errors).toEqual([]);
});

test("analysis details stay behind the header info icon, with keyboard dismissal and no work dispatched", async ({ page }) => {
  test.skip(process.env.SAUCE_PACKAGED_FRONTEND === "1", "Deterministic partial-result layout fixture");
  await page.route("**/src/hooks/use-picture-model.ts*", route => route.fulfill({ contentType: "text/javascript", body: `
    export function usePictureModelPreference() { return {id:"qwen3.5-4b-video",select:()=>{},error:""}; }
    export function usePictureModel() { return {...usePictureModelPreference(),ready:true,models:[{id:"qwen3.5-4b-video",ready:true},{id:"qwen3.5-9b-video",ready:true}]}; }` }));
  await page.route("**/src/hooks/use-shot-intelligence.ts*", route => route.fulfill({ contentType: "text/javascript", body: `
    export function useShotIntelligence() { return {
      busy:false, complete:false, stopping:false, draining:false, error:"Analysis stopped to give playback or transcription priority.", nativeError:"", audioError:"", phase:"", progress:null,
      modelUsed:"qwen3.5-4b-video", audio:{status:"not-started"}, answers:[], start:async()=>{}, stop:()=>{},
      evidence:{id:"quiet-layout", detection:{boundaries:[{}]}, shots:Array.from({length:12},(_,index)=>({id:index+1,start_us:index*1001000,end_us:(index+1)*1001000,transcript:""}))}
    }; }` }));
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await boot(page, true, false, "/a-long-source-name-for-analysis-layout.mp4", 60000 / 1001);
  const mode = page.getByRole("switch", { name: "Advanced Intelligence" });
  await mode.click();
  const info = page.getByRole("button", { name: "Analysis info", exact: true });
  const gear = page.getByRole("button", { name: "Advanced Intelligence settings" });
  await expect(info).toBeVisible();
  await expect(page.getByText(/Analysis could not finish|Source audio has not been analyzed|Picture results:/)).toHaveCount(0);
  await expect(page.getByText("Not generated", { exact: true })).toHaveCount(12);
  await expect(page.getByText("No dialogue", { exact: true })).toHaveCount(12);
  await expect(page.getByRole("button", { name: "Retry analysis", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry analysis", exact: true })).toBeEnabled();
  const originalSizes = await page.evaluate(() => Object.fromEntries(["base", "md", "lg", "xl"].map(size => [size, parseFloat(getComputedStyle(document.documentElement).getPropertyValue(`--text-${size}`))])));
  for (const width of [680, 440, 360]) for (const scale of [1, 1.25]) {
    await page.setViewportSize({ width, height: 560 });
    await page.evaluate(({ sizes, scale }) => { for (const [name, size] of Object.entries(sizes)) document.documentElement.style.setProperty(`--text-${name}`, `${size * scale}px`); }, { sizes: originalSizes, scale });
    const infoBox = (await info.boundingBox())!, gearBox = (await gear.boundingBox())!;
    expect(infoBox.width).toBeGreaterThanOrEqual(24); expect(infoBox.height).toBeGreaterThanOrEqual(24);
    expect(infoBox.x + infoBox.width).toBeLessThanOrEqual(gearBox.x - 3);
    expect(Math.abs(infoBox.y - gearBox.y)).toBeLessThan(1);
    expect(gearBox.x + gearBox.width).toBeLessThanOrEqual(width - 7);
    await info.focus(); await page.keyboard.press("Enter");
    const details = page.getByRole("dialog", { name: "Analysis info" });
    await expect(details).toBeVisible();
    await expect(details.getByText("Incomplete", { exact: true })).toBeVisible();
    await expect(details.getByText("Qwen3.5 4B", { exact: true })).toBeVisible();
    await expect(details.getByText("Not analyzed", { exact: true })).toBeVisible();
    await expect(details.locator("details")).not.toHaveAttribute("open", "");
    await details.getByText("Technical details", { exact: true }).click();
    await expect(details.getByText("Analysis stopped to give playback or transcription priority.")).toBeVisible();
    // Native details expansion triggers the popup's ResizeObserver placement.
    await expect.poll(async () => {
      const box = (await details.boundingBox())!;
      return box.x >= 7 && box.x + box.width <= width - 7 && box.y >= 7 && box.y + box.height <= 553;
    }).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.keyboard.press("Escape");
    await expect(details).toHaveCount(0); await expect(info).toBeFocused();
  }
  await page.setViewportSize({ width: 840, height: 820 });
  await page.evaluate(sizes => { for (const [name, size] of Object.entries(sizes)) document.documentElement.style.setProperty(`--text-${name}`, `${size}px`); }, originalSizes);
  await expect.poll(() => page.locator(".cp-shot-table").evaluate(table => {
    const headers = Array.from(table.querySelectorAll("thead th"));
    const cells = Array.from(table.querySelectorAll("tbody tr:first-child > *"));
    return headers.every((header, index) => Math.abs(header.getBoundingClientRect().left - cells[index].getBoundingClientRect().left) < 1);
  })).toBe(true);
  await page.screenshot({ path: `/private/tmp/sauce-quiet-analysis-${process.env.SCENE_BROWSER ?? "chromium"}.png` });
  await info.click();
  await page.getByText("Technical details", { exact: true }).click();
  await page.screenshot({ path: `/private/tmp/sauce-quiet-analysis-info-${process.env.SCENE_BROWSER ?? "chromium"}.png` });
  await mode.click();
  await expect(page.getByRole("dialog", { name: "Analysis info" })).toHaveCount(0);
  await mode.click();
  await expect(info).toHaveAttribute("aria-expanded", "false");
  const requests = await page.evaluate(() => JSON.parse(localStorage.getItem("e2e.shotRequests") ?? "[]"));
  expect(requests.every((request: VideoRequest) => request.operation === "models")).toBe(true);
  expect(errors).toEqual([]);
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
  const sourceFps = scenario.generated ? 24000 / 1001 : 30;
  await boot(page, true, false, manifest.source.path, sourceFps);
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
  await expect(page.getByText(`${expectedShots} shots · ${expectedShots - 1} ${expectedShots === 2 ? "cut" : "cuts"}`)).toBeVisible();
  await expect(page.locator(".cp-shot-table tbody > tr")).toHaveCount(expectedShots);
  await expect(page.getByRole("button", { name: "Shot 1 start at 00:00:00:00", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `Shot 1 end at ${secondsToTc(scenario.generated ? 1.001 : 0.866667, sourceFps)}`, exact: true })).toBeVisible();
  if (videoWorkerPath) {
    await expect(page.getByRole("button", { name: "Analyze video", exact: true })).toBeEnabled({ timeout: 200_000 });
    expect(realDescriptions?.shots).toHaveLength(expectedShots);
    await test.info().attach("actual-shot-descriptions", { body: JSON.stringify(realDescriptions, null, 2), contentType: "application/json" });
    for (const shot of realDescriptions!.shots) {
      // The prior greedy sampler repeated 32 sentences on shot 2. Retain the
      // raw answer above; fail the real-model check instead of hiding a loop.
      const sentences = shot.text.split(/(?<=[.!?])\s+/).map(text => text.trim()).filter(Boolean);
      expect(sentences.length - new Set(sentences).size, `Shot ${shot.id} repeated sentences`).toBeLessThan(3);
      await expect(page.locator(".cp-shot-table tbody > tr").nth(shot.id - 1).locator("td").nth(2))
        .toHaveText(shot.picture_description ?? `Legacy combined response: ${shot.text}`, { useInnerText: true });
    }
    if (scenario.generated) {
      expect(realDescriptions!.shots[0].text.toLowerCase()).toContain("red");
      expect(realDescriptions!.shots[1].text.toLowerCase()).toContain("blue");
      expect(realDescriptions!.shots.map(shot => [shot.start_us, shot.end_us])).toEqual([[0, 1_001_000], [1_001_000, 2_002_000]]);
    }
  } else await expect(page.getByText("Visible description for shot 12.")).toBeAttached();
  if (!scenario.generated && (audioHelperPath || recordedMusic)) {
    const count = recordedMusic ? 3 : 8;
    await expect(page.getByRole("list", { name: "Audio content" })).toHaveCount(0);
    const disclosure = page.getByText(`Audio · ${count} ranges`, { exact: true });
    await disclosure.focus(); await page.keyboard.press("Enter");
    const ranges = page.getByRole("list", { name: "Audio content" }).getByRole("listitem");
    await expect(ranges).toHaveCount(count);
    await expect(ranges.last()).toContainText("Unclassified");
    await expect(page.getByText(/score|Music suggested|Possible type:/)).toHaveCount(0);
    if (recordedMusic) {
      await expect(ranges.nth(0)).toContainText("Music");
      await expect(ranges.nth(1)).toContainText("Music");
    }
    await expect(ranges.last().getByRole("button", { name: /start at/ })).toHaveText(recordedMusic ? "00:00:20:00" : "00:00:21:00");
    await expect(ranges.last().getByRole("button", { name: /end at/ })).toHaveText("00:00:23:15");
    await page.getByRole("button", { name: "Analysis info", exact: true }).click();
    const info = page.getByRole("dialog", { name: "Analysis info" });
    await expect(info.getByText("Analyzed", { exact: true })).toBeVisible();
    await info.getByText("Audio details", { exact: true }).click();
    await expect(info.getByText(/not frame-level event boundaries/)).toBeAttached();
    if (recordedMusic) await expect(info.getByText("Possible music types: Electronic music. Not verified.")).toBeAttached();
    await page.keyboard.press("Escape");
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
    await disclosure.click(); // Restore the normal compact result.
  } else await expect(page.getByText("No audio track", { exact: true })).toBeVisible();
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
