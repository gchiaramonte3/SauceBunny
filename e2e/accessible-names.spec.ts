import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * Every control says what it is — WCAG 4.1.2 (Name, Role, Value).
 *
 * This app is mostly icon buttons. An icon button with no text, no
 * `aria-label` and no `title` is announced as "button" and nothing else, so a
 * screen reader user gets a row of identical unnamed controls where a sighted
 * user sees a toolbar. It is also unhoverable-unknowable for anyone who does
 * not already recognise the glyph.
 *
 * Measured in the harness rather than grepped, for the same reason the target
 * size check is: the accessible name can come from text content, aria-label,
 * aria-labelledby, or title, and only the rendered DOM knows which one won.
 *
 * Scope is honest: this covers what the smoke harness renders with IPC mocked.
 * Controls that appear only once a real source is loaded are not covered and
 * are not claimed to be.
 */

type Unnamed = { tag: string; cls: string; html: string };

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

/** Visible controls whose accessible name resolves to nothing. */
async function unnamed(page: Page): Promise<Unnamed[]> {
  return page.evaluate(() => {
    const sel = 'button, [role="button"], a[href], [role="switch"], [role="tab"], [role="menuitem"], [role="checkbox"]';
    const out: Array<{ tag: string; cls: string; html: string }> = [];
    for (const el of Array.from(document.querySelectorAll(sel))) {
      const e = el as HTMLElement;
      if (e.getAttribute("aria-hidden") === "true") continue;
      const cs = getComputedStyle(e);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      const r = e.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;

      // The four ways a control can get a name, in the order they win.
      const labelledBy = (e.getAttribute("aria-labelledby") || "")
        .split(/\s+/).filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent?.trim() || "")
        .join(" ").trim();
      const name =
        labelledBy ||
        (e.getAttribute("aria-label") || "").trim() ||
        (e.getAttribute("title") || "").trim() ||
        // Text content, but NOT text that is itself aria-hidden.
        Array.from(e.childNodes)
          .filter((n) => !(n instanceof HTMLElement && n.getAttribute("aria-hidden") === "true"))
          .map((n) => n.textContent || "")
          .join("").trim();

      if (!name) {
        out.push({
          tag: e.tagName.toLowerCase(),
          cls: (e.className || "").toString().slice(0, 46),
          html: e.outerHTML.slice(0, 110),
        });
      }
    }
    return out;
  });
}

test("the harness renders controls to check", async ({ page }) => {
  // A selector matching nothing would report perfect accessibility.
  await boot(page);
  const all = await page.locator('button, [role="button"]').count();
  expect(all, "too few controls to be measuring the real workbench").toBeGreaterThan(15);
});

test("no control is announced as an unnamed button", async ({ page }) => {
  await boot(page);
  const bad = await unnamed(page);
  expect(
    bad.map((b) => `${b.tag}.${b.cls}`),
    `These resolve to no accessible name:\n${bad.map((b) => b.html).join("\n")}`,
  ).toEqual([]);
});

test("the settings modal names its controls too", async ({ page }) => {
  await boot(page);
  const gear = page.locator('[aria-label="Settings"], button:has-text("Settings")').first();
  if (await gear.count()) {
    await gear.click();
    await page.waitForTimeout(300);
  }
  const bad = await unnamed(page);
  expect(
    bad.map((b) => `${b.tag}.${b.cls}`),
    `Unnamed in Settings:\n${bad.map((b) => b.html).join("\n")}`,
  ).toEqual([]);
});

/**
 * Every top-level view, not just the workbench.
 *
 * The two tests above measure Clip and Settings, which is where the smoke
 * harness already goes. The app has five views behind mod+1..5, and a control
 * that never renders on Clip is exactly the one nobody has looked at.
 */
const VIEWS: ReadonlyArray<readonly [key: string, label: string, root: string]> = [
  ["Control+1", "Home", "cp-view-home"],
  ["Control+2", "Library", "cp-view-library"],
  ["Control+3", "Clip", "cp-view-clip"],
  ["Control+4", "Review", "cp-view-coreview"],
  ["Control+5", "Transcripts", "cp-view-reader"],
];

for (const [key, label, root] of VIEWS) {
  test(`${label} names every control it renders`, async ({ page }) => {
    await boot(page);
    await page.keyboard.press(key);
    await page.waitForTimeout(250);

    // Prove the switch happened before believing the result. All five view
    // roots stay in the DOM with `hidden` toggling, so a shortcut that stops
    // working leaves every one of these tests measuring the Clip view and
    // reporting five passes for one screen. Counting buttons does not show it
    // either: the raw count is identical from every view because it includes
    // the hidden ones.
    const active = await page.evaluate(() =>
      document.querySelector(".cp-view:not([hidden])")?.className ?? "");
    expect(active, `${key} did not switch to ${label}`).toContain(root);

    const bad = await unnamed(page);
    expect(
      bad.map((b) => `${b.tag}.${b.cls}`),
      `Unnamed in ${label}:\n${bad.map((b) => b.html).join("\n")}`,
    ).toEqual([]);
  });
}
