import { test, expect } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * Every keyboard tab stop must LOOK different when it is focused (WCAG 2.4.7).
 *
 * The suite already checks that focus is trapped in dialogs, that popovers are
 * reachable, and that a focus ring is never the green accent. None of those
 * check the thing they all assume: that you can see where focus is. 61
 * `outline: none` declarations across 13 stylesheets make that assumption worth
 * testing rather than trusting - three of those files suppress the outline and
 * contain no `:focus-visible` rule at all.
 *
 * TIMING IS THE WHOLE DIFFICULTY. Focus styles here are transitioned (120ms),
 * and getComputedStyle during a transition returns the CURRENT animated value -
 * which at t=0 is still the resting one. Reading immediately reports every
 * transitioned indicator as missing; that is exactly how a first run of this
 * "found" the library search field to have no focus ring when it has a correct
 * one. Transitions are zeroed for the test so the final state is read, not a
 * frame of the animation.
 *
 * The indicator may live on the focused element OR on an ancestor: composed
 * fields (a wrapper plus a borderless inner input) brighten the WRAPPER via
 * :focus-within and deliberately suppress the inner ring. CLAUDE.md documents
 * that pattern, so the walk checks a few levels up.
 */

const STYLE_KEYS = [
  "outlineStyle", "outlineWidth", "outlineColor", "boxShadow",
  "borderColor", "backgroundColor", "filter", "textDecorationLine",
] as const;

test("every tab stop shows a visible focus indicator", async ({ page }) => {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });

  // Read the settled value, not a frame of the fade. This is a measurement
  // aid, not a claim about the app - the app's transitions stay as they are.
  await page.addStyleTag({
    content: "*, *::before, *::after { transition-duration: 0s !important; }",
  });

  await page.evaluate((keys) => {
    const w = window as unknown as { __key: (el: Element) => string; __base: Map<string, string> };
    w.__key = (el: Element) => {
      const cs = getComputedStyle(el) as unknown as Record<string, string>;
      return keys.map((k) => cs[k]).join("|");
    };
    w.__base = new Map();
    let i = 0;
    for (const el of document.querySelectorAll<HTMLElement>("*")) {
      if (!el.checkVisibility()) continue;
      el.setAttribute("data-fv", String(i));
      w.__base.set(String(i), w.__key(el));
      i++;
    }
  }, STYLE_KEYS as unknown as string[]);

  const invisible: string[] = [];
  let stops = 0;
  for (let n = 0; n < 70; n++) {
    await page.keyboard.press("Tab");
    const r = await page.evaluate(() => {
      const w = window as unknown as { __key: (el: Element) => string; __base: Map<string, string> };
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      let node: HTMLElement | null = el;
      for (let d = 0; d < 4 && node; d++, node = node.parentElement) {
        const id = node.getAttribute?.("data-fv");
        if (!id) continue;
        const base = w.__base.get(id);
        if (base !== undefined && base !== w.__key(node)) return { changed: true, desc: "" };
      }
      const p = el.parentElement;
      return {
        changed: false,
        desc: `<${el.tagName.toLowerCase()} class="${el.getAttribute("class") ?? ""}"> in `
          + `<${p?.tagName.toLowerCase()} class="${p?.getAttribute("class") ?? ""}">`,
      };
    });
    if (!r) continue;
    stops++;
    if (!r.changed) invisible.push(r.desc);
  }

  // A run that tabbed into nothing would report a clean bill of health.
  expect(stops, "Tab reached no focusable element").toBeGreaterThan(25);
  expect([...new Set(invisible)], `no visible focus indicator:\n${[...new Set(invisible)].join("\n")}`).toEqual([]);
});
