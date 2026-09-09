import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

async function boot(page: Page) {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1"); localStorage.setItem("saucebunny.permissioned", "1");
    const base = "/e2e-mock/Documents/Sauce Bunny";
    const key = "ndi:recorded-pass";
    const note = { id: "n1", versionId: "v1", parentId: null, timeStart: 0, timeEnd: null,
      body: "Please shorten the final shot", author: "Guest", resolved: false, annotation: null,
      createdAt: 1, updatedAt: 1, sessionId: "guest-local-id",
      timing: { kind: "manual", sourceId: key, pass: "Final pass", timecode: "01:02:03:04" } };
    const review = { sourceKey: key, versions: [], activeVersionId: null, status: {}, comments: [note,
      { ...note, id: "n2", parentId: "n1", body: "I will adjust it", author: "Editor" },
      { ...note, id: "other", body: "A different session note" }] };
    const session = { id: "s1", title: "Premiere review", startedAt: 1756000000000, endedAt: 1756000600000,
      role: "host", participants: [{ name: "Editor", isHost: true, joinedAt: 1, leftAt: 2 }],
      segments: [{ id: "seg1", kind: "ndi", url: null, fingerprint: null, localSourceKey: key,
        title: "Studio (Adobe Premiere Pro)", duration: null, startedAt: 1, endedAt: 2, commentIds: ["n1"], watched: true }] };
    const files = {
      [`${base}/Screenings/index.json`]: JSON.stringify({ version: 1, screenings: { s1: {
        file: "s1.json", title: session.title, startedAt: session.startedAt, endedAt: session.endedAt,
        participants: ["Editor", "Guest"], segmentCount: 1, commentCount: 1, bytes: 200,
        // Legacy index intentionally has neither sourceKeys nor sourceKinds.
      } } }),
      [`${base}/Screenings/s1.json`]: JSON.stringify(session),
      [`${base}/Reviews/index.json`]: JSON.stringify({ version: 1, docs: { [key]: { file: "review.json", bytes: 1000, count: 2, updatedAt: 1 } } }),
      [`${base}/Reviews/review.json`]: JSON.stringify(review),
    };
    localStorage.setItem("e2e.files", JSON.stringify(files));
    const w = window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a?: unknown) => Promise<unknown> }; archiveCalls: string[] };
    const original = w.__TAURI_INTERNALS__.invoke;
    w.archiveCalls = [];
    w.__TAURI_INTERNALS__.invoke = (c, a) => { w.archiveCalls.push(c); return original(c, a); };
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await page.getByRole("button", { name: "Past sessions in Library" }).click();
  await expect(page.locator('.cp-lib-lrow[data-path="s1"]')).toBeVisible();
  await page.evaluate(() => { (window as unknown as { archiveCalls: string[] }).archiveCalls = []; });
}

for (const [width, height, scale] of [[1100, 700, 1], [1100, 700, 1.25], [1680, 1020, 1], [1680, 1020, 1.25]]) {
  test(`saved notes and unclipped session search at ${width} / ${scale}`, async ({ page }) => {
    await page.setViewportSize({ width, height }); await boot(page);
    if (scale > 1) await page.addStyleTag({ content: ':root { --text-md: 15px; --text-base: 13.75px; --text-lg: 16.25px; --text-xl: 17.5px; }' });
    const field = page.getByRole("textbox", { name: "Search sessions and people" });
    expect(await field.evaluate(el => {
      const input = el as HTMLInputElement, style = getComputedStyle(input);
      const canvas = document.createElement("canvas"); const ctx = canvas.getContext("2d")!;
      ctx.font = style.font;
      return ctx.measureText(input.placeholder).width <= input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
    })).toBe(true);
    await field.fill("Guest"); await expect(page.locator('.cp-lib-lrow[data-path="s1"]')).toBeVisible();
    await page.getByRole("button", { name: "Clear search" }).click();
    await expect(page.getByTitle("Premiere Pro live session")).toBeVisible();
    const row = page.locator('.cp-lib-lrow[data-path="s1"]');
    await row.click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "Reveal in Finder" })).toHaveCount(0);
    await page.getByRole("menuitem", { name: "Open session" }).click();
    const reader = page.getByRole("region", { name: "Saved review session", exact: true });
    await expect(reader).toBeVisible();
    await expect(reader.getByText("Please shorten the final shot")).toBeVisible();
    await expect(reader.getByText("I will adjust it")).toBeVisible();
    await expect(reader.getByText("A different session note")).toHaveCount(0);
    await expect(reader.getByText(/Manual 01:02:03:04 · Unverified/)).toBeVisible();
    await expect(reader.getByRole("button", { name: "Open source in Clip" })).toHaveCount(0);
    const source = await reader.getByRole("region", { name: "Session source" }).boundingBox();
    const notes = await reader.getByRole("region", { name: "Saved session notes" }).boundingBox();
    expect(source!.x + source!.width).toBeLessThanOrEqual(notes!.x + 1);
    expect(notes!.x + notes!.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: `test-results/saved-session-${width}-${scale}.png` });
    await reader.getByRole("button", { name: "Back to sessions" }).click();
    await expect(row).toBeFocused();
    await row.press("Enter"); await expect(reader).toBeVisible();
    await reader.getByRole("button", { name: "Back to sessions" }).click();
    await page.getByRole("button", { name: "Grid view" }).click();
    const card = page.locator('.cp-sess-card[data-path="s1"]');
    await card.focus(); await card.press("Shift+F10");
    await page.keyboard.press("Escape"); await expect(card).toBeFocused();
    await card.dblclick(); await expect(reader).toBeVisible();
    const calls = await page.evaluate(() => (window as unknown as { archiveCalls: string[] }).archiveCalls);
    expect(calls.filter(c => /^(reveal_in_finder|probe_local_file|ndi_start|session_start|session_join|session_send|premiere_marker)/.test(c))).toEqual([]);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("e2e.files")!)["/e2e-mock/Documents/Sauce Bunny/Reviews/review.json"]);
    expect(JSON.parse(saved).comments).toHaveLength(3);
  });
}
