import { expect, test, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { multitrackFixture } from "../src/test/multitrack-fixture";
import { tauriMockInit } from "./tauri-mock";

/**
 * AAF Audio opens clear on every launch (the owner, 2026-10-05). A sequence
 * that reopened by itself on a drive that was offline filled every lane with
 * "Waveform unavailable" and the Pipeline with errors before anyone asked for
 * it. The welcome is for someone who has never imported an AAF; after that
 * the page asks which sequence to open. What is opened stays open while the
 * app runs.
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

test("with saved work it opens clear, asks which sequence, and starts clear again after a relaunch", async ({ page }) => {
  await boot(page, true);
  const region = page.getByRole("region", { name: "AAF Audio" });
  await expect(region.getByRole("heading", { name: "Open a sequence" })).toBeVisible();
  await expect(region.getByRole("heading", { name: "Interview" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Read the room, mic by mic" })).toHaveCount(0);
  await region.getByRole("combobox", { name: "Open saved AAF" }).selectOption(multitrackFixture().id);
  await expect(region.getByRole("heading", { name: "Interview" })).toBeVisible();
  // Leaving the page and coming back keeps it open.
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.getByRole("button", { name: "AAF Audio", exact: true }).click();
  await expect(region.getByRole("heading", { name: "Interview" })).toBeVisible();
  // A relaunch does not.
  await page.reload();
  await page.getByRole("button", { name: "AAF Audio", exact: true }).click();
  await expect(region.getByRole("heading", { name: "Open a sequence" })).toBeVisible();
  await expect(region.getByRole("heading", { name: "Interview" })).toHaveCount(0);
});
