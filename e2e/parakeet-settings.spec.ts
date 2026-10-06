import { expect, test } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { multitrackFixture } from "../src/test/multitrack-fixture";
import { tauriMockInit } from "./tauri-mock";

/**
 * Models download in Settings, never on a page (docs/UI-CORRECTIONS-2026-10-05.md,
 * item 11). AAF Audio says which model is missing and opens Settings on
 * Transcription; Settings lists every Parakeet model and installs it; AAF
 * Audio hears about it without a relaunch.
 */
test("a missing Parakeet model is downloaded in Settings, and AAF Audio sees it arrive", async ({ page }) => {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript((fixture) => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1"); localStorage.setItem("saucebunny.permissioned", "1");
    type Mock = { emitTauriEvent: (event: string, payload: unknown) => void };
    const app = window as unknown as { __downloads: string[]; __TAURI_MOCK__: Mock; __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> } };
    const installed = new Set(["parakeet-tdt-0.6b-v3"]);
    app.__downloads = [];
    const original = app.__TAURI_INTERNALS__.invoke;
    app.__TAURI_INTERNALS__.invoke = (command, args = {}) => {
      if (command === "aaf_list") return Promise.resolve([]);
      if (command === "aaf_sequences") return Promise.resolve([{ id: "fixture", name: fixture.manifest.name }]);
      if (command === "aaf_import" || command === "aaf_open") return Promise.resolve(structuredClone(fixture));
      if (command === "plugin:dialog|open") return Promise.resolve(fixture.source_path);
      if (command === "aaf_resolve_media") return new Promise(() => {});
      if (command === "list_whisper_models") return Promise.resolve([]);
      if (command === "parakeet_model_downloaded") return Promise.resolve(installed.has(String(args.model ?? "parakeet-tdt-0.6b-v3")));
      if (command === "download_parakeet_model") { app.__downloads.push(String(args.model)); installed.add(String(args.model)); return Promise.resolve(); }
      // Tauri delivers an emit to every listener, the sender's own window included.
      if (command === "plugin:event|emit") { app.__TAURI_MOCK__.emitTauriEvent(String(args.event), args.payload); return Promise.resolve(); }
      return original(command, args);
    };
  }, multitrackFixture());
  await page.goto("/");
  await page.locator(".cp-nav-item").filter({ hasText: "AAF Audio" }).click();
  const region = page.getByRole("region", { name: "AAF Audio", exact: true });
  await region.getByRole("button", { name: "Import AAF…", exact: true }).first().click();
  await region.getByRole("combobox", { name: "Engine", exact: true }).selectOption("parakeet");
  await region.getByRole("combobox", { name: "Model", exact: true }).selectOption("parakeet-ultra");
  const missing = region.getByText("Parakeet Ultra is not downloaded.");
  await expect(missing).toBeVisible();
  // Nothing on the page downloads.
  await expect(region.getByRole("button", { name: /^(Download Parakeet|Cancel download)/ })).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("aaf-missing-model.png") });
  await region.getByRole("button", { name: "Download in Settings…" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  const ultra = settings.locator(".cp-model-row", { has: page.locator(".name", { hasText: /^Parakeet Ultra$/ }) });
  await expect(ultra).toBeVisible();
  await expect(settings.locator(".cp-model-row", { has: page.locator(".name", { hasText: /^Parakeet TDT 0\.6B v3$/ }) })).toContainText("Installed");
  await ultra.getByRole("button", { name: "Download", exact: true }).click();
  await expect(ultra).toContainText("Installed");
  await ultra.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("settings-parakeet-models.png") });
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await expect(missing).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __downloads: string[] }).__downloads)).toEqual(["parakeet-ultra"]);
});
