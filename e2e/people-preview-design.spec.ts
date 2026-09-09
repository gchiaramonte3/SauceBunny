import { test, expect, type Locator, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

// Mount the real App. Only native session/device input is mocked; no copied
// participant markup or catalog CSS can make these geometry checks pass.
async function bootPeople(page: Page) {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.permissioned", "1");
    localStorage.setItem("saucebunny.review.author", JSON.stringify("Editor"));
    localStorage.setItem("saucebunny.mediaDevices", JSON.stringify({ cameraOff: true, micMuted: true }));
    localStorage.setItem("e2e.avGranted", "1");
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible();
  await page.locator(".cp-nav-item").filter({ hasText: "Review" }).click();
  await page.evaluate(() => {
    const mock = (window as unknown as { __TAURI_MOCK__: { emitTauriEvent: (name: string, payload: unknown) => void } }).__TAURI_MOCK__;
    mock.emitTauriEvent("session:state", {
      role: "host", code: "design-fixture", selfId: "m0", presenter: "m1", presenterEpoch: 1,
      peers: [{ id: "m1", name: "Alexandra Morgan with a very long reviewer name", epoch: 1 }],
      title: "Design verification", error: null,
    });
  });
  await expect(page.locator('.cp-people:not(.strip) [data-member-id="m1"]')).toBeVisible();
  await page.evaluate(() => {
    const mock = (window as unknown as { __TAURI_MOCK__: { emitTauriEvent: (name: string, payload: unknown) => void } }).__TAURI_MOCK__;
    mock.emitTauriEvent("session:msg", { kind: "sharing", from: "m1", on: true });
    mock.emitTauriEvent("session:msg", { kind: "recording", from: "m1", what: "camera", on: true });
    mock.emitTauriEvent("session:msg", { kind: "reaction", from: "m1", emote: "hand", on: true });
  });
  await expect(page.locator(".cp-people:not(.strip)")).toBeVisible();
}

async function expectHitArea(control: Locator) {
  const box = (await control.boundingBox())!;
  expect(box.width).toBeGreaterThanOrEqual(24);
  expect(box.height).toBeGreaterThanOrEqual(24);
  expect(await control.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  })).toBe(true);
}

for (const width of [1100, 1680]) for (const enlarged of [false, true]) {
  test(`People production geometry and theater parity ${width}px ${enlarged ? "125%" : "100%"}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 1100 ? 700 : 1020 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await bootPeople(page);
    if (enlarged) await page.evaluate(() => {
      const tokens = ["--text-xs", "--text-sm", "--text-base", "--text-md", "--text-lg", "--text-xl"];
      const computed = getComputedStyle(document.documentElement);
      const values = tokens.map((name) => [name, `${parseFloat(computed.getPropertyValue(name)) * 1.25}px`]);
      for (const [name, value] of values) document.documentElement.style.setProperty(name, value);
    });
    const monitor = page.locator(".cp-view-clip .cp-monitor");
    await monitor.evaluate((el) => el.setAttribute("data-design-identity", "retained"));
    const rail = page.locator(".cp-people:not(.strip)");
    if (width > 1100) {
      expect((await rail.boundingBox())!.width).toBe(240);
      await page.screenshot({ path: info.outputPath("people-expanded.png") });
      await rail.getByRole("button", { name: "Collapse the people panel to avatars" }).click();
    }
    expect((await rail.boundingBox())!.width).toBe(72);
    const peer = rail.locator('[data-member-id="m1"]');
    const picture = peer.locator(".cp-person-picture");
    expect((await picture.boundingBox())!.width).toBe(48);
    expect((await picture.boundingBox())!.height).toBe(48);
    const railBox = (await rail.boundingBox())!;
    const indicators = peer.locator(".cp-person-signal,.cp-person-presenter-pin");
    const boxes = [];
    for (const indicator of await indicators.all()) {
      if (!await indicator.isVisible()) continue;
      const box = (await indicator.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(railBox.x);
      expect(box.x + box.width).toBeLessThanOrEqual(railBox.x + railBox.width);
      for (const prior of boxes) {
        const overlap = Math.min(box.x + box.width, prior.x + prior.width) - Math.max(box.x, prior.x) > .5
          && Math.min(box.y + box.height, prior.y + prior.height) - Math.max(box.y, prior.y) > .5;
        expect(overlap, "participant indicators overlap").toBe(false);
      }
      boxes.push(box);
    }
    // Bright-picture visual stress fixture, not a claim of a live camera test.
    await peer.locator(".cp-person-avatar").evaluate(el => { el.style.background = "white"; });
    for (const button of await rail.locator(".cp-person-controls button").all()) await expect(button).toBeHidden();
    for (const icon of await rail.locator(".cp-person-muted,.cp-person-camera").all()) await expect(icon).toBeHidden();
    const details = peer.locator(".cp-person-trigger");
    await details.focus();
    await page.keyboard.press("Enter");
    const menu = page.getByRole("menu", { name: /Alexandra.*participant details/i });
    await expect(menu).toBeVisible();
    await expect(menu).toContainText("Presenting");
    await expect(menu).toContainText("Sharing");
    await expect(menu).toContainText("Recording");
    await expect(menu).toContainText("Hand raised");
    const bounds = (await menu.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    await page.screenshot({ path: info.outputPath("people-compact-details.png") });
    await page.keyboard.press("Escape");
    await expect(details).toBeFocused();
    await expect(menu).toHaveCount(0);
    await page.keyboard.press("Space");
    await expect(menu).toBeVisible();
    await expect(menu.getByRole("menuitem", { name: /Hide their video/ })).toBeFocused();
    await page.keyboard.press("Space");
    await expect(menu).toHaveCount(0);
    await expect(details).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(menu.getByRole("menuitem", { name: /Show their video/ })).toBeVisible();
    await page.keyboard.press("Escape");
    await details.click();
    await expect(menu).toBeVisible();
    await details.click();
    await expect(menu).toHaveCount(0);
    await page.getByRole("button", { name: "Theater: widen the stage" }).click();
    const strip = page.locator(".cp-people.strip");
    await expect(strip).toBeVisible();
    const theaterPeer = strip.locator('[data-member-id="m1"]');
    await expect(theaterPeer.locator(".cp-person-presenting")).toBeVisible();
    const theaterPicture = (await theaterPeer.locator(".cp-person-picture").boundingBox())!;
    expect(theaterPicture.width).toBe(168);
    expect(theaterPicture.width / theaterPicture.height).toBeCloseTo(16 / 9, 1);
    const self = strip.locator('[data-member-id="m0"]');
    await expect(self.getByRole("button", { name: "Turn camera on", exact: true })).toBeVisible();
    const mic = self.getByRole("button", { name: "Unmute", exact: true });
    await expectHitArea(mic);
    await mic.click();
    await expect(self.getByRole("button", { name: "Mute", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(monitor).toHaveAttribute("data-design-identity", "retained");
    await page.screenshot({ path: info.outputPath("people-theater.png") });
  });
}
