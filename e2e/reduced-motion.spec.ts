import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * No keyframe animation may run when the user has asked for reduced motion.
 *
 * The app already satisfies this - 58 animation declarations across 21
 * stylesheets, every one of them guarded. That is the point of writing it down:
 * the policy is currently perfect and nothing was checking it, so the next
 * `animation:` added without a guard would be the first anyone heard of it, and
 * only from a user who feels ill.
 *
 * TRANSITIONS are deliberately not asserted here. 33 rules across 10 files move
 * something on :hover/:active (mostly a 1px lift), and they still transition
 * under reduce. Suppressing them one by one, or tokenising the lift so a single
 * rule can switch it off, is a design decision rather than a bug fix - recorded
 * in docs/HAND-TEST.md rather than quietly changed here.
 */

async function boot(page: Page) {
  // page.emulateMedia, NOT test.use({reducedMotion}). The fixture form silently
  // did nothing in this project's config: matchMedia kept reporting false while
  // the test read as if it were measuring a reduced-motion browser. Two wrong
  // conclusions came out of that before the canary below was added.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
}

/** Elements currently running a keyframe animation, by class. */
async function animating(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("*")) {
      if (el.offsetParent === null && el.tagName !== "BODY") continue;
      const cs = getComputedStyle(el);
      if ((parseFloat(cs.animationDuration) || 0) > 0.001) {
        out.push(`${cs.animationName} ${cs.animationDuration} .${el.getAttribute("class")}`);
      }
    }
    return out;
  });
}

test("the reduced-motion emulation is actually on", async ({ page }) => {
  // Without this the suite below passes by measuring a normal browser and
  // finding the animations it was always going to find - which is exactly what
  // happened. This test is the reason the others mean anything.
  await boot(page);
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
});

test("no keyframe animation runs in any view under reduced motion", async ({ page }) => {
  await boot(page);
  const VIEWS: Array<[string, string]> = [
    ["Library", ".cp-view-library"],
    ["Clip", ".cp-view-clip"],
    ["Review", ".cp-view-coreview"],
    ["Transcripts", ".cp-view-reader"],
    ["Home", ".cp-view-home"],
  ];
  const found: string[] = [];
  let visited = 0;
  for (const [label, root] of VIEWS) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(page.locator(root)).toBeVisible();
    visited++;
    found.push(...(await animating(page)).map((a) => `${label}: ${a}`));
  }
  expect(visited, "no view was visited").toBe(VIEWS.length);
  expect(found, `still animating:\n${found.join("\n")}`).toEqual([]);
});

test("the settings modal does not animate in under reduced motion", async ({ page }) => {
  // The entrance keyframe is the one a user meets before they can turn anything
  // off, so it is the one worth naming separately.
  await boot(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const found = await animating(page);
  expect(found, `still animating:\n${found.join("\n")}`).toEqual([]);
});
