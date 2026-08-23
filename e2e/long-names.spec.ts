import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * Media filenames are long, and some of them cannot wrap.
 *
 * This is a video app: names arrive as `PROJECT_CLIENT_v3_FINAL_ProRes422HQ`
 * and as camera originals like `A001C001_220101_R1AB` — and macOS allows 255
 * bytes, none of which need be a space or a hyphen. A name with no break
 * opportunity has an intrinsic width equal to its full length, and a flex row
 * measures that.
 *
 * A 203-character one pushed the library row's title 1110px past a
 * minimum-width window, taking the row's item count and its REMOVE button with
 * it. The page does not scroll sideways, so those controls were not merely
 * awkward — they were unreachable, and the folder could not be removed.
 *
 * Runs at the declared minimum window size (read from tauri.conf.json) because
 * that is the width the app promises to work at and the one where an
 * unbreakable string does the most damage.
 */

const conf = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src-tauri/tauri.conf.json", import.meta.url)), "utf8"),
) as { app: { windows: Array<{ minWidth?: number; minHeight?: number }> } };
const win = conf.app.windows.find((w) => w.minWidth && w.minHeight)!;

test.use({ viewport: { width: win.minWidth!, height: win.minHeight! } });

/** Names that exercise the three ways a filename resists layout. */
const NAMES = {
  unbreakable: "A".repeat(200) + "END",
  camera: "A001C001_220101_R1AB_MASTER_DELIVERY_PRORES422HQ_REEL_ONE_FULLRES_NOSPACES",
  spaced: "PROJECT CLIENT v3 FINAL REVISED 2026 08 16 ProRes 422 HQ Reel A Delivery Master",
};

async function libraryWithRoot(page: Page, name: string) {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript((n) => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.libraryRoots", JSON.stringify([`/e2e/${n}`]));
  }, name);
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".cp-lib-row-title").first()).toBeVisible();

  // The name is REALLY on screen. Without this the overflow sweep below is
  // satisfied by a library that failed to seed: nothing renders, nothing
  // overflows, every test passes, and the one input the file exists to try was
  // never applied. Asserting a row is visible is not enough - it has to be the
  // row with this name in it.
  const title = await page.locator(".cp-lib-row-title").first().textContent();
  expect(
    (title ?? "").replace(/\s+/g, " ").trim(),
    `the seeded name never reached the row (got "${(title ?? "").slice(0, 40)}…")`,
  ).toContain(name.slice(0, 24));
}

/** Reachable elements pushed past the right edge. */
async function overflowing(page: Page) {
  return page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>("*")) {
      if (!el.checkVisibility() || el.closest("[inert]")) continue;
      const b = el.getBoundingClientRect();
      if (b.width > 0 && b.right > window.innerWidth + 1) {
        out.push(`<${el.tagName.toLowerCase()} class="${(el.getAttribute("class") ?? "").slice(0, 34)}"> right=${Math.round(b.right)}`);
      }
    }
    return [...new Set(out)];
  });
}

for (const [shape, name] of Object.entries(NAMES)) {
  test(`a ${shape} folder name keeps the row inside the window`, async ({ page }) => {
    await libraryWithRoot(page, name);
    const over = await overflowing(page);
    expect(over, `pushed out of the window:\n${over.join("\n")}`).toEqual([]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth),
      "the page scrolls sideways",
    ).toBe(false);
  });
}

test("the row's own controls stay clickable", async ({ page }) => {
  // The actual harm. Overflow is cosmetic until it carries a control out of
  // reach — here Remove, on a row the user most likely wants gone.
  await libraryWithRoot(page, NAMES.unbreakable);
  const remove = page.locator(".cp-lib-row-remove").first();
  await expect(remove).toBeVisible();
  await expect(remove).toBeInViewport();
});

test("the full name is still recoverable when a card truncates it", async ({ page }) => {
  // Wrapping solves the row. Cards clamp instead, so they carry the whole name
  // in a title attribute — checked here so the two strategies stay honest.
  await libraryWithRoot(page, NAMES.camera);
  const titled = await page.evaluate((n) => {
    const els = [...document.querySelectorAll<HTMLElement>("[title]")];
    return els.some((e) => (e.getAttribute("title") ?? "").includes(n.slice(0, 24)));
  }, NAMES.camera);
  // Home renders rows; if a card surface is present it must be titled.
  const hasCards = await page.locator(".cp-lib-card").count();
  if (hasCards > 0) expect(titled, "a truncated card name with no title attribute").toBe(true);
});

