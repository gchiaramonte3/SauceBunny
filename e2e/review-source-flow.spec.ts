import { expect, test, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

async function boot(page: Page) {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1"); localStorage.setItem("saucebunny.permissioned", "1");
    localStorage.setItem("saucebunny.review.author", JSON.stringify("Review editor"));
    localStorage.setItem("saucebunny.queueDrawerActiveTab", "review");
    localStorage.setItem("e2e.avGranted", "1"); localStorage.setItem("e2e.files", "{}");
    const fixture = window as unknown as { __reviewSourceCalls: string[]; __TAURI_INTERNALS__: { invoke: (command: string, args?: unknown) => Promise<unknown> } };
    const original = fixture.__TAURI_INTERNALS__.invoke;
    fixture.__reviewSourceCalls = [];
    fixture.__TAURI_INTERNALS__.invoke = (command, args) => {
      fixture.__reviewSourceCalls.push(command);
      if (command === "ndi_discover") return Promise.resolve({ bridgeCompiled: true, runtime: "ready", sources: [], error: null });
      if (command === "plugin:dialog|open") return Promise.resolve("/e2e-mock/review-source.mp4");
      if (command === "probe_local_file") return Promise.resolve({ path: "/e2e-mock/review-source.mp4", filename: "review-source.mp4",
        size_bytes: 4096, duration: 120, width: 1920, height: 1080, fps: 24, vcodec: "h264", acodec: "aac", has_video: true, has_audio: true });
      // Local media bytes stay pending: these checks cover source selection,
      // layout and note ownership, not decoding or playback quality.
      if (command === "read_file_range") return new Promise(() => {});
      return original(command, args);
    };
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible();
  await page.locator(".cp-nav-item").filter({ hasText: "Review" }).first().click();
}

async function loadWeb(page: Page) {
  const source = page.getByRole("textbox", { name: "Load a source for the room" });
  await source.fill("https://youtube.com/watch?v=aaaa");
  await page.getByRole("button", { name: "Load source", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Comment", exact: true })).toBeVisible();
  await expect(source).toHaveValue("https://youtube.com/watch?v=aaaa");
}

for (const viewport of [{ width: 1100, height: 700 }, { width: 1680, height: 1020 }]) {
  for (const scale of [1, 1.25]) test(`Review start offers reachable source choices at ${viewport.width}px / ${scale}`, async ({ page }) => {
    await page.setViewportSize(viewport); await boot(page);
    await page.evaluate(scale => {
      const root = document.documentElement, css = getComputedStyle(root);
      const sizes = ["--text-sm", "--text-base", "--text-md", "--text-2xl", "--text-3xl"]
        .map(token => [token, `${parseFloat(css.getPropertyValue(token)) * scale}px`]);
      for (const [token, size] of sizes) root.style.setProperty(token, size);
    }, scale);
    const starter = page.getByRole("region", { name: "Choose a review source" });
    await expect(starter.getByRole("heading", { name: "What would you like to share?" })).toBeVisible();
    await expect(starter.getByRole("button")).toHaveCount(6);
    await expect(page.locator(".cp-empty-resume")).toHaveCount(0);
    for (const button of await starter.getByRole("button").all()) {
      await button.scrollIntoViewIfNeeded();
      const hit = await button.evaluate(element => { const r = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); });
      expect(hit, await button.innerText()).toBe(true);
    }
    await page.screenshot({ path: test.info().outputPath("review-source-start.png") });
    for (const kind of ["Screen", "Window", "Region", "NDI"]) {
      await starter.getByRole("button", { name: new RegExp(`^${kind} `) }).click();
      const dialog = page.getByRole("dialog", { name: "Source settings", exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole("tab", { name: kind, exact: true })).toHaveAttribute("aria-selected", "true");
      await dialog.getByRole("button", { name: "Done", exact: true }).click();
    }
    expect(await page.evaluate(() => (window as unknown as { __reviewSourceCalls: string[] }).__reviewSourceCalls
      .filter(command => /^(session_start|session_host|session_join|ndi_start|ndi_publish|obs_start|obs_broadcast_start|start_screen_share|recording_start)$/.test(command)))).toEqual([]);
  });
}

test("Review start Link and Local file use the existing loading flow", async ({ page }) => {
  await boot(page);
  const starter = page.getByRole("region", { name: "Choose a review source" });
  await starter.getByRole("button", { name: /^Link / }).click();
  const field = starter.getByRole("textbox", { name: "Video URL" });
  await expect(field).toBeFocused();
  await field.fill("https://youtube.com/watch?v=aaaa");
  await field.press("Escape");
  await expect(starter.getByRole("button", { name: /^Link / })).toBeFocused();
  await starter.getByRole("button", { name: /^Link / }).click();
  await field.press("Enter");
  await expect(page.getByRole("textbox", { name: "Comment", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear", exact: true }).click();
  await starter.getByRole("button", { name: /^Local file / }).click();
  await expect(page.getByRole("textbox", { name: "Comment", exact: true })).toBeVisible();
});

for (const viewport of [{ width: 1100, height: 700 }, { width: 1680, height: 1020 }]) {
  for (const scale of [1, 1.25]) test(`private Review source and transport fit at ${viewport.width}px / ${scale}`, async ({ page }) => {
    await page.setViewportSize(viewport); await boot(page);
    await page.evaluate(scale => {
      const root = document.documentElement, css = getComputedStyle(root);
      const sizes = ["--text-sm", "--text-base", "--text-md", "--text-lg", "--text-xl", "--text-2xl"]
        .map(token => [token, `${parseFloat(css.getPropertyValue(token)) * scale}px`]);
      for (const [token, size] of sizes) root.style.setProperty(token, size);
    }, scale);
    await loadWeb(page);
    const main = page.locator(".cp-view-clip .cp-main"), bounds = (await main.boundingBox())!;
    const title = main.locator(".cp-room-title .cp-room-name");
    expect(await title.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
    const controls = main.locator(".cp-preview-head button, .cp-preview-head input, .cp-transport button:visible");
    expect(await controls.count()).toBeGreaterThan(6);
    for (const control of await controls.all()) {
      const box = (await control.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(bounds.x);
      expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
      expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height + 1);
      if (await control.evaluate(element => element.tagName === "BUTTON")) {
        const hit = await control.evaluate(element => { const r = element.getBoundingClientRect();
          return element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); });
        expect(hit, await control.getAttribute("aria-label") ?? await control.innerText()).toBe(true);
      }
    }
    await expect(main.getByRole("button", { name: "Source settings", exact: true })).toBeVisible();
    await expect(main.locator(".cp-volume > button")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("private-review-layout.png") });
  });
}

for (const viewport of [{ width: 1100, height: 700 }, { width: 1680, height: 1020 }]) {
  for (const scale of [1, 1.25]) test(`Review setup actions share the rail width at ${viewport.width}px / ${scale}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.route("https://**", route => route.abort());
    await boot(page);
    await page.evaluate(scale => {
      const root = document.documentElement, css = getComputedStyle(root);
      const sizes = ["--text-xs", "--text-sm", "--text-base", "--text-md", "--text-lg", "--text-xl", "--text-2xl", "--text-3xl"]
        .map(token => [token, `${parseFloat(css.getPropertyValue(token)) * scale}px`]);
      for (const [token, size] of sizes) root.style.setProperty(token, size);
    }, scale);
    const setup = page.getByRole("region", { name: "Session setup", exact: true });
    const liveSource = setup.getByRole("button", { name: "Choose live source…", exact: true });
    const start = setup.getByRole("button", { name: "Start session", exact: true });
    for (const action of ["Start session", "Join"] as const) {
      if (action === "Join") {
        await setup.getByRole("tab", { name: "Join a session", exact: true }).click();
        await expect(start).toBeHidden();
      }
      const button = setup.getByRole("button", { name: action, exact: true });
      await expect(button).toBeInViewport(); await expect(liveSource).toBeInViewport();
      const bounds = (await button.boundingBox())!, reference = (await liveSource.boundingBox())!;
      expect(Math.abs(bounds.x - reference.x), `${action} left edge`).toBeLessThanOrEqual(1);
      expect(Math.abs(bounds.x + bounds.width - reference.x - reference.width), `${action} right edge`).toBeLessThanOrEqual(1);
      expect(Math.abs(bounds.width - reference.width), `${action} width`).toBeLessThanOrEqual(1);
      await page.screenshot({ path: test.info().outputPath(`review-setup-${action === "Join" ? "join" : "host"}.png`) });
    }
    expect(await page.evaluate(() => (window as unknown as { __reviewSourceCalls: string[] }).__reviewSourceCalls
      .filter(command => /^(session_start|session_host|session_join|ndi_start|ndi_publish|obs_start|obs_broadcast_start|recording_start)$/.test(command)))).toEqual([]);
  });
}

for (const kind of ["web", "file"]) test(`${kind} Review notes do not require source settings or a room`, async ({ page }) => {
  await boot(page);
  if (kind === "web") await loadWeb(page);
  else await page.getByRole("button", { name: "File", exact: true }).click();
  const note = page.getByRole("textbox", { name: "Comment", exact: true });
  await expect(note).toBeEnabled(); await note.fill("My private note stays here");
  await note.evaluate(element => element.setAttribute("data-review-source-retained", "same"));
  await page.getByRole("button", { name: "Session setup…", exact: true }).click();
  await expect(note).toBeHidden();
  await page.getByRole("button", { name: "Review notes", exact: true }).click();
  await expect(note).toHaveValue("My private note stays here");
  await page.getByRole("button", { name: "Source settings", exact: true }).click();
  await page.getByRole("dialog", { name: "Source settings" }).getByRole("button", { name: "Done", exact: true }).click();
  await expect(note).toHaveValue("My private note stays here");
  await expect(note).toHaveAttribute("data-review-source-retained", "same");
  expect(await page.evaluate(() => (window as unknown as { __reviewSourceCalls: string[] }).__reviewSourceCalls
    .filter(command => /^(ndi_start|obs_start|obs_broadcast_start|session_host|session_join)$/.test(command)))).toEqual([]);
});
