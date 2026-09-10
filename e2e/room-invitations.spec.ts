import { test, expect } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

test("the active host can invite without leaving comments or changing admission policy", async ({ page }) => {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.permissioned", "1");
    localStorage.setItem("saucebunny.review.author", JSON.stringify("Host"));
    const w = window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> } };
    const original = w.__TAURI_INTERNALS__.invoke;
    w.__TAURI_INTERNALS__.invoke = (command, args) => {
      if (command === "review_code") return Promise.resolve("SAUC-HOST");
      if (command === "review_invited_only") return Promise.resolve(true);
      if (command === "list_review_grants") return Promise.resolve([]);
      if (command === "create_review_grant") {
        sessionStorage.setItem("issued", String(Number(sessionStorage.getItem("issued") ?? 0) + 1));
        return Promise.resolve({ label: "Guest test", secret: "fixture-private-grant" });
      }
      if (command === "set_review_invited_only") sessionStorage.setItem("policy-changed", "yes");
      if (command === "session_join") sessionStorage.setItem("join-args", JSON.stringify(args));
      return original(command, args);
    };
  });
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.goto("/");
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.evaluate(() => {
    (window as unknown as { __TAURI_MOCK__: { emitTauriEvent: (n: string, p: unknown) => void } }).__TAURI_MOCK__
      .emitTauriEvent("session:state", { role: "host", code: "SAUC-HOST", selfId: "m0", presenter: "m0",
        presenterEpoch: 0, peers: [], title: "Invitation test", error: null });
  });
  const trigger = page.getByRole("button", { name: "Invite…" });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Invite reviewers" });
  await expect(dialog).toBeVisible();
  await expect(page.locator(".cp-view-coreview")).toBeHidden();
  await expect(dialog.getByRole("checkbox")).toBeChecked();
  await expect(dialog.getByRole("button", { name: "Copy open join link" })).toHaveCount(0);
  await dialog.getByRole("textbox", { name: "Who is this for" }).fill("Guest test");
  await dialog.getByRole("button", { name: "Make a link" }).click();
  await expect(dialog.getByRole("button", { name: "Copy link" })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(dialog.getByRole("button", { name: "Copy link" })).toBeVisible();
  await page.keyboard.press("Shift+Tab");
  expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
  expect(await dialog.evaluate(el => el.scrollWidth - el.clientWidth)).toBe(0);
  expect(await page.evaluate(() => sessionStorage.getItem("issued"))).toBe("1");
  expect(await page.evaluate(() => sessionStorage.getItem("policy-changed"))).toBeNull();
  await page.keyboard.press("Escape");
  await page.evaluate(() => {
    (window as unknown as { __TAURI_MOCK__: { emitTauriEvent: (n: string, p: unknown) => void } }).__TAURI_MOCK__
      .emitTauriEvent("session:state", { role: "off", code: null, peers: [], error: null });
  });
  await page.getByRole("tab", { name: "Join a session" }).click();
  await page.getByRole("textbox", { name: "Join code" }).evaluate(el => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", "saucebunny://review/SAUC-OTHER/fixture-secret\n\nNo Sauce Bunny yet? https://example.com");
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  });
  await page.getByRole("button", { name: "Join", exact: true }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(sessionStorage.getItem("join-args") ?? "{}")))
    .toMatchObject({ ticket: "SAUC-OTHER", name: "Host", grant: "fixture-secret" });
});
