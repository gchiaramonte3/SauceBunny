import { expect, test, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * "Where is this file?" from Continue (docs/RECONNECT-MEDIA-SPEC-2026-10-05.md,
 * phase 2), driven the way a person reaches it: Resume on Home. A file that
 * moved used to be removed from Continue; now it asks where it is, and the
 * other files that moved with it come along.
 */
const was = "/e2e/missing/Day 3", now = "/e2e/Found/Day 3";

async function boot(page: Page) {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(({ was }) => {
    if (sessionStorage.getItem("e2e.seeded")) return;
    sessionStorage.setItem("e2e.seeded", "1");
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1"); localStorage.setItem("saucebunny.permissioned", "1");
    localStorage.setItem("saucebunny.recentSources", JSON.stringify([
      { kind: "file", value: `${was}/A001.mov`, title: "A001", durationSeconds: 12, lastOpenedAt: 3 },
      { kind: "file", value: `${was}/A002.mov`, title: "A002", lastOpenedAt: 2 },
    ]));
    localStorage.setItem("saucebunny.libraryThumbTimes", JSON.stringify({ [`${was}/A001.mov`]: 4, [`${was}/A002.mov`]: 6 }));
  }, { was });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
}

test("a moved file asks where it is, and the others that moved with it are reconnected too", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await boot(page);
  await page.getByRole("region", { name: "Continue watching" }).getByRole("button", { name: "Resume" }).click();
  const sheet = page.getByRole("dialog", { name: "Where is A001.mov?" });
  await expect(sheet).toBeVisible();
  await expect(sheet).toContainText(`It was in ${was}`);
  await expect(sheet.getByRole("checkbox", { name: "Reconnect other offline files that moved with it" })).toBeChecked();
  await page.screenshot({ path: test.info().outputPath("where-is-this-file.png") });
  await page.evaluate((now) => localStorage.setItem("e2e.pickFolder", `${now}/A001.mov`), now);
  await sheet.getByRole("button", { name: "Locate file…" }).click();
  await expect(sheet).toHaveCount(0);
  const stored = async (key: string) => JSON.parse(await page.evaluate((key) => localStorage.getItem(key) ?? "null", key));
  await expect.poll(async () => (await stored("saucebunny.recentSources")).map((entry: { value: string }) => entry.value).sort())
    .toEqual([`${now}/A001.mov`, `${now}/A002.mov`]);
  expect(await stored("saucebunny.libraryThumbTimes")).toEqual({ [`${now}/A001.mov`]: 4, [`${now}/A002.mov`]: 6 });
  expect(errors, errors.join("\n")).toEqual([]);
});

test("cancelling keeps a file that cannot be found in Continue", async ({ page }) => {
  await boot(page);
  await page.getByRole("region", { name: "Continue watching" }).getByRole("button", { name: "Resume" }).click();
  const sheet = page.getByRole("dialog", { name: "Where is A001.mov?" });
  await sheet.getByRole("button", { name: "Cancel" }).click();
  await expect(sheet).toHaveCount(0);
  const values = await page.evaluate(() => JSON.parse(localStorage.getItem("saucebunny.recentSources") ?? "[]").map((entry: { value: string }) => entry.value));
  expect(values).toContain(`${was}/A001.mov`);
});
