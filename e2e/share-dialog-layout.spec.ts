import { expect, test, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

async function boot(page: Page, scale: number) {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1"); localStorage.setItem("saucebunny.permissioned", "1");
    localStorage.setItem("saucebunny.review.author", JSON.stringify("Generated editor"));
    localStorage.setItem("e2e.avGranted", "1");
    const fixture = window as unknown as { __shareCalls: string[];
      __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> } };
    fixture.__shareCalls = [];
    const original = fixture.__TAURI_INTERNALS__.invoke;
    fixture.__TAURI_INTERNALS__.invoke = (command, args) => {
      fixture.__shareCalls.push(command);
      if (command === "screen_capture_access") return Promise.resolve("granted");
      if (command === "list_share_sources") {
        const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 180;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "#28262f"; context.fillRect(0, 0, 320, 180);
        context.fillStyle = "#eeeeef"; context.font = "16px sans-serif"; context.fillText("Generated display", 32, 90);
        return Promise.resolve({ capture_engine: true, windows: [], displays: [{ id: 7,
          label: "Generated studio display", width: 3840, height: 2160, thumb: canvas.toDataURL("image/jpeg").split(",")[1] }] });
      }
      return original(command, args);
    };
  });
  await page.goto("/"); await expect(page.locator(".cp-view-home")).toBeVisible();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.evaluate(scale => {
    const root = document.documentElement, css = getComputedStyle(root);
    const values = ["--text-xs", "--text-sm", "--text-base", "--text-md", "--text-lg", "--text-xl", "--text-2xl"]
      .map(token => [token, `${parseFloat(css.getPropertyValue(token)) * scale}px`]);
    for (const [token, value] of values) root.style.setProperty(token, value);
    // Generated room state only; no session or capture is started.
    (window as unknown as { __TAURI_MOCK__: { emitTauriEvent: (name: string, payload: unknown) => void } }).__TAURI_MOCK__
      .emitTauriEvent("session:state", { role: "host", code: "generated-layout", selfId: "m0", presenter: "m0",
        presenterEpoch: 0, peers: [], title: "Generated layout", error: null });
  }, scale);
  await page.getByRole("toolbar", { name: "Room controls" }).getByRole("button", { name: /^Share your screen/ }).click();
  const dialog = page.getByRole("dialog", { name: "Share your screen" });
  await dialog.getByRole("tab", { name: "Portion of screen" }).click();
  await dialog.getByRole("button", { name: /Generated studio display/ }).click();
  for (const [name, value] of [["Left", "10"], ["Top", "20"], ["Width", "60"], ["Height", "50"]]) {
    await dialog.getByRole("spinbutton", { name, exact: true }).fill(value);
  }
  return dialog;
}

for (const viewport of [{ width: 1100, height: 700 }, { width: 1680, height: 1020 }]) {
  for (const scale of [1, 1.25]) test(`share region keeps audio and actions separate at ${viewport.width}×${viewport.height}, ${scale * 100}% text`, async ({ page }) => {
    await page.setViewportSize(viewport); await page.emulateMedia({ reducedMotion: "reduce" });
    const dialog = await boot(page, scale);
    const body = dialog.locator(".cp-share-dialog-body"), footer = dialog.locator(".cp-share-dialog-foot");
    await expect(body).toBeVisible();
    const before = (await footer.boundingBox())!;
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.width).toBeGreaterThan(800);
    expect(bounds.x).toBeGreaterThanOrEqual(16); expect(bounds.y).toBeGreaterThanOrEqual(16);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width - 16);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height - 16);
    const noOverlap = async () => {
      const content = (await body.boundingBox())!, foot = (await footer.boundingBox())!;
      expect(content.y + content.height).toBeLessThanOrEqual(foot.y + 1);
      await expect(dialog.getByRole("checkbox", { name: "Share system audio" })).toBeInViewport({ ratio: 1 });
      await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeInViewport({ ratio: 1 });
      await expect(dialog.getByRole("button", { name: "Share", exact: true })).toBeInViewport({ ratio: 1 });
      expect(await dialog.evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    };
    await noOverlap();
    for (const scrollTop of [0, 10000]) {
      await body.evaluate((element, top) => { element.scrollTop = top; }, scrollTop);
      await noOverlap();
      expect((await footer.boundingBox())!.y).toBeCloseTo(before.y, 0);
    }
    const fields = (await dialog.locator(".cp-capture-region-fields").boundingBox())!;
    expect(fields.y + fields.height).toBeLessThanOrEqual(before.y + 1);
    await dialog.getByRole("checkbox", { name: "Share system audio" }).check();
    await expect(dialog.getByRole("button", { name: "Share", exact: true })).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath("share-region-layout.png") });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const calls = await page.evaluate(() => (window as unknown as { __shareCalls: string[] }).__shareCalls);
    expect(calls.filter(command => ["session_start", "session_join", "start_screen_share", "obs_start", "ndi_start", "ndi_publish"].includes(command))).toEqual([]);
  });
}
