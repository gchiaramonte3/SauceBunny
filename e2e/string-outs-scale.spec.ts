import { expect, test, type Page } from "@playwright/test";
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

async function boot(page: Page) {
  // Silent PCM of the asked length, so playback runs without media.
  await page.route("**/e2e-mock/solo-*.wav", (route) => {
    const frames = Number(new URL(route.request().url()).pathname.match(/solo-(\d+)\.wav$/)?.[1]);
    const samples = Math.ceil(frames * 1001 / 24000 * 16000), body = Buffer.alloc(44 + samples * 2);
    body.write("RIFF", 0); body.writeUInt32LE(body.length - 8, 4); body.write("WAVEfmt ", 8);
    body.writeUInt32LE(16, 16); body.writeUInt16LE(1, 20); body.writeUInt16LE(1, 22);
    body.writeUInt32LE(16000, 24); body.writeUInt32LE(32000, 28); body.writeUInt16LE(2, 32); body.writeUInt16LE(16, 34);
    body.write("data", 36); body.writeUInt32LE(samples * 2, 40);
    return route.fulfill({ contentType: "audio/wav", body });
  });
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
    const app = window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>; convertFileSrc: (path: string, protocol?: string) => string } };
    const original = app.__TAURI_INTERNALS__.invoke, originalFileSrc = app.__TAURI_INTERNALS__.convertFileSrc;
    app.__TAURI_INTERNALS__.convertFileSrc = (path, protocol) => path.startsWith("/e2e-mock/solo-") ? path : originalFileSrc(path, protocol);
    app.__TAURI_INTERNALS__.invoke = (command, args = {}) => {
      switch (command) {
        case "aaf_list": return Promise.resolve([{ id: "big", name: "Big scene", track_count: mics, transcribed_tracks: mics, source_path: "/fixtures/Big.aaf" }]);
        case "aaf_open": return Promise.resolve(document);
        case "aaf_speech": return Promise.resolve(speech(args.trackId as string, tracks.findIndex((track) => track.id === args.trackId)));
        case "aaf_waveform": return Promise.reject(new Error("not built"));
        case "aaf_prepare_audio": return Promise.resolve({ path: `/e2e-mock/solo-${args.durationFrames}.wav`, start_frame: args.startFrame, duration_frames: args.durationFrames, sample_rate: 16000, sample_count: Math.ceil(Number(args.durationFrames) * 1001 / 24000 * 16000), peaks: [] });
        case "edit_list": return Promise.resolve([...edits.keys()].map((id) => ({ id, title: "Big scene", created_at: 1, updated_at: 1, head: 1, states: 1 })));
        case "edit_create": {
          // A test can ask for the new string out as a few short pieces with long cuts between them.
          const document = args.document as { segments: { in_frame: number; out_frame: number; id: string }[] };
          const pieces = (window as unknown as { __cutInto?: [number, number][] }).__cutInto;
          if (pieces) document.segments = pieces.map(([from, to], index) => ({ ...document.segments[0], id: `piece-${index}`, in_frame: Math.round(from * 24000 / 1001), out_frame: Math.round(to * 24000 / 1001) }));
          edits.set(args.id as string, { document }); return Promise.resolve(head(args.id as string));
        }
        case "edit_head": return Promise.resolve(head(args.id as string));
        case "edit_commit": edits.set(args.id as string, { document: args.document }); return Promise.resolve({ ...head(args.id as string), label: args.label });
        case "edit_history": return Promise.resolve({ head: 1, states: [], next: [] });
        default: return original(command, args);
      }
    };
  }, { mics: MICS, perMic: WORDS_PER_MIC, seconds: SECONDS });
}

