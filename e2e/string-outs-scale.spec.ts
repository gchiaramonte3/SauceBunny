import { expect, test } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * String Outs opens a real-sized transcribed sequence, and stays small.
 *
 * Found by driving the app on a production AAF: 20 mics, 3h39m, 9,597 cues,
 * 146,018 words. Opening it in String Outs drew every word of the source,
 * 1,017,132 DOM nodes, and froze the window: 64 s in Chromium, about 3.5
 * minutes in the app's WKWebView. Cutting the whole sequence in and scrolling
 * crashed the renderer outright. Both text panes now draw a page at a time
 * (EditWindowedParagraphs); measured on that same sequence: open in 0.49 s at
 * 4,102 nodes, whole sequence cut in 0.58 s at 9,201, and about 14,000
 * anywhere you scroll.
 *
 * This is the same shape, synthetic (the real one carries production names).
 * Thresholds are several times the measured values, so they fire on a
 * regression to drawing everything, not on a busy CI box.
 */

const MICS = 20, WORDS_PER_MIC = 7_300, SECONDS = 13_000;

test("a 20-mic, 146k-word sequence opens, cuts in whole and scrolls without drawing every word", async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(({ mics, perMic, seconds }) => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1"); localStorage.setItem("saucebunny.permissioned", "1");
    const rate = { numerator: 24000, denominator: 1001 }, frames = Math.round(seconds * 24000 / 1001);
    const tracks = Array.from({ length: mics }, (_, index) => ({ id: `t${index + 1}`, name: `Person ${index + 1}`, warnings: [],
      clips: [{ start_frame: 0, duration_frames: frames, kind: "audio", master_id: null, source_id: null, source_start_sample: 0, sample_rate: 48000, warnings: [] }] }));
    const document = { schema_version: 1, id: "big", source_path: "/fixtures/Big.aaf", source_size: 1, source_modified_ms: 1,
      manifest: { schema_version: 1, name: "Big scene", source_fingerprint: "b".repeat(64), edit_rate: rate, start_frame: 86400, duration_frames: frames,
        timecode_fps: 24, drop_frame: false, recording_dates: [], tracks, warnings: [] }, labels: [], transcripts: [] };
    // Each mic talks in turn: a word every ~1.8 s of its own, spread across the scene.
    const speech = (trackId: string, index: number) => ({ track_id: trackId, floor_db: -96, measured: false, activity: [], reactions: [],
      words: Array.from({ length: perMic }, (_, n) => { const at = Math.round(((n * mics + index) / (perMic * mics)) * (seconds - 10) * 16_000);
        return { cue_id: `${trackId}-${Math.floor(n / 12)}`, text: n % 12 === 11 ? "done." : "word", start_sample: at, end_sample: at + 4_000 }; }) });
    const edits = new Map<string, { document: unknown }>();
    const head = (id: string) => ({ state: 1, label: "Opened", document: edits.get(id)!.document, undo: null, redo: null });
    const app = window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } };
    const original = app.__TAURI_INTERNALS__.invoke;
    app.__TAURI_INTERNALS__.invoke = (command, args = {}) => {
      switch (command) {
        case "aaf_list": return Promise.resolve([{ id: "big", name: "Big scene", track_count: mics, transcribed_tracks: mics, source_path: "/fixtures/Big.aaf" }]);
        case "aaf_open": return Promise.resolve(document);
        case "aaf_speech": return Promise.resolve(speech(args.trackId as string, tracks.findIndex((track) => track.id === args.trackId)));
        case "aaf_waveform": return Promise.reject(new Error("not built"));
        case "edit_list": return Promise.resolve([...edits.keys()].map((id) => ({ id, title: "Big scene", created_at: 1, updated_at: 1, head: 1, states: 1 })));
        case "edit_create": edits.set(args.id as string, { document: args.document }); return Promise.resolve(head(args.id as string));
        case "edit_head": return Promise.resolve(head(args.id as string));
        case "edit_commit": edits.set(args.id as string, { document: args.document }); return Promise.resolve({ ...head(args.id as string), label: args.label });
        case "edit_history": return Promise.resolve({ head: 1, states: [], next: [] });
        default: return original(command, args);
      }
    };
  }, { mics: MICS, perMic: WORDS_PER_MIC, seconds: SECONDS });
  await page.goto("/");
  await page.getByRole("button", { name: "String Outs", exact: true }).click();
  await page.getByRole("button", { name: "New string out…" }).first().click();
  await page.getByLabel("Start from").selectOption({ label: "Big scene" });
  await expect(page.getByLabel(/whole sequence/i)).not.toBeChecked();
  const opening = Date.now();
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.locator(".cp-te-src-body [data-src-index]").first()).toBeVisible({ timeout: 60_000 });
  expect(Date.now() - opening).toBeLessThan(15_000);
  const nodes = () => page.evaluate(() => document.querySelectorAll("*").length);
  // The source opens on its first person, as AAF Audio's transcript does: one mic's words.
  await expect(page.locator(".cp-te-src-foot")).toContainText(`/${WORDS_PER_MIC.toLocaleString("en-US")} of Person 1's words used`);
  const onePerson = await nodes();
  // Canary: the source really holds all 146k words, a page of which is drawn.
  await page.getByRole("tab", { name: "All voices" }).click();
  await expect(page.locator(".cp-te-src-foot")).toContainText(`/${(MICS * WORDS_PER_MIC).toLocaleString("en-US")} used`);
  expect(await nodes()).toBeLessThan(60_000);
  expect(onePerson).toBeLessThan(60_000);

  // Source/Record: the timeline's Source view is the loaded sequence, one row per mic.
  await page.getByRole("radio", { name: "Source" }).click();
  await expect(page.locator("[data-source-track]")).toHaveCount(MICS);
  expect(await nodes()).toBeLessThan(60_000);
  await page.getByRole("radio", { name: "Record" }).click();
  await expect(page.locator("[data-source-track]")).toHaveCount(0);

  await page.getByRole("button", { name: /^Add all of/ }).click();
  await expect(page.locator(".cp-te-doc [data-index]").first()).toBeVisible({ timeout: 60_000 });
  expect(await nodes()).toBeLessThan(80_000);
  // The record pane keeps its height limit and draws only what is near the view.
  const doc = page.locator(".cp-te-doc");
  expect(await doc.evaluate((element) => element.clientHeight)).toBeLessThan(2_000);
  await doc.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(page.locator(".cp-te-doc [data-index]").last()).toHaveAttribute("data-index", String(MICS * WORDS_PER_MIC - 1), { timeout: 10_000 });
  expect(await nodes()).toBeLessThan(80_000);
});
