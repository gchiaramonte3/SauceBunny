import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * Undo/redo shell wiring — same mocked-IPC harness as smoke.spec.ts.
 *
 * The load-bearing pair is the ⌘Z routing tests: OUTSIDE a text field the app
 * claims the keydown (preventDefault → the native Edit ▸ Undo menu equivalent
 * is suppressed); INSIDE a field it must fall through untouched so the field's
 * native undo manager keeps working. This exact split is the contract between
 * the JS registry binding (edit.undo, global: false) and the macOS menu's
 * PredefinedMenuItem::undo — a regression here silently breaks one side or
 * the other. (This spec also caught the original mod+shift+z vs shift+mod+z
 * combo-serialization-order bug.)
 */

const pageErrors: string[] = [];

async function boot(page: Page): Promise<void> {
  pageErrors.length = 0;
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
  });
  await page.goto("/");
  await expect(page.locator(".cp-toolbar")).toBeVisible({ timeout: 15_000 });
}

test("cheat-sheet lists Undo ⌘Z / Redo ⇧⌘Z from the registry", async ({ page }) => {
  await boot(page);
  await page.keyboard.press("Control+/");
  const sheet = page.locator(".cp-shortcuts");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText("Undo", { exact: true })).toBeVisible();
  await expect(sheet.getByText("Redo", { exact: true })).toBeVisible();
  await expect(sheet.getByText("⌘Z", { exact: true })).toBeVisible();
  await expect(sheet.getByText("⌘⇧Z", { exact: true })).toBeVisible();
  expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
});

test("palette shows Undo/Redo disabled on an empty stack", async ({ page }) => {
  await boot(page);
  await page.keyboard.press("Control+k");
  const pal = page.locator("input[type=text], input").last();
  await pal.fill("undo");
  await expect(page.getByText("Nothing to undo")).toBeVisible();
  expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
});

test("mod+z in a text field is left to the native undo (no preventDefault, no crash)", async ({ page }) => {
  await boot(page);
  const prevented = await page.evaluate(() => {
    const el = document.querySelector<HTMLInputElement>("input[placeholder^='Paste a video URL']")!;
    el.focus();
    el.value = "hello";
    const ev = new KeyboardEvent("keydown", {
      key: "z", code: "KeyZ", metaKey: true, bubbles: true, cancelable: true,
    });
    el.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  expect(prevented).toBe(false); // falls through → native menu/undo manager owns it
  expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
});

test("mod+z outside a field IS claimed by the app (preventDefault) and no-ops safely on empty stack", async ({ page }) => {
  await boot(page);
  const prevented = await page.evaluate(() => {
    const ev = new KeyboardEvent("keydown", {
      key: "z", code: "KeyZ", metaKey: true, bubbles: true, cancelable: true,
    });
    window.dispatchEvent(ev);
    return ev.defaultPrevented;
  });
  expect(prevented).toBe(true); // runAction ran → menu equivalent suppressed
  expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
});
