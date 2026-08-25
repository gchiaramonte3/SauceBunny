import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * The session header's two clusters must not collide.
 *
 * This drives the REAL room header, because the synthetic one lied. The first
 * version of this test mounted a hand-written copy of the markup whose title
 * cluster was a single short span, and measured down to 640px. The real title
 * cluster carries a live dot, the session name, the source name, a review
 * status chip, a blocked-members note and a transfer row - so the real header
 * runs out of room while the fixture still had inches to spare, and the guard
 * passed while "Clear" was being painted underneath "Copy join code" at the
 * app's own declared minimum width.
 *
 * The bug underneath: `.cp-room-source-bar` carried `min-width: 0`, which
 * switches OFF flexbox's automatic minimum size. The bar's box then shrank
 * below its own non-shrinking buttons, which spilled out to the right onto the
 * header actions - and those paint on top, being later in the DOM. Clicking
 * Clear copied the join code.
 */

/** The app's own declared floor, from src-tauri/tauri.conf.json. */
const MIN_W = 1100;
const MIN_H = 700;

async function bootRoom(page: Page, title: string): Promise<void> {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.review.author", JSON.stringify("Nika"));
    localStorage.setItem("e2e.avGranted", "1");
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+3");
  // A source, so the presenter's source bar renders with something in it.
  await page.locator("input[placeholder^='Paste a video URL']").fill("https://youtube.com/watch?v=aaaa");
  await page.getByRole("button", { name: /^Fetch/ }).click();
  await expect(page.locator(".cp-timeline-hint")).toContainText("No marks set", { timeout: 10_000 });

  await page.getByRole("button", { name: "Review" }).click();
  await page.evaluate((t) => {
    (window as unknown as {
      __TAURI_MOCK__: { emitTauriEvent: (e: string, p: unknown) => void };
    }).__TAURI_MOCK__.emitTauriEvent("session:state", {
      role: "host",
      code: "e2e-ticket",
      peers: [{ id: "m1", name: "Ada" }],
      selfId: "m0",
      error: null,
      title: t,
    });
  }, title);
  await expect(page.locator(".cp-room-head")).toBeVisible();
}

const clearBtn = (page: Page) => page.locator(".cp-room-source-bar").getByRole("button", { name: "Clear" });
const codeBtn = (page: Page) => page.getByRole("button", { name: "Copy join code" });

/** What the user's pointer would actually hit at the centre of `sel`. */
const topmostAt = (page: Page, sel: string) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (!el) return "MISSING";
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return hit?.closest("button")?.textContent?.trim() ?? hit?.tagName ?? "none";
}, sel);

test("Clear is the thing you hit when you click Clear, at the minimum window size", async ({ page }) => {
  await page.setViewportSize({ width: MIN_W, height: MIN_H });
  await bootRoom(page, "Friday grade pass");

  await expect(clearBtn(page)).toBeVisible();
  await expect(codeBtn(page)).toBeVisible();
  expect(await topmostAt(page, ".cp-room-source-bar .btn:last-child"))
    .toBe("Clear");
});

test("the source bar's buttons never overlap the header actions, at any width", async ({ page }) => {
  await bootRoom(page, "Q3 sizzle, round two");

  for (const width of [MIN_W, 1200, 1280, 1440, 1600]) {
    await page.setViewportSize({ width, height: MIN_H });
    const clear = (await clearBtn(page).boundingBox())!;
    const code = (await codeBtn(page).boundingBox())!;
    const gap = code.x - (clear.x + clear.width);
    expect(gap, `Clear and Copy join code collide at ${width}px (gap ${gap}px)`)
      .toBeGreaterThanOrEqual(4);
  }
});

test("a long session name squeezes the field, never the buttons", async ({ page }) => {
  // The title cluster is where the pressure comes from, so this is the
  // realistic worst case rather than a shrunken window with a short name.
  await page.setViewportSize({ width: MIN_W, height: MIN_H });
  await bootRoom(page, "Q3 sizzle, round two, grade pass with the client in the room");

  const clear = (await clearBtn(page).boundingBox())!;
  const code = (await codeBtn(page).boundingBox())!;
  expect(code.x - (clear.x + clear.width),
    "a long session name pushed Clear into Copy join code").toBeGreaterThanOrEqual(4);

  // And nothing spilled out of the header.
  const head = (await page.locator(".cp-room-head").boundingBox())!;
  const end = (await page.getByRole("button", { name: /End session/ }).boundingBox())!;
  expect(end.x + end.width).toBeLessThanOrEqual(head.x + head.width + 1);
});
