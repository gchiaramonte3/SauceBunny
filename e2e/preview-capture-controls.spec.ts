import { expect, test, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import type { ObsSelection } from "../src/bindings/ObsSelection";
import { tauriMockInit } from "./tauri-mock";

/**
 * Preview ▸ Source chooses Screen, Window and Region through macOS's own
 * sharing picker (docs/PROGRAM-CAPTURE.md). The picker is native, so here it is
 * a fixture that answers with a pick or a cancel; what is under test is that
 * the dialog asks for nothing until a click, starts only what was picked, keeps
 * each tab's draft, and fits the screen it is on.
 */
const sourceId = "c".repeat(32);
type Call = { command: string; args: unknown };
type BrowserFixture = {
  __captureCalls: Call[];
  /** What macOS's sharing picker answers in this fixture: a pick, or a cancel. */
  __pickOutcome: "chosen" | "cancelled";
  __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> };
};
const picks = {
  screen: { choice: "d".repeat(32), kind: "screen", label: "Generated studio display", width: 1920, height: 1080 },
  window: { choice: "e".repeat(32), kind: "window", label: "Generated remote desktop · Full-screen session", width: 1920, height: 1080 },
  region: { choice: "f".repeat(32), kind: "region", label: "Generated ultrawide display", width: 1920, height: 810 },
} as const;

async function boot(page: Page) {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(({ sourceId, picks }) => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1"); localStorage.setItem("saucebunny.permissioned", "1");
    localStorage.setItem("saucebunny.review.author", JSON.stringify("Generated editor"));
    localStorage.setItem("e2e.avGranted", "1"); localStorage.setItem("e2e.files", "{}");
    localStorage.setItem("saucebunny.queueDrawerActiveTab", "review");
    const fixture = window as unknown as BrowserFixture;
    fixture.__captureCalls = [];
    fixture.__pickOutcome = "chosen";
    const original = fixture.__TAURI_INTERNALS__.invoke;
    let selected: ObsSelection | null = null;
    const program = { id: sourceId, name: "Generated capture", url: `http://127.0.0.1:51730/capture-ui-fixture/${sourceId}` };
    const telemetry = { sourceId, phase: "live", error: null, inputWidth: 160, inputHeight: 108,
      outputFps: 30, inputFps: 30, connectionCount: 1, receivedFrames: 60, ndiDroppedFrames: 0,
      encoderDroppedFrames: 0, encoderDroppedAudioSamples: 0, leftPeak: 0, rightPeak: 0,
      lastInputAgeMs: 0, encodedBitrateKbps: 6000 };
    // UI ownership only, not a decoder/media proof. This known generated URL
    // stays pending and abortable without making a network request.
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (String(input).includes("/capture-ui-fixture/")) return new Promise<Response>((_resolve, reject) => {
        const aborted = () => reject(new DOMException("Generated fixture closed", "AbortError"));
        if (init?.signal?.aborted) aborted();
        else init?.signal?.addEventListener("abort", aborted, { once: true });
      });
      return originalFetch(input, init);
    };
    fixture.__TAURI_INTERNALS__.invoke = (command, value) => {
      if (command.startsWith("obs_") || command.startsWith("program_capture_") || ["ndi_start", "ndi_stop", "ndi_publish", "ndi_unpublish"].includes(command)) {
        fixture.__captureCalls.push({ command, args: value });
      }
      const args = value as { kind?: keyof typeof picks; choice?: string; selection?: ObsSelection; id?: string } | undefined;
      if (command === "program_capture_preflight") return Promise.resolve({ available: true, error: null, kinds: ["screen", "window", "region"], systemAudio: true, applicationAudio: true });
      if (command === "program_capture_choose") return Promise.resolve(fixture.__pickOutcome === "cancelled" ? { outcome: "cancelled" }
        : { outcome: "chosen", choice: picks[args!.kind!] });
      if (command === "program_capture_cancel_choose") return Promise.resolve();
      if (command === "program_capture_snapshot") {
        const pick = Object.values(picks).find(item => item.choice === args?.choice)!;
        const canvas = document.createElement("canvas"); canvas.width = pick.width / 2; canvas.height = pick.height / 2;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "#28262f"; context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = "#eeeeef"; context.font = "24px sans-serif"; context.fillText(pick.label, 24, 64);
        return Promise.resolve({ image: canvas.toDataURL("image/jpeg"), width: pick.width, height: pick.height });
      }
      if (command === "program_capture_start") { selected = args!.selection!; return Promise.resolve({ program, selection: selected }); }
      if (command === "ndi_stop" && args?.id === sourceId) { selected = null; return Promise.resolve(); }
      if (command === "ndi_sessions") return Promise.resolve({ programs: selected
        ? [{ program, capture: selected, telemetry, encodedReady: true, roomGeneration: null }] : [], room: null });
      if (command === "ndi_status") return Promise.resolve({ program: selected ? program : null, capture: selected,
        telemetry, encodedReady: !!selected, roomGeneration: null });
      if (command === "ndi_discover") return Promise.resolve({ bridgeCompiled: true, runtime: "ready",
        runtimeVersion: "Generated UI fixture", error: null, sources: [] });
      return original(command, value);
    };
  }, { sourceId, picks });
  await page.goto("/"); await expect(page.locator(".cp-view-home")).toBeVisible();
  await page.locator(".cp-nav-item").filter({ hasText: "Review" }).first().click();
}

