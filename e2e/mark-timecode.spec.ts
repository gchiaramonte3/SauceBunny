import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * Typing a timecode into Mark in / Mark out.
 *
 * The field is controlled, and two effects used to fight over it: one parsed
 * the text on every keystroke and moved the marks, the other wrote the marks
 * back into the field as a canonical timecode. `tcToFrames` left-pads, so the
 * FIRST character of "00:00:05:00" - a bare "0" - was a valid frame 0, which
 * round-tripped a full "00:00:00:00" into the input and every later character
 * appended to that. The field ended up holding "00:00:00:000:00:05:00", and
 * retyping over a good out point destroyed the range on the way past.
 *
 * Only a paste survived, so there was no keyboard route to a mark at all.
 * Which is why this is typed one character at a time here: `fill()` sets the
 * value in one shot and never enters the state the bug lives in.
 */
async function bootClip(page: Page): Promise<void> {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+3");
  await expect(page.locator(".cp-toolbar")).toBeVisible();
  await page.locator("input[placeholder^='Paste a video URL']").fill("https://youtube.com/watch?v=aaaa");
  await page.getByRole("button", { name: /^Fetch/ }).click();
  await expect(page.locator(".cp-timeline-hint")).toContainText("No marks set", { timeout: 10_000 });
}

const markIn = (page: Page) => page.getByRole("textbox", { name: "Mark in" });
const markOut = (page: Page) => page.getByRole("textbox", { name: "Mark out" });

/** Type into a focused field the way a hand does, one character at a time. */
async function typeInto(field: ReturnType<typeof markIn>, text: string) {
  await field.click();
  await field.press("ControlOrMeta+a");
  for (const ch of text) await field.pressSequentially(ch);
}

test("a timecode typed one character at a time is the timecode that lands", async ({ page }) => {
  await bootClip(page);
  await typeInto(markIn(page), "00:00:05:00");
  await expect(markIn(page)).toHaveValue("00:00:05:00");
  await expect(markIn(page)).not.toHaveClass(/invalid/);
});

test("the first keystroke does not round-trip a whole timecode into the field", async ({ page }) => {
  // The bug in one assertion: "0" is a valid frame 0, and committing it wrote
  // "00:00:00:00" back under the cursor. A partial entry must parse without
  // committing.
  await bootClip(page);
  const field = markIn(page);
  await field.click();
  await field.pressSequentially("0");
  await expect(field).toHaveValue("0");
  await field.pressSequentially("0");
  await expect(field).toHaveValue("00");
});

test("retyping over a good out point leaves a range, not wreckage", async ({ page }) => {
  await bootClip(page);
  await typeInto(markIn(page), "00:00:01:00");
  await typeInto(markOut(page), "00:00:20:00");
  await expect(page.locator(".cp-track-selection")).toHaveCount(1);

  // Over the top of it, selecting all first - the gesture that used to append
  // to the old value and collapse the selection.
  await typeInto(markOut(page), "00:00:10:00");
  await expect(markOut(page)).toHaveValue("00:00:10:00");
  await expect(page.locator(".cp-track-selection")).toHaveCount(1);
});

test("shorthand still expands on blur, so a partial entry is not lost", async ({ page }) => {
  // Committing only complete timecodes must not strand someone who types "5"
  // and tabs away: blur normalises first, and that commits.
  await bootClip(page);
  const field = markIn(page);
  await field.click();
  await field.pressSequentially("5");
  await field.blur();
  await expect(field).toHaveValue("00:00:00:05");
});

test("clearing the field still clears the mark", async ({ page }) => {
  await bootClip(page);
  await typeInto(markIn(page), "00:00:05:00");
  await expect(page.locator(".cp-timeline-hint")).not.toContainText("No marks set");

  await markIn(page).click();
  await markIn(page).press("ControlOrMeta+a");
  await markIn(page).press("Backspace");
  await expect(markIn(page)).toHaveValue("");
  await expect(page.locator(".cp-timeline-hint")).toContainText("No marks set");
});

test("a timecode that cannot exist is refused, and leaves the mark alone", async ({ page }) => {
  await bootClip(page);
  await typeInto(markIn(page), "00:00:05:00");
  await typeInto(markIn(page), "00:99:99:99");
  await expect(markIn(page)).toHaveClass(/invalid/);
  // Refused, not committed: blur cannot normalise it either, so it stays put
  // and says so rather than silently becoming some other frame.
  await markIn(page).blur();
  await expect(markIn(page)).toHaveValue("00:99:99:99");
});

test("a one-digit hour is not respelled under the cursor while it is being typed", async ({ page }) => {
  // "0:00:05:00" and "00:00:05:00" are the same frame, so committing the
  // first must not write the second back into the field - that moves the
  // caret to the end mid-edit. Blur still normalises it.
  await bootClip(page);
  const field = markIn(page);
  await typeInto(field, "0:00:05:00");
  await expect(field).toHaveValue("0:00:05:00");
  await expect(page.locator(".cp-track-selection")).toHaveCount(0); // in only, no range yet
  await field.blur();
  await expect(field).toHaveValue("00:00:05:00");
});
