import { test, expect } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

for (const role of ["host", "peer"] as const) {
  test(`${role} entry reports actual devices, not saved-on preferences`, async ({ page }) => {
    await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
    await page.addInitScript(() => {
      localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
      localStorage.setItem("saucebunny.welcomed", "1");
      localStorage.setItem("saucebunny.permissioned", "1");
      localStorage.setItem("saucebunny.review.author", JSON.stringify("Capture test"));
      localStorage.setItem("saucebunny.mediaDevices", JSON.stringify({ cameraOff: false, micMuted: false }));
      localStorage.setItem("e2e.avGranted", "1");
      const getUserMedia = navigator.mediaDevices.getUserMedia;
      navigator.mediaDevices.getUserMedia = async constraints => {
        sessionStorage.setItem("capture-count", String(Number(sessionStorage.getItem("capture-count") ?? 0) + 1));
        return getUserMedia.call(navigator.mediaDevices, constraints);
      };
    });
    await page.goto("/");
    await expect(page.locator(".cp-view-home")).toBeVisible();
    await page.getByRole("button", { name: "Review", exact: true }).click();
    await expect(page.getByText("Camera off · Microphone off", { exact: true })).toBeVisible();
    await page.evaluate(r => {
      (window as unknown as { __TAURI_MOCK__: { emitTauriEvent: (name: string, payload: unknown) => void } }).__TAURI_MOCK__
        .emitTauriEvent("session:state", { role: r, code: "capture-fixture", selfId: r === "host" ? "m0" : "m1",
          presenter: "m0", presenterEpoch: 0, peers: [], title: "Capture state", error: null });
    }, role);
    const bar = page.getByRole("toolbar", { name: "Room controls" });
    await expect(bar.getByRole("button", { name: "Unmute microphone", exact: true })).toBeVisible();
    await expect(bar.getByRole("button", { name: "Turn camera on", exact: true })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem("capture-count"))).toBeNull();
    // Only this explicit click may open devices. The saved-on microphone
    // stays muted when the user asks only for their camera.
    await bar.getByRole("button", { name: "Turn camera on", exact: true }).click();
    await expect(bar.getByRole("button", { name: "Turn camera off", exact: true })).toBeVisible();
    await expect(bar.getByRole("button", { name: "Unmute microphone", exact: true })).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem("capture-count"))).toBe("1");
    await bar.getByRole("button", { name: "Turn camera off", exact: true }).click();
    await expect(bar.getByRole("button", { name: "Turn camera on", exact: true })).toBeVisible();
  });
}
