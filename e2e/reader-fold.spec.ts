import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * The transcripts picker opens folded.
 *
 * A hundred transcripts across six months is a scroll with no shape when
 * every group is open. Folded, the picker is a list of the months and
 * projects you actually have. Nothing is hidden - the count stays on every
 * heading - and whatever you open is remembered.
 *
 * Two groups open themselves regardless, and both would be bugs otherwise:
 * the search results, and whichever group holds the transcript you are
 * reading.
 */
async function bootReader(page: Page, seed: (() => void) | null = null): Promise<void> {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.permissioned", "1");
    localStorage.setItem("e2e.transcripts", "1");
  });
  if (seed) await page.addInitScript(seed);
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+5");
  await expect(page.locator(".cp-view-reader")).toBeVisible();
  await expect(page.locator(".cp-reader-group-label, .cp-reader-project").first())
    .toBeVisible({ timeout: 10_000 });
}

const rows = (page: Page) => page.locator(".cp-reader-row");

test("every group starts folded, and still says how much is in it", async ({ page }) => {
  await bootReader(page);
  await expect(rows(page)).toHaveCount(0);
  // The heading is still a full account of what is there.
  await expect(page.locator(".cp-reader-group-count").first()).toBeVisible();
});

test("opening one group opens only that one", async ({ page }) => {
  await bootReader(page);
  const heads = page.locator(".cp-reader-group-label button");
  await heads.first().click();
  const openedCount = await rows(page).count();
  expect(openedCount).toBeGreaterThan(0);

  // The other headings did not follow.
  const expandedStates = await page.locator(".cp-reader-group-label button")
    .evaluateAll((els) => els.map((e) => e.getAttribute("aria-expanded")));
  expect(expandedStates.filter((v) => v === "true")).toHaveLength(1);
});

test("what you opened is still open next time", async ({ page }) => {
  await bootReader(page);
  await page.locator(".cp-reader-group-label button").first().click();
  await expect(rows(page).first()).toBeVisible();

  await page.reload();
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+5");
  await expect(rows(page).first()).toBeVisible({ timeout: 10_000 });
});

test("a search shows its results, folded state notwithstanding", async ({ page }) => {
  // A needle collapses everything into one synthetic group. Folded, a search
  // would return a heading and no rows - which reads as "nothing found" for
  // a query that matched.
  await bootReader(page);
  await expect(rows(page)).toHaveCount(0);
  await page.getByLabel(/Search transcripts/i).fill("interview");
  await expect(rows(page).first()).toBeVisible();
});

test("the group holding the open transcript can still be closed", async ({ page }) => {
  // The bug this pins: that group opened itself on every render, which made
  // its own chevron dead - clicking to close it did nothing at all. An
  // override that outranks the user is not a default, it is a broken
  // control.
  await bootReader(page);
  // Open a group and load a transcript from it, so that group holds the
  // active row.
  const head = page.locator(".cp-reader-group-label button").first();
  await head.click();
  const row = rows(page).first();
  await row.click();
  await expect(row).toHaveAttribute("aria-current", "true");

  // Now fold it. The row must go.
  await head.click();
  await expect(head).toHaveAttribute("aria-expanded", "false");
  await expect(rows(page)).toHaveCount(0);
});

test("a group you closed stays closed across a relaunch", async ({ page }) => {
  await bootReader(page);
  const head = page.locator(".cp-reader-group-label button").first();
  await head.click();
  await expect(rows(page).first()).toBeVisible();
  await rows(page).first().click();
  await head.click();
  await expect(rows(page)).toHaveCount(0);

  await page.reload();
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+5");
  await expect(page.locator(".cp-reader-group-label").first()).toBeVisible({ timeout: 10_000 });
  // Still shut, even though it holds the transcript that is loaded.
  await expect(page.locator(".cp-reader-group-label button").first())
    .toHaveAttribute("aria-expanded", "false");
});
