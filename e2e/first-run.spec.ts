import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * The first launch — the one screen every user sees, tested by nothing.
 *
 * Every other spec in this suite seeds `saucebunny.welcomed` to skip straight
 * past it, which is convenient and is exactly why nobody noticed the state it
 * was in: TWO dialogs open at once (the welcome screen at z-index 300, painted
 * over the YouTube connect modal), and the welcome declaring `aria-modal` with
 * no focus trap behind it.
 *
 * A keyboard user's first launch went: Tab into the nav rail, through Home's
 * buttons, and then into the covered modal's browser picker — a list that
 * borrows cookies, offered to someone who cannot see it — while "Get started",
 * the one button on screen, was never reachable at all.
 *
 * These specs boot with a genuinely empty localStorage. Nothing here may seed
 * `saucebunny.welcomed`, or it stops testing first run.
 */

async function firstRun(page: Page, sink?: string[]) {
  if (sink) {
    page.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning") sink.push(`[${m.type()}] ${m.text()}`);
    });
    page.on("pageerror", (e) => sink.push(`[pageerror] ${String(e)}`));
  }
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.goto("/");
  await expect(page.getByRole("dialog", { name: "Welcome to Sauce Bunny" })).toBeVisible({
    timeout: 15_000,
  });
}

test("a brand new install opens on the welcome screen, quietly", async ({ page }) => {
  const noise: string[] = [];
  await firstRun(page, noise);
  await expect(page.getByRole("button", { name: "Get started" })).toBeVisible();
  expect(noise, `console noise on first run:\n${noise.join("\n")}`).toEqual([]);
});

test("focus cannot leave the welcome dialog", async ({ page }) => {
  // The bug this file was written for. Two dialogs are open at once here, so
  // an untrapped Tab does not merely reach the page behind — it reaches a
  // second modal the user cannot see.
  await firstRun(page);
  const escaped: string[] = [];
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press("Tab");
    const where = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return "body";
      if (el.closest(".cp-welcome")) return null;
      return `${el.closest(".cp-ytauth") ? "covered modal" : "page behind"}: `
        + `${(el.textContent || el.getAttribute("aria-label") || "?").trim().slice(0, 24)}`;
    });
    if (where) escaped.push(where);
  }
  expect(escaped, `focus left the welcome dialog:\n${[...new Set(escaped)].join("\n")}`).toEqual([]);
});

test("Get started dismisses it, and it stays dismissed", async ({ page }) => {
  // The latch. A welcome screen that returns on every launch is worse than
  // no welcome screen.
  await firstRun(page);
  await page.getByRole("button", { name: "Get started" }).click();
  await expect(page.getByRole("dialog", { name: "Welcome to Sauce Bunny" })).toBeHidden();
  await expect(page.locator(".cp-view-home")).toBeVisible();

  await page.reload();
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("dialog", { name: "Welcome to Sauce Bunny" })).toHaveCount(0);
});

test("onboarding is a sequence, not a stack", async ({ page }) => {
  // Exactly one modal at a time. Two aria-modal dialogs open together is both
  // an ambiguity for assistive tech and the reason Escape used to resolve to
  // the wrong one.
  await firstRun(page);
  await expect(page.getByRole("dialog")).toHaveCount(1);

  await page.getByRole("button", { name: "Get started" }).click();
  // The YouTube connect prompt takes its turn only now.
  await expect(page.locator(".cp-ytauth")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
});

test("Escape is the same as Get started", async ({ page }) => {
  // The component binds Esc and Enter to onDone in the capture phase, so the
  // app-level shortcut handler cannot swallow them.
  await firstRun(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Welcome to Sauce Bunny" })).toBeHidden();
});
