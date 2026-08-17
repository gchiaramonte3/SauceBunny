import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * A collapsed panel must be genuinely unreachable, not merely silent.
 *
 * Both panels close by animating to width: 0 with overflow: hidden — not
 * display: none — so their controls stayed focusable, while aria-hidden told
 * the screen reader to describe none of them. Tab walked ~40 invisible
 * controls including "Export N clips": an unannounced path to a destructive
 * button, which is worse than either problem on its own.
 */
async function boot(page: Page): Promise<void> {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Control+3");
  await expect(page.locator(".cp-toolbar")).toBeVisible();
}

/** Focusable descendants a keyboard user could actually land on. */
const focusableIn = (page: Page, sel: string) => page.evaluate((s) => {
  const root = document.querySelector(s);
  if (!root) return -1;
  const q = "a[href],button,input,select,textarea,[tabindex]:not([tabindex='-1'])";
  return [...root.querySelectorAll<HTMLElement>(q)]
    // An inert subtree reports no focus target; this is what we are asserting.
    .filter((el) => !el.closest("[inert]"))
    .length;
}, sel);

test("a collapsed queue drawer has no focusable controls", async ({ page }) => {
  await boot(page);
  const drawer = page.locator(".cp-queue-drawer").first();
  // The drawer opens with the Clip view; close it the way a user would.
  await expect(drawer).toHaveClass(/open/);
  await page.keyboard.press("Control+Shift+Q");
  await expect(drawer).not.toHaveClass(/open/);

  await expect(drawer).toHaveAttribute("aria-hidden", "true");
  await expect(drawer).toHaveAttribute("inert", "");
  expect(await focusableIn(page, ".cp-queue-drawer")).toBe(0);
});

test("reopening the drawer restores its controls", async ({ page }) => {
  // The other half, and the reason inertWhen returns an object to spread
  // rather than a value to assign: `inert` is presence-based like `disabled`,
  // so inert="false" is STILL inert. Setting it falsey would freeze the panel
  // permanently while looking perfectly correct in the JSX.
  await boot(page);
  const drawer = page.locator(".cp-queue-drawer").first();
  await page.keyboard.press("Control+Shift+Q");   // close
  await expect(drawer).toHaveAttribute("inert", "");
  await page.keyboard.press("Control+Shift+Q");   // and open again
  await expect(drawer).toHaveClass(/open/);
  await expect(drawer).not.toHaveAttribute("inert", /.*/);
  expect(await focusableIn(page, ".cp-queue-drawer")).toBeGreaterThan(0);
});

/**
 * The same seal, with something behind it worth sealing.
 *
 * The tests above close a drawer on a fresh app, where it holds little. With a
 * source and a transcript loaded it holds 24 focusable controls — the queue,
 * the transcript's own cues and buttons, the review composer. That is the
 * population the `inert` attribute actually has to contain, and no test had
 * ever measured it, because the harness could not load a transcript.
 *
 * A note on the probe that found this, since it nearly produced a false alarm:
 * `container.querySelectorAll('a[href],button,input')` scopes only the FIRST
 * term to the container — the commas start new selectors that match
 * document-wide. Scoped wrongly it reported 89 controls escaping the seal;
 * scoped correctly, zero do.
 */
const INERT_SRT = `1
00:00:01,000 --> 00:00:03,000
[SPEAKER_00] The first line of dialogue.

2
00:00:04,000 --> 00:00:06,000
[SPEAKER_01] And the second speaker answers.
`;
const INERT_SRT_PATH = "/e2e-mock/Documents/Sauce Bunny/Transcripts/2026-08/demo.srt";
const INERT_URL = "https://youtube.com/watch?v=abc";
const FOCUSABLE_SEL = 'a[href],button,input,select,textarea,[tabindex]:not([tabindex="-1"])';

test("a closed drawer seals a LOADED transcript's controls too", async ({ page }) => {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(([srt, srtPath, url]: string[]) => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("e2e.files", JSON.stringify({ [srtPath]: srt }));
    localStorage.setItem("saucebunny.transcriptHistory", JSON.stringify([{
      id: "h1", srtPath, sourcePath: null, sourceUrl: url,
      title: "demo", origin: "whisper", createdAt: Date.now(), lastOpenedAt: Date.now(),
    }]));
    localStorage.setItem("saucebunny.recentSources", JSON.stringify([
      { kind: "url", value: url, title: "Seeded", durationSeconds: 90, lastOpenedAt: Date.now() },
    ]));
  }, [INERT_SRT, INERT_SRT_PATH, INERT_URL]);

  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Control+3");
  await page.getByTitle("Recent sources", { exact: true }).click();
  await page.locator(".cp-recents-row").first().click();
  await expect(page.locator("[data-cue-idx]")).toHaveCount(4, { timeout: 15_000 });

  const drawer = page.locator(".cp-queue-drawer").first();
  await expect(drawer).toHaveClass(/open/);
  await page.keyboard.press("Control+Shift+Q");
  await expect(drawer).not.toHaveClass(/open/);
  await expect(drawer).toHaveAttribute("inert", "");

  const sealed = await page.evaluate((sel) => {
    const d = document.querySelector(".cp-queue-drawer") as HTMLElement | null;
    if (!d) return { total: 0, escaping: 0 };
    const inside = [...d.querySelectorAll<HTMLElement>(sel)];
    return { total: inside.length, escaping: inside.filter((e) => !e.closest("[inert]")).length };
  }, FOCUSABLE_SEL);

  // Canary: "nothing escaped" is trivially true of an empty drawer, and an
  // empty drawer is exactly what this test exists to stop measuring.
  expect(sealed.total, "the drawer held no controls, so the seal proved nothing")
    .toBeGreaterThan(10);
  expect(sealed.escaping, "controls escaped the inert seal").toBe(0);
});
