import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * The accessibility sweeps, pointed at screens they had never seen.
 *
 * `form-labels.spec.ts` and `accessible-names.spec.ts` are older than this
 * file and were never wrong — they simply walk whatever is on screen, and the
 * only screen reachable before the mock could load a source was the empty
 * Clip view. Everything behind a loaded source (the export fields, the
 * transcript, the review tab, the name gate) had no coverage at all.
 *
 * Pointing the SAME detector at those states found four unlabelled fields on
 * the first run:
 *
 *  · Mark in / Mark out — each had a VISIBLE `<label>` that was a sibling with
 *    no `htmlFor`, and the input was not inside the label either. Visually
 *    labelled, programmatically anonymous: a screen reader read "edit text".
 *  · the review composer — the app's main writing surface, named only by a
 *    placeholder that changes with the playhead ("Comment at 1:23"), which is
 *    a hint, not a name.
 *  · the name gate's input.
 *
 * All four are fixed. This file exists so the next screen added behind a
 * source is checked too, instead of waiting for someone to notice.
 *
 * The detector is deliberately a copy of form-labels.spec.ts's, not an import:
 * that spec keeps its helper private, and the honest choice was to duplicate
 * ~20 lines here rather than refactor a passing spec for tidiness. If a third
 * copy ever appears, extract all three then.
 */

const SRT = `1
00:00:01,000 --> 00:00:03,000
[SPEAKER_00] The first line of dialogue.

2
00:00:04,000 --> 00:00:06,000
[SPEAKER_01] And the second speaker answers.
`;
const SRT_PATH = "/e2e-mock/Documents/Sauce Bunny/Transcripts/2026-08/demo.srt";
const SOURCE_URL = "https://youtube.com/watch?v=abc";

const pageErrors: string[] = [];

/** Visible form fields with no accessible name. Placeholder is NOT a name. */
function unlabelled(page: Page) {
  return page.evaluate(() => {
    const found: string[] = [];
    let total = 0;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("input,select,textarea"))) {
      // checkVisibility() needs Safari 17.4 and the app targets macOS 14
      // (Safari 17.0) — fine HERE because e2e runs in Chromium, and this file
      // never ships. Production code uses getClientRects().length instead.
      if (!el.checkVisibility()) continue;
      const type = (el as HTMLInputElement).type || el.tagName.toLowerCase();
      if (type === "hidden") continue;
      total++;
      const id = el.id;
      const named =
        (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)) ||
        el.closest("label") ||
        el.getAttribute("aria-label") ||
        (el.getAttribute("aria-labelledby") &&
          document.getElementById(el.getAttribute("aria-labelledby")!)) ||
        el.getAttribute("title");
      if (!named) {
        found.push(`${el.tagName.toLowerCase()}[${type}] placeholder=${JSON.stringify(el.getAttribute("placeholder"))}`);
      }
    }
    return { found, total };
  });
}

async function bootWithSource(page: Page): Promise<void> {
  pageErrors.length = 0;
  page.on("pageerror", (e) => pageErrors.push(String(e)));
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
  }, [SRT, SRT_PATH, SOURCE_URL]);

  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Control+3");
  await expect(page.locator(".cp-toolbar")).toBeVisible();
  await page.getByTitle("Recent sources", { exact: true }).click();
  await page.locator(".cp-recents-row").first().click();
  await expect(page.locator("[data-cue-idx]")).toHaveCount(4, { timeout: 15_000 });
}

test("a loaded source: every field has a name", async ({ page }) => {
  await bootWithSource(page);
  const { found, total } = await unlabelled(page);
  // Canary. "No unlabelled fields" is trivially true of a page with no fields,
  // and this state has five — including the two Mark in/out inputs that only
  // exist once a source is loaded, which is the whole reason this file exists.
  expect(total, "no form fields found, so this asserted nothing").toBeGreaterThanOrEqual(4);
  expect(found, "unlabelled fields behind a loaded source").toEqual([]);
  expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
});

test("the review tab: every field has a name", async ({ page }) => {
  await bootWithSource(page);
  await page.locator("#cp-tab-review").click();
  await expect(page.getByPlaceholder(/^Comment at/)).toBeVisible();
  const { found, total } = await unlabelled(page);
  expect(total).toBeGreaterThanOrEqual(5);
  expect(found, "unlabelled fields in the review tab").toEqual([]);
  expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
});

test("the name gate: every field has a name", async ({ page }) => {
  await bootWithSource(page);
  await page.locator("#cp-tab-review").click();
  const box = page.getByPlaceholder(/^Comment at/);
  await box.click();
  await box.fill("HELLO");
  await expect(box).toHaveValue("HELLO");
  const post = page.getByRole("button", { name: "Post", exact: true });
  await expect(post).toBeEnabled();
  await post.click();
  await expect(page.locator(".cp-review-namegate")).toBeVisible();

  const { found, total } = await unlabelled(page);
  expect(total).toBeGreaterThanOrEqual(6);
  expect(found, "unlabelled fields with the name gate open").toEqual([]);
  expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
});