const captureDialog = (page: Page) => page.getByRole("dialog", { name: "Source settings" });
const gear = (page: Page) => page.getByRole("button", { name: "Source settings", exact: true });
async function writes(page: Page) {
  return page.evaluate(() => (window as unknown as BrowserFixture).__captureCalls.filter(({ command }) =>
    !["program_capture_preflight", "program_capture_snapshot", "obs_broadcast_status"].includes(command)));
}
async function scaleText(page: Page, scale: number) {
  await page.evaluate(value => {
    const root = document.documentElement, css = getComputedStyle(root);
    const values = ["--text-xs", "--text-sm", "--text-base", "--text-md", "--text-lg", "--text-xl", "--text-2xl"]
      .map(token => [token, `${parseFloat(css.getPropertyValue(token)) * value / 100}px`]);
    for (const [token, size] of values) root.style.setProperty(token, size);
  }, scale);
}

for (const scale of [100, 125]) {
  test(`Screen, Window and Region choose through macOS's picker and keep independent drafts at ${scale}% text`, async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 700 }); await boot(page); await scaleText(page, scale);
    await gear(page).click(); const dialog = captureDialog(page);
    await expect(dialog.getByRole("tab")).toHaveText(["NDI", "Screen", "Window", "Region"]);
    await dialog.getByRole("tab", { name: "Window", exact: true }).click();
    await expect(dialog.getByText(/OBS/)).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: "Preview source" })).toBeDisabled();
    expect(await writes(page)).toEqual([]);
    // The picker's Share click is the go-ahead: a window previews as soon as it is picked, with its own app's sound.
    await dialog.getByRole("button", { name: "Choose window…" }).click();
    await expect(dialog.getByRole("status", { name: "Selected window" })).toHaveText(`Selected: ${picks.window.label}`);
    await expect.poll(async () => (await writes(page)).map(item => item.command)).toEqual(["program_capture_choose", "program_capture_start"]);
    expect((await writes(page))[1].args).toEqual({ selection: { choice: picks.window.choice, kind: "window", label: picks.window.label, audio: true } });
    await expect(dialog.getByRole("checkbox", { name: "Include application audio" })).toBeChecked();
    await dialog.getByRole("tab", { name: "Screen", exact: true }).click();
    const systemAudio = dialog.getByRole("checkbox", { name: "Include system audio" });
    await expect(systemAudio).toBeDisabled();
    await dialog.getByRole("tab", { name: "Region", exact: true }).click();
    await dialog.getByRole("button", { name: "Choose screen…" }).click();
    await expect(dialog.getByRole("img", { name: picks.region.label })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Preview source" })).toBeDisabled();
    await systemAudio.check();
    for (const [name, value] of [["Left", "10"], ["Top", "20"], ["Width", "50"], ["Height", "60"]]) {
      await dialog.getByRole("spinbutton", { name, exact: true }).fill(value);
    }
    await expect(dialog.getByText(`Captures 960 × 486 of ${picks.region.label}.`)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Preview source" })).toBeEnabled();
    await dialog.getByRole("tab", { name: "Window", exact: true }).click();
    await expect(dialog.getByRole("status", { name: "Selected window" })).toHaveText(`Selected: ${picks.window.label}`);
    await dialog.getByRole("tab", { name: "Region", exact: true }).click();
    await expect(dialog.getByRole("spinbutton", { name: "Left", exact: true })).toHaveValue("10");
    await expect(systemAudio).toBeChecked();
    await expect(dialog.getByRole("button", { name: "Preview source" })).toBeInViewport();
    // Nothing since the window pick: drafts on other tabs stay local until their own Preview.
    expect((await writes(page)).map(item => item.command)).toEqual(["program_capture_choose", "program_capture_start", "program_capture_choose"]);
    await page.screenshot({ path: test.info().outputPath(`region-${scale}.png`) });
    await dialog.getByRole("button", { name: "Preview source" }).click();
    await expect.poll(async () => (await writes(page)).filter(item => item.command === "program_capture_start").length).toBe(2);
    const start = (await writes(page)).filter(item => item.command === "program_capture_start")[1];
    expect(start.args).toEqual({ selection: { choice: picks.region.choice, kind: "region", label: picks.region.label, audio: true,
      region: { x: .1, y: .2, width: .5, height: .6 } } });
    expect((await writes(page)).some(item => item.command === "ndi_publish" || item.command === "obs_broadcast_start")).toBe(false);
  });
}

