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
 * The first three are fixed and asserted below. A FOURTH defect is confirmed
 * and NOT fixed, so it is written down rather than quietly left: focus never
 * enters the gate when it opens. `document.activeElement` is still the Post
 * button behind the scrim at +0ms, +100ms and +500ms.
 *
 * The mechanism is known, which is the useful part. Instrumenting the mount
 * showed the focus call SUCCEEDING — activeElement was the input immediately
 * after — and then being taken back. `useModalFocus`'s cleanup ends with
 * `if (prev && prev.isConnected) prev.focus()`, restoring focus to whatever
 * opened the modal; something re-runs that cleanup after mount, so the Post
 * button reclaims focus. Focusing the same input from outside afterwards
 * works and sticks, so nothing refuses focus — it is purely that restore
 * winning the last word.
 *
 * Two attempts (a rAF, then a 0ms macrotask) did not beat it, and guessing
 * further at ordering is how a real fix gets papered over. It needs the
 * focus-restore contract looked at properly, not another delay.
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
  await page.keyboard.press("Control+3");
  await expect(page.locator(".cp-toolbar")).toBeVisible();
  await page.getByTitle("Recent sources", { exact: true }).click();
  await page.locator(".cp-recents-row").first().click();

  const tab = page.locator("#cp-tab-review");
  await expect(tab, "no review tab, so nothing below was exercised").toHaveCount(1);
  await tab.click();

  const box = page.getByPlaceholder(/^Comment at/);
  await expect(box, "no comment composer found").toBeVisible();
  await box.click();
  await box.fill("HELLO");
  // Assert the value LANDED before reading the button that depends on it.
  // `type()` into a composer the drawer may still be laying out dropped the
  // text under parallel load, so Post stayed disabled and the helper failed
  // for a reason unrelated to any test using it.
  await expect(box).toHaveValue("HELLO");

  const post = page.getByRole("button", { name: "Post", exact: true });
  await expect(post).toBeEnabled();
  await post.click();

  const gate = page.locator(".cp-review-namegate");
  await expect(gate, "posting without a name did not raise the name gate").toBeVisible();
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

test("Tab cannot leave the gate", async ({ page }) => {
  const gate = await openNameGate(page);

  // NOTE: focus-on-open is NOT asserted, because it does not work — see the
  // header. Asserting it would mean shipping a red test or, worse, deleting
  // the assertion later and losing the record that it was ever broken.
  //
  // Eight tabs is more than the control count, so an untrapped dialog would
  // certainly have leaked by now. The trap works from outside too: Tab walks
  // in and then cannot get back out, which is what makes the modal usable by
  // keyboard even with the focus-on-open defect present.
  for (let i = 0; i < 8; i++) await page.keyboard.press("Tab");
  const stillInside = await page.evaluate(() =>
    !!(document.activeElement as HTMLElement | null)?.closest(".cp-review-namegate"));
  expect(stillInside, "Tab escaped the modal").toBe(true);
  await expect(gate).toBeVisible();
  expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
});

test("naming keeps the typed comment rather than discarding it", async ({ page }) => {
  // `submit` bails at `ensureNamed()` BEFORE clearing the composer, so the
  // draft survives. Worth pinning: the alternative — a user types a note,
  // presses Post, and the text is gone — is the kind of loss that is invisible
  // in code review and infuriating in use.
  await openNameGate(page);
  await page.locator(".cp-review-namegate input").first().fill("Ada");
  await page.getByRole("button", { name: "Start reviewing" }).click();
  await expect(page.locator(".cp-review-namegate")).toHaveCount(0);
  await expect(page.getByPlaceholder(/^Comment at/)).toHaveValue("HELLO");
  expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
});
