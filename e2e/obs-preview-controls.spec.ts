import { expect, test, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import type { ObsSelection } from "../src/bindings/ObsSelection";
import type { ObsWindow } from "../src/bindings/ObsWindow";
import type { ObsBroadcastStatus } from "../src/bindings/ObsBroadcastStatus";
import { tauriMockInit } from "./tauri-mock";

const sourceId = "c".repeat(32);
const application = "test.generated.application";
const applicationName = "Generated application with a deliberately long editing workspace and project name";
const windowTitle = "Timeline with a deliberately long sequence name shared by two different windows";
type Call = { command: string; args: unknown };
type BrowserFixture = {
  __obsCalls: Call[];
  __obsWindows: ObsWindow[];
  __obsBroadcast: ObsBroadcastStatus;
  __obsBroadcastReadError: string | null;
  __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> };
};

async function boot(page: Page) {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(({ sourceId, application, applicationName, windowTitle }) => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1"); localStorage.setItem("saucebunny.permissioned", "1");
    localStorage.setItem("saucebunny.review.author", JSON.stringify("Generated editor"));
    localStorage.setItem("e2e.avGranted", "1"); localStorage.setItem("e2e.files", "{}");
    localStorage.setItem("saucebunny.queueDrawerActiveTab", "review");
    const fixture = window as unknown as BrowserFixture;
    fixture.__obsCalls = [];
    fixture.__obsWindows = [
      { app: application, pid: 101, id: 501, title: windowTitle, width: 640, height: 360 },
      { app: application, pid: 101, id: 502, title: windowTitle, width: 320, height: 180 },
    ];
    const original = fixture.__TAURI_INTERNALS__.invoke;
    let selected: ObsSelection | null = null;
    fixture.__obsBroadcast = { sourceId, attempt: 0, phase: "off", error: null };
    fixture.__obsBroadcastReadError = null;
    const program = { id: sourceId, name: applicationName, url: `http://127.0.0.1:51730/obs-ui-fixture/${sourceId}` };
    const telemetry = { sourceId, phase: "live", error: null, inputWidth: 160, inputHeight: 108,
      outputFps: 30, inputFps: 30, connectionCount: 1, receivedFrames: 60, ndiDroppedFrames: 0,
      encoderDroppedFrames: 0, encoderDroppedAudioSamples: 0, leftPeak: 0, rightPeak: 0,
      lastInputAgeMs: 0, encodedBitrateKbps: 6000 };
    // UI ownership only, not a decoder/media proof. This known generated URL
    // stays pending and abortable without making a network request or delivering
    // user media. Native decoding has its own generated-fixture acceptance gate.
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (String(input).includes("/obs-ui-fixture/")) return new Promise<Response>((_resolve, reject) => {
        const aborted = () => reject(new DOMException("Generated fixture closed", "AbortError"));
        if (init?.signal?.aborted) aborted();
        else init?.signal?.addEventListener("abort", aborted, { once: true });
      });
      return originalFetch(input, init);
    };
    fixture.__TAURI_INTERNALS__.invoke = (command, value) => {
      if (command.startsWith("obs_") || ["ndi_start", "ndi_stop", "ndi_publish", "ndi_unpublish"].includes(command)) {
        fixture.__obsCalls.push({ command, args: value });
      }
      const args = value as { application?: string; selection?: ObsSelection; id?: string; attempt?: number } | undefined;
      if (command === "obs_preflight") return Promise.resolve({ available: true, error: null });
      if (command === "obs_applications") return Promise.resolve([{ app: application, pid: 101, name: applicationName }]);
      if (command === "obs_windows") return Promise.resolve(args?.application === application ? fixture.__obsWindows : []);
      if (command === "obs_start") { selected = args!.selection!; return Promise.resolve({ program, selection: selected }); }
      if (command === "ndi_stop" && args?.id === sourceId) {
        selected = null;
        // Capture stop requests broadcast shutdown, but does not wait for the
        // native sender child to finish. Its independent status must survive.
        if (["starting", "live"].includes(fixture.__obsBroadcast.phase)) {
          fixture.__obsBroadcast = { ...fixture.__obsBroadcast, phase: "stopping" };
        }
        return Promise.resolve();
      }
      if (command === "obs_broadcast_status") return fixture.__obsBroadcastReadError
        ? Promise.reject(new Error(fixture.__obsBroadcastReadError)) : Promise.resolve(fixture.__obsBroadcast);
      if (command === "obs_broadcast_start") {
        fixture.__obsBroadcast = { sourceId: args!.id!, attempt: args!.attempt!, phase: "live", error: null };
        return Promise.resolve(fixture.__obsBroadcast);
      }
      if (command === "obs_broadcast_stop") {
        fixture.__obsBroadcast = { sourceId: args!.id!, attempt: args!.attempt!, phase: "stopped", error: null };
        return Promise.resolve(fixture.__obsBroadcast);
      }
      if (command === "ndi_sessions") return Promise.resolve({ programs: selected
        ? [{ program, capture: selected, telemetry, encodedReady: true, roomGeneration: null }] : [], room: null });
      if (command === "ndi_status") return Promise.resolve({ program: selected ? program : null, capture: selected,
        telemetry, encodedReady: !!selected, roomGeneration: null });
      if (command === "ndi_discover") return Promise.resolve({ bridgeCompiled: true, runtime: "ready",
        runtimeVersion: "Generated UI fixture", error: null, sources: [] });
      return original(command, value);
    };
  }, { sourceId, application, applicationName, windowTitle });
  await page.goto("/"); await expect(page.locator(".cp-view-home")).toBeVisible();
  await page.locator(".cp-nav-item").filter({ hasText: "Review" }).first().click();
}

