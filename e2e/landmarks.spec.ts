import { test, expect } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * Every view must expose exactly one named main landmark.
 *
 * Four <main> elements live in the tree at once - one per view - which is
 * correct here and deliberate: the inactive view roots carry [hidden], so a
 * browser drops those subtrees from the accessibility tree and only the active
 * one is ever exposed. LibraryView.tsx documents the arrangement.
 *
 * What was missing was the NAME. Only CoReviewLobby labelled its landmark, so a
 * screen-reader user cycling landmarks heard "main" four times over with no way
 * to tell which view they had landed in, and the Library view had no landmark
 * at all - its root was a plain <div>.
 *
 * This asserts the exposed count as well as the name, because the count is what
 * makes the whole arrangement legal. If a view ever renders without [hidden],
 * two mains become visible at once and this fails.
 */
const VIEWS: Array<[string, string, string]> = [
  // nav label, view root, expected accessible name of that view's main
  ["Home", ".cp-view-home", "Library"],
  ["Library", ".cp-view-library", "Library"],
  ["Clip", ".cp-view-clip", "Clip"],
  ["Review", ".cp-view-coreview", "Co-Review"],
  ["Transcripts", ".cp-view-reader", "Transcript"],
];

test("each view exposes exactly one named main landmark", async ({ page }) => {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.permissioned", "1");
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });

  const seen: string[] = [];
  for (const [label, root, name] of VIEWS) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(page.locator(root)).toBeVisible();

    // getByRole excludes anything hidden from the a11y tree, so this counts
    // what a screen reader would actually find - not what is in the DOM.
    const mains = page.getByRole("main");
    await expect(mains, `${label}: expected one exposed main`).toHaveCount(1);
    await expect(mains).toHaveAccessibleName(name);
    seen.push(`${label}=${name}`);
  }

  // A loop whose body never ran would pass every assertion above.
  expect(seen).toHaveLength(VIEWS.length);
});

test("the primary nav is a named landmark too", async ({ page }) => {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("navigation", { name: "Primary" })).toHaveCount(1);
});
