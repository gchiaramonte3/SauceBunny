import { expect, test, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

type Content = "empty" | "folder" | "recent" | "transcripts";

async function boot(page: Page, content: Content = "empty") {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/*", route => {
    const host = new URL(route.request().url()).hostname;
    return host === "localhost" || host === "127.0.0.1" ? route.continue() : route.abort();
  });
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(content => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.permissioned", "1");
    if (content === "folder") localStorage.setItem("saucebunny.libraryRoots", JSON.stringify(["/e2e-mock/Footage"]));
    if (content === "transcripts") localStorage.setItem("e2e.transcripts", "1");
    if (content === "recent") localStorage.setItem("saucebunny.recentSources", JSON.stringify([
      { kind: "file", value: "/e2e-mock/Assembly.mov", title: "Assembly", durationSeconds: 120, lastOpenedAt: Date.now() },
    ]));
    const fixture = window as unknown as {
      __homeWelcomeCalls: string[];
      __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> };
    };
    const invoke = fixture.__TAURI_INTERNALS__.invoke;
    fixture.__homeWelcomeCalls = [];
    fixture.__TAURI_INTERNALS__.invoke = (command, args) => {
      fixture.__homeWelcomeCalls.push(command);
      if (command === "plugin:dialog|open") return Promise.resolve(null);
      return invoke(command, args);
    };
  }, content);
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

for (const viewport of [{ width: 1100, height: 700 }, { width: 1680, height: 1020 }, { width: 2200, height: 1100 }]) {
  for (const scale of [1, 1.25]) test(`empty Home fills the viewport at ${viewport.width}px / ${scale}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await boot(page);
    await page.evaluate(scale => {
      const root = document.documentElement, css = getComputedStyle(root);
      const sizes = ["--text-md", "--text-lg", "--text-5xl"]
        .map(token => [token, `${parseFloat(css.getPropertyValue(token)) * scale}px`]);
      for (const [token, size] of sizes) root.style.setProperty(token, size);
    }, scale);
    const home = page.locator(".cp-view-home .cp-lib");
    const hero = home.getByRole("region", { name: "Get started" });
    await expect(hero).toBeVisible();
    await expect(home.locator(".cp-lib-rows")).toHaveCount(0);
    const bounds = (await home.boundingBox())!, welcome = (await hero.boundingBox())!;
    expect(Math.abs(welcome.y + welcome.height - bounds.y - bounds.height)).toBeLessThanOrEqual(1);
    expect(await home.evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
    expect(await home.evaluate(el => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    expect(await hero.evaluate(el => getComputedStyle(el).backgroundImage)).toBe("none");
    for (const button of await hero.getByRole("button").all()) {
      const box = (await button.boundingBox())!;
      expect(box.y).toBeGreaterThan(bounds.y);
      expect(box.y + box.height).toBeLessThan(bounds.y + bounds.height);
      expect(await button.evaluate(el => {
        const r = el.getBoundingClientRect();
        return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
      })).toBe(true);
    }
    await page.screenshot({ path: test.info().outputPath("home-welcome.png") });
  });
}

test("welcome actions remain keyboard operable and keep the Clip player mounted", async ({ page }) => {
  await boot(page);
  const hero = page.getByRole("region", { name: "Get started" });
  await page.locator(".cp-view-clip .cp-monitor-area").evaluate(el => el.setAttribute("data-retained-player", "yes"));
  await hero.getByRole("button", { name: "Add a folder", exact: true }).focus();
  await page.keyboard.press("Enter");
  expect(await page.evaluate(() => (window as unknown as { __homeWelcomeCalls: string[] }).__homeWelcomeCalls
    .filter(command => command === "plugin:dialog|open"))).toHaveLength(1);
  await page.keyboard.press("Tab");
  await expect(hero.getByRole("button", { name: "Paste a URL", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".cp-view-clip")).toBeVisible();
  await expect(page.locator(".cp-view-clip .cp-monitor-area")).toHaveAttribute("data-retained-player", "yes");
});

test("search can leave and restore the full-height welcome", async ({ page }) => {
  await boot(page);
  const search = page.getByRole("textbox", { name: "Search library", exact: true });
  await search.fill("missing footage");
  await expect(page.getByText("No matches for “missing footage”.")).toBeVisible();
  await expect(page.locator(".cp-lib-start")).toHaveCount(0);
  await search.press("Escape");
  await expect(page.getByRole("heading", { name: "Welcome to Sauce Bunny" })).toBeVisible();
  await expect(page.locator(".cp-lib-start")).toBeVisible();
});

for (const content of ["folder", "recent", "transcripts"] as const) test(`${content} Home retains its populated shelves`, async ({ page }) => {
  await boot(page, content);
  const title = content === "folder" ? "Footage" : content === "recent" ? "Continue" : "Transcribed";
  await expect(page.locator(".cp-lib-row-title").filter({ hasText: new RegExp(`^${title}$`) })).toBeVisible();
  await expect(page.locator(".cp-lib-start")).toHaveCount(0);
  await expect(page.locator(".cp-lib-rows")).toBeVisible();
  if (content === "recent") {
    await expect(page.getByRole("region", { name: "Continue watching" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Resume", exact: true })).toBeEnabled();
  }
});
