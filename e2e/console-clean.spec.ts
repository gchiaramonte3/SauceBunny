import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * Nothing in this suite watched console.error.
 *
 * Six specs listen for `pageerror`, which fires only for an UNCAUGHT exception.
 * React does not throw for the mistakes it catches: a duplicate `key`, a <div>
 * inside a <p>, a setState during another component's render, an act() warning,
 * a removed lifecycle. Every one of those is reported through console.error and
 * every one of them was invisible to this suite.
 *
 * They matter here more than in a normal web app: CLAUDE.md records that
 * console output is unreachable in a packaged WKWebView build without attaching
 * Safari's inspector, so a warning that would nag a developer daily in Chrome
 * ships silently. This is the only place it can be read.
 *
 * The list is deliberately empty. If a warning is genuinely acceptable, add it
 * to ALLOWED with the reason - do not widen the matcher.
 */
const ALLOWED: RegExp[] = [];

/** Nav rail label -> the view root that must become visible when clicked. */
const VIEWS: Array<[string, string]> = [
  ["Library", ".cp-view-library"],
  ["Clip", ".cp-view-clip"],
  ["Review", ".cp-view-coreview"],
  ["Transcripts", ".cp-view-reader"],
  ["Home", ".cp-view-home"],
];

async function boot(page: Page, sink: string[]) {
  page.on("console", (m) => {
    const type = m.type();
    if (type !== "error" && type !== "warning") return;
    const text = m.text();
    if (ALLOWED.some((re) => re.test(text))) return;
    sink.push(`[${type}] ${text}`);
  });
  // An uncaught throw is console-silent, so it would otherwise slip past a spec
  // whose whole subject is console output.
  page.on("pageerror", (e) => sink.push(`[pageerror] ${String(e)}`));
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
}

test("every view renders without a console error or warning", async ({ page }) => {
  const noise: string[] = [];
  await boot(page, noise);

  for (const [label, root] of VIEWS) {
    await page.getByRole("button", { name: label, exact: true }).click();
    // Assert the click LANDED. A spec that silently fails to navigate reports a
    // clean console for one view and calls it five.
    await expect(page.locator(root)).toBeVisible();
  }

  expect(noise, `console noise:\n${noise.join("\n")}`).toEqual([]);
});

test("the console listener can actually see a warning", async ({ page }) => {
  // Without this, a broken listener - wrong event name, a filter that eats
  // everything - would report silence and pass forever. The test above is only
  // worth its runtime if this one proves the microphone is on.
  const noise: string[] = [];
  await boot(page, noise);
  await page.evaluate(() => {
    console.error("canary: console.error is observable");
    console.warn("canary: console.warn is observable");
  });
  await expect.poll(() => noise.length).toBe(2);
  expect(noise.join("\n")).toContain("[error] canary");
  expect(noise.join("\n")).toContain("[warning] canary");
});

test("opening settings and the command palette stays quiet", async ({ page }) => {
  // Two surfaces that mount a lot at once, both behind a portal, and both
  // recently changed: the focus trap and the palette's dismiss handling.
  const noise: string[] = [];
  await boot(page, noise);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();

  await page.keyboard.press("Meta+k");
  await page.keyboard.press("Escape");

  expect(noise, `console noise:\n${noise.join("\n")}`).toEqual([]);
});
