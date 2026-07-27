import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * The Library's keyboard, end to end.
 *
 * Two things make this worth an e2e rather than a unit test. The roving
 * tabindex is measured off real layout (offsetTop decides how many cards are
 * on a row), and the whole feature only works because the global transport
 * dispatcher was taught to leave these keys alone — arrows were bound to
 * frame-step and Home/End to seek, so before that gate they never reached the
 * Library at all. Both halves are only observable in a booted app.
 */
async function bootLibrary(page: Page): Promise<void> {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.libraryRoots", JSON.stringify(["/e2e-mock/Footage"]));
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Control+2");
  await expect(page.locator(".cp-view-library")).toBeVisible();
  await page.locator(".cp-lib-statusbar").first().waitFor({ timeout: 10_000 });
}

/** Name of the card/row that currently has focus. */
const focusedName = (p: Page) => p.evaluate(() => {
  const el = document.activeElement as HTMLElement | null;
  const item = el?.closest(".cp-lib-card,.cp-lib-lrow");
  return item?.querySelector(".cp-lib-card-title,.cp-lib-lrow-name")?.textContent?.trim() ?? "none";
});

test("the whole wall is one tab stop", async ({ page }) => {
  // The point of a roving tabindex. Before it, Tab walked every card one at a
  // time — hundreds of stops to get past a folder.
  await bootLibrary(page);
  const tabindexes = await page.evaluate(() =>
    [...document.querySelectorAll(".cp-view-library .cp-lib-card")]
      .map((c) => c.getAttribute("tabindex")));
  expect(tabindexes.length).toBeGreaterThan(1);
  expect(tabindexes.filter((t) => t === "0")).toHaveLength(1);
  expect(tabindexes.filter((t) => t === "-1")).toHaveLength(tabindexes.length - 1);
});

test("arrows, Home and End walk the grid", async ({ page }) => {
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await bootLibrary(page);

  await page.locator(".cp-view-library .cp-lib-card").first().focus();
  const first = await focusedName(page);
  expect(first).not.toBe("none");

  await page.keyboard.press("ArrowRight");
  const second = await focusedName(page);
  expect(second).not.toBe(first);

  await page.keyboard.press("End");
  const last = await focusedName(page);
  await page.keyboard.press("Home");
  expect(await focusedName(page)).toBe(first);
  expect(last).not.toBe(first);

  // Left at the first item clamps rather than wrapping or throwing.
  await page.keyboard.press("ArrowLeft");
  expect(await focusedName(page)).toBe(first);

  expect(errs).toEqual([]);
});

test("type-ahead jumps to a name", async ({ page }) => {
  // Finder's oldest trick, and the fastest way to reach a known clip in a
  // folder of two hundred.
  await bootLibrary(page);
  await page.locator(".cp-view-library .cp-lib-card").first().focus();
  await page.keyboard.press("v"); // voice-memo.m4a
  expect(await focusedName(page)).toMatch(/^voice/i);
});

test("transport keys do not reach the Clip player from the Library", async ({ page }) => {
  // The bug this whole batch started from: the Clip view stays mounted behind
  // the Library, so Space played a video nobody could see and i/o moved the
  // export marks on a different file than the one under the cursor.
  //
  // Asserted via defaultPrevented rather than via any visible effect, and that
  // choice is the test. The first version of this pressed Space/i/o/digits and
  // checked that nothing happened — which passed with the gate DELETED,
  // because the mock has no source loaded so those actions had nothing to move
  // either way. It proved nothing.
  //
  // `[` is the probe: bound to play.rateDown, so with the gate gone runAction
  // claims it and calls preventDefault. The Library's own type-ahead sees no
  // match for "[" among the fixture names and deliberately does not
  // preventDefault, so the flag has exactly one possible author.
  await bootLibrary(page);
  await page.locator(".cp-view-library .cp-lib-card").first().focus();

  const claimed = await page.evaluate(async () => {
    let prevented: boolean | null = null;
    const probe = (e: KeyboardEvent) => { prevented = e.defaultPrevented; };
    // Bubble phase on window: runs after React's root handler and after the
    // app's own window listener, so it sees their verdict.
    window.addEventListener("keydown", probe);
    document.activeElement?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "[", bubbles: true, cancelable: true }),
    );
    window.removeEventListener("keydown", probe);
    return prevented;
  });
  expect(claimed).toBe(false);
});
