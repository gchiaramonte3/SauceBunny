import { expect, test } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";
import { parsePremierePairingCode } from "../src/lib/premiere-pairing-code";

for (const viewport of [{ width: 1100, height: 700 }, { width: 1680, height: 1020 }]) {
  test(`companion setup is opt-in and separate from NDI at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
    await page.addInitScript(() => {
      localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
      localStorage.setItem("saucebunny.welcomed", "1"); localStorage.setItem("saucebunny.permissioned", "1");
      const w = window as unknown as { __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> }; __premiereCalls: string[] };
      const original = w.__TAURI_INTERNALS__.invoke;
      let phase = "off"; w.__premiereCalls = [];
      Object.defineProperty(navigator, "clipboard", { value: { writeText: async (text: string) => {
        (window as unknown as { __copiedPairing: string }).__copiedPairing = text;
      } }, configurable: true });
      w.__TAURI_INTERNALS__.invoke = async (command, args) => {
        if (command.startsWith("premiere_") || command === "ndi_start") w.__premiereCalls.push(command);
        if (command === "premiere_bridge_status") return { phase, binding: null, syncEnabled: false,
          automaticPlacement: false, pendingCount: 0, otherBindingPendingCount: 0, ledgerRevision: 0, error: null };
        if (command === "premiere_bridge_start") { phase = "pairing"; return { url: "ws://127.0.0.1:39000/premiere", token: "a".repeat(64), expiresAt: Date.now() + 300000 }; }
        if (command === "premiere_bridge_stop") { phase = "off"; return null; }
        if (command === "premiere_install_companion") return null;
        return original(command, args);
      };
    });
    await page.goto("/"); await expect(page.locator(".cp-view-home")).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Settings" });
    await dialog.getByRole("button", { name: "Integrations", exact: true }).click();
    const setup = dialog.getByRole("region", { name: "Premiere timeline markers" });
    await expect(setup.getByText(/Automatic placement is off/)).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __premiereCalls: string[] }).__premiereCalls))
      .not.toContain("premiere_bridge_start");
    const pair = setup.getByRole("button", { name: "Pair companion…" });
    await pair.focus(); await page.keyboard.press("Space");
    const copy = setup.getByRole("button", { name: "Copy pairing code" });
    await copy.click();
    await expect(setup.getByText("Copied. Paste in Premiere.")).toBeVisible();
    const code = await page.evaluate(() => (window as unknown as { __copiedPairing: string }).__copiedPairing);
    expect(parsePremierePairingCode(code)).toMatchObject({ url: "ws://127.0.0.1:39000/premiere", token: "a".repeat(64) });
    await expect(setup.locator(".cp-premiere-pairing input")).toHaveCount(0);
    await page.screenshot({ path: `test-results/premiere-pairing-${viewport.width}.png` });
    await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => { throw new Error("Clipboard unavailable"); } }, configurable: true }); });
    await copy.click();
    await expect(setup.getByRole("alert")).toContainText("Clipboard unavailable");
    await expect(setup.getByText("Copied. Paste in Premiere.")).toHaveCount(0);
    await setup.getByRole("button", { name: "Disconnect companion" }).click();
    await expect(copy).toHaveCount(0);
    await setup.getByRole("button", { name: "Install Premiere companion…" }).click();
    const calls = await page.evaluate(() => (window as unknown as { __premiereCalls: string[] }).__premiereCalls);
    expect(calls.filter(command => command === "premiere_bridge_start")).toHaveLength(1);
    expect(calls).toContain("premiere_install_companion"); expect(calls).not.toContain("ndi_start");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeFocused();
  });
}
