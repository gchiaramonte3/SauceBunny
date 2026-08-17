import { test, expect } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * A modal's scrim actually covers the window.
 *
 * `.cp-modal-scrim` is the backdrop class on three portalled modals - the
 * transcript search, the library rename dialog and Quick Look - and no
 * stylesheet in the app declares it. The rule that does this job elsewhere is
 * `.cp-modal-backdrop`; the name was invented three separate times, in three
 * separate commits, and never once matched anything.
 *
 * Nothing catches that. The class attribute is valid, React renders it happily,
 * tsc has no opinion about CSS, and the dialog inside has its own width and
 * background so it still looks like a dialog. What is missing is the layer:
 * position, inset, centering, z-index and the dim. A portalled child of <body>
 * with static position lands wherever normal flow puts it - after the app root,
 * which is a full-viewport element - so the modal is laid out below the fold.
 *
 * This measures the scrim rather than asserting the class name, so it stays
 * true if the fix is a new rule, a renamed class, or a shared selector list.
 */

const VIEWPORT = { width: 1280, height: 800 };

test("the transcript search scrim covers the viewport", async ({ page }) => {
  await page.setViewportSize(VIEWPORT);
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 20_000 });

  // Open it the way a user does: command palette, then the entry.
  await page.keyboard.press("Meta+k");
  await expect(page.locator(".cp-palette")).toBeVisible();
  await page.keyboard.type("Search all transcripts");
  await page.keyboard.press("Enter");

  const scrim = page.locator(".cp-modal-scrim");
  await expect(scrim).toBeAttached({ timeout: 10_000 });

  // Canary: the dialog itself must have rendered, or "the scrim is wrong" is
  // being measured on something that never opened.
  await expect(page.locator(".cp-txsearch")).toBeAttached();

  const geom = await scrim.evaluate((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      position: cs.position,
      zIndex: cs.zIndex,
      display: cs.display,
      width: Math.round(r.width),
      height: Math.round(r.height),
      top: Math.round(r.top),
    };
  });

  expect(geom.position, `scrim position is "${geom.position}" - it is not a layer`).toBe("fixed");
  expect(geom.width, "scrim does not span the viewport width").toBeGreaterThanOrEqual(VIEWPORT.width);
  expect(geom.height, "scrim does not span the viewport height").toBeGreaterThanOrEqual(VIEWPORT.height);
  expect(geom.top, "scrim does not start at the top of the viewport").toBeLessThanOrEqual(0);

  // The dialog has to be ON SCREEN, which is the part a user notices.
  const box = await page.locator(".cp-txsearch").boundingBox();
  expect(box, "the dialog has no box at all").not.toBeNull();
  expect(box!.y, `dialog renders at y=${box!.y}, below the ${VIEWPORT.height}px fold`)
    .toBeLessThan(VIEWPORT.height);
  expect(box!.y + box!.height, "dialog starts on screen but runs off the bottom")
    .toBeGreaterThan(0);
});
