import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * The review panel's name gate, which was the app's only modal that did not
 * say it was one.
 *
 * Every other modal — Settings, Share, Media info, YouTube auth, Rename, the
 * transcript search, Paste notes — declares `role="dialog"`. This one rendered
 * as a bare `<div class="cp-review-namegate">` with a scrim, so:
 *
 *  · a screen reader announced no dialog boundary at all;
 *  · `document.querySelector('[role="dialog"][aria-modal="true"]')` found
 *    NOTHING while a modal was plainly on screen, which is the exact selector
 *    TranscriptViewer's ⌘F and ⌘G consult before deciding it is safe to act;
 *  · and Tab walked straight out of it.
 *
 * All of those are fixed and asserted below.
 *
 * A NOTE ON A DEFECT THAT TURNED OUT NOT TO EXIST, because an earlier version
 * of this file asserted it and two tasks were filed about it. Focus DOES enter
 * the gate. The gate opens from the composer's own `onFocus` handler
 * (`ensureNamed()`), so by the time it mounts the caret is already heading
 * into it — `useModalFocus` observes `prev: INPUT, contains: true` and
 * `document.activeElement` settles on the gate's name field.
 *
 * The apparent bug was this test's fault. It used to type into the composer
 * with `fill()` and then click Post — but the gate is modal and covers the
 * composer, so filling it is something Playwright can do and a user cannot.
 * That dragged focus back out before the assertion ran, and every measurement
 * afterwards reported the Post button. Four theories were tested against that
 * phantom (the focus hook, StrictMode, duplicate mounts, mount timing) before
 * instrumenting the production bundle showed the effects running correctly all
 * along.
 *
 * The helper below now opens the gate the way a user does: focus the composer,
 * and it appears.
 *
 * It was only reachable at all once the mock could load a source and open the
 * review tab, which is why it survived every earlier accessibility sweep —
 * `e2e/accessible-names.spec.ts` and `focus-trap.spec.ts` walk what is on
 * screen, and this never was.
 */

const SOURCE_URL = "https://youtube.com/watch?v=abc";
const pageErrors: string[] = [];

async function openNameGate(page: Page) {
  pageErrors.length = 0;
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript((u: string) => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    // Opt in to the mock's read/write filesystem; seed nothing.
    localStorage.setItem("e2e.files", "{}");
    localStorage.setItem("saucebunny.recentSources", JSON.stringify([
      { kind: "url", value: u, title: "Seeded", durationSeconds: 90, lastOpenedAt: Date.now() },
    ]));
  }, SOURCE_URL);

  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+3");
  await expect(page.locator(".cp-toolbar")).toBeVisible();
  await page.getByTitle("Recent sources", { exact: true }).click();
  await page.locator(".cp-recents-row").first().click();

  const tab = page.locator("#cp-tab-review");
  await expect(tab, "no review tab, so nothing below was exercised").toHaveCount(1);
  await tab.click();

  // Focusing the composer IS what raises the gate — `onFocus={() => ensureNamed()}`.
  // No typing, no Post click: those were the steps that used to reach past an
  // open modal and invalidate every focus measurement in this file.
  const box = page.getByPlaceholder(/^Comment at/);
  await expect(box, "no comment composer found").toBeVisible();
  await box.click();

  const gate = page.locator(".cp-review-namegate");
  await expect(gate, "focusing the composer did not raise the name gate").toBeVisible();
  return gate;
}

test("the name gate is a real dialog, with a name", async ({ page }) => {
  await openNameGate(page);
  const dialog = page.locator('[role="dialog"][aria-modal="true"]');
  await expect(dialog, "the name gate is not discoverable as a modal dialog").toHaveCount(1);

  const label = await dialog.evaluate((d) => {
    const id = d.getAttribute("aria-labelledby");
    return id ? document.getElementById(id)?.textContent ?? null : d.getAttribute("aria-label");
  });
  expect(label, "the dialog has no accessible name").toBe("What's your name?");
  expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
});

test("focus enters the gate, and Tab cannot leave it", async ({ page }) => {
  const gate = await openNameGate(page);

  // Focus-on-open, asserted again now that the flow above matches what a user
  // can actually do. This is the assertion an earlier version of this file
  // deleted on the strength of a measurement taken from an unreachable state.
  await expect(async () => {
    const inside = await page.evaluate(() =>
      !!(document.activeElement as HTMLElement | null)?.closest(".cp-review-namegate"));
    expect(inside, "focus did not enter the dialog").toBe(true);
  }).toPass({ timeout: 3000 });

  // Eight tabs is more than the control count, so an untrapped dialog would
  // certainly have leaked by now.
  for (let i = 0; i < 8; i++) await page.keyboard.press("Tab");
  const stillInside = await page.evaluate(() =>
    !!(document.activeElement as HTMLElement | null)?.closest(".cp-review-namegate"));
  expect(stillInside, "Tab escaped the modal").toBe(true);
  await expect(gate).toBeVisible();
  expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
});

test("naming dismisses the gate and hands the composer back", async ({ page }) => {
  // The gate blocks the composer until a name exists; once saved it should get
  // out of the way and leave the user typing where they meant to.
  await openNameGate(page);
  await page.locator(".cp-review-namegate input").first().fill("Ada");
  await page.getByRole("button", { name: "Start reviewing" }).click();
  await expect(page.locator(".cp-review-namegate")).toHaveCount(0);

  const box = page.getByPlaceholder(/^Comment at/);
  await box.click();
  await box.fill("a real note");
  await expect(box, "the composer is unusable after naming").toHaveValue("a real note");
  await expect(page.locator(".cp-review-namegate"), "the gate came back for a named reviewer")
    .toHaveCount(0);
  expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
});
