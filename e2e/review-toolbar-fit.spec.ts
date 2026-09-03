import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * The review toolbar, measured instead of reasoned about.
 *
 * Scope note: this file used to carry a second test asserting that no
 * fixed-size control renders narrower than it declares. It was deleted rather
 * than kept, because it could not fail: when this row overruns, the
 * right-hand cluster is right-anchored and slides LEFT over the filter, and
 * nothing is ever crushed. Forcing the crush deliberately (flex-shrink: 1 on
 * the icon buttons, an unshrinkable 240px filter) still produced 26px buttons.
 * A passing test that cannot fail is worse than no test.
 *
 * Reported as "problems with the all button and the search button, it's
 * overlaying", with a screenshot of the magnifier painted across the filter
 * dropdown's chevron. The cause was a half-pinned control: `.cp-review-glyph`
 * carried `flex-shrink: 0` and the 26px button holding it did not, so in a
 * `nowrap` row that overran, the button squashed and its glyph did not.
 *
 * Reading CSS cannot catch that - the sizes are all declared correctly and the
 * failure is in how a flex row distributes an overrun. So this renders the row
 * at the narrowest width the app allows and measures the boxes.
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

async function openReviewTab(page: Page) {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(([srt, srtPath, url]: string[]) => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.permissioned", "1");
    localStorage.setItem("e2e.files", JSON.stringify({ [srtPath]: srt }));
    // THE REPORTED CONDITION. 320 is DRAWER_WIDTH_MIN, whose comment in
    // QueueDrawer.tsx says it was raised from 280 precisely "so the Review
    // tab's toolbar ... always have room to lay out without clipping". The
    // screenshot that prompted this file shows it does not. Measuring at the
    // floor is measuring the narrowest state the app itself permits.
    localStorage.setItem("saucebunny.queueDrawerWidth", "320");
    localStorage.setItem("saucebunny.recentSources", JSON.stringify([
      { kind: "url", value: url, title: "Seeded", durationSeconds: 90, lastOpenedAt: Date.now() },
    ]));
  }, [SRT, SRT_PATH, SOURCE_URL]);

  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+3");
  await expect(page.locator(".cp-toolbar")).toBeVisible();
  await page.getByTitle("Recent sources", { exact: true }).click();
  await page.locator(".cp-recents-row").first().click();
  await page.locator("#cp-tab-review").click();
  await expect(page.locator(".cp-review-toolbar")).toBeVisible({ timeout: 15_000 });
}

/** Every control in the toolbar, with its rendered box. */
async function controls(page: Page) {
  return page.evaluate(() => {
    const bar = document.querySelector(".cp-review-toolbar");
    if (!bar) return [];
    const walk = (el: Element): Element[] =>
      el.matches("button, select, input, .cp-review-iconbtn")
        ? [el]
        : [...el.children].flatMap(walk);
    return walk(bar).map((el) => {
      const r = el.getBoundingClientRect();
      return {
        name: el.className || el.tagName,
        x: r.x, right: r.right, w: r.width, h: r.height,
      };
    }).filter((c) => c.w > 0);
  });
}

test.describe("the review toolbar at the narrowest panel", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 700 });
  });

  test("no two controls overlap", async ({ page }) => {
    await openReviewTab(page);
    const boxes = await controls(page);
    // Canary: an empty toolbar would pass every assertion below.
    expect(boxes.length, "no controls found, so this asserted nothing").toBeGreaterThanOrEqual(4);

    const overlaps: string[] = [];
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i], b = boxes[j];
        // Horizontal overlap only: the row is one line, and a 0.5px seam from
        // subpixel layout is not what was reported.
        // Not merely "do they overlap" but "do they keep a gap". The first
        // attempt at this fix left the filter and the search button flush at
        // zero pixels, which passes an overlap test and is still the bug,
        // one longer label away from returning. The row declares a 6px gap;
        // require most of it.
        const over = Math.min(a.right, b.right) - Math.max(a.x, b.x);
        if (over > -4) overlaps.push(`${a.name} and ${b.name} are ${(-over).toFixed(1)}px apart (want 4px+)`);
      }
    }
    expect(overlaps, overlaps.join("\n")).toEqual([]);
  });

});
