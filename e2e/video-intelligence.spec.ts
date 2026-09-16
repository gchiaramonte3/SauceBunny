import { expect, test, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

async function boot(page: Page) {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
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
        ], sources: [{ key: "a".repeat(64), path: "/e2e-mock/Footage/clip-a.mp4", duration: 90, model: "pinned", complete: 1, available: true, segments: 15 }],
        hits: request.operation === "search" ? [{ id: 1, source_key: "a".repeat(64), path: "/e2e-mock/Footage/clip-a.mp4", start: 6, end: 14, frames: [6, 7], score: 0.7 }] : [],
        answers: request.operation === "reason" ? [{ id: 1, path: "/e2e-mock/Footage/clip-a.mp4", start: 6, end: 14, text: "The selected moment shows a blue screen." }] : [] });
      }
      return original(cmd, args);
    };
  });
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
  await expect(buttons).toHaveCount(3);
  for (const button of await buttons.all()) {
    await button.scrollIntoViewIfNeeded();
    const box = (await button.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0); expect(box.x + box.width).toBeLessThanOrEqual(1050);
    expect(box.height).toBeGreaterThanOrEqual(24);
  }
  await page.screenshot({ path: "/private/tmp/sauce-video-settings.png" });
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
