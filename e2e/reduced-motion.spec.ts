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
 * TRANSITIONS are now covered too, and the WAY they are suppressed is the part
 * worth pinning. 41 base rules across 15 files transition `transform` or `all`.
 * The obvious fix - `transform: none` under reduce - would have broken the app:
 * several of those transforms do real work rather than decoration. A
 * translateX(-50%) on `.cp-ai-chip::after`, `.cp-playhead::before` and the
 * follow pill is CENTRING, so neutralising it shifts them half their own width
 * off target; and `.cp-thumb-actions` translateY(0) is what REVEALS the
 * sidebar's hover buttons, so neutralising it hides controls permanently.
 *
 * What ships instead is `transition-duration: 0s` - the interpolation goes, the
 * destination does not. "Resting geometry is identical" below is the test that
 * keeps it that way: it compares every visible element's computed transform
 * with reduce on and off, so anyone who later reaches for `transform: none`
 * inside one of these blocks hears about it here rather than from a user whose
 * buttons vanished.
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
      if (!el.checkVisibility()) continue;
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

/**
 * Every visible element's resting `transform`, keyed by a stable-ish label.
 *
 * Pseudo-elements are included on purpose, and are most of the point: the
 * centring translateX(-50%) this test exists to protect lives on
 * `.cp-playhead::before`, `.cp-ai-chip::after` and the segmented control's
 * sliding `::before`. `getComputedStyle(el)` alone reports NONE of them, so a
 * first version of this probe found zero transforms on the whole page and would
 * have compared two empty objects for ever.
 */
async function restingTransforms(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    document.querySelectorAll<HTMLElement>("*").forEach((el, i) => {
      if (!el.checkVisibility()) return;
      const key = `${i}:${el.tagName}.${el.getAttribute("class") ?? ""}`;
      for (const pseudo of [null, "::before", "::after"]) {
        const t = getComputedStyle(el, pseudo).transform;
        if (t && t !== "none") out[key + (pseudo ?? "")] = t;
      }
    });
    return out;
  });
}

/** Walk every view so the transformed elements actually exist to be measured. */
async function walkViews(page: Page) {
  for (const [label, root] of [
    ["Library", ".cp-view-library"], ["Clip", ".cp-view-clip"],
    ["Review", ".cp-view-coreview"], ["Transcripts", ".cp-view-reader"],
    ["Home", ".cp-view-home"],
  ] as Array<[string, string]>) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(page.locator(root)).toBeVisible();
  }
}

test("nothing still travels: no transform transition survives reduce", async ({ page }) => {
  await boot(page);
  const moving = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("*")) {
      if (!el.checkVisibility()) continue;
      const cs = getComputedStyle(el);
      const props = cs.transitionProperty;
      if (!/\btransform\b|\ball\b/.test(props)) continue;
      // A comma list pairs property N with duration N; any nonzero one counts.
      const secs = cs.transitionDuration.split(",").map((d) => parseFloat(d) || 0);
      if (secs.some((s) => s > 0.001)) {
        out.push(`.${el.getAttribute("class")} — ${props} ${cs.transitionDuration}`);
      }
    }
    return out;
  });
  expect(moving, `still transitioning transform under reduce:\n${moving.join("\n")}`).toEqual([]);
});

test("resting geometry is identical with reduced motion on and off", async ({ page }) => {
  // The guard on HOW the above is achieved. Zeroing a duration cannot move
  // anything; `transform: none` moves centred elements off-centre and hides
  // the sidebar's revealed actions. Only the first survives this comparison.
  await boot(page);
  await walkViews(page);
  const reduced = await restingTransforms(page);

  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.reload();
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await walkViews(page);
  const normal = await restingTransforms(page);

  expect(Object.keys(normal).length, "no transforms found at all — the probe is measuring nothing")
    .toBeGreaterThan(0);
  expect(reduced).toEqual(normal);
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