const captureDialog = (page: Page) => page.getByRole("dialog", { name: "Application capture settings" });
const gear = (page: Page) => page.getByRole("button", { name: "Source settings", exact: true });
async function chooseCapture(page: Page) {
  await gear(page).click();
  await page.getByRole("dialog", { name: "NDI settings" }).getByRole("combobox", { name: "Input", exact: true }).selectOption("capture");
  const dialog = captureDialog(page);
  await expect(dialog.getByRole("combobox", { name: "Application", exact: true })).toHaveValue("");
  await expect(dialog.getByRole("combobox", { name: "Window", exact: true })).toHaveValue("");
  await expect(dialog.getByRole("button", { name: "Preview source" })).toBeDisabled();
  await dialog.getByRole("combobox", { name: "Application", exact: true }).selectOption(`${application}:101`);
  await expect(dialog.getByRole("option", { name: `${windowTitle} · 640 × 360 · 501` })).toHaveCount(1);
  await expect(dialog.getByRole("option", { name: `${windowTitle} · 320 × 180 · 502` })).toHaveCount(1);
  await expect(dialog.getByRole("button", { name: "Preview source" })).toBeDisabled();
  await dialog.getByRole("combobox", { name: "Window", exact: true }).selectOption("502");
  await dialog.locator("summary").filter({ hasText: "Crop" }).click();
  for (const [name, value] of [["Left", "10"], ["Top", "20"], ["Width", "50"], ["Height", "60"]]) {
    await dialog.getByRole("spinbutton", { name, exact: true }).fill(value);
  }
  await expect(dialog.getByRole("button", { name: "Preview source" })).toBeEnabled();
  return dialog;
}
async function writes(page: Page) {
  return page.evaluate(() => (window as unknown as BrowserFixture).__obsCalls.filter(({ command }) =>
    !["obs_preflight", "obs_applications", "obs_windows", "obs_broadcast_status"].includes(command)));
}

for (const viewport of [{ width: 1100, height: 700 }, { width: 1680, height: 1020 }]) {
  for (const scale of [1, 1.25]) test(`application controls fit ${viewport.width}px at ${scale * 100}% text and preserve explicit drafts`, async ({ page }) => {
    await page.setViewportSize(viewport); await page.emulateMedia({ reducedMotion: "reduce" }); await boot(page);
    await page.evaluate(scale => {
      const root = document.documentElement, css = getComputedStyle(root);
      const values = ["--text-xs", "--text-sm", "--text-base", "--text-md", "--text-lg", "--text-xl", "--text-2xl"]
        .map(token => [token, `${parseFloat(css.getPropertyValue(token)) * scale}px`]);
      for (const [token, value] of values) root.style.setProperty(token, value);
    }, scale);
    const monitor = page.locator(".cp-view-clip .cp-monitor");
    await monitor.evaluate(element => element.setAttribute("data-obs-stage", "retained"));
    const dialog = await chooseCapture(page);
    expect(await writes(page)).toEqual([]);
    const box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(16); expect(box.y).toBeGreaterThanOrEqual(16);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - 16);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height - 16);
    expect(await dialog.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    for (const field of await dialog.locator("select,input[type=number]").all()) {
      await field.scrollIntoViewIfNeeded(); await expect(field).toBeInViewport();
      const bounds = (await field.boundingBox())!;
      expect(bounds.height).toBeGreaterThanOrEqual(24);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(box.x + box.width);
    }
    await dialog.getByRole("button", { name: "Preview source" }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: test.info().outputPath("application-capture-controls.png") });
    await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); await expect(gear(page)).toBeFocused();
    await gear(page).press("Enter");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("combobox", { name: "Application", exact: true })).toHaveValue(`${application}:101`);
    await expect(dialog.getByRole("combobox", { name: "Window", exact: true })).toHaveValue("502");
    await dialog.locator("summary").filter({ hasText: "Crop" }).click();
    for (const [name, value] of [["Left", "10"], ["Top", "20"], ["Width", "50"], ["Height", "60"]]) {
      await expect(dialog.getByRole("spinbutton", { name, exact: true })).toHaveValue(value);
    }
    await expect(monitor).toHaveAttribute("data-obs-stage", "retained");
    expect(await writes(page)).toEqual([]);
    await expect(page.locator(".cp-queue-drawer .cp-obs-capture-controls")).toHaveCount(0);
  });
}

