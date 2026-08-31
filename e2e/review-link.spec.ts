import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * A clicked saucebunny://review/<code> link lands in the lobby with the code
 * already in the field.
 *
 * TWO ARRIVAL PATHS, and they fail differently, which is why both are here.
 * A link clicked while the app RUNS arrives as a Tauri event. A link clicked
 * while the app is CLOSED launches it, and the URL reaches Rust before any
 * webview exists - Tauri drops events rather than queueing them for a listener
 * that has not registered - so it is buffered and pulled on mount. Shipping
 * only the event handler would work in development, where the app is always
 * already running, and silently do nothing for the case a real reviewer hits.
 *
 * It must NOT auto-join. A link is an instruction from someone else and
 * joining opens a connection to whoever's key is in it.
 */
async function boot(page: Page, pending: string | null): Promise<void> {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript((code) => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.permissioned", "1");
    localStorage.setItem("saucebunny.review.author", "Dana");
    const w = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> };
    };
    const real = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (c, a) =>
      c === "take_pending_review_link" ? Promise.resolve(code) : real(c, a);
  }, pending);
  await page.goto("/");
  // Wait for the SHELL, not for Home. With a buffered link the app navigates
  // to the lobby on its own, so waiting for Home to be visible fails exactly
  // when the feature works - which is how the first draft of this spec read as
  // three failures against correct code.
  await expect(page.getByRole("button", { name: "Library", exact: true }))
    .toBeVisible({ timeout: 15_000 });
}

/** The JOIN CODE field specifically. Three inputs share .cp-colobby-input
 *  (name, session title, join code), so .first() picks the name field and the
 *  assertion measures the wrong box. */
/** The banner that says a link arrived. The join field itself is two steps
 *  away on purpose - the device defaults are camera and mic ON, so a link must
 *  not skip that step - and CoReviewLobby.test.tsx covers the field fill. */
const arrived = (page: Page) => page.locator(".cp-colobby-linkbanner");

test("a cold launch claims the buffered link", async ({ page }) => {
  await boot(page, "SAUC-COLD1-COLD2");
  // The view moves on its own: the code is useless on a screen you cannot see.
  await expect(page.locator(".cp-view-coreview")).toBeVisible({ timeout: 10_000 });
  await expect(arrived(page), "nothing tells the user their link was received").toBeVisible();
});

test("a link clicked while running arrives as an event", async ({ page }) => {
  await boot(page, null);
  // CANARY: nothing is pre-filled and we are NOT in the lobby, so the
  // assertions below measure the event rather than a leftover.
  await expect(page.locator(".cp-view-home")).toBeVisible();
  await expect(page.locator(".cp-view-coreview")).toBeHidden();

  await page.evaluate(() => {
    const w = window as unknown as {
      __TAURI_MOCK__: { emitTauriEvent: (event: string, payload: unknown) => void };
    };
    w.__TAURI_MOCK__.emitTauriEvent("deeplink:review", "SAUC-WARM1-WARM2");
  });

  await expect(page.locator(".cp-view-coreview")).toBeVisible({ timeout: 10_000 });
  await expect(arrived(page)).toBeVisible();
});

test("it fills the field and does not join", async ({ page }) => {
  const calls: string[] = [];
  await page.exposeFunction("__record", (c: string) => { calls.push(c); });
  // The recorder must be installed BEFORE the page loads. Patching after
  // boot() misses the whole window this test is about: the link arrives during
  // startup, so an auto-join would already have happened and gone unrecorded.
  // The first draft did exactly that and passed against a deliberate auto-join.
  await page.addInitScript(() => {
    const w = window as unknown as {
      __TAURI_INTERNALS__?: { invoke: (c: string, a?: unknown) => Promise<unknown> };
      __record: (c: string) => void;
    };
    const install = () => {
      const real = w.__TAURI_INTERNALS__!.invoke;
      w.__TAURI_INTERNALS__!.invoke = (c, a) => { void w.__record(c); return real(c, a); };
    };
    if (w.__TAURI_INTERNALS__) install();
    else Object.defineProperty(w, "__TAURI_INTERNALS__", {
      configurable: true,
      set(v: { invoke: (c: string, a?: unknown) => Promise<unknown> }) {
        Object.defineProperty(w, "__TAURI_INTERNALS__", { value: v, writable: true, configurable: true });
        install();
      },
    });
  });
  await boot(page, "SAUC-NOJOIN");
  await expect(arrived(page)).toBeVisible();
  await page.waitForTimeout(400);

  // CANARY: the recorder saw SOMETHING, so "no session_join" is a real
  // observation rather than an empty list.
  expect(calls.length, "the invoke recorder captured nothing").toBeGreaterThan(3);
  expect(calls, "the link joined by itself; a link is an instruction from someone else")
    .not.toContain("session_join");
});
