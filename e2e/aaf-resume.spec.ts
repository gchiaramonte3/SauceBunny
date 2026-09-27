import { expect, test, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { multitrackFixture } from "../src/test/multitrack-fixture";
import { tauriMockInit } from "./tauri-mock";

/**
 * AAF Audio's welcome is for someone who has never imported an AAF. After
 * that the page reopens the sequence that was open (or, on an install from
 * before this was remembered, the newest one), including after a relaunch.
 */
async function boot(page: Page, saved: boolean) {
  const fixture = multitrackFixture();
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(({ document, saved }) => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1"); localStorage.setItem("saucebunny.permissioned", "1");
    const app = window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } };
    const original = app.__TAURI_INTERNALS__.invoke;
    app.__TAURI_INTERNALS__.invoke = (command, args = {}) => {
      if (command === "aaf_list") return Promise.resolve(saved ? [{ id: document.id, name: document.manifest.name, track_count: 3, transcribed_tracks: 0, source_path: document.source_path, modified_ms: 5 }] : []);
      if (command === "aaf_open") return Promise.resolve(document);
      return original(command, args);
    };
  }, { document: fixture, saved });
  await page.goto("/");
  await page.getByRole("button", { name: "AAF Audio", exact: true }).click();
}

test("a first visit shows the welcome", async ({ page }) => {
  await boot(page, false);
  await expect(page.getByRole("heading", { name: "Read the room, mic by mic" })).toBeVisible();
});

test("with saved work the page reopens it instead of the welcome, and again after a relaunch", async ({ page }) => {
  await boot(page, true);
  const region = page.getByRole("region", { name: "AAF Audio" });
  await expect(region.getByRole("heading", { name: "Interview" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Read the room, mic by mic" })).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("saucebunny.aafAudio.lastDocument"))).toBe(multitrackFixture().id);
  await page.reload();
  await page.getByRole("button", { name: "AAF Audio", exact: true }).click();
  await expect(region.getByRole("heading", { name: "Interview" })).toBeVisible();
});