test("a vanished generated window cannot switch to a same-title replacement or start capture", async ({ page }) => {
  await boot(page); const dialog = await chooseCapture(page);
  await page.evaluate(() => { const fixture = window as unknown as BrowserFixture;
    fixture.__obsWindows = fixture.__obsWindows.filter(window => window.id !== 502); });
  await dialog.getByRole("button", { name: "Refresh windows" }).click();
  await expect(dialog.getByRole("option", { name: "Window 502 · Not currently found" })).toHaveCount(1);
  await expect(dialog.getByRole("combobox", { name: "Window", exact: true })).toHaveValue("502");
  await expect(dialog.getByRole("button", { name: "Preview source" })).toBeDisabled();
  expect(await writes(page)).toEqual([]);
});

test("exact capture and independent broadcast require separate clicks and survive settings close", async ({ page }) => {
  await boot(page); const dialog = await chooseCapture(page);
  const selection = { application, process: 101, window: 502, crop: { x: .1, y: .2, width: .5, height: .6 } };
  expect(await writes(page)).toEqual([]);
  await dialog.getByRole("button", { name: "Preview source" }).click();
  await expect.poll(() => writes(page)).toEqual([{ command: "obs_start", args: { selection } }]);
  await expect(dialog.getByRole("status", { name: "NDI broadcast" })).toHaveText("Not broadcasting");
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  const comment = page.getByRole("textbox", { name: "Comment", exact: true });
  await expect(comment).toBeEnabled(); await comment.fill("Generated capture draft remains private");
  await comment.evaluate(element => element.setAttribute("data-obs-note", "retained"));
  const monitor = page.locator(".cp-view-clip .cp-ndi-monitor");
  await monitor.evaluate(element => element.setAttribute("data-obs-player", "retained"));
  await gear(page).click();
  await expect(dialog.getByRole("button", { name: "Broadcast to NDI" })).toBeEnabled();
  expect(await writes(page)).toEqual([{ command: "obs_start", args: { selection } }]);
  await dialog.getByRole("button", { name: "Broadcast to NDI" }).click();
  await expect(dialog.getByRole("status", { name: "NDI broadcast" })).toHaveText("Broadcasting on your local network");
  await page.keyboard.press("Escape"); await expect(gear(page)).toBeFocused();
  await expect(comment).toHaveValue("Generated capture draft remains private");
  await expect(comment).toHaveAttribute("data-obs-note", "retained");
  await expect(monitor).toHaveAttribute("data-obs-player", "retained");
  const network = page.getByRole("status", { name: "Network broadcast" });
  await expect(network).toHaveText(`Broadcasting to NDI · ${applicationName}`);
  await expect(page.locator(".cp-ndi-preview-header .cp-ndi-publication")).toHaveText("Not shared with room");
  await expect(page.locator(".cp-monitor .cp-ndi-broadcast-notice")).toHaveCount(0);
  const noticeBox = (await network.boundingBox())!, pictureBox = (await monitor.boundingBox())!;
  expect(noticeBox.y + noticeBox.height).toBeLessThanOrEqual(pictureBox.y);
  await page.screenshot({ path: test.info().outputPath("capture-broadcast-closed.png") });
  expect(await writes(page)).toEqual([{ command: "obs_start", args: { selection } },
    { command: "obs_broadcast_start", args: { id: sourceId, attempt: 1 } }]);
  await gear(page).click();
  await expect(dialog.getByRole("status", { name: "NDI broadcast" })).toHaveText("Broadcasting on your local network");
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: `Stop NDI broadcast from ${applicationName}`, exact: true }).click();
  await expect(network).toHaveCount(0);
  expect(await writes(page)).toEqual([{ command: "obs_start", args: { selection } },
    { command: "obs_broadcast_start", args: { id: sourceId, attempt: 1 } },
    { command: "obs_broadcast_stop", args: { id: sourceId, attempt: 1 } }]);
  await gear(page).click();
  await expect(dialog.getByRole("status", { name: "NDI broadcast" })).toHaveText("Not broadcasting");
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await expect(monitor).toHaveAttribute("data-obs-player", "retained");
  await expect(comment).toHaveValue("Generated capture draft remains private");
});

