import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * Pointer target size — WCAG 2.2 SC 2.5.8 (Target Size, Minimum, AA).
 *
 * This is here rather than in a CSS contract test because the rule cannot be
 * decided from CSS. The success criterion is 24x24 CSS pixels, but a smaller
 * target still PASSES under the spacing exception when a 24px-diameter circle
 * centred on it does not intersect the circle of any other target. So a 22px
 * button with 2px of clearance conforms, and an identical 22px button packed
 * against a neighbour does not. Only layout knows which.
 *
 * That distinction matters practically, not just legally: the naive fix is to
 * inflate every small control's hit area, and on a tightly packed row that
 * makes the hit areas OVERLAP, so the wrong control fires. A test that
 * measures is the difference between fixing this and moving it.
 *
 * Scope is honest: this measures what the smoke harness actually renders, with
 * the IPC layer mocked. Controls that only appear once a real source is loaded
 * are not covered here and are not claimed to be.
 */

const MIN = 24;

type Box = { x: number; y: number; w: number; h: number };
type Target = { label: string; box: Box; path: string };

async function boot(page: Page): Promise<void> {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.permissioned", "1");
  });
  await page.goto("/");
  // Walk to the Clip workbench the way the smoke suite does. Landing on Home
  // and measuring there found NINE targets, and two of these tests passed over
  // essentially nothing - which the count assertion below is here to catch.
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+3");
  await expect(page.locator(".cp-toolbar")).toBeVisible();
}

/** Every visible, enabled, genuinely clickable element and its box. */
async function targets(page: Page): Promise<Target[]> {
  return page.evaluate(() => {
    // Controls only. A bare `[tabindex]` was in this list at first and pulled
    // in focusable SCROLL REGIONS (div.cp-logs-header and friends), which are
    // keyboard affordances, not things anyone clicks - and counting them as
    // neighbours invented crowding that does not exist. SC 2.5.8 is about
    // pointer targets; a div earns its place here by carrying a widget role.
    // `[role="separator"]` earns its place the way the others do: a FOCUSABLE
    // separator is an ARIA window splitter - a control you drag to set a value
    // - and the list columns use exactly that. Its absence here is why a
    // 10px-wide drag handle went unmeasured while this file's own test name
    // cites SC 2.5.8. A static separator has no tabindex and is filtered out
    // below with everything else that is not operable.
    const sel = 'button, [role="button"], a[href], input:not([type="hidden"]), select, textarea, [role="switch"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="checkbox"], [role="radio"], [role="option"], [role="slider"], [role="separator"][tabindex]';
    const out: Array<{ label: string; box: { x: number; y: number; w: number; h: number }; path: string }> = [];
    for (const el of Array.from(document.querySelectorAll(sel))) {
      const e = el as HTMLElement;
      if (e.hasAttribute("disabled") || e.getAttribute("aria-disabled") === "true") continue;
      if (e.getAttribute("aria-hidden") === "true") continue;
      const cs = getComputedStyle(e);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.pointerEvents === "none") continue;
      if (Number(cs.opacity) === 0) continue;
      const r = e.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // The visually-hidden pattern (1x1 clipped) is an accessibility helper,
      // not a pointer target - it exists to be read, never clicked.
      if (r.width <= 2 && r.height <= 2) continue;
      const id = e.getAttribute("aria-label") || e.getAttribute("title") || e.textContent?.trim().slice(0, 30) || "";
      // Child-index path from the root, so the test can tell NESTING apart
      // from adjacency without shipping DOM nodes across the boundary.
      const seg: number[] = [];
      for (let n: Element | null = e; n && n.parentElement; n = n.parentElement) {
        seg.unshift(Array.prototype.indexOf.call(n.parentElement.children, n));
      }
      out.push({
        label: `${e.tagName.toLowerCase()}.${(e.className || "").toString().split(" ")[0]} "${id}"`,
        box: { x: r.x, y: r.y, w: r.width, h: r.height },
        path: seg.join("."),
      });
    }
    return out;
  });
}

const centre = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const undersized = (b: Box) => b.w < MIN || b.h < MIN;

/** Does a circle of radius `r` at `c` reach into rectangle `b`? */
function circleHitsRect(c: { x: number; y: number }, r: number, b: Box): boolean {
  const nx = Math.max(b.x, Math.min(c.x, b.x + b.w));
  const ny = Math.max(b.y, Math.min(c.y, b.y + b.h));
  return Math.hypot(c.x - nx, c.y - ny) < r;
}

/**
 * SC 2.5.8 as written, which is fussier than "is it 24px":
 *
 *   at least 24x24, OR undersized and positioned so that a 24px-DIAMETER
 *   circle centred on it does not intersect another target, nor the circle of
 *   another undersized target.
 *
 * The first version of this compared centre to centre against every neighbour,
 * which is wrong twice over: it treats a wide toolbar button as if it were a
 * point, and it ignores that two undersized targets are judged circle against
 * circle while an undersized one beside a full-size one is judged circle
 * against BOX. Both errors invent failures on roomy layouts.
 */
