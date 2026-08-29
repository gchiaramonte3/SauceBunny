import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * Every visible input, select and textarea must have an accessible name.
 *
 * `accessible-names.spec.ts` covers BUTTONS. Form controls were never checked,
 * and Settings - nine tabs of them - is where nearly all of them live. Seven
 * had nothing but a placeholder, which is not a name: it is a fallback some
 * browsers read, it is not exposed as the label, and it disappears the moment
 * the user types. A password field announced as "edit text, blank" is the worst
 * of them.
 *
 * The scan walks EVERY tab. A one-tab version of this found one of the seven
 * and would have reported the rest as clean, because a control on a tab you
 * never opened is not a visible control.
 */

/** Tab labels from SettingsModal's TABS. Kept explicit so a REMOVED tab fails
 *  this test rather than silently shrinking the scan. */
const TABS = [
  "General", "Captions", "Camera & Mic", "Web sources", "Transcription",
  "AI Summary", "AI APIs", "Shortcuts", "About",
];

type Unlabelled = { tag: string; type: string; cls: string; placeholder: string };

async function unlabelledIn(page: Page): Promise<{ found: Unlabelled[]; total: number }> {
  return page.evaluate(() => {
    const found: Unlabelled[] = [];
    let total = 0;
    for (const el of document.querySelectorAll<HTMLElement>("input,select,textarea")) {
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
      // NOTE: placeholder is deliberately NOT accepted as a name.
      if (!named) {
        found.push({
          tag: el.tagName.toLowerCase(),
          type,
          cls: el.getAttribute("class") ?? "",
          placeholder: el.getAttribute("placeholder") ?? "",
        });
      }
    }
    return { found, total };
  }) as Promise<{ found: Unlabelled[]; total: number }>;
}

test("every form control in Settings has an accessible name", async ({ page }) => {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.permissioned", "1");
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();

  const bad: string[] = [];
  let scanned = 0;
  for (const label of TABS) {
    await page.getByRole("button", { name: label, exact: true }).click();
    const { found, total } = await unlabelledIn(page);
    scanned += total;
    for (const f of found) {
      bad.push(`[${label}] <${f.tag} type=${f.type} class="${f.cls}" placeholder="${f.placeholder}">`);
    }
  }

  // A scan that walked nine empty tabs would report a clean bill of health.
  expect(scanned, "no form controls were scanned at all").toBeGreaterThan(15);
  expect(bad, `unlabelled controls:\n${bad.join("\n")}`).toEqual([]);
});

test("form controls outside Settings are named too", async ({ page }) => {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.permissioned", "1");
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });

  const bad: string[] = [];
  const VIEWS: Array<[string, string]> = [
    ["Library", ".cp-view-library"],
    ["Clip", ".cp-view-clip"],
    ["Review", ".cp-view-coreview"],
    ["Transcripts", ".cp-view-reader"],
    ["Home", ".cp-view-home"],
  ];
  for (const [label, root] of VIEWS) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(page.locator(root)).toBeVisible();
    const { found } = await unlabelledIn(page);
    for (const f of found) bad.push(`[${label}] <${f.tag} type=${f.type} class="${f.cls}">`);
  }
  expect(bad, `unlabelled controls:\n${bad.join("\n")}`).toEqual([]);
});
