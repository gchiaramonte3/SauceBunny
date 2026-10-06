import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { multitrackFixture, multitrackTranscript } from "../src/test/multitrack-fixture";
import { tauriMockInit } from "./tauri-mock";

/**
 * AAF Audio transcripts on the Transcripts page are organized like
 * transcripts (docs/UI-CORRECTIONS-2026-10-05.md, item 17): named as AAF Audio
 * and String Outs name them, renamed and filed from a right-click menu,
 * dragged onto a project, and summarised when opened. "I can't organize
 * transcript AAFs in the folders. I can't right-click to rename."
 */
const ID = "a".repeat(64);
const PROJECTS = "/e2e-mock/Documents/Sauce Bunny/Transcripts/projects.json";

async function boot(page: Page) {
  const document = { ...multitrackFixture(), id: ID, transcripts: [multitrackTranscript()] };
  const summary = { id: ID, name: document.manifest.name, track_count: 3, transcribed_tracks: 1, source_path: document.source_path, modified_ms: 1_754_000_400_000 };
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(({ document, summary }) => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1"); localStorage.setItem("saucebunny.permissioned", "1");
    localStorage.setItem("e2e.transcripts", "1");
    if (localStorage.getItem("e2e.files") === null) localStorage.setItem("e2e.files", "{}");
    if (localStorage.getItem("e2e.aafList") === null) localStorage.setItem("e2e.aafList", JSON.stringify([summary]));
    const app = window as unknown as {
      __aafCalls: { command: string; args: Record<string, unknown> }[];
      __TAURI_INTERNALS__: { invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> };
      __TAURI_MOCK__: { emitTauriEvent: (event: string, payload: unknown) => void };
    };
    app.__aafCalls = [];
    const original = app.__TAURI_INTERNALS__.invoke;
    app.__TAURI_INTERNALS__.invoke = (command, args = {}) => {
      app.__aafCalls.push({ command, args });
      if (command === "aaf_open") return Promise.resolve(structuredClone(document));
      if (command === "aaf_rename") {
        // As the store does: a blank name goes back to the sequence's, and the change is announced.
        const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : undefined;
        localStorage.setItem("e2e.aafList", JSON.stringify([{ ...summary, title }]));
        setTimeout(() => app.__TAURI_MOCK__.emitTauriEvent("saucebunny:multitrack-changed", summary.id), 0);
        return Promise.resolve({ ...structuredClone(document), title });
      }
      return original(command, args);
    };
  }, { document, summary });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+5");
  await expect(page.locator(".cp-view-reader")).toBeVisible();
  await expect(page.getByRole("region", { name: "AAF Audio transcripts" })).toBeVisible({ timeout: 10_000 });
}

const calls = (page: Page, command: string) => page.evaluate((name) =>
  (window as unknown as { __aafCalls: { command: string; args: Record<string, unknown> }[] }).__aafCalls
    .filter((call) => call.command === name).map((call) => call.args), command);
const documentRow = (page: Page) => page.locator(`.cp-reader-row[data-path="aaf:${ID}"]`);
const centre = (b: { x: number; y: number; width: number; height: number }) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
async function dragTo(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 }); await page.mouse.up();
}
const filed = (page: Page) => page.evaluate((path) => {
  const text = (JSON.parse(localStorage.getItem("e2e.files") ?? "{}") as Record<string, string>)[path];
  return text ? (JSON.parse(text) as { version: number; projects: { folder: string; documents: string[] }[] }) : null;
}, PROJECTS);

test("an AAF Audio transcript goes by its sequence's name, and right-click renames it", async ({ page }) => {
  await boot(page);
  await expect(documentRow(page)).toContainText("Interview");
  await documentRow(page).click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem")).toHaveText(["Rename…", "Move to project…", "Open in AAF Audio", "Open in String Outs", "Reveal AAF in Finder", "Remove from Transcripts"]);
  // Reached by keyboard, as every menu here is.
  await expect(menu.getByRole("menuitem").first()).toBeFocused();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Rename transcript" });
  await expect(dialog.getByRole("textbox", { name: "Name" })).toHaveValue("Interview");
  await dialog.getByRole("textbox", { name: "Name" }).fill("Day 3, kitchen");
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  expect(await calls(page, "aaf_rename")).toEqual([{ documentId: ID, title: "Day 3, kitchen" }]);
  await expect(documentRow(page)).toContainText("Day 3, kitchen");
});