test("opening Source never shows macOS's picker, and a cancelled pick starts nothing", async ({ page }) => {
  await boot(page); await gear(page).click(); const dialog = captureDialog(page);
  await dialog.getByRole("tab", { name: "Screen", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Choose screen…" })).toBeEnabled();
  expect(await writes(page)).toEqual([]);
  await page.evaluate(() => { (window as unknown as BrowserFixture).__pickOutcome = "cancelled"; });
  await dialog.getByRole("button", { name: "Choose screen…" }).click();
  await expect.poll(async () => (await writes(page)).map(item => item.command)).toEqual(["program_capture_choose"]);
  await expect(dialog.getByRole("button", { name: "Choose screen…" })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "Preview source" })).toBeDisabled();
  await expect(dialog.getByRole("alert")).toHaveCount(0);
});

test("a region is drawn on the still by dragging and nudged by keys, and stays local until Preview", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 700 }); await boot(page);
  await gear(page).click(); const dialog = captureDialog(page);
  await dialog.getByRole("tab", { name: "Region", exact: true }).click();
  await dialog.getByRole("button", { name: "Choose screen…" }).click();
  const surface = dialog.locator(".cp-capture-region-surface");
  await expect(surface.getByRole("img")).toBeVisible();
  await surface.scrollIntoViewIfNeeded();
  const bounds = (await surface.boundingBox())!;
  expect(bounds.width / bounds.height).toBeCloseTo(picks.region.width / picks.region.height, 1);
  await page.mouse.move(bounds.x + bounds.width * .2, bounds.y + bounds.height * .25);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * .7, bounds.y + bounds.height * .75, { steps: 5 });
  await page.mouse.up();
  for (const [name, expected] of [["Left", 20], ["Top", 25], ["Width", 50], ["Height", 50]] as const) {
    expect(Number(await dialog.getByRole("spinbutton", { name, exact: true }).inputValue())).toBeCloseTo(expected, 0);
  }
  await surface.focus(); await surface.press("ArrowRight");
  expect(Number(await dialog.getByRole("spinbutton", { name: "Left", exact: true }).inputValue())).toBeGreaterThan(20);
  await expect(dialog.getByRole("button", { name: "Preview source" })).toBeEnabled();
  expect((await writes(page)).map(item => item.command)).toEqual(["program_capture_choose"]);
  await page.keyboard.press("Escape"); await gear(page).click();
  await expect(dialog.getByRole("tab", { name: "Region", exact: true })).toHaveAttribute("aria-selected", "true");
  expect(Number(await dialog.getByRole("spinbutton", { name: "Left", exact: true }).inputValue())).toBeGreaterThan(20);
  expect((await writes(page)).map(item => item.command)).toEqual(["program_capture_choose"]);
});

// The Source dialog was 960px of mostly empty row on an ultrawide display. It is
// sized to what it holds, and its Preview and Done stay put while the still scrolls.
for (const viewport of [{ width: 1100, height: 700 }, { width: 2560, height: 1080 }]) {
  for (const scale of [100, 125]) test(`the capture dialog fits ${viewport.width}px at ${scale}% text without stretching`, async ({ page }) => {
    await page.setViewportSize(viewport); await page.emulateMedia({ reducedMotion: "reduce" }); await boot(page); await scaleText(page, scale);
    await gear(page).click(); const dialog = captureDialog(page);
    await dialog.getByRole("tab", { name: "Region", exact: true }).click();
    await dialog.getByRole("button", { name: "Choose screen…" }).click();
    await expect(dialog.getByRole("img", { name: picks.region.label })).toBeVisible();
    for (const [name, value] of [["Left", "10"], ["Top", "20"], ["Width", "50"], ["Height", "60"]]) {
      await dialog.getByRole("spinbutton", { name, exact: true }).fill(value);
    }
    const box = (await dialog.boundingBox())!;
    expect(box.width).toBeLessThanOrEqual(680);
    expect(box.x).toBeGreaterThanOrEqual(16); expect(box.y).toBeGreaterThanOrEqual(16);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - 16);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height - 16);
    expect(await dialog.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    const body = dialog.locator(".cp-ndi-input-body"), footer = dialog.locator(".cp-ndi-input-footer");
    const footerBounds = (await footer.boundingBox())!;
    for (const scrollTop of [0, 10000]) {
      await body.evaluate((element, top) => { element.scrollTop = top; }, scrollTop);
      const bodyBounds = (await body.boundingBox())!;
      expect(bodyBounds.y + bodyBounds.height).toBeLessThanOrEqual(footerBounds.y + 1);
      await expect(dialog.getByRole("checkbox", { name: "Include system audio" })).toBeInViewport({ ratio: 1 });
      await expect(dialog.getByRole("button", { name: "Preview source" })).toBeInViewport({ ratio: 1 });
      await expect(dialog.getByRole("button", { name: "Done", exact: true })).toBeInViewport({ ratio: 1 });
    }
    for (const field of await dialog.locator("input[type=number]").all()) {
      await field.scrollIntoViewIfNeeded(); await expect(field).toBeInViewport();
      expect((await field.boundingBox())!.height).toBeGreaterThanOrEqual(24);
    }
    await page.screenshot({ path: test.info().outputPath(`capture-dialog-${viewport.width}-${scale}.png`) });
    expect((await writes(page)).map(item => item.command)).toEqual(["program_capture_choose"]);
  });
}
