import { expect, test, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

test.use({ browserName: process.env.SAUCE_UI_BROWSER === "webkit" ? "webkit" : "chromium" });

test("model downloads use the shared neutral rail under OS Light", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await boot(page);
  await page.evaluate(() => {
    const app = window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };
    const original = app.__TAURI_INTERNALS__.invoke;
    app.__TAURI_INTERNALS__.invoke = (cmd, args) => cmd === "video_intelligence_run" && (args?.request as { operation: string })?.operation === "download"
      ? new Promise(() => {}) : original(cmd, args);
  });
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Video Intelligence", exact: true }).click();
  await page.locator(".cp-model-row").filter({ hasText: "Qwen3.5 9B" }).getByRole("button", { name: "Download", exact: true }).click();
  const rail = page.getByRole("progressbar", { name: "Downloading Qwen3.5 9B" });
  await expect(rail).toBeVisible();
  await expect(rail).not.toHaveAttribute("aria-valuenow");
  for (const width of [1050, 1440]) {
    await page.setViewportSize({ width, height: 820 });
    const result = await rail.evaluate(element => {
      const style = getComputedStyle(element), box = element.getBoundingClientRect();
      return { height: box.height, width: box.width, right: box.right, colorScheme: style.colorScheme, animation: style.animationName, background: style.backgroundImage };
    });
    expect(result.height).toBe(4); expect(result.width).toBeLessThanOrEqual(280);
    expect(result.right).toBeLessThan(width); expect(result.colorScheme).toContain("dark");
    expect(result.animation).toBe("none"); expect(result.background).toContain("gradient");
  }
  await page.screenshot({ path: test.info().outputPath("download-os-light.png") });
});

async function boot(page: Page, installed = false) {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(installed => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1"); localStorage.setItem("saucebunny.permissioned", "1");
    localStorage.setItem("saucebunny.libraryRoots", JSON.stringify(["/e2e-mock/Footage"]));
    const app = window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };
    const original = app.__TAURI_INTERNALS__.invoke;
    app.__TAURI_INTERNALS__.invoke = (cmd, args) => {
      if (cmd === "video_intelligence_run") {
        const request = args?.request as { operation: string; paths?: string[]; scope?: string[] };
        const calls = JSON.parse(localStorage.getItem("e2e.videoRequests") ?? "[]");
        localStorage.setItem("e2e.videoRequests", JSON.stringify([...calls, request]));
        return Promise.resolve({ models: [
          { id: "qwen3-vl-embedding-2b", name: "Qwen3-VL Embedding 2B", role: "embedding", bytes: 1796334205, ready: false },
          { id: "qwen3-vl-reranker-2b", name: "Qwen3-VL Reranker 2B", role: "reranker", bytes: 1796333118, ready: false },
          { id: "qwen3.5-9b-video", name: "Qwen3.5 9B", role: "reasoning", bytes: 5977071067, ready: false },
          { id: "qwen3.5-4b-video", name: "Qwen3.5 4B", role: "reasoning", bytes: 3100000000, ready: false },
          { id: "ast-audioset", name: "AudioSet AST", role: "audio", bytes: 346433173, ready: false },
        ].map(model => ({ ...model, ready: installed })), sources: [{ key: "a".repeat(64), path: "/e2e-mock/Footage/clip-a.mp4", duration: 90, model: "pinned", complete: 1, available: true, segments: 15 }],
        hits: request.operation === "search" ? [{ id: 1, source_key: "a".repeat(64), path: "/e2e-mock/Footage/clip-a.mp4", start: 6, end: 14, frames: [6, 7], score: 0.7 }] : [],
        answers: request.operation === "reason" ? [{ id: 1, path: "/e2e-mock/Footage/clip-a.mp4", start: 6, end: 14, text: "The selected moment shows a blue screen." }] : [] });
      }
      return original(cmd, args);
    };
  }, installed);
  await page.goto("/"); await expect(page.locator(".cp-view-home")).toBeVisible();
}

test("Settings places compact Video Intelligence directly below AI Summary without loading models", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const summary = page.getByRole("button", { name: "AI Summary", exact: true });
  const video = page.getByRole("button", { name: "Video Intelligence", exact: true });
  await video.click();
  expect(await summary.evaluate((element) => element.nextElementSibling?.textContent)).toContain("Video Intelligence");
  await expect(page.getByRole("heading", { name: "Video Intelligence" })).toBeVisible();
  await expect(page.getByText("Qwen3.5 9B", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("e2e.videoRequests") ?? "[]"))).toEqual([{ operation: "models" }]);
  await page.setViewportSize({ width: 1050, height: 760 });
  await page.addStyleTag({ content: ":root { --text-base: 22px; --text-md: 24px; --text-sm: 20px; }" });
  const navigation = await page.locator(".cp-modal-tab").evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect(); return { top: box.top, bottom: box.bottom };
  }));
  for (let index = 1; index < navigation.length; index++) {
    expect(navigation[index].top).toBeGreaterThanOrEqual(navigation[index - 1].bottom);
  }
  const buttons = page.getByRole("button", { name: "Download", exact: true });
  await expect(buttons).toHaveCount(5);
  for (const button of await buttons.all()) {
    await button.scrollIntoViewIfNeeded();
    const box = (await button.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(1050);
    expect(box.height).toBeGreaterThanOrEqual(24);
  }
  await page.screenshot({ path: "/private/tmp/sauce-video-settings.png" });
});