test("dragged onto a project it is filed there by reference, and dragged back it comes out", async ({ page }) => {
  await boot(page);
  const project = page.locator(".cp-reader-project").filter({ hasText: "Marry Harry" });
  await dragTo(page, centre((await documentRow(page).boundingBox())!), centre((await project.boundingBox())!));
  const group = page.locator(".cp-reader-group").filter({ has: project });
  if (await project.getByRole("button", { name: /Expand/ }).count()) await project.getByRole("button", { name: /Expand/ }).click();
  await expect(group.locator(`.cp-reader-row[data-path="aaf:${ID}"]`)).toBeVisible();
  await expect(page.getByRole("region", { name: "AAF Audio transcripts" })).toContainText("Every AAF Audio transcript is in a project");
  await page.screenshot({ path: test.info().outputPath("aaf-filed.png") });
  // Nothing moved on disk: the project lists it, in a file stamped with the version that knows how.
  expect((await calls(page, "move_transcript_to_folder")).length).toBe(0);
  await expect.poll(async () => (await filed(page))?.projects.find((p) => p.folder === "Marry Harry")?.documents).toEqual([ID]);
  expect((await filed(page))?.version).toBe(2);
  const heading = page.locator(".cp-reader-group-label").filter({ hasText: "AAF Audio" });
  await dragTo(page, centre((await documentRow(page).boundingBox())!), centre((await heading.boundingBox())!));
  await expect(page.getByRole("region", { name: "AAF Audio transcripts" }).locator(`.cp-reader-row[data-path="aaf:${ID}"]`)).toBeVisible();
  await expect.poll(async () => (await filed(page))?.projects.find((p) => p.folder === "Marry Harry")?.documents).toEqual([]);
});

test("opened, it is summarised above its text, and opens in AAF Audio or String Outs", async ({ page }) => {
  await boot(page);
  await documentRow(page).click();
  const summary = page.locator(".cp-multitrack-reader-head");
  await expect(summary.getByRole("heading", { name: "Interview" })).toBeVisible();
  for (const [term, value] of [["File", "Interview.aaf"], ["Tracks", "3 tracks, 1 transcribed"], ["Duration", "00:16:40:00"]]) {
    await expect(summary.locator("div").filter({ has: page.locator("dt", { hasText: term }) }).locator("dd")).toHaveText(value);
  }
  await page.screenshot({ path: test.info().outputPath("aaf-summary.png") });
  await summary.getByRole("button", { name: "Open in String Outs" }).click();
  await expect(page.locator(".cp-view-editor")).toBeVisible();
});

test("several selected transcripts dropped on a project all move", async ({ page }) => {
  await boot(page);
  for (const head of await page.locator(".cp-reader-group-label button, .cp-reader-project-chevbtn").all()) {
    if ((await head.getAttribute("aria-expanded")) === "false") await head.click();
  }
  const first = page.locator(".cp-reader-row").filter({ hasText: "first-interview" });
  const second = page.locator(".cp-reader-row").filter({ hasText: "second-interview" });
  await first.click({ modifiers: ["Meta"] }); await second.click({ modifiers: ["Meta"] });
  const project = page.locator(".cp-reader-project").filter({ hasText: "Marry Harry" });
  const start = centre((await first.boundingBox())!), end = centre((await project.boundingBox())!);
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2, { steps: 6 });
  await expect(page.locator(".cp-card-ghost")).toHaveText("2 transcripts");
  await page.mouse.move(end.x, end.y, { steps: 6 }); await page.mouse.up();
  await expect.poll(async () => (await calls(page, "move_transcript_to_folder")).map((args) => String(args.srtPath).split("/").pop()))
    .toEqual(["first-interview.srt", "second-interview.srt"]);
});

test("Remove from Transcripts takes it off this page and nowhere else", async ({ page }) => {
  await boot(page);
  await documentRow(page).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Remove from Transcripts" }).click();
  await expect(documentRow(page)).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("saucebunny.libraryHidden") ?? "")).toContain(`aaf:${ID}`);
});

