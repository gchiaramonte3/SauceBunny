import { expect, test } from "@playwright/test";
import { tauriMockInit } from "./tauri-mock";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";

test.use({ browserName: process.env.SCENE_BROWSER === "webkit" ? "webkit" : "chromium" });
test("analysis events reach the existing Pipeline, status pill, and Copy", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1"); localStorage.setItem("saucebunny.permissioned", "1");
    localStorage.setItem("cp-logs-open", "true");
    Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => sessionStorage.setItem("pipeline-copy", text) } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Clip", exact: true }).click();
  const panel = page.locator(".cp-logs:visible");
  await expect(panel).toBeVisible();
  const send = (sequence: number, status: string, message: string) => page.evaluate(payload => {
    (window as unknown as { __TAURI_MOCK__: { emitTauriEvent: (event: string, payload: unknown) => void } })
      .__TAURI_MOCK__.emitTauriEvent("video-analysis-pipeline", payload);
  }, { runId: "detached-analysis", sequence, status, tag: "info", message });
  await send(1, "active", "DIGGER.mp4 · Starting analysis on this Mac · Qwen3.5 4B.");
  await expect(panel.locator(".status-pill")).toHaveText("ANALYZING");
  await send(2, "active", "DIGGER.mp4 · Model processed shot 12 of 113; batch results pending.");
  await expect(panel).toContainText("Model processed shot 12 of 113");
  await panel.getByRole("button", { name: "Copy", exact: true }).click();
  expect(await page.evaluate(() => sessionStorage.getItem("pipeline-copy"))).toContain("Qwen3.5 4B");
  await page.screenshot({ path: `/private/tmp/sauce-analysis-pipeline-${process.env.SCENE_BROWSER ?? "chromium"}.png` });
  await send(3, "stopping", "DIGGER.mp4 · Stopping analysis: playback took priority.");
  await expect(panel.locator(".status-pill")).toHaveText("STOPPING ANALYSIS");
  await send(4, "finished", "DIGGER.mp4 · Analysis stopped: playback took priority.");
  await expect(panel.locator(".status-pill")).not.toHaveText(/ANALYZING|STOPPING/);
  await send(2, "active", "Late duplicate must not appear");
  await expect(panel).not.toContainText("Late duplicate");
  await panel.getByRole("button", { name: "Clear", exact: true }).click();
  await expect(panel).not.toContainText("DIGGER.mp4");
  expect(errors).toEqual([]);
});
