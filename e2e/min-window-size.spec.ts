import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * The app promises a minimum window size and nothing checked it.
 *
 * `tauri.conf.json` sets minWidth/minHeight, so a user CAN drag the window to
 * exactly that and the layout has to hold there. The size is read from the
 * config rather than typed here: lowering the minimum without looking at the
 * layout should make this test start failing, not start lying.
 *
 * Two traps are designed out, both of which produced a false bug report before
 * this file existed:
 *
 * 1. The queue drawer is OPEN by default. A probe that "opens" it with a click
 *    closes it instead, then measures a slide-out panel parked off-canvas and
 *    reports 82px of clipping that no user could ever see.
 * 2. A closed panel legitimately sits outside the viewport. The filter is
 *    `[inert]` - collapsed panels carry it (that is its own contract), focus
 *    does not land in them, and content the user cannot reach cannot be
 *    clipped. Filtering on inert rather than on geometry is what makes the
 *    difference between the two cases legible.
 */

const conf = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src-tauri/tauri.conf.json", import.meta.url)), "utf8"),
) as { app: { windows: Array<{ minWidth?: number; minHeight?: number }> } };

const win = conf.app.windows.find((w) => w.minWidth && w.minHeight);
const MIN = { width: win?.minWidth ?? 0, height: win?.minHeight ?? 0 };

test.use({ viewport: MIN });

const VIEWS: Array<[string, string]> = [
  ["Library", ".cp-view-library"],
  ["Clip", ".cp-view-clip"],
  ["Review", ".cp-view-coreview"],
  ["Transcripts", ".cp-view-reader"],
  ["Home", ".cp-view-home"],
];

/**
 * Reachable elements that extend past the viewport's RIGHT edge.
 *
 * Horizontal only, deliberately. Content below the fold is what a scrolling
 * pane is for - Settings is 2400px tall by design - so flagging `bottom >
 * innerHeight` reports every scrollable list in the app as broken. Sideways is
 * the direction that actually indicates a layout which did not fit.
 */
async function clipped(page: Page) {
  return page.evaluate(() => {
    const out: string[] = [];
    let checked = 0;
    for (const el of document.querySelectorAll<HTMLElement>("*")) {
      if (!el.checkVisibility()) continue;
      if (el.closest("[inert]")) continue; // a closed panel, parked off-canvas
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      checked++;
      if (r.right > window.innerWidth + 1) {
        out.push(`<${el.tagName.toLowerCase()} class="${(el.getAttribute("class") ?? "").slice(0, 40)}"> `
          + `right=${Math.round(r.right)}`);
      }
    }
    return { out: [...new Set(out)], checked };
  });
}

async function boot(page: Page) {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
}

test("the declared minimum size is a real size", () => {
  // If this ever reads 0, the config shape moved and every test below has been
  // measuring a default viewport while claiming to measure the minimum.
  expect(MIN.width).toBeGreaterThan(400);
  expect(MIN.height).toBeGreaterThan(300);
});

test("nothing is clipped at the minimum window size", async ({ page }) => {
  await boot(page);
  const found: string[] = [];
  for (const [label, root] of VIEWS) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(page.locator(root)).toBeVisible();
    const { out, checked } = await clipped(page);
    expect(checked, `${label}: nothing was measured`).toBeGreaterThan(20);
    found.push(...out.map((o) => `[${label}] ${o}`));
    // A layout that fits by growing a scrollbar has not fitted.
    const scrollsX = await page.evaluate(() =>
      document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(scrollsX, `${label}: the page scrolls horizontally`).toBe(false);
  }
  expect(found, `clipped at ${MIN.width}x${MIN.height}:\n${found.join("\n")}`).toEqual([]);
});

test("the settings dialog fits at the minimum size, on every tab", async ({ page }) => {
  // The widest thing the app opens, and the one most likely to outgrow a small
  // window as tabs get added.
  await boot(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();

  const found: string[] = [];
  for (const tab of ["General", "Captions", "Camera & Mic", "Web sources",
    "Transcription", "AI Summary", "AI APIs", "Shortcuts", "About"]) {
    await page.getByRole("button", { name: tab, exact: true }).click();
    const { out } = await clipped(page);
    found.push(...out.map((o) => `[${tab}] ${o}`));
  }
  expect(found, `clipped at ${MIN.width}x${MIN.height}:\n${found.join("\n")}`).toEqual([]);
});

test("closing the queue drawer parks it out of reach, not into the layout", async ({ page }) => {
  // Pins the arrangement the filter above depends on: a closed drawer is inert
  // AND off-canvas. If it ever stopped being inert, its off-canvas tabs would
  // become reachable tab stops pointing at nothing, and the test above would
  // start reporting them - correctly.
  await boot(page);
  await page.getByRole("button", { name: "Clip", exact: true }).click();
  await expect(page.locator(".cp-view-clip")).toBeVisible();

  const toggle = page.locator(".cp-queue-toggle").first();
  await expect(toggle).toHaveClass(/active/); // open by default
  await toggle.click();
  await expect(toggle).not.toHaveClass(/active/);

  const state = await page.evaluate(() => {
    // The drawer's OWN tab, not whichever .cp-tab happens to be first in the
    // document - that was the bug in the first draft of this assertion.
    const tab = document.querySelector<HTMLElement>(".cp-queue-drawer .cp-tab");
    tab?.focus();
    return {
      found: !!tab,
      inert: !!tab?.closest("[inert]"),
      focusLanded: document.activeElement === tab,
    };
  });
  expect(state.found, "no tab found inside the queue drawer").toBe(true);
  expect(state.inert, "a closed drawer must be inert").toBe(true);
  expect(state.focusLanded, "focus must not land inside a closed drawer").toBe(false);
});
