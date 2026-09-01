import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * Nothing paints on top of the thing next to it.
 *
 * This is a class of bug, not an incident. It was reported four separate times
 * from four different screenshots in one sitting: the session header's buttons
 * overlapping into "THEM THLEFILE"; the Resolved badge painted across a
 * comment's "1m ago"; the review filter row breaking onto a second line of
 * icons; the source name reduced to "LPI..." while chips took the space.
 *
 * Every one had the same mechanism. A flex row where EVERY child can shrink
 * and NONE is pinned: no `flex-shrink: 0` on the fixed things, no `nowrap` on
 * the short labels, and `min-width: 0` on a parent so it can go below its
 * content. Squeeze that row and the children do not queue up politely, they
 * slide through each other.
 *
 * Fixing instances was not working, so this measures the RENDERED page: for
 * every non-wrapping flex row, no two in-flow children may intersect.
 *
 * Absolutely positioned children are skipped on purpose. Badges, scrims and
 * focus rings are SUPPOSED to sit over their siblings; the bug is in-flow
 * boxes colliding, and including the rest would bury the signal.
 *
 * Runs at the app's declared minimum window size, which is where a row has
 * least room and where every one of these was seen.
 *
 * WHAT THIS CANNOT SEE, and it is most of what was reported. The harness mocks
 * the whole Tauri IPC layer, so there is no live session and no review comment:
 * the session header with its chips, and a comment carrying a Resolved badge,
 * are states it cannot reach. Measured at the time of writing, the reachable
 * views expose 15 / 11 / 3 / 1 / 1 non-wrapping rows and ZERO overlaps - which
 * is a real result for those states and says nothing about the four that were
 * actually reported.
 * So this is a ratchet against the class coming back where the harness can
 * look, not proof it is gone. Making a session and a resolved comment
 * reachable is the work that would turn it into proof.
 */

const conf = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src-tauri/tauri.conf.json", import.meta.url)), "utf8"),
) as { app: { windows: Array<{ minWidth?: number; minHeight?: number }> } };
const win = conf.app.windows.find((w) => w.minWidth && w.minHeight)!;

test.use({ viewport: { width: win.minWidth!, height: win.minHeight! } });

async function boot(page: Page) {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.permissioned", "1");
    localStorage.setItem("saucebunny.libraryRoots", JSON.stringify(["/e2e/Footage"]));
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
}

type Sweep = { rows: number; offenders: string[] };

/** Every non-wrapping flex row, and any in-flow children that intersect. */
async function sweep(page: Page): Promise<Sweep> {
  return page.evaluate(() => {
    const offenders: string[] = [];
    let rows = 0;
    const name = (el: Element) => {
      const c = (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean).slice(0, 2).join(".");
      return c ? `${el.tagName.toLowerCase()}.${c}` : el.tagName.toLowerCase();
    };
    for (const row of document.querySelectorAll<HTMLElement>("*")) {
      if (!row.checkVisibility() || row.closest("[inert]") || row.closest("[hidden]")) continue;
      const rs = getComputedStyle(row);
      if (rs.display !== "flex" && rs.display !== "inline-flex") continue;
      if (rs.flexWrap !== "nowrap") continue;
      if (rs.flexDirection.startsWith("column")) continue;

      const kids = [...row.children].filter((k): k is HTMLElement => {
        if (!(k instanceof HTMLElement) || !k.checkVisibility()) return false;
        const ks = getComputedStyle(k);
        // In-flow only. A badge or a scrim is MEANT to sit over its siblings.
        if (ks.position !== "static" && ks.position !== "relative") return false;
        const b = k.getBoundingClientRect();
        return b.width > 0 && b.height > 0;
      });
      if (kids.length < 2) continue;
      rows++;

      for (let i = 0; i < kids.length; i++) {
        for (let j = i + 1; j < kids.length; j++) {
          const a = kids[i].getBoundingClientRect();
          const b = kids[j].getBoundingClientRect();
          // A whole pixel of mutual encroachment. Sub-pixel rounding on a
          // fractional layout is not a bug and reporting it would make this
          // test noise that people learn to ignore.
          const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (overlapX > 1 && overlapY > 1) {
            offenders.push(
              `${name(row)} > ${name(kids[i])} overlaps ${name(kids[j])}` +
              ` by ${Math.round(overlapX)}x${Math.round(overlapY)}px`,
            );
          }
        }
      }
    }
    return { rows, offenders: [...new Set(offenders)] };
  });
}

const VIEWS = [
  { name: "Home", nav: "Home" },
  { name: "Library", nav: "Library" },
  { name: "Clip", nav: "Clip" },
  { name: "Review", nav: "Review" },
  { name: "Transcripts", nav: "Transcripts" },
];

for (const v of VIEWS) {
  test(`${v.name}: no in-flow sibling paints over another`, async ({ page }) => {
    await boot(page);
    await page.getByRole("button", { name: v.nav, exact: true }).click();
    await page.waitForTimeout(250);
    const { rows, offenders } = await sweep(page);
    // The canary. A sweep that examined nothing reports a clean bill of health
    // for ever, and four guards in this repo have already passed that way.
    // Per-view floor is 1: Review and Transcripts are genuinely sparse when
    // empty, and demanding density from them would only teach the next person
    // to raise the number until it passed.
    expect(rows, `${v.name} exposed no non-wrapping flex rows to check`).toBeGreaterThan(0);
    expect(offenders, `${v.name} has elements painting over their siblings`).toEqual([]);
  });
}

test("the sweep actually has something to examine", async ({ page }) => {
  // The real canary, kept apart from the per-view floors so it cannot be
  // satisfied by a sparse view. Clip is the densest surface and the one that
  // carries the session header, which is where this bug keeps appearing.
  // If this number collapses, the sweep has stopped seeing the page and every
  // assertion above is passing over nothing.
  await boot(page);
  await page.getByRole("button", { name: "Clip", exact: true }).click();
  await page.waitForTimeout(250);
  const { rows } = await sweep(page);
  expect(rows, "the densest view stopped exposing rows; the sweep is blind").toBeGreaterThan(8);
});
