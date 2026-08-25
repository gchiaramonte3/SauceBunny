import { test, expect } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * The session header's two clusters must not collide.
 *
 * A live session is not reachable from the mocked harness, so this mounts
 * the header's REAL markup into the running app - which means the app's real
 * compiled stylesheet - and measures the boxes. The bug it pins: the source
 * bar's field carried `min-width: 200px`, so the bar could not shrink below
 * its contents, while the bar itself was shrinkable. Squeezed, its buttons
 * overflowed their own box and ran straight into "Copy join code", which
 * rendered as "CLEARCOPY JOIN CODE".
 */
const HEAD = `
<div class="cp-room-head" style="width:720px">
  <div class="cp-room-title"><span>A session name that is quite long</span></div>
  <div class="cp-room-source-bar">
    <div class="cp-room-source-field"><input placeholder="Paste a link to watch together"></div>
    <button class="btn btn-ghost btn-compact" id="t-file">File</button>
    <button class="btn btn-ghost btn-compact" id="t-clear">Clear</button>
  </div>
  <div class="cp-room-head-actions">
    <button class="btn btn-ghost btn-compact cp-room-code" id="t-code">Copy join code</button>
    <button class="btn cp-room-end" id="t-end">End session</button>
  </div>
</div>`;

test("Clear and Copy join code never touch, even when the header is tight", async ({ page }) => {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });

  await page.evaluate((html) => {
    const host = document.createElement("div");
    host.id = "head-probe";
    host.style.cssText = "position:fixed;left:0;top:0;z-index:99999";
    host.innerHTML = html;
    document.body.appendChild(host);
  }, HEAD);

  for (const width of [980, 820, 720, 640]) {
    await page.evaluate((w) => {
      const el = document.querySelector("#head-probe .cp-room-head") as HTMLElement;
      el.style.width = `${w}px`;
    }, width);

    const clear = (await page.locator("#t-clear").boundingBox())!;
    const code = (await page.locator("#t-code").boundingBox())!;
    const gap = code.x - (clear.x + clear.width);
    expect(gap, `Clear and Copy join code collide at ${width}px (gap ${gap}px)`)
      .toBeGreaterThanOrEqual(4);

    // Nothing may spill out of the header either.
    const head = (await page.locator("#head-probe .cp-room-head").boundingBox())!;
    const end = (await page.locator("#t-end").boundingBox())!;
    expect(end.x + end.width, `the actions overflow the header at ${width}px`)
      .toBeLessThanOrEqual(head.x + head.width + 1);
  }
});
