import { test, expect } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

test("failed setup recheck stays unknown until a successful retry", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 700 });
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.permissioned", "1");
    const runtime = window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> }; __installation: "missing" | "error" | "found"; __setupCommands: string[] };
    const original = runtime.__TAURI_INTERNALS__.invoke;
    runtime.__installation = "missing";
    runtime.__setupCommands = [];
    runtime.__TAURI_INTERNALS__.invoke = (command, args) => {
      runtime.__setupCommands.push(command);
      if (command === "ndi_preflight") {
        if (runtime.__installation === "error") return Promise.reject({ kind: "Io", data: "Cannot inspect the Premiere output plugin: permission denied" });
        return Promise.resolve({ bridgeCompiled: true, runtime: "ready", runtimeOrigin: "bundled", runtimeVersion: "6.3.2",
          premiereInstalled: true, premiereVersion: "26.3.2", pluginInstalled: runtime.__installation === "found", error: null });
      }
      return original(command, args);
    };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Integrations", exact: true }).click();
  const integration = page.getByRole("region", { name: "Premiere integration", exact: true });
  const status = integration.getByRole("status", { name: "NDI installation" });
  await expect(status).toHaveText("Premiere output plugin not found");
  await page.evaluate(() => {
    (window as unknown as { __installation: string }).__installation = "error";
    window.dispatchEvent(new Event("focus"));
  });
  await expect(status).toHaveText("Installation status unavailable");
  await expect(integration.getByRole("alert")).toContainText("Could not check Premiere setup");
  await expect(integration.getByRole("alert")).toContainText("permission denied");
  const retry = integration.getByRole("button", { name: "Check again", exact: true });
  await expect(retry).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath("premiere-setup-check-failed.png") });
  await page.evaluate(() => { (window as unknown as { __installation: string }).__installation = "found"; });
  await retry.focus();
  await retry.press("Enter");
  await expect(status).toHaveText("Premiere output plugin found");
  await expect(integration.getByRole("alert")).toHaveCount(0);
  await expect(retry).toBeFocused();
  const commands = await page.evaluate(() => (window as unknown as { __setupCommands: string[] }).__setupCommands);
  expect(commands.some(command => ["ndi_start", "ndi_publish", "premiere_bridge_start", "premiere_install_companion"].includes(command))).toBe(false);
});

for (const viewport of [{ width: 1100, height: 700 }, { width: 1680, height: 1020 }]) {
  for (const scale of [1, 1.25]) {
    test(`Premiere Settings matches shared recipes at ${viewport.width}px / ${scale}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
      await page.addInitScript(() => {
        localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
        localStorage.setItem("saucebunny.welcomed", "1");
        localStorage.setItem("saucebunny.permissioned", "1");
        const runtime = window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> }; __settingsCalls: string[] };
        const original = runtime.__TAURI_INTERNALS__.invoke;
        runtime.__settingsCalls = [];
        runtime.__TAURI_INTERNALS__.invoke = (command, args) => {
          runtime.__settingsCalls.push(command);
          if (command === "ndi_preflight") return Promise.resolve({ bridgeCompiled: true, runtime: "ready", runtimeOrigin: "bundled",
            runtimeVersion: `NDI SDK ${"long-version-metadata-".repeat(20)}`, premiereInstalled: true, premiereVersion: "26.3.2", pluginInstalled: true, error: null });
          return original(command, args);
        };
      });
      await page.goto("/");
      await expect(page.locator(".cp-view-home")).toBeVisible();
      await page.evaluate(scale => {
        const style = getComputedStyle(document.documentElement);
        const tokens = ["base", "sm", "md", "lg", "xl", "2xl", "3xl"].map(name => [`--text-${name}`, parseFloat(style.getPropertyValue(`--text-${name}`)) * scale] as const);
        for (const [name, value] of tokens) document.documentElement.style.setProperty(name, `${value}px`);
      }, scale);
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "General", exact: true }).click();
      const reference = await dialog.locator(".cp-pane-title").evaluate(element => {
        const style = getComputedStyle(element);
        return { size: style.fontSize, family: style.fontFamily, weight: style.fontWeight, margin: style.marginTop };
      });
      const sectionSize = await dialog.locator(".cp-section-head .label").first().evaluate(element => getComputedStyle(element).fontSize);
      await dialog.getByRole("button", { name: "Integrations", exact: true }).click();
      const integration = dialog.getByRole("region", { name: "Premiere integration", exact: true });
      const title = integration.getByRole("heading", { name: "Premiere Beta", exact: true });
      await expect(title).toHaveCSS("font-size", reference.size);
      await expect(title).toHaveCSS("font-family", reference.family);
      await expect(title).toHaveCSS("font-weight", reference.weight);
      await expect(title).toHaveCSS("margin-top", reference.margin);
      await expect(integration.locator(".cp-pane-sub")).toHaveCSS("font-size", `${12 * scale}px`);
      await expect(integration.getByRole("status", { name: "NDI installation" })).toHaveCSS("font-size", `${11 * scale}px`);
      const connection = integration.getByRole("button", { name: "Connection details", exact: true });
      await expect(connection.locator(".label")).toHaveCSS("font-size", sectionSize);
      await expect(connection).toHaveAttribute("aria-expanded", "false");
      await expect(integration.getByText(/NDI runtime NDI SDK/)).not.toBeVisible();
      await connection.focus();
      await connection.press("Space");
      await expect(connection).toHaveAttribute("aria-expanded", "true");
      await expect(integration.getByText(/NDI runtime NDI SDK/)).toBeVisible();
      for (const button of await integration.locator(".btn:visible").all()) {
        await expect(button).toHaveCSS("text-transform", "none");
        await expect(button).toHaveCSS("font-size", `${12 * scale}px`);
        expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(30);
      }
      expect(await integration.evaluate(element => {
        const bounds = element.getBoundingClientRect();
        return [...element.querySelectorAll<HTMLElement>("p,button,h3,h4")].filter(child => child.checkVisibility())
          .filter(child => child.getBoundingClientRect().right > bounds.right + 1).map(child => child.textContent);
      })).toEqual([]);
      await connection.click();
      await integration.getByRole("button", { name: "Check again", exact: true }).click();
      await expect(integration.getByRole("status", { name: "NDI installation" })).toHaveText("Premiere output plugin found");
      const calls = await page.evaluate(() => (window as unknown as { __settingsCalls: string[] }).__settingsCalls);
      expect(calls.filter(command => command === "ndi_preflight").length).toBeGreaterThanOrEqual(2);
      expect(calls.some(command => ["ndi_start", "ndi_publish", "premiere_bridge_start", "premiere_install_companion", "ndi_timing_probe_start"].includes(command))).toBe(false);
      await page.screenshot({ path: test.info().outputPath("premiere-settings.png") });
      await page.keyboard.press("Escape");
      await expect(dialog).not.toBeVisible();
    });
  }
}
