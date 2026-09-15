import { expect, test, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

async function boot(page: Page, withSource = true) {
  // Metadata-only source fixture. No user media or external player request
  // may escape this browser test; the native stream resolver is also mocked.
  await page.route("https://**", route => route.abort());
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1"); localStorage.setItem("saucebunny.permissioned", "1");
    localStorage.setItem("saucebunny.review.author", JSON.stringify("Keyboard fixture"));
    localStorage.setItem("e2e.avGranted", "1"); localStorage.setItem("e2e.files", "{}");
    localStorage.setItem("saucebunny.queueDrawerActiveTab", "ai");
    const fixture = window as unknown as {
      __keyboardWrites: string[];
      __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> };
    };
    fixture.__keyboardWrites = [];
    const original = fixture.__TAURI_INTERNALS__.invoke;
    fixture.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (["obs_start", "obs_broadcast_start", "ndi_start", "ndi_publish", "session_create", "session_start", "session_join"].includes(command)) {
        fixture.__keyboardWrites.push(command);
        return Promise.reject(new Error("Keyboard fixture never captures, publishes, or joins"));
      }
      if (command === "ndi_discover") return Promise.resolve({ bridgeCompiled: true, runtime: "ready", runtimeVersion: "Keyboard fixture", sources: [], error: null });
      if (command === "obs_preflight") return Promise.resolve({ available: true, error: null });
      if (command === "obs_applications") return Promise.resolve([
        { app: "test.keyboard.alpha", pid: 101, name: "Generated Alpha" },
        { app: "test.keyboard.beta", pid: 202, name: "Generated Beta" },
      ]);
      if (command === "obs_windows") return Promise.resolve([]);
      if (command === "obs_displays") return Promise.resolve([]);
      if (command === "obs_all_windows") return Promise.resolve([
        { app: "test.keyboard.alpha", applicationName: "Generated Alpha", pid: 101, id: 501, title: "Alpha timeline", width: 640, height: 360 },
        { app: "test.keyboard.beta", applicationName: "Generated Beta", pid: 202, id: 601, title: "Beta timeline", width: 640, height: 360 },
      ]);
      if (command === "capture_window_thumbnail") return Promise.reject(new Error("Keyboard fixture has no image"));
      return original(command, args);
    };
  });
  await page.goto("/"); await expect(page.locator(".cp-view-home")).toBeVisible();
  await page.keyboard.press("Meta+3");
  if (withSource) {
    await page.locator("input[placeholder^='Paste a video URL']").fill("https://youtube.com/watch?v=aaaa");
    await page.getByRole("button", { name: /^Fetch/ }).click();
    await expect(page.locator(".cp-timeline-hint")).toContainText("No marks set");
  }
  await page.keyboard.press("Meta+4");
  await expect(page.locator(".cp-view-clip")).toBeVisible();
  if (withSource) await expect(page.getByRole("tablist", { name: "Right panel sections" })).toBeVisible();
}
const strip = (page: Page) => page.getByRole("tablist", { name: "Right panel sections" });
const tab = (page: Page, name: string) => strip(page).getByRole("tab", { name, exact: true });
async function selected(page: Page, name: string) {
  await expect(tab(page, name)).toHaveAttribute("aria-selected", "true");
  await expect(tab(page, name)).toHaveAttribute("tabindex", "0");
  await expect(strip(page).locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
}
async function noCapture(page: Page) {
  expect(await page.evaluate(() => (window as unknown as { __keyboardWrites: string[] }).__keyboardWrites)).toEqual([]);
}

test("empty Review omits its bottom Shortcuts hint without removing the shortcut sheet or Clip hint", async ({ page }) => {
  await boot(page, false);
  const hint = page.locator(".cp-view-clip .cp-timeline-hint");
  await expect(hint).toBeEmpty();
  await expect(hint).toHaveAttribute("aria-hidden", "true");
  await expect(hint.locator("kbd")).toHaveCount(0);

  await page.keyboard.press("Meta+/");
  const sheet = page.getByRole("dialog", { name: "Keyboard shortcuts", exact: true });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("Play / pause", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(hint).toBeEmpty();

  await page.keyboard.press("Meta+3");
  await expect(page.locator("input[placeholder^='Paste a video URL']")).toBeVisible();
  await expect(hint).toContainText("Shortcuts");
  await expect(hint).toHaveAttribute("aria-hidden", "false");
  await expect(hint.locator("kbd")).toHaveCount(1);
  await page.keyboard.press("Meta+4");
  await expect(hint).toBeEmpty();
  await expect(hint.locator("kbd")).toHaveCount(0);
  await noCapture(page);
});

test("Space and Enter activate source settings while native select type-ahead stays native", async ({ page }) => {
  await boot(page);
  const gear = page.getByRole("button", { name: "Source settings", exact: true });
  await gear.focus(); await gear.press("Space");
  let dialog = page.getByRole("dialog", { name: "Source settings", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Done", exact: true }).press("Space");
  await expect(dialog).toHaveCount(0); await expect(gear).toBeFocused();
  await gear.press("Enter"); await expect(dialog).toBeVisible();
  const input = dialog.getByRole("tab", { name: "NDI", exact: true });
  await input.focus(); await input.press("ArrowRight");
  const screenTab = dialog.getByRole("tab", { name: "Screen", exact: true });
  await expect(screenTab).toBeFocused();
  await screenTab.press("ArrowRight");
  dialog = page.getByRole("dialog", { name: "Source settings" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("tab", { name: "Window", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("button", { name: "Preview source", exact: true })).toBeDisabled();
  const window = dialog.getByRole("button", { name: /Beta timeline .* Window 601$/ });
  await window.focus(); await window.press("Space");
  await expect(window).toHaveAttribute("aria-pressed", "true");
  await expect(dialog.getByRole("button", { name: "Preview source", exact: true })).toBeEnabled();
  await expect(page.locator(".cp-timeline-hint")).toContainText("No marks set");
  await page.keyboard.press("Escape"); await expect(gear).toBeFocused();
  // Outside the modal's own event boundary, O used to be claimed by global
  // Mark out. It must choose the actual native option without altering marks.
  const sort = page.getByRole("combobox", { name: "Sort comments" });
  await sort.focus(); await sort.press("o"); await expect(sort).toHaveValue("oldest");
  await expect(page.locator(".cp-timeline-hint")).toContainText("No marks set");
  await noCapture(page);
});

test("Review tab arrows wrap, use one tab stop, and leave Clip's saved tab untouched", async ({ page }) => {
  await boot(page); await selected(page, "Review");
  await tab(page, "Review").focus(); await page.keyboard.press("ArrowRight");
  await expect(tab(page, "Queue")).toBeFocused(); await selected(page, "Queue");
  await page.keyboard.press("End"); await expect(tab(page, "Review")).toBeFocused();
  await page.keyboard.press("Home"); await expect(tab(page, "Queue")).toBeFocused();
  await page.keyboard.press("ArrowLeft"); await expect(tab(page, "Review")).toBeFocused();
  await page.keyboard.press("ArrowLeft"); await selected(page, "AI Summary");
  expect(await page.evaluate(() => localStorage.getItem("saucebunny.queueDrawerActiveTab"))).toBe("ai");
  // Tab must leave the composite rather than walk all four header buttons.
  await page.keyboard.press("Tab");
  await expect(strip(page).locator('[role="tab"]:focus')).toHaveCount(0);
  await page.keyboard.press("Meta+3");
  await expect(page.locator(".cp-view-clip")).toBeVisible();
  await page.keyboard.press("Meta+4"); await selected(page, "AI Summary");
  await noCapture(page);
});

test("pointer-reordered tabs keep their order and arrow focus after navigation", async ({ page }) => {
  await boot(page);
  const queue = tab(page, "Queue"), ai = tab(page, "AI Summary");
  const from = (await queue.boundingBox())!, to = (await ai.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width - 2, to.y + to.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => strip(page).getByRole("tab").evaluateAll(items => items.map(item => item.getAttribute("aria-label"))))
    .toEqual(["Transcript", "AI Summary", "Queue", "Review"]);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("saucebunny.queueDrawerTabOrder")!)))
    .toEqual(["transcript", "ai", "queue", "review"]);
  await queue.focus(); await page.keyboard.press("ArrowLeft");
  await expect(ai).toBeFocused(); await selected(page, "AI Summary");
  await page.keyboard.press("Home"); await selected(page, "Transcript");
  await page.keyboard.press("Meta+3"); await page.keyboard.press("Meta+4");
  await selected(page, "Transcript");
  await expect(strip(page).getByRole("tab").first()).toHaveAccessibleName("Transcript");
  await noCapture(page);
});

test("private Review range shortcuts follow its visible tab rather than Clip's saved tab", async ({ page }) => {
  await boot(page); await selected(page, "Review");
  expect(await page.evaluate(() => localStorage.getItem("saucebunny.queueDrawerActiveTab"))).toBe("ai");
  const stage = page.locator(".cp-view-clip");
  const range = page.locator(".cp-review-rangebar");
  await stage.focus(); await page.keyboard.press("Shift+I");
  await expect(range).toBeVisible();
  await expect(range).toContainText("⇧O marks OUT");
  await page.getByRole("button", { name: "Clear range", exact: true }).click();
  await expect(range).toHaveCount(0);

  await tab(page, "Transcript").click();
  await stage.focus(); await page.keyboard.press("Shift+I");
  await expect(range).toHaveCount(0);
  await tab(page, "Review").click();
  await expect(range).toHaveCount(0);

  await page.getByRole("button", { name: "Session setup…", exact: true }).click();
  await stage.focus(); await page.keyboard.press("Shift+O");
  await expect(range).toHaveCount(0);
  await page.getByRole("button", { name: "Review notes", exact: true }).click();
  await stage.focus(); await page.keyboard.press("Shift+O");
  await expect(range).toBeVisible();
  await expect(range).toContainText("⇧I marks IN");
  expect(await page.evaluate(() => localStorage.getItem("saucebunny.queueDrawerActiveTab"))).toBe("ai");
  await noCapture(page);
});