function failures(all: Target[]): string[] {
  const bad: string[] = [];
  for (const t of all) {
    if (!undersized(t.box)) continue;
    const c = centre(t.box);
    for (const o of all) {
      if (o === t) continue;
      // NESTED targets are not "crowding" each other. The Pipeline log header
      // is itself role="button" and holds Stop / Copy / Clear inside it, so
      // every one of those children sits within its ancestor's box by
      // construction. Whether a click near Copy toggles the panel is a real
      // question, but it is decided by hit testing and event order, not by
      // the spacing exception, which is about ADJACENT targets.
      if (t.path.startsWith(o.path + ".") || o.path.startsWith(t.path + ".")) continue;
      const clash = undersized(o.box)
        ? Math.hypot(c.x - centre(o.box).x, c.y - centre(o.box).y) < MIN // circle vs circle
        : circleHitsRect(c, MIN / 2, o.box);                            // circle vs box
      if (clash) {
        bad.push(`${t.label} is ${Math.round(t.box.w)}x${Math.round(t.box.h)} and collides with ${o.label}`);
        break;
      }
    }
  }
  return bad;
}

test("the harness finds real controls to measure", async ({ page }) => {
  // A selector that matches nothing would report perfect conformance.
  await boot(page);
  const all = await targets(page);
  expect(all.length, "too few controls to be measuring the real workbench").toBeGreaterThan(25);
});

test("no pointer target is both undersized and crowded (WCAG 2.2 SC 2.5.8)", async ({ page }) => {
  await boot(page);
  const bad = failures(await targets(page));
  expect(bad, `Undersized AND crowded, so the spacing exception does not save them:\n${bad.join("\n")}`).toEqual([]);
});

test("the settings modal's controls clear the bar too", async ({ page }) => {
  // Settings is the densest surface in the app: rows of toggles, inputs and
  // small icon buttons, which is exactly where crowding shows up.
  await boot(page);
  const gear = page.locator('[aria-label="Settings"], button:has-text("Settings")').first();
  // NOT `if (await gear.count())`. That guard meant a renamed or removed
  // Settings button quietly skipped the open, leaving this test measuring the
  // main view again and reporting a pass for a surface it never saw. The gear
  // has to be there, and the dialog has to appear - both asserted, and the
  // dialog with an auto-retrying assertion rather than a fixed wait.
  await expect(gear, "no Settings control found, so this measured the main view").toHaveCount(1);
  await gear.click();
  await expect(page.locator('.cp-modal, [role="dialog"]').first()).toBeVisible();
  const bad = failures(await targets(page));
  expect(bad, `Undersized AND crowded in Settings:\n${bad.join("\n")}`).toEqual([]);
});

/**
 * THE LIST HEADER, which this file could not see at all.
 *
 * Two layers hid a 10px-wide drag handle from a suite whose own test name
 * cites SC 2.5.8. First the selector above listed `[role="slider"]` and not
 * `[role="separator"]`, so a column divider was not a target as far as this
 * file was concerned. Fixing that alone changed nothing, and the mutation
 * proved it: `boot()` walks to the CLIP workbench, where no list view exists,
 * so the widened selector matched zero elements and the suite went on passing
 * with the divider shrunk to 3x3.
 *
 * A selector that matches nothing reports perfect conformance. That is the
 * failure this repo has met four times, and it met it again here.
 */
async function bootLibraryList(page: Page): Promise<void> {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.permissioned", "1");
    localStorage.setItem("saucebunny.libraryRoots", JSON.stringify(["/e2e-mock/Footage"]));
    localStorage.setItem("e2e.manyFiles", "40");
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+2");
  await expect(page.locator(".cp-lib-pane")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: /List view/i }).click();
  await expect(page.locator(".cp-lib-list")).toBeVisible();
}

test("the list view's targets clear the bar too", async ({ page }) => {
  await bootLibraryList(page);
  const found = await targets(page);

  // CANARY, and the whole reason this test exists rather than just a wider
  // selector: without it the widened selector passes by matching nothing,
  // which is exactly what it did. Measured by breaking it - the divider was
  // shrunk to 3x3 and the suite stayed green.
  const dividers = found.filter((t) => /Resize .* column/i.test(t.label));
  expect(dividers.length, "no column dividers measured - the scan is not reaching them")
    .toBeGreaterThanOrEqual(3);

  // Judged by THIS FILE'S rule - undersized AND crowded - rather than a
  // stricter bare-size one applied to the dividers alone. SC 2.5.8's spacing
  // exception is the standard the rest of the app is held to here, and
  // holding one control to a different bar is how a suite stops being read.
  const bad = failures(found);
  expect(bad, `Undersized AND crowded in the library list:\n${bad.join("\n")}`).toEqual([]);
});