test("Settings picture default persists into Clip and syncs across windows without model work", async ({ page, context }) => {
  await boot(page, true);
  const openSettings = async () => {
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Video Intelligence", exact: true }).click();
  };
  await openSettings();
  const picture = page.getByRole("region", { name: "Picture analysis" });
  await expect(picture.locator(".cp-model-row")).toHaveCount(2);
  await expect(page.getByRole("region", { name: "Audio analysis" }).getByRole("button", { name: "Use as default" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Video search" }).getByRole("button", { name: "Use as default" })).toHaveCount(0);
  await picture.locator(".cp-model-row").filter({ hasText: "Qwen3.5 4B" }).getByRole("button", { name: "Use as default" }).click();
  await expect(picture.locator(".selected.cp-model-row")).toContainText("Qwen3.5 4B");
  await expect(picture.locator(".selected.cp-model-row")).toContainText("Default");
  await page.reload(); await openSettings();
  await expect(picture.locator(".selected.cp-model-row")).toContainText("Qwen3.5 4B");
  await page.setViewportSize({ width: 1050, height: 760 });
  await page.addStyleTag({ content: ":root { --text-base: 13.75px; --text-md: 15px; --text-sm: 12.5px; }" });
  for (const row of await page.locator(".cp-video-model-settings .cp-model-row").all()) {
    await row.scrollIntoViewIfNeeded();
    expect(await row.evaluate(element => {
      const box = element.getBoundingClientRect();
      return [...element.querySelectorAll("button")].every(button => {
        const action = button.getBoundingClientRect();
        return action.left >= box.left && action.right <= box.right && action.height >= 24;
      });
    })).toBe(true);
  }
  await picture.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `/private/tmp/sauce-picture-default-${process.env.SAUCE_UI_BROWSER ?? "chromium"}.png` });
  await page.evaluate(() => {
    localStorage.setItem("saucebunny.shotIntelligence.preview", "1");
    localStorage.setItem("saucebunny.panelSnapshot", JSON.stringify({ sourceIdentity: "clip", aiVideoPath: "/clip.mp4", fps: 24, hasSource: true, durationSec: 12 }));
  });
  await page.goto("/?window=panel");
  await page.getByRole("tab", { name: "AI Summary" }).click();
  await page.getByRole("switch", { name: "Advanced Intelligence" }).click();
  const selection = page.getByRole("combobox", { name: "Picture model" });
  await expect(selection).toHaveValue("qwen3.5-4b-video");
  await expect(selection.locator("option")).toHaveCount(2);
  const other = await context.newPage();
  await other.route("**/preference-test", route => route.fulfill({ contentType: "text/html", body: "<main>Preference test window</main>" }));
  await other.goto("/preference-test");
  await other.evaluate(() => localStorage.setItem("saucebunny.pictureModel", "qwen3.5-9b-video"));
  await expect(selection).toHaveValue("qwen3.5-9b-video");
  await other.close();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("e2e.videoRequests") ?? "[]")
    .every((request: { operation: string }) => request.operation === "models"))).toBe(true);
});

test("Library requires an explicit selection and renders source-linked results", async ({ page }) => {
  await boot(page); await page.keyboard.press("Meta+2");
  await page.getByRole("button", { name: "Video Intelligence", exact: true }).click();
  const panel = page.getByRole("region", { name: "Video Intelligence", exact: true });
  await expect(panel).toBeVisible();
  // No indexing starts merely by opening the panel.
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("e2e.videoRequests") ?? "[]").some((r: { operation: string }) => r.operation === "index"))).toBe(false);
  const card = page.locator(".cp-lib-pane .cp-lib-card:not(.cp-lib-foldercard)").filter({ hasText: "clip-a.mp4" }).first();
  await card.click();
  await panel.getByRole("textbox", { name: "Describe a video moment" }).fill("blue screen");
  await panel.getByRole("button", { name: "Search", exact: true }).click();
  await expect(panel.getByRole("button", { name: /clip-a.mp4/ })).toBeVisible();
  await panel.getByRole("button", { name: "Describe", exact: true }).click();
  await expect(panel).toContainText("The selected moment shows a blue screen.");
  const requests = await page.evaluate(() => JSON.parse(localStorage.getItem("e2e.videoRequests") ?? "[]"));
  expect(requests.find((r: { operation: string }) => r.operation === "search").scope).toEqual(["a".repeat(64)]);
  await page.screenshot({ path: "/private/tmp/sauce-video-library.png" });
});
