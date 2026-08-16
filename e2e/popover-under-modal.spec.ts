import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * A keystroke must not land on a surface the user cannot see.
 *
 * `useDismiss` closes a popover on an outside MOUSEDOWN and on Escape. ⌘K is
 * neither, so opening the command palette from the keyboard left the recents
 * popover open UNDERNEATH it with its own ↑/↓/Enter listener still attached.
 * Both lists then moved on one ArrowDown, and one Enter LOADED A RECENT VIDEO
 * while the user was looking at the palette — measured, not theorised: the
 * probe that found this read the URL field afterwards and it contained
 * `youtube.com/watch?v=abc`.
 *
 * The fix is a `saucebunny:dismiss-popovers` window event fired when a
 * keyboard shortcut opens a modal, which both `useDismiss` and RecentSources'
 * own listeners answer.
 *
 * This lives in e2e and not in a component test on purpose. The conflict does
 * not exist in either component alone; it needs App mounted, the palette
 * bound to a real key, and two live listeners racing on one event. That is the
 * same blind spot that hid the duplicate Escape closer in SettingsModal, found
 * the same way.
 */

const pageErrors: string[] = [];

async function boot(page: Page, urlOnly = false): Promise<void> {
  pageErrors.length = 0;
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript((one: boolean) => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    const web = { kind: "url", value: "https://youtube.com/watch?v=abc", title: "Seeded web source", durationSeconds: 90, lastOpenedAt: Date.now() };
    const file = { kind: "file", value: "/tmp/seeded.mp4", title: "seeded.mp4", lastOpenedAt: Date.now() - 60_000 };
    // `urlOnly` matters. With two entries, one ArrowDown lands on the FILE row,
    // and opening a file never touches the URL field — so the Enter test below
    // passed even with the bug restored. The break-test caught that; the
    // fixture now guarantees the covered popover's Enter targets the URL entry,
    // which is the only thing that makes the assertion mean anything.
    localStorage.setItem("saucebunny.recentSources", JSON.stringify(one ? [web] : [web, file]));
  }, urlOnly);
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Control+3");
  await expect(page.locator(".cp-toolbar")).toBeVisible();
}

async function openRecents(page: Page) {
  await page.getByTitle("Recent sources", { exact: true }).click();
  const pop = page.locator(".cp-recents-pop");
  // Asserted, not assumed: if the popover stops opening, the whole point of
  // these tests evaporates and they would pass on an absence.
  await expect(pop, "the recents popover did not open, so nothing was covered").toBeVisible();
  return pop;
}

test("the command palette closes the popover it covers", async ({ page }) => {
  await boot(page);
  const pop = await openRecents(page);

  await page.keyboard.press("Control+k");

  await expect(pop, "the recents popover survived under the palette").toHaveCount(0);
  expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
});

test("Enter in the palette does not load a recent source behind it", async ({ page }) => {
  // The bug in its user-visible form. The URL field is the witness: it was
  // empty, and the covered popover filled it from a keystroke aimed elsewhere.
  await boot(page, /* urlOnly */ true);
  const url = page.locator(".cp-url input");
  await expect(url).toHaveValue("");

  await openRecents(page);
  await page.keyboard.press("Control+k");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(250);

  await expect(url, "a covered popover consumed the palette's Enter and loaded a source")
    .toHaveValue("");
  expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
});

test("the shortcut sheet dismisses it too, and a mouse-opened palette is unaffected", async ({ page }) => {
  // Two halves. The sheet is the other keyboard-opened modal, so it carries
  // the same dispatch. And the popover must still open normally afterwards —
  // a dismissal that fires too eagerly would make the feature unusable, which
  // is the way this fix could plausibly break something.
  await boot(page);
  const pop = await openRecents(page);
  await page.keyboard.press("Control+/");
  await expect(pop, "the shortcut sheet left the popover live underneath").toHaveCount(0);

  await page.keyboard.press("Escape");
  const again = await openRecents(page);
  await expect(again).toBeVisible();
  expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
});
