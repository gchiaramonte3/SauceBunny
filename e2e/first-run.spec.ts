import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * The first launch — the one screen every user sees, tested by nothing.
 *
 * Every other spec in this suite seeds `saucebunny.welcomed` to skip straight
 * past it, which is convenient and is exactly why nobody noticed the state it
 * was in: TWO dialogs open at once (the welcome screen at z-index 300, painted
 * over the YouTube connect modal), and the welcome declaring `aria-modal` with
 * no focus trap behind it.
 *
 * A keyboard user's first launch went: Tab into the nav rail, through Home's
 * buttons, and then into the covered modal's browser picker — a list that
 * borrows cookies, offered to someone who cannot see it — while "Get started",
 * the one button on screen, was never reachable at all.
 *
 * These specs boot with a genuinely empty localStorage. Nothing here may seed
 * `saucebunny.welcomed`, or it stops testing first run.
 */

async function firstRun(page: Page, sink?: string[]) {
  if (sink) {
    page.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning") sink.push(`[${m.type()}] ${m.text()}`);
    });
    page.on("pageerror", (e) => sink.push(`[pageerror] ${String(e)}`));
  }
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.goto("/");
  await expect(page.getByRole("dialog", { name: "Welcome to Sauce Bunny" })).toBeVisible({
    timeout: 15_000,
  });
}

test("a brand new install opens on the welcome screen, quietly", async ({ page }) => {
  const noise: string[] = [];
  await firstRun(page, noise);
  await expect(page.getByRole("button", { name: "Get started" })).toBeVisible();
  expect(noise, `console noise on first run:\n${noise.join("\n")}`).toEqual([]);
});

test("focus cannot leave the welcome dialog", async ({ page }) => {
  // The bug this file was written for. Two dialogs are open at once here, so
  // an untrapped Tab does not merely reach the page behind — it reaches a
  // second modal the user cannot see.
  await firstRun(page);
  const escaped: string[] = [];
  const visited: string[] = [];
  for (let i = 0; i < 20; i++) {
    await page.keyboard.press("Tab");
    const at = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return { escaped: "body", at: "body" };
      // The dialog container is a legal focus target on OPEN but must never be
      // where a Tab lands; naming it separately is what tells a working
      // one-control trap apart from a frozen one.
      const isContainer = el.classList.contains("cp-welcome");
      const label = isContainer
        ? "container"
        : `${el.tagName.toLowerCase()} "${
            (el.textContent || el.getAttribute("aria-label") || "?").trim().slice(0, 24)}"`;
      if (el.closest(".cp-welcome")) return { escaped: null, at: label };
      return {
        escaped: `${el.closest(".cp-ytauth") ? "covered modal" : "page behind"}: ${label}`,
        at: label,
      };
    });
    if (at.escaped) escaped.push(at.escaped);
    visited.push(at.at);
  }
  expect(escaped, `focus left the welcome dialog:\n${[...new Set(escaped)].join("\n")}`).toEqual([]);

  // And it LANDED ON THE CONTROL rather than resting on the container.
  //
  // Be clear about what this can and cannot show, because the first two
  // attempts at it were wrong. "Focus must MOVE" is the wrong rule here: this
  // screen has exactly one focusable control, so a correct trap parks on that
  // control every press and not moving is the right answer. Asserting movement
  // failed against correct code.
  //
  // And the honest limit: because the button carries `autoFocus`, focus STARTS
  // on it, so a trap frozen solid - every Tab swallowed, nothing reachable -
  // leaves focus in the same place a working one does. The two are
  // indistinguishable from outside, and freezing the trap on purpose does not
  // fail this test. A one-control dialog simply has no observable difference to
  // catch. That failure mode is covered where it CAN be seen, against the
  // ~40-control settings dialog in focus-trap.spec.ts.
  //
  // What is left is still worth pinning: the stop is a real control, and
  // `.cp-welcome` (tabIndex={-1}, focusable programmatically but never a tab
  // stop) is not where Tab comes to rest.
  const stops = new Set(visited);
  expect([...stops], "Tab rested on the dialog container, not on a control")
    .not.toContain("container");
  expect(stops.size, `visited: ${[...stops].join(" | ")}`).toBe(1);
});

test("Get started dismisses it, and it stays dismissed", async ({ page }) => {
  // The latch. A welcome screen that returns on every launch is worse than
  // no welcome screen.
  await firstRun(page);
  await page.getByRole("button", { name: "Get started" }).click();
  await expect(page.getByRole("dialog", { name: "Welcome to Sauce Bunny" })).toBeHidden();
  await expect(page.locator(".cp-view-home")).toBeVisible();

  await page.reload();
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("dialog", { name: "Welcome to Sauce Bunny" })).toHaveCount(0);
});

test("onboarding is a sequence, not a stack", async ({ page }) => {
  // Exactly one modal at a time, all the way through. Two aria-modal dialogs
  // open together is both an ambiguity for assistive tech and the reason
  // Escape used to resolve to the wrong one. The permissions step shares the
  // welcome's z-rung, so stacking them would hide one behind the other and
  // trap focus in whichever mounted last.
  await firstRun(page);
  await expect(page.getByRole("dialog")).toHaveCount(1);

  await page.getByRole("button", { name: "Get started" }).click();
  await expect(page.getByRole("dialog", { name: "Permissions" })).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);

  await page.getByRole("button", { name: "Continue" }).click();
  // The YouTube connect prompt takes its turn only now.
  await expect(page.locator(".cp-ytauth")).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(1);
});

test("the permissions step says none of it is required", async ({ page }) => {
  // The one thing this screen must never imply. Everything it asks for is for
  // watching together; transcribing a local file needs none of it. A first-run
  // wall that reads as mandatory would be worse than not asking at all.
  await firstRun(page);
  await page.getByRole("button", { name: "Get started" }).click();
  const dlg = page.getByRole("dialog", { name: "Permissions" });
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText(/skipping is a perfectly good answer/i);
  // Every permission it lists is reachable and named.
  for (const name of ["Microphone", "Camera", "Screen Recording", "Full Disk Access"]) {
    await expect(dlg.getByText(name, { exact: false }).first()).toBeVisible();
  }
});

test("the permissions step latches, like the welcome", async ({ page }) => {
  // Asking again on every launch is the failure mode that makes people stop
  // reading these screens at all.
  await firstRun(page);
  await page.getByRole("button", { name: "Get started" }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("dialog", { name: "Permissions" })).toHaveCount(0);

  await page.reload();
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("dialog", { name: "Permissions" })).toHaveCount(0);
});

test("Escape leaves the permissions step rather than trapping the user in it", async ({ page }) => {
  await firstRun(page);
  await page.getByRole("button", { name: "Get started" }).click();
  await expect(page.getByRole("dialog", { name: "Permissions" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Permissions" })).toHaveCount(0);
});

test("Escape is the same as Get started", async ({ page }) => {
  // The component binds Esc and Enter to onDone in the capture phase, so the
  // app-level shortcut handler cannot swallow them.
  await firstRun(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Welcome to Sauce Bunny" })).toBeHidden();
});
