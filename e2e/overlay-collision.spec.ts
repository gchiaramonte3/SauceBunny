import { test, expect } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * The canvas toast and the prep banner must never overlap.
 *
 * Reported as notifications stacking: a "Downloading preview…" toast printed
 * across the top-right corner of a "Downloading preview…" prep banner that
 * said the same thing. Two faults, and this covers the second.
 *
 * The duplicate copy is gone (the banner carries progress and a Cancel
 * button, so it is the one surface that event gets). The geometry is fixed
 * separately, because ANY toast — an export finishing, a failed drop — can
 * land while a transcode runs. The lift used to be a flat 72px guessing the
 * banner's height; it now reads --prep-h, which Monitor measures.
 *
 * This drives the CSS relationship directly rather than the app state: there
 * is no harness route to a live playbackPrepBusy, and the rule under test is
 * a stylesheet one. Both elements are built from the real classes inside a
 * real .cp-monitor so the shipped rules are what decide the boxes.
 */
test("a toast lifted above the prep banner does not touch it", async ({ page }) => {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.permissioned", "1");
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });

  const boxes = await page.evaluate(() => {
    const stage = document.createElement("div");
    stage.className = "cp-monitor";
    // A realistic player box; the banner is bottom-left, the toast centered.
    Object.assign(stage.style, { position: "relative", width: "900px", height: "506px" });

    // The banner, with a subtitle long enough to WRAP — which is what made
    // the old constant too small in the first place.
    const banner = document.createElement("div");
    banner.className = "cp-prep-banner";
    banner.innerHTML =
      '<div style="width:44px;height:44px"></div>' +
      '<div class="cp-prep-text"><div class="cp-prep-title">Downloading preview…</div>' +
      '<div class="cp-prep-sub">CDN blocked in-app streaming. Fetching via yt-dlp so you can scrub.</div></div>' +
      '<button class="cp-prep-cancel">Cancel</button>';

    const toast = document.createElement("div");
    toast.className = "cp-canvas-toast cp-canvas-toast--above-banner";
    toast.innerHTML =
      '<span class="icon"></span><div><div>Export finished</div>' +
      '<div>Your clip is in the output folder.</div></div>';

    stage.append(banner, toast);
    document.body.append(stage);

    // Publish the measured height exactly as Monitor does.
    stage.style.setProperty("--prep-h", `${banner.offsetHeight}px`);

    const b = banner.getBoundingClientRect();
    const t = toast.getBoundingClientRect();
    const out = {
      bannerTop: b.top, bannerHeight: b.height,
      toastBottom: t.bottom,
      // Do the two rectangles intersect at all?
      overlapY: Math.min(b.bottom, t.bottom) - Math.max(b.top, t.top),
      overlapX: Math.min(b.right, t.right) - Math.max(b.left, t.left),
    };
    stage.remove();
    return out;
  });

  // Canary: if the banner never laid out, everything below passes vacuously.
  expect(boxes.bannerHeight, "the banner did not render").toBeGreaterThan(40);
  // They share a horizontal band (the toast is centered, the banner is wide),
  // so the vertical separation is the only thing keeping them apart.
  expect(boxes.overlapX, "the two never share an x band; the test proves nothing").toBeGreaterThan(0);
  expect(
    boxes.toastBottom,
    `toast bottom ${boxes.toastBottom} is below the banner top ${boxes.bannerTop}`,
  ).toBeLessThanOrEqual(boxes.bannerTop);
  expect(boxes.overlapY, "the toast and the prep banner overlap").toBeLessThanOrEqual(0);
});
