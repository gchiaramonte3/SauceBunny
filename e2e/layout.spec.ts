import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * Small-window layout guarantees — same mocked-IPC harness as smoke.spec.ts.
 *
 * The app declares 1100x700 as its minimum window (tauri.conf.json), but the
 * fixed rails used to eat it: nav (72) + sidebar (320) + drawer (440) left a
 * ~236px editor column, with the transport clipping offscreen. The adaptive
 * rules in shell.css (below 1350px the OPEN drawer floats over the monitor as
 * a right-anchored sheet; the sidebar clamps) are what these specs pin down:
 * at both audited sizes the monitor keeps a usable width, the transport stays
 * inside the viewport, and the document never scrolls horizontally.
 */

const pageErrors: string[] = [];

async function bootToClip(page: Page, width: number, height: number): Promise<void> {
  pageErrors.length = 0;
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.setViewportSize({ width, height });
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.permissioned", "1");
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+3");
  await expect(page.locator(".cp-toolbar")).toBeVisible();
}

async function assertWorkbenchUsable(page: Page, viewport: { width: number; height: number }, minMonitor: number) {
  // Fresh profile: the drawer boots open — the hostile case for width.
  await expect(page.locator(".cp-queue-drawer.open")).toBeVisible();
  // The monitor column keeps a real width (the drawer overlays, not pushes,
  // below 1350px; at 1280+ the docked layout must still clear the floor).
  const monitor = await page.locator(".cp-main").boundingBox();
  expect(monitor, "monitor column missing").not.toBeNull();
  expect(monitor!.width).toBeGreaterThanOrEqual(minMonitor);
  // The transport row renders fully inside the viewport.
  const transport = await page.getByRole("region", { name: "Playback transport" }).boundingBox();
  expect(transport, "transport missing").not.toBeNull();
  expect(transport!.y + transport!.height).toBeLessThanOrEqual(viewport.height + 1);
  expect(transport!.x).toBeGreaterThanOrEqual(-1);
  // No horizontal document scroll at the declared minimum.
  const overflowX = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflowX).toBeLessThanOrEqual(0);
  expect(pageErrors, `pageerrors:\n${pageErrors.join("\n")}`).toHaveLength(0);
}

test("1100x700 (declared minimum): monitor keeps width, transport on screen, no x-scroll", async ({ page }) => {
  await bootToClip(page, 1100, 700);
  await assertWorkbenchUsable(page, { width: 1100, height: 700 }, 560);
});

test("1280x800: docked tier - panels clamp, monitor keeps ~440px+, nothing overlays", async ({ page }) => {
  await bootToClip(page, 1280, 800);
  // 1200-1349 is the DOCKED tier: the drawer must still be in-flow (not a
  // sheet over the monitor - position static), just narrower.
  const position = await page
    .locator(".cp-queue-drawer.open")
    .evaluate((el) => getComputedStyle(el).position);
  expect(position).not.toBe("absolute");
  await assertWorkbenchUsable(page, { width: 1280, height: 800 }, 440);
});

test("1100x700: the drawer is a sheet (absolute) so it never crushes the monitor", async ({ page }) => {
  await bootToClip(page, 1100, 700);
  const position = await page
    .locator(".cp-queue-drawer.open")
    .evaluate((el) => getComputedStyle(el).position);
  expect(position).toBe("absolute");
});