/**
 * The same hazard in the TRANSCRIPT, which is where most user text lives.
 *
 * Filenames were the known case. Cue text is the bigger one: it is arbitrary
 * output from Whisper, and it reaches a user with no break opportunity all the
 * time — URLs, hyphen-free camera IDs, and any language that does not space
 * its words. `.cp-tx-cue` was the only text surface in the app with no
 * unbreakable-string guard, while the library carried `overflow-wrap: anywhere`
 * in six places and the AI chat and co-review roster had their own.
 *
 * Measured before the fix, at this file's minimum-window viewport: a
 * 180-character token put the cue at right=2234 in a ~900px window. The page
 * does not scroll sideways, so this was not awkward layout — the rest of the
 * line was CLIPPED and unreadable.
 */
const HOSTILE_SRT = `1
00:00:01,000 --> 00:00:03,000
[SPEAKER_${"X".repeat(120)}] ${"Z".repeat(180)}

2
00:00:04,000 --> 00:00:06,000
[SPEAKER_01] A normal line for contrast.
`;
const HOSTILE_SRT_PATH = "/e2e-mock/Documents/Sauce Bunny/Transcripts/2026-08/hostile.srt";
const HOSTILE_URL = "https://youtube.com/watch?v=abc";

async function transcriptWithHostileText(page: Page) {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(([srt, srtPath, url]: string[]) => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("e2e.files", JSON.stringify({ [srtPath]: srt }));
    localStorage.setItem("saucebunny.transcriptHistory", JSON.stringify([{
      id: "h1", srtPath, sourcePath: null, sourceUrl: url,
      title: "demo", origin: "whisper", createdAt: Date.now(), lastOpenedAt: Date.now(),
    }]));
    // A long source title too — it rides the same rows.
    localStorage.setItem("saucebunny.recentSources", JSON.stringify([
      { kind: "url", value: url, title: "P".repeat(150), durationSeconds: 90, lastOpenedAt: Date.now() },
    ]));
  }, [HOSTILE_SRT, HOSTILE_SRT_PATH, HOSTILE_URL]);

  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+3");
  await page.getByTitle("Recent sources", { exact: true }).click();
  await page.locator(".cp-recents-row").first().click();
  await expect(page.locator("[data-cue-idx]")).toHaveCount(4, { timeout: 15_000 });
  // The hostile text REALLY rendered. Without this the sweep below is happy
  // with a transcript that failed to load: nothing renders, nothing overflows.
  const body = await page.locator("body").innerText();
  expect(body, "the hostile cue never reached the page").toContain("ZZZZZZZZZZ");
}

test("an unbreakable cue wraps instead of running off the panel", async ({ page }) => {
  await transcriptWithHostileText(page);
  const over = await overflowing(page);
  expect(over, `pushed out of the window:\n${over.join("\n")}`).toEqual([]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth),
    "the page scrolls sideways",
  ).toBe(false);
});

test("and the review tab survives the same source", async ({ page }) => {
  await transcriptWithHostileText(page);
  await page.locator("#cp-tab-review").click();
  await expect(page.getByPlaceholder(/^Comment at/)).toBeVisible();
  const over = await overflowing(page);
  expect(over, `pushed out of the window:\n${over.join("\n")}`).toEqual([]);
});

test("an unbreakable review COMMENT wraps too", async ({ page }) => {
  // The other surface where a user supplies arbitrary text, and the one they
  // are most likely to paste a URL into. It already wraps — this is a pin on
  // correct behaviour, not a fix — but it is the same failure the transcript
  // had, on the app's main writing surface, so it is worth one test.
  await transcriptWithHostileText(page);
  await page.locator("#cp-tab-review").click();

  // Focusing the composer raises the name gate; clear it the way a user does.
  const box = page.getByPlaceholder(/^Comment at/);
  await box.click();
  const gate = page.locator(".cp-review-namegate");
  if (await gate.count()) {
    await gate.locator("input").first().fill("Ada");
    await page.getByRole("button", { name: "Start reviewing" }).click();
    await expect(gate).toHaveCount(0);
  }

  const unbreakable = "Z".repeat(200);
  await box.click();
  await box.fill(unbreakable);
  await expect(box).toHaveValue(unbreakable);
  await page.getByRole("button", { name: "Post", exact: true }).click();

  // Canary: a comment that never posted cannot overflow anything.
  await expect(page.locator("body")).toContainText("ZZZZZZZZZZ");

  const over = await overflowing(page);
  expect(over, `pushed out of the window:\n${over.join("\n")}`).toEqual([]);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth),
    "the page scrolls sideways",
  ).toBe(false);
});