test("a 20-mic, 146k-word sequence opens, cuts in whole and scrolls without drawing every word", async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
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

test("a partial string out of it, with Removed lines on, shows only the cuts between its pieces, inside the same budgets", async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  await page.goto("/");
  await page.getByRole("button", { name: "String Outs", exact: true }).click();
  await page.getByRole("button", { name: "New string out…" }).first().click();
  await page.getByLabel("Start from").selectOption({ label: "Big scene" });
  await page.getByLabel(/whole sequence/i).check();
  // Three one-minute pieces of a 3h36m sequence: two long cuts between them, and the rest never in the string out.
  await page.evaluate(() => { (window as unknown as { __cutInto: [number, number][] }).__cutInto = [[0, 60], [4_000, 4_060], [9_000, 9_060]]; });
  const opening = Date.now();
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.locator(".cp-te-doc [data-index]").first()).toBeVisible({ timeout: 60_000 });
  expect(Date.now() - opening).toBeLessThan(15_000);
  await expect(page.getByRole("button", { name: "Removed lines" })).toHaveAttribute("aria-pressed", "true");
  const doc = page.locator(".cp-te-doc");
  const nodes = () => page.evaluate(() => document.querySelectorAll("*").length);
  const order = () => doc.evaluate((element) => [...element.querySelectorAll(".cp-te-ghost.is-line, [data-index]")].map((node) => node.classList.contains("cp-te-ghost") ? "ghost" : "word"));
  // Nothing removed comes before the first word.
  expect((await order())[0]).toBe("word");
  // Canary: scrolling a screen at a time reaches the first cut, drawn in its page.
  for (let step = 0; step < 400 && !(await doc.locator(".cp-te-ghost").count()); step++) await doc.evaluate((element) => { element.scrollTop += 2 * element.clientHeight; });
  await expect(doc.locator(".cp-te-ghost").first()).toBeVisible();
  expect(await nodes()).toBeLessThan(80_000);
  // Nor after the last.
  await doc.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(async () => (await order()).at(-1)).toBe("word");
  expect(await nodes()).toBeLessThan(80_000);
});

test("playing the whole 146k-word string out costs a few milliseconds a frame, not a redraw of the editor", async ({ page }) => {
  test.setTimeout(180_000);
  await boot(page);
  await page.goto("/");
  await page.getByRole("button", { name: "String Outs", exact: true }).click();
  await page.getByRole("button", { name: "New string out…" }).first().click();
  await page.getByLabel("Start from").selectOption({ label: "Big scene" });
  await page.getByLabel(/whole sequence/i).check();
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.locator(".cp-te-doc [data-index]").first()).toBeVisible({ timeout: 60_000 });
  const record = page.getByRole("region", { name: "Record", exact: true });
  await record.getByRole("button", { name: "Play", exact: true }).click();
  await expect(record.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  const clock = record.locator(".cp-te-tools-tc");
  const before = await clock.textContent();
  await expect(clock).not.toHaveText(before!, { timeout: 15_000 });
  // Scripting time per animation frame while it plays, from Chromium's own counter.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const script = async () => (await cdp.send("Performance.getMetrics")).metrics.find((metric) => metric.name === "ScriptDuration")!.value;
  await page.evaluate(() => { const app = window as unknown as { __frames: number }; app.__frames = 0; const tick = () => { app.__frames++; requestAnimationFrame(tick); }; requestAnimationFrame(tick); });
  const start = await script();
  await page.waitForTimeout(2_000);
  const spent = (await script()) - start, frames = await page.evaluate(() => (window as unknown as { __frames: number }).__frames);
  await expect(record.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  // Measured on this fixture: 65 ms a frame (about 16 frames a second) while
  // the editor redrew on every frame, 2.8 ms once only what draws the
  // playhead follows it (lib/frame-store). The goal was under 4 ms; the
  // threshold leaves a slower machine room and still fails a regression to
  // redrawing everything.
  const perFrame = spent * 1000 / frames;
  console.log(`PERF ${perFrame.toFixed(2)} ms of script per frame over ${frames} frames`);
  expect(frames).toBeGreaterThan(30);
  expect(perFrame).toBeLessThan(12);
});
