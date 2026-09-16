import { expect, test, type Locator, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { multitrackFixture } from "../src/test/multitrack-fixture";
import { tauriMockInit } from "./tauri-mock";

async function boot(page: Page, mixed = false) {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(({ mixed, sequence }) => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1"); localStorage.setItem("saucebunny.permissioned", "1");
    localStorage.setItem("saucebunny.libraryRoots", JSON.stringify(["/e2e-mock/Footage"]));
    localStorage.setItem("e2e.transcripts", "1");
    localStorage.setItem("e2e.aafList", JSON.stringify([{ id: sequence.id, name: "Saved microphones", track_count: 3, transcribed_tracks: 0, source_path: sequence.source_path }]));
    if (mixed && !localStorage.getItem("e2e.organization")) localStorage.setItem("e2e.organization", JSON.stringify({ version: 1, favorites: [], assets: [
      { id: "file", kind: "file", locator: "/e2e-mock/Footage/clip-a.mp4", title: "Local picture" },
      { id: "web", kind: "web", locator: "https://example.com/reference", title: "Web reference" },
      { id: "text", kind: "transcript", locator: "/e2e-mock/words.srt", title: "Interview words" },
      { id: "multi", kind: "multitrack", locator: sequence.id, title: "Saved microphones" },
      { id: "missing", kind: "file", locator: "/missing/clip.mov", title: "Missing picture" },
    ], folders: [{ id: "show", parentId: null, name: "Show", assetIds: ["file", "web", "text", "multi", "missing"], rule: null }] }));
    const app = window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } };
    const original = app.__TAURI_INTERNALS__.invoke;
    app.__TAURI_INTERNALS__.invoke = (cmd, args) => {
      if (cmd === "aaf_open") return Promise.resolve(sequence);
      if (cmd === "aaf_waveform") return Promise.resolve({ track_id: args?.trackId, peaks: [] });
      if (cmd === "plugin:dialog|open") return Promise.resolve(localStorage.getItem("e2e.picked") ?? null);
      if (cmd === "read_text_file_capped" && args?.path === "/e2e-mock/words.srt") return Promise.resolve("1\n00:00:01,000 --> 00:00:03,000\nProject transcript sentence.\n");
      return original(cmd, args);
    };
  }, { mixed, sequence: multitrackFixture() });
  await page.goto("/"); await expect(page.locator(".cp-view-home")).toBeVisible();
  await page.keyboard.press("Meta+2"); await expect(page.getByRole("button", { name: "Add to Library", exact: true })).toBeVisible();
}
const stored = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem("e2e.organization") ?? "null"));
const commands = (page: Page) => page.evaluate(() => (window as unknown as { __TAURI_MOCK__: { invoked: () => { cmd: string; args: Record<string, unknown> }[] } }).__TAURI_MOCK__.invoked());
async function newFolder(page: Page, name: string, smart = false) {
  await page.getByRole("button", { name: "Add to Library", exact: true }).click();
  await page.getByRole("menuitem", { name: smart ? "New smart folder…" : "New in-app folder…", exact: true }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  return page.getByRole("dialog", { name: "New in-app folder" });
}
async function drag(page: Page, from: Locator, to: Locator) {
  const a = (await from.boundingBox())!, b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2); await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2, { steps: 3 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 8 }); await page.mouse.up();
}

