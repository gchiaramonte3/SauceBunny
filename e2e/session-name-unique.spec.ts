import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * Every screening gets its own name.
 *
 * The lobby restores the LAST session's title, and nothing stopped Start
 * being pressed on it again - so a week of reviews came back as five rows
 * all called "Test Session 4". The record on disk was fine; the name was
 * the only thing shown and it was identical in all of them, which makes the
 * history unreadable.
 */
const LIB = "/e2e-mock/Documents/Sauce Bunny";

async function bootLobby(page: Page, lastTitle: string): Promise<void> {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(([lib, title]: string[]) => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.permissioned", "1");
    // A saved identity enables Host; device permission is independent.
    localStorage.setItem("saucebunny.review.author", JSON.stringify("Ada"));
    // The title the lobby restores - the whole mechanism behind the pile-up.
    localStorage.setItem("saucebunny.sessionTitle", JSON.stringify(title));
    localStorage.setItem("e2e.files", JSON.stringify({
      [`${lib}/Screenings/index.json`]: JSON.stringify({
        version: 1,
        screenings: {
          s1: {
            file: "s1.json", title: "Test Session 4", startedAt: 1, endedAt: 2,
            participants: ["Ada"], segmentCount: 1, commentCount: 0, bytes: 10,
          },
        },
      }),
    }));
  }, [LIB, lastTitle]);
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Review" }).click();
  await expect(page.locator(".cp-view-coreview")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Session name")).toBeVisible({ timeout: 10_000 });
  await expect(startBtn(page)).toBeEnabled(); // history hydration has finished
}

const startBtn = (page: Page) => page.getByRole("button", { name: /Start session/ });

test("a saved name already used opens with the next free name, not an error", async ({ page }) => {
  await bootLobby(page, "Test Session 4");
  await expect(page.getByRole("textbox", { name: "Session name" })).toHaveValue("Test Session 5");
  await expect(page.getByText(/already screened a session with that name/i)).toHaveCount(0);
  await expect(startBtn(page)).toBeEnabled();
});

test("an intentionally entered duplicate cannot start a session", async ({ page }) => {
  await bootLobby(page, "Test Session 4");
  await page.getByRole("textbox", { name: "Session name" }).fill("Test Session 4");
  await expect(page.getByText(/already screened a session with that name/i)).toBeVisible();
  await expect(startBtn(page)).toBeDisabled();
  await page.evaluate(() => {
    const w = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> };
      __duplicateNameStartCalls: number;
    };
    w.__duplicateNameStartCalls = 0;
    const invoke = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command === "session_start") w.__duplicateNameStartCalls++;
      return invoke(command, args);
    };
  });
  await page.getByRole("textbox", { name: "Session name" }).press("Enter");
  expect(await page.evaluate(() => (window as unknown as { __duplicateNameStartCalls: number }).__duplicateNameStartCalls)).toBe(0);
  await expect(page.locator(".cp-body.cp-room")).toHaveCount(0);
});

test("the fix is one click, and continues the numbering", async ({ page }) => {
  // A rule that only blocks is a rule people work around by adding a space.
  await bootLobby(page, "Test Session 4");
  await page.getByRole("textbox", { name: "Session name" }).fill("Test Session 4");
  await page.getByRole("button", { name: /Use “Test Session 5”/ }).click();
  await expect(page.getByRole("textbox", { name: "Session name" })).toHaveValue("Test Session 5");
  await expect(startBtn(page)).toBeEnabled();
  await expect(page.getByText(/already screened a session with that name/i)).toHaveCount(0);
});

test("a fresh name is never in the way", async ({ page }) => {
  await bootLobby(page, "Grade pass");
  await expect(page.getByText(/already screened a session with that name/i)).toHaveCount(0);
  await expect(startBtn(page)).toBeEnabled();
});

test("case and stray spaces do not make it a different session", async ({ page }) => {
  // "test session 4 " is the same meeting to a person reading the list.
  await bootLobby(page, "Grade pass");
  await page.getByRole("textbox", { name: "Session name" }).fill("  test session 4 ");
  await expect(startBtn(page)).toBeDisabled();
});