test("broadcast status failures remain visible with settings closed", async ({ page }) => {
  await boot(page); const dialog = await chooseCapture(page);
  await dialog.getByRole("button", { name: "Preview source" }).click();
  await dialog.getByRole("button", { name: "Broadcast to NDI" }).click();
  await expect(dialog.getByRole("status", { name: "NDI broadcast" })).toHaveText("Broadcasting on your local network");
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  const network = page.getByRole("status", { name: "Network broadcast" });
  await page.evaluate(() => { (window as unknown as BrowserFixture).__obsBroadcastReadError = "Generated status transport unavailable"; });
  await expect(network).toContainText("NDI broadcast status unavailable");
  await expect(network).toHaveAttribute("title", "Generated status transport unavailable");
  await expect(page.getByRole("button", { name: `Stop NDI broadcast from ${applicationName}`, exact: true })).toBeEnabled();
  await page.evaluate(() => {
    const fixture = window as unknown as BrowserFixture;
    fixture.__obsBroadcastReadError = null;
    fixture.__obsBroadcast = { ...fixture.__obsBroadcast, phase: "error", error: "Generated cleanup could not be confirmed" };
  });
  await expect(network).toContainText("NDI broadcast needs attention");
  await expect(network).toHaveAttribute("title", "Generated cleanup could not be confirmed");
  expect((await writes(page)).map(call => call.command)).toEqual(["obs_start", "obs_broadcast_start"]);
});

test("cancelled capture retains its broadcast notice until native retirement is confirmed", async ({ page }) => {
  await boot(page); const dialog = await chooseCapture(page);
  await dialog.getByRole("button", { name: "Preview source" }).click();
  await dialog.getByRole("button", { name: "Broadcast to NDI" }).click();
  await expect(dialog.getByRole("status", { name: "NDI broadcast" })).toHaveText("Broadcasting on your local network");
  await dialog.getByRole("button", { name: "Cancel preview", exact: true }).click();
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  const network = page.getByRole("status", { name: "Network broadcast" });
  await expect(page.locator(".cp-view-clip .cp-ndi-monitor")).toHaveCount(0);
  await expect(page.locator(".cp-view-clip .cp-ndi-preview-header")).toHaveCount(0);
  await expect(network).toHaveText(`Stopping NDI broadcast… · ${applicationName}`);
  expect((await writes(page)).map(call => call.command)).toEqual(["obs_start", "obs_broadcast_start", "ndi_stop"]);
  await page.evaluate(() => {
    const fixture = window as unknown as BrowserFixture;
    fixture.__obsBroadcast = { ...fixture.__obsBroadcast, phase: "error", error: "Generated cleanup could not be confirmed" };
  });
  await expect(network).toContainText("NDI broadcast needs attention");
  await expect(network).toHaveAttribute("title", "Generated cleanup could not be confirmed");
  // The registry can prune completed unavailable sources while polling a new
  // one. Off/0 is the native terminal observation, not a stale attempt here.
  await page.evaluate(() => {
    const fixture = window as unknown as BrowserFixture;
    fixture.__obsBroadcast = { ...fixture.__obsBroadcast, attempt: 0, phase: "off", error: null };
  });
  await expect(network).toHaveCount(0);
  const reads = await page.evaluate(() => (window as unknown as BrowserFixture).__obsCalls.filter(call => call.command === "obs_broadcast_status").length);
  await page.getByRole("button", { name: "Source settings", exact: true }).click();
  await captureDialog(page).getByRole("button", { name: "Done", exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as BrowserFixture).__obsCalls.filter(call => call.command === "obs_broadcast_status").length)).toBe(reads);
  expect((await writes(page)).map(call => call.command)).toEqual(["obs_start", "obs_broadcast_start", "ndi_stop"]);
});