test("project hierarchy, mixed references, keyboard undo and durable reopen never move originals", async ({ page }) => {
  await boot(page);
  await (await newFolder(page, "Episode")).getByRole("button", { name: "Create folder" }).click();
  await page.getByRole("button", { name: "New folder", exact: true }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Interviews");
  await page.getByRole("button", { name: "Create folder", exact: true }).click();
  await page.getByRole("button", { name: "Add items…" }).click();
  const modal = page.getByRole("dialog", { name: "Add to project folder" });
  for (const name of ["clip-a.mp4", "First clip", "first-interview", "Saved microphones"]) await modal.getByRole("checkbox", { name: new RegExp(name) }).check();
  await modal.getByRole("button", { name: "Add references" }).click();
  const pane = page.getByRole("region", { name: "Project folder contents" });
  await expect(pane.locator(".cp-project-item")).toHaveCount(4);
  await pane.getByRole("button", { name: "Actions for clip-a.mp4" }).click();
  await page.getByRole("menuitem", { name: "Remove from this folder" }).click();
  await expect(pane.locator(".cp-project-item")).toHaveCount(3);
  await page.keyboard.press("Meta+z"); await expect(pane.locator(".cp-project-item")).toHaveCount(4);
  await page.keyboard.press("Meta+Shift+z"); await expect(pane.locator(".cp-project-item")).toHaveCount(3);
  await page.keyboard.press("Meta+z"); await expect(pane.locator(".cp-project-item")).toHaveCount(4);
  const saved = await stored(page); expect(saved.assets.map((a: { kind: string }) => a.kind).sort()).toEqual(["file", "multitrack", "transcript", "web"]);
  expect(saved.folders[1].parentId).toBe(saved.folders[0].id);
  await page.reload(); await page.keyboard.press("Meta+2");
  await page.locator(".cp-project-sidebar .cp-project-location").filter({ hasText: "Interviews" }).click();
  await expect(pane.locator(".cp-project-item")).toHaveCount(4);
  expect((await commands(page)).filter((c) => /move_library|copy_library|rename_path|move_transcript|trash|delete_/.test(c.cmd))).toEqual([]);
});

test("folder drag, favorite order, missing media and explicit relink remain reference-only", async ({ page }) => {
  await boot(page, true);
  await (await newFolder(page, "Second")).getByRole("button", { name: "Create folder" }).click();
  const sidebar = page.locator(".cp-project-sidebar");
  await drag(page, sidebar.locator("[data-project-source]").filter({ hasText: "Second" }), sidebar.locator("[data-project-parent='show']"));
  await expect.poll(async () => (await stored(page)).folders.find((f: { name: string }) => f.name === "Second").parentId).toBe("show");
  for (const name of ["Show", "Second"]) {
    await sidebar.getByRole("button", { name: `Actions for ${name}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "Add to Favorites" }).click();
  }
  const favorites = page.getByRole("region", { name: "Favorites", exact: true });
  await drag(page, favorites.locator("[data-favorite-source]").filter({ hasText: "Second" }), favorites.locator("[data-favorite-target]").filter({ hasText: "Show" }));
  await expect.poll(async () => (await stored(page)).favorites.map((f: { name: string }) => f.name)).toEqual(["Second", "Show"]);
  await favorites.getByRole("button", { name: "Favorite actions for Second" }).click();
  await page.getByRole("menuitem", { name: "Move down" }).click();
  await expect.poll(async () => (await stored(page)).favorites.map((f: { name: string }) => f.name)).toEqual(["Show", "Second"]);
  await sidebar.locator("[data-project-source='show']").click();
  const missing = page.locator(".cp-project-item").filter({ hasText: "Missing picture" });
  await expect(missing).toContainText("Offline");
  await missing.getByRole("button", { name: "Actions for Missing picture" }).click();
  await page.evaluate(() => localStorage.setItem("e2e.picked", "/e2e-mock/reconnected.mov"));
  await page.getByRole("menuitem", { name: "Relink…", exact: true }).click();
  await expect.poll(async () => (await stored(page)).assets.find((a: { id: string }) => a.id === "missing").locator).toBe("/e2e-mock/reconnected.mov");
  await page.keyboard.press("Meta+z"); await expect(missing).toContainText("Offline");
  expect((await commands(page)).some((c) => c.cmd === "move_library_file")).toBe(false);
});

test("smart rules persist and failed writes keep prior folders", async ({ page }) => {
  await boot(page, true);
  const modal = await newFolder(page, "Offline originals", true);
  await modal.getByRole("combobox", { name: "Status", exact: true }).selectOption("offline");
  await modal.getByRole("button", { name: "Create folder" }).click();
  const pane = page.getByRole("region", { name: "Project folder contents" });
  await expect(pane.locator(".cp-project-item")).toHaveCount(1); await expect(pane).toContainText("Missing picture");
  await pane.getByRole("button", { name: "Edit rules…" }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Must not persist");
  await page.evaluate(() => localStorage.setItem("e2e.organizationRefuse", "1"));
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Disk full");
  expect((await stored(page)).folders.some((f: { name: string }) => f.name === "Must not persist")).toBe(false);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("saved Multitrack and transcript references open their actual existing views", async ({ page }) => {
  await boot(page, true);
  await page.locator("[data-project-source='show']").click();
  await page.locator(".cp-project-item-open").filter({ hasText: "Saved microphones" }).click();
  await expect(page.getByRole("region", { name: "Multitrack", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Open saved multitrack" })).toHaveValue("sequence-test");
  await page.keyboard.press("Meta+2");
  await page.locator(".cp-project-item-open").filter({ hasText: "Interview words" }).click();
  // Library transcript opening deliberately uses the same Clip + transcript
  // route as Home/history, not a second, project-only reader behavior.
  await expect(page.locator(".cp-view-clip")).toBeVisible();
  await expect(page.locator(".cp-view-clip")).toContainText("Project transcript sentence.");
});

test("300-item pages expose every file without selecting unseen items", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("e2e.manyFiles", "315"));
  await boot(page);
  await expect(page.locator(".cp-lib-pane .cp-lib-card:not(.cp-lib-foldercard)")).toHaveCount(300);
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.locator(".cp-lib-pane .cp-lib-card:not(.cp-lib-foldercard)")).toHaveCount(18);
  await expect(page.locator(".cp-lib-statusbar")).toContainText("Page 2 of 2");
  await page.locator(".cp-lib-pane .cp-lib-card:not(.cp-lib-foldercard)").first().focus();
  await page.keyboard.press("Meta+a");
  await expect(page.locator(".cp-lib-pane .cp-lib-card.selected")).toHaveCount(18);
  await page.getByRole("button", { name: "Previous page" }).click();
  await expect(page.locator(".cp-lib-pane .cp-lib-card:not(.cp-lib-foldercard)")).toHaveCount(300);
});

test("project controls and dialogs fit a narrow, enlarged-text layout", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 750 }); await boot(page, true);
  await page.evaluate(() => document.documentElement.style.setProperty("--text-md", "16px"));
  await page.locator("[data-project-source='show']").click();
  await page.getByRole("button", { name: "Add items…" }).click();
  const dialog = page.getByRole("dialog", { name: "Add to project folder" });
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  const box = (await dialog.boundingBox())!; expect(box.x).toBeGreaterThanOrEqual(0); expect(box.y + box.height).toBeLessThanOrEqual(750);
  await page.screenshot({ path: test.info().outputPath("library-project-dialog.png") });
  await page.keyboard.press("Escape");
  expect(await page.locator(".cp-view-library").evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: test.info().outputPath("library-project-folder.png") });
});

test("deep browsing and the full disk move picker do not register redundant roots", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("e2e.deepLibrary", "1"));
  await boot(page);
  const tree = page.getByRole("tree", { name: "Library folders" });
  await tree.getByRole("treeitem", { name: "Season", exact: true }).click();
  await tree.getByRole("treeitem", { name: "Episode", exact: true }).click();
  await tree.getByRole("treeitem", { name: "Selects", exact: true }).click();
  await tree.getByRole("treeitem", { name: "Takes", exact: true }).click();
  await expect(page.locator(".cp-lib-pane")).toContainText("deep-take.mov");
  expect((await commands(page)).filter((c) => c.cmd === "scan_library_folder" && c.args.path === "/e2e-mock/Footage/Season/Episode/Selects").map((c) => c.args.maxDepth)).toEqual([1]);
  await tree.getByRole("treeitem", { name: "Footage", exact: true }).click();
  await page.locator(".cp-lib-pane .cp-lib-card:not(.cp-lib-foldercard)").filter({ hasText: "root.mov" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: /Move to folder/ }).click();
  const modal = page.getByRole("dialog", { name: "Move to folder", exact: true });
  for (const name of ["Season", "Episode", "Selects", "Takes"]) await modal.getByRole("button", { name, exact: true }).click();
  expect((await commands(page)).filter((c) => c.cmd === "move_library_file")).toEqual([]);
  await modal.getByRole("button", { name: "Move here", exact: true }).click();
  await expect.poll(async () => (await commands(page)).filter((c) => c.cmd === "move_library_file").map((c) => c.args)).toEqual([{ srcPath: "/e2e-mock/Footage/root.mov", destDir: "/e2e-mock/Footage/Season/Episode/Selects/Takes" }]);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("saucebunny.libraryRoots")!))).toEqual(["/e2e-mock/Footage"]);
});

test("file filing, reference copy/move drags, and keyboard folder edits never mutate originals", async ({ page }) => {
  await boot(page, true);
  await (await newFolder(page, "Second")).getByRole("button", { name: "Create folder" }).click();
  await page.getByRole("treeitem", { name: "All", exact: true }).click();
  const sidebar = page.locator(".cp-project-sidebar");
  await drag(page, page.locator(".cp-lib-pane .cp-lib-card").filter({ hasText: "voice-memo.m4a" }), sidebar.locator("[data-project-parent='show']"));
  await expect.poll(async () => (await stored(page)).folders.find((f: { id: string }) => f.id === "show").assetIds.length).toBe(6);
  await sidebar.locator("[data-project-source='show']").click();
  const voice = page.locator(".cp-project-item").filter({ hasText: "voice-memo.m4a" });
  const second = sidebar.locator("[data-project-parent]").filter({ has: page.locator("[data-project-source]", { hasText: "Second" }) });
  await page.keyboard.down("Alt"); await drag(page, voice, second); await page.keyboard.up("Alt");
  await expect.poll(async () => (await stored(page)).folders.find((f: { name: string }) => f.name === "Second").assetIds.length).toBe(1);
  await expect(voice).toBeVisible();
  await drag(page, voice, second); await expect(voice).toHaveCount(0);
  const show = sidebar.locator("[data-project-source='show']");
  await show.focus(); await show.press("Shift+F10"); await page.keyboard.press("Escape"); await expect(show).toBeFocused();
  await show.focus(); await show.press("Shift+F10"); await page.keyboard.press("ArrowDown"); await page.keyboard.press("Enter");
  const modal = page.getByRole("dialog", { name: "Edit project folder" });
  await modal.getByRole("textbox", { name: "Name", exact: true }).fill("Renamed show");
  await modal.getByRole("combobox", { name: "Inside", exact: true }).selectOption({ label: "Second" });
  await modal.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(async () => (await stored(page)).folders.find((f: { id: string }) => f.id === "show").name).toBe("Renamed show");
  await show.focus(); await show.press("Shift+F10"); await page.keyboard.press("End"); await page.keyboard.press("Enter");
  await expect(show).toHaveCount(0); await page.keyboard.press("Meta+z"); await expect(show).toBeVisible();
  expect((await commands(page)).filter((c) => /move_library|copy_library|rename_path|trash|delete_/.test(c.cmd))).toEqual([]);
});

test("smart results refresh from current availability rather than saved flags", async ({ page }) => {
  await boot(page, true);
  const modal = await newFolder(page, "Offline", true);
  await modal.getByRole("combobox", { name: "Status", exact: true }).selectOption("offline");
  await modal.getByRole("button", { name: "Create folder" }).click();
  await expect(page.locator(".cp-project-item")).toHaveCount(1);
  await page.evaluate(() => {
    const app = window as unknown as { __TAURI_INTERNALS__: { invoke: (cmd: string, args?: { paths: string[] }) => Promise<unknown> } };
    const prior = app.__TAURI_INTERNALS__.invoke;
    app.__TAURI_INTERNALS__.invoke = (cmd, args) => cmd === "library_reference_status" ? Promise.resolve(args!.paths.map((path) => ({ path, exists: true }))) : prior(cmd, args);
  });
  await page.getByRole("button", { name: "Refresh project items" }).click();
  await expect(page.locator(".cp-project-item")).toHaveCount(0);
  expect((await stored(page)).folders.find((f: { name: string }) => f.name === "Offline").rule.status).toBe("offline");
});

test("a disk favorite remains usable without turning it back into a registered root", async ({ page }) => {
  await boot(page);
  const root = page.getByRole("treeitem", { name: "Footage", exact: true });
  await root.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Add to Favorites" }).click();
  await expect(page.getByRole("region", { name: "Favorites" })).toBeVisible();
  await root.click({ button: "right" });
  page.once("dialog", (dialog) => { void dialog.accept(); });
  await page.getByRole("menuitem", { name: "Remove from library" }).click();
  await expect(root).toHaveCount(0);
  await page.getByRole("region", { name: "Favorites" }).getByRole("button", { name: "Footage", exact: true }).click();
  await expect(page.locator(".cp-lib-pane")).toContainText("clip-a.mp4");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("saucebunny.libraryRoots")!))).toEqual([]);
  expect((await stored(page)).favorites[0]).toMatchObject({ kind: "disk", target: "/e2e-mock/Footage" });
  expect((await commands(page)).some((c) => /move_library|trash|delete_/.test(c.cmd))).toBe(false);
});
