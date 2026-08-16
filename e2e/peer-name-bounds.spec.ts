import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * A peer's display name is remote data, and it lands on top of your video.
 *
 * Every reaction in a co-review session paints the sender's name over the
 * picture. `.cp-reaction-name` was the only name rule in the app with
 * `white-space: nowrap` and no bound — 35 of the other 36 clamp with an
 * ellipsis. A 198-character name measured 1136px in a 1100px window: a band of
 * text across someone else's footage, and unfixable from the receiving side,
 * because the string belongs to the sender.
 *
 * The lobby's "Your name" field had no `maxLength` either, while the session
 * title beside it was capped at 80. Both ends are fixed now, and BOTH matter
 * for different reasons: the input stops this build producing such a name, and
 * the CSS stops any other build's name doing damage here. Only the second is
 * load-bearing — a peer runs their own binary.
 *
 * The reaction markup is constructed directly rather than driven through a
 * session: a live peer is exactly what this harness cannot provide, and the
 * subject is the rule, not the transport.
 */

const conf = JSON.parse(
  readFileSync(fileURLToPath(new URL("../src-tauri/tauri.conf.json", import.meta.url)), "utf8"),
) as { app: { windows: Array<{ minWidth?: number; minHeight?: number }> } };
const win = conf.app.windows.find((w) => w.minWidth && w.minHeight)!;

test.use({ viewport: { width: win.minWidth!, height: win.minHeight! } });

const HOSTILE_NAME = "Bartholomew".repeat(18); // 198 chars, no break opportunity

test("a hostile peer name cannot escape the window", async ({ page }) => {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });

  const measured = await page.evaluate((name) => {
    // ReactionLayer's real markup. The container matters: .cp-reaction-float
    // is display:flex, which is what makes the name a flex item and lets
    // max-width apply at all. A first draft of this test used a plain <div>,
    // where the span stayed inline, max-width was ignored per spec, and the
    // fix appeared not to work.
    const host = document.createElement("div");
    host.className = "cp-reaction-layer";
    host.style.cssText = "position:fixed;left:0;top:200px;width:600px";
    host.innerHTML =
      `<span class="cp-reaction-float"><span class="cp-reaction-glyph">👍</span>` +
      `<span class="cp-reaction-name"></span></span>`;
    // textContent, never innerHTML: the name is remote input.
    const el = host.querySelector(".cp-reaction-name") as HTMLElement;
    el.textContent = name;
    document.body.appendChild(host);
    const cs = getComputedStyle(el);
    const b = el.getBoundingClientRect();
    const out = {
      width: Math.round(b.width),
      right: Math.round(b.right),
      viewport: window.innerWidth,
      textOverflow: cs.textOverflow,
      clipped: el.scrollWidth > el.clientWidth,
    };
    host.remove();
    return out;
  }, HOSTILE_NAME);

  expect(measured.right, "the name reaches past the window edge").toBeLessThanOrEqual(measured.viewport);
  // Bounded AND legible: an ellipsis means the reader can see it was truncated.
  expect(measured.textOverflow).toBe("ellipsis");
  expect(measured.clipped, "the long name is not actually being clipped").toBe(true);
});

test("an ordinary name is untouched", async ({ page }) => {
  // A cap that mangles normal names would be a worse bug than the one fixed.
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  const clipped = await page.evaluate(() => {
    const host = document.createElement("span");
    host.className = "cp-reaction-float";
    host.innerHTML = `<span class="cp-reaction-name"></span>`;
    const el = host.firstElementChild as HTMLElement;
    el.textContent = "Gasper Chiaramonte";
    document.body.appendChild(host);
    const out = el.scrollWidth > el.clientWidth;
    host.remove();
    return out;
  });
  expect(clipped, "a normal-length name is being truncated").toBe(false);
});

test("the lobby caps the name at the source too", async ({ page }) => {
  // Belt as well as braces: this build should not originate such a name.
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    // Both flags: without ytAuthOnboarded the connect modal is up and swallows
    // the nav click, which reads as "the Review button never appeared".
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.getByRole("button", { name: "Review", exact: true }).click();

  const field = page.getByRole("textbox", { name: "Your name" });
  if (await field.count()) {
    await field.fill(HOSTILE_NAME);
    const value = await field.inputValue();
    expect(value.length, "the name field accepted an unbounded string").toBeLessThanOrEqual(40);
  } else {
    // The lobby step may not be reachable without a session; assert the cap
    // exists in the source rather than skipping silently.
    const src = readFileSync(fileURLToPath(new URL("../src/components/CoReviewLobby.tsx", import.meta.url)), "utf8");
    expect(src).toMatch(/value=\{name\}[^>]*maxLength=\{\d+\}/s);
  }
});
