import { expect, test } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

test.use({ browserName: process.env.SCENE_BROWSER === "webkit" ? "webkit" : "chromium" });

test("detached cut confirmations reach the current timeline hint without leaking across sources", async ({ page }) => {
  await page.route("https://**", route => route.abort());
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1"); localStorage.setItem("saucebunny.permissioned", "1");
  });
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto("/"); await expect(page.locator(".cp-view-home")).toBeVisible();
  await page.keyboard.press("Meta+3");
  await page.locator("input[placeholder^='Paste a video URL']").fill("https://youtube.com/watch?v=aaaa");
  await page.getByRole("button", { name: /^Fetch/ }).click();
  const hint = page.locator(".cp-timeline-hint"), status = hint.getByRole("status");
  await expect(hint).toContainText("No marks set");
  const before = await hint.boundingBox();
  const sourceKey = await page.evaluate(() => {
    (window as unknown as { __TAURI_MOCK__: { emitTauriEvent: (name: string, payload: unknown) => void } })
      .__TAURI_MOCK__.emitTauriEvent("panel:request-state", null);
    return JSON.parse(localStorage.getItem("saucebunny.panelSnapshot")!).sourceIdentity as string;
  });
  expect(sourceKey).toBeTruthy();
  await page.evaluate(sourceKey => {
    localStorage.setItem(`saucebunny.cutMarkers.${sourceKey.normalize("NFC")}`, JSON.stringify([{ time: 1.5 }]));
    (window as unknown as { __TAURI_MOCK__: { emitTauriEvent: (name: string, payload: unknown) => void } })
      .__TAURI_MOCK__.emitTauriEvent("panel:action:cutMarkersChanged", { sourceKey, addedCount: 1 });
  }, sourceKey);
  await expect(status).toHaveText("Added 1 cut marker");
  await expect(page.locator(".cp-track-cut")).toHaveCount(1);
  expect(await hint.boundingBox()).toEqual(before);
  await expect(page.locator(".cp-timeline-confirmation")).toHaveCount(0, { timeout: 5000 });
  await expect(hint.locator(".cp-timeline-hint-default")).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __TAURI_MOCK__: { emitTauriEvent: (name: string, payload: unknown) => void } })
      .__TAURI_MOCK__.emitTauriEvent("panel:action:cutMarkersChanged", { sourceKey: "previous-source", addedCount: 99 });
  });
  await expect(status).toBeEmpty();
  await expect(page.locator(".cp-track-cut")).toHaveCount(1);
  await page.evaluate(sourceKey => {
    (window as unknown as { __TAURI_MOCK__: { emitTauriEvent: (name: string, payload: unknown) => void } })
      .__TAURI_MOCK__.emitTauriEvent("panel:action:cutMarkersChanged", { sourceKey, addedCount: 0 });
  }, sourceKey);
  await expect(status).toHaveText("Cut markers already added");
  await page.locator(".cp-toolbar").getByRole("button", { name: "Clear", exact: true }).click();
  await expect(page.locator(".cp-timeline-confirmation")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("cut adoption is separate from chapters, precise and keyboard accessible", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width: 360, height: 700 });
  await page.route("**/shot-cuts-test", route => route.fulfill({ contentType: "text/html", body:
    '<!doctype html><html><body><div id="root"></div><script type="module" src="/e2e/fixtures/shot-cuts.tsx"></script></body></html>' }));
  await page.goto("/shot-cuts-test");
  const action = page.getByRole("button", { name: "Add cut markers" });
  await expect(action).toBeVisible();
  await expect(page.locator(".cp-track-chapter")).toHaveCount(1);
  await expect(page.locator(".cp-track-cut")).toHaveCount(0);
  const countBox = (await page.locator(".cp-shot-count").boundingBox())!;
  const actionBox = (await action.boundingBox())!;
  const timelineBefore = await page.locator(".cp-timeline-hint").boundingBox();
  expect(Math.abs(countBox.y + countBox.height / 2 - actionBox.y - actionBox.height / 2)).toBeLessThan(1);
  await action.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status")).toContainText("Added 1 cut marker");
  await expect(page.locator(".cp-track-chapter")).toHaveCount(1);
  const cut = page.getByRole("button", { name: "Cut at 00:00:01:11" });
  await expect(cut).toBeVisible();
  await page.keyboard.press("Space");
  await expect(page.locator(".cp-timeline-hint").getByRole("status")).toContainText("Cut markers already added");
  await expect(page.locator(".cp-shot-analysis").getByRole("status")).toHaveCount(0);
  expect(await page.locator(".cp-timeline-hint").boundingBox()).toEqual(timelineBefore);
  expect(await page.locator("html").getAttribute("data-notifications")).toBe("2");
  await page.screenshot({ path: `/private/tmp/sauce-cut-confirmation-${process.env.SCENE_BROWSER ?? "chromium"}.png` });
  const saved = await page.evaluate(() => ({
    chapters: JSON.parse(localStorage.getItem("saucebunny.chapters.fixture-source")!),
    cuts: JSON.parse(localStorage.getItem("saucebunny.cutMarkers.fixture-source")!),
  }));
  expect(saved.chapters).toEqual([{ time: 1.500002, title: "Creator chapter", origin: "creator" }]);
  expect(saved.cuts).toEqual([{ time: 1.500002 }]);
  await expect(page.locator(".cp-timeline-confirmation")).toHaveCSS("animation-name", "cp-timeline-confirmation");
  await expect(page.locator(".cp-timeline-confirmation")).toHaveCount(0, { timeout: 5000 });
  await expect(page.getByText("No marks set. Export grabs the whole clip.")).toBeVisible();
  expect(await page.locator(".cp-timeline-hint").boundingBox()).toEqual(timelineBefore);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await action.click();
  await expect(page.locator(".cp-timeline-confirmation")).toHaveCSS("animation-name", "none");
  await expect(page.locator(".cp-timeline-confirmation")).toHaveCount(0, { timeout: 5000 });

  // Same-time chapter remains top-anchored; the cut's visible hash rises from
  // the bottom. Mouse and keyboard use exact seconds, never rounded frames.
  const geometry = await cut.evaluate(element => {
    const tick = getComputedStyle(element, "::after");
    const chapter = getComputedStyle(document.querySelector(".cp-track-chapter")!);
    return { bottom: getComputedStyle(element).bottom, tickBottom: tick.bottom,
      tickHeight: tick.height, chapterTop: chapter.top };
  });
  expect(geometry).toEqual({ bottom: "0px", tickBottom: "0px", tickHeight: "9px", chapterTop: "0px" });
  const box = (await cut.boundingBox())!;
  await cut.click({ position: { x: box.width / 2, y: box.height - 3 } });
  await expect(page.locator("html")).toHaveAttribute("data-cut-seek", "1.500002");
  expect(await page.locator("html").getAttribute("data-frame-seek")).toBeNull();
  await cut.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-cut-seek", "1.500002");
  await page.reload();
  await expect(cut).toBeVisible();
  await expect(page.getByRole("status")).toBeEmpty();
  await page.evaluate(() => document.documentElement.style.setProperty("--text-base", "14px"));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `/private/tmp/sauce-cut-markers-${process.env.SCENE_BROWSER ?? "chromium"}.png` });
  expect(errors).toEqual([]);
});
