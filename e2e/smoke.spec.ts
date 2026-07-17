import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * UI smoke — boots the real frontend bundle in Chromium with Tauri IPC mocked
 * (see tauri-mock.ts) and proves the shell renders and its chrome is wired.
 * Not a pixel test and not the native pipeline: it exists to catch "the app
 * white-screens on launch" and "the popover/modal wiring broke" classes of
 * regression that tsc + vitest can't see.
 */

const pageErrors: string[] = [];

async function boot(page: Page): Promise<void> {
  pageErrors.length = 0;
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  // Latch the one-time first-run prompt (YouTube sign-in welcome) — its
  // backdrop would otherwise intercept every click in the suite.
  // (App.tsx DEFAULTS_KEY — the cp- prefix is the project-wide carryover.)
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
  });
  await page.goto("/");
  // The app shell is up once the toolbar renders.
  await expect(page.locator(".cp-toolbar")).toBeVisible({ timeout: 15_000 });
}

test("shell boots: toolbar, sidebar, monitor render without pageerrors", async ({ page }) => {
  await boot(page);
  await expect(page.locator(".cp-wordmark")).toContainText("sauce bunny");
  await expect(page.locator(".cp-sidebar")).toBeVisible();
  await expect(page.locator(".cp-monitor-area")).toBeVisible();
  // No stale-binary warning — the mocked build-id matches the frontend's.
  await expect(page.getByText(/stale/i)).toHaveCount(0);
  expect(pageErrors, `pageerrors:\n${pageErrors.join("\n")}`).toHaveLength(0);
});

test("toolbar Fetch is a stateful button resting in the idle phase", async ({ page }) => {
  await boot(page);
  // No source loaded → the toolbar action is the animated Fetch StatefulButton
  // (not the Clear button), parked at data-phase="idle" with its idle label.
  const fetchBtn = page.locator(".cp-toolbar .cp-sbtn-fetch");
  await expect(fetchBtn).toHaveAttribute("data-phase", "idle");
  await expect(fetchBtn).toContainText("Fetch");
  expect(pageErrors, `pageerrors:\n${pageErrors.join("\n")}`).toHaveLength(0);
});

test("nav rail: switches views, keeps the Clip view mounted, persists", async ({ page }) => {
  await boot(page);
  const rail = page.getByRole("navigation", { name: "Primary" });
  await expect(rail).toBeVisible();
  // Fresh profile boots into Clip (the working view).
  await expect(page.locator(".cp-view-clip")).toBeVisible();
  // Home item → the Library. Fresh profile = no roots + no recents, so the
  // empty hero invites with enabled actions.
  await rail.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Your library" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add a folder" })).toBeEnabled();
  // KEEP-ALIVE: the Clip view is hidden, NOT unmounted — toolbar/monitor
  // stay in the DOM so playback and running jobs survive the switch.
  await expect(page.locator(".cp-view-clip")).toBeHidden();
  await expect(page.locator(".cp-view-clip .cp-toolbar")).toBeAttached();
  await expect(page.locator(".cp-view-clip .cp-monitor-area")).toBeAttached();
  // ⌘-nav (mod serializes ctrl the same) rides the rebindable registry. The
  // Library detail browser is now ⌘2 (between Home and Clip); Clip shifted to ⌘3.
  await page.keyboard.press("Control+2");
  await expect(page.locator(".cp-view-library")).toBeVisible();
  await expect(page.getByRole("tree", { name: "Library folders" })).toBeVisible();
  await page.keyboard.press("Control+3");
  await expect(page.locator(".cp-view-clip")).toBeVisible();
  await page.keyboard.press("Control+1");
  await expect(page.getByRole("heading", { name: "Your library" })).toBeVisible();
  // Co-Review is a first-class destination: the rail item reads "Review" (short
  // rail label) + ⌘4 → the lobby, whose heading keeps the full "Co-Review" name.
  // Keep-alive like the others (Clip stays mounted).
  await rail.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Co-Review" })).toBeVisible();
  await expect(page.locator(".cp-view-clip")).toBeHidden();
  await expect(page.locator(".cp-view-clip .cp-toolbar")).toBeAttached();
  // The lobby is session-first: hosting is available with no source loaded.
  await expect(page.getByRole("button", { name: "Start a session" })).toBeEnabled();
  await page.keyboard.press("Control+3");
  await expect(page.locator(".cp-view-clip")).toBeVisible();
  await page.keyboard.press("Control+1");
  await expect(page.getByRole("heading", { name: "Your library" })).toBeVisible();
  // The choice persists (saucebunny.activeView) across reload.
  await page.reload();
  await expect(page.getByRole("heading", { name: "Your library" })).toBeVisible({ timeout: 15_000 });
  expect(pageErrors, `pageerrors:\n${pageErrors.join("\n")}`).toHaveLength(0);
});

test("a11y landmarks: banner/main/complementary present and uniquely labeled", async ({ page }) => {
  await boot(page);
  // Toolbar = the banner landmark; the canvas column = main.
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();
  // Left sidebar is a labeled complementary panel.
  await expect(page.getByRole("complementary", { name: "Source and export" })).toBeVisible();
  // Transport + timeline are labeled regions.
  await expect(page.getByRole("region", { name: "Playback transport" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Timeline" })).toBeVisible();
  // Opening the drawer exposes the second complementary panel + tablist.
  await page.locator(".cp-queue-toggle").click();
  await expect(page.getByRole("complementary", { name: "Queue and tools" })).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Right panel sections" })).toBeVisible();
  await expect(page.getByRole("tabpanel")).toBeVisible(); // active tab body
  // Every complementary landmark carries a unique label (aria-hidden ones
  // are excluded by getByRole, so this checks what a screen reader sees).
  const names = await page
    .getByRole("complementary")
    .evaluateAll((els) => els.map((el) => el.getAttribute("aria-label") ?? ""));
  expect(names.every((n) => n.length > 0)).toBe(true);
  expect(new Set(names).size).toBe(names.length);
  // The single polite live region for pipeline milestones exists.
  await expect(page.locator(".cp-a11y-status[aria-live='polite']")).toHaveCount(1);
  expect(pageErrors, `pageerrors:\n${pageErrors.join("\n")}`).toHaveLength(0);
});

test("settings modal is a labeled dialog and restores focus on close", async ({ page }) => {
  await boot(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Settings" })).toHaveCount(0);
  // Focus returns to the button that opened the modal.
  await expect(page.getByRole("button", { name: "Settings", exact: true })).toBeFocused();
  expect(pageErrors, `pageerrors:\n${pageErrors.join("\n")}`).toHaveLength(0);
});

test("settings modal opens and closes", async ({ page }) => {
  await boot(page);
  await page.getByTitle("Settings (⌘,)").click();
  await expect(page.getByText("Settings", { exact: true }).first()).toBeVisible();
  await page.keyboard.press("Escape");
  expect(pageErrors, `pageerrors:\n${pageErrors.join("\n")}`).toHaveLength(0);
});

test("co-review popover opens with session-first Start available", async ({ page }) => {
  await boot(page);
  await page.getByLabel("Co-review session").click();
  const pop = page.locator(".cp-coreview-pop");
  await expect(pop).toBeVisible();
  // Session-first: Start is enabled even with no source loaded.
  await expect(pop.getByRole("button", { name: "Start a session" })).toBeEnabled();
  await expect(pop.getByPlaceholder("Paste a join code…")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);
  expect(pageErrors, `pageerrors:\n${pageErrors.join("\n")}`).toHaveLength(0);
});

test("side panel toggles open", async ({ page }) => {
  await boot(page);
  await page.locator(".cp-queue-toggle").click();
  await expect(page.locator(".cp-queue-drawer.open")).toBeVisible();
  expect(pageErrors, `pageerrors:\n${pageErrors.join("\n")}`).toHaveLength(0);
});

test("transcript tab shows the empty state with Generate gated on a source", async ({ page }) => {
  await boot(page);
  await page.locator(".cp-queue-toggle").click();
  await page.getByRole("tab", { name: /Transcript/ }).click();
  const empty = page.locator(".cp-tx-empty");
  await expect(empty).toBeVisible();
  await expect(empty.getByText("No transcript yet")).toBeVisible();
  // No source loaded in the smoke run → the primary action is disabled with
  // a hint, while Import stays available.
  await expect(empty.getByRole("button", { name: "Generate transcript" })).toBeDisabled();
  await expect(empty.getByRole("button", { name: "Import transcript…" })).toBeEnabled();
  await expect(page.locator(".cp-tx-empty-hint")).toBeVisible();
  expect(pageErrors, `pageerrors:\n${pageErrors.join("\n")}`).toHaveLength(0);
});

test("drag-and-drop: overlay tracks hover, transcript-without-media drop toasts", async ({ page }) => {
  await boot(page);
  // Push webview drag events through the mock seam exactly as Rust would.
  const emit = (event: string, payload: unknown) =>
    page.evaluate(
      ([e, p]) => {
        (window as unknown as {
          __TAURI_MOCK__: { emitTauriEvent: (e: string, p: unknown) => void };
        }).__TAURI_MOCK__.emitTauriEvent(e as string, p);
      },
      [event, payload] as const,
    );
  // Hovering a media file classifies the drop and names the file.
  await emit("tauri://drag-enter", { paths: ["/tmp/movie.mp4"], position: { x: 20, y: 20 } });
  const card = page.locator(".cp-drop-card");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Drop to import");
  await expect(card).toContainText("movie.mp4");
  // Leaving clears the overlay.
  await emit("tauri://drag-leave", null);
  await expect(page.locator(".cp-drop-overlay")).toHaveCount(0);
  // Dropping a transcript with no source loaded → informative toast, no crash.
  await emit("tauri://drag-drop", { paths: ["/tmp/notes.srt"], position: { x: 20, y: 20 } });
  await expect(page.getByText("Load media first")).toBeVisible();
  await expect(page.locator(".cp-drop-overlay")).toHaveCount(0);
  expect(pageErrors, `pageerrors:\n${pageErrors.join("\n")}`).toHaveLength(0);
});

test("shortcut cheat-sheet: opens on mod+/, lists live bindings, Customize deep-links", async ({ page }) => {
  await boot(page);
  // mod+/ (ctrl serializes to the same "mod" as ⌘ — lib/keybindings eventToCombo).
  await page.keyboard.press("Control+/");
  const sheet = page.locator(".cp-shortcuts");
  await expect(sheet).toBeVisible();
  // Registry-driven rows (grouped) + the hardcoded contextual group.
  await expect(sheet.getByText("Play / pause")).toBeVisible();
  await expect(sheet.getByText("Command palette")).toBeVisible();
  await expect(sheet.getByText("not rebindable")).toBeVisible();
  await expect(sheet.getByText("Find in transcript")).toBeVisible();
  // Escape closes (shared modal convention).
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  // Customize… routes to Settings → Commands with the tab preselected.
  await page.keyboard.press("Control+/");
  await page.getByRole("button", { name: "Customize…" }).click();
  await expect(page.locator(".cp-modal-tab.active")).toContainText("Shortcuts");
  expect(pageErrors, `pageerrors:\n${pageErrors.join("\n")}`).toHaveLength(0);
});

test("first-run checklist: pending steps render, folder step opens Settings, dismiss persists", async ({ page }) => {
  await boot(page);
  // Fresh profile → no recents, no folder, no transcript: all three pending.
  const card = page.locator(".cp-getting-started");
  await expect(card).toBeVisible();
  await expect(card.locator(".cp-getting-started-step")).toHaveCount(3);
  await expect(card.locator(".cp-getting-started-step.done")).toHaveCount(0);
  // Pending folder step deep-links into Settings (General tab).
  await card.getByRole("button", { name: /Set your export folder/ }).click();
  await expect(page.locator(".cp-modal-tab.active")).toContainText("General");
  await page.keyboard.press("Escape");
  // "Don't show again" hides the card and persists across reload.
  await card.getByRole("button", { name: "Don't show again" }).click();
  await expect(card).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".cp-toolbar")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".cp-getting-started")).toHaveCount(0);
  expect(pageErrors, `pageerrors:\n${pageErrors.join("\n")}`).toHaveLength(0);
});

/** Clicks the nav rail's Home item (the Library view). */
async function goHome(page: Page): Promise<void> {
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("button", { name: "Home", exact: true })
    .click();
}

test("library: seeded root scans into a shelf; search filters a flat grid; Esc restores", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("saucebunny.libraryRoots", JSON.stringify(["/e2e/Footage"]));
  });
  await boot(page);
  await goHome(page);
  // Header chrome: title, search, Add Folder, rescan. (Home's H1 is now "Home"
  // — the landing page — while the detail browser owns the "Library" name.)
  await expect(page.locator(".cp-lib-head").getByRole("heading", { name: "Home", exact: true })).toBeVisible();
  await expect(page.getByLabel("Search library")).toBeVisible();
  await expect(page.locator(".cp-lib-head").getByRole("button", { name: "Add Folder" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Rescan library" })).toBeVisible();
  // The mocked scan renders one shelf: folder collection + video + audio cards.
  const row = page.getByRole("list", { name: "Footage" });
  await expect(row).toBeVisible();
  await expect(row.getByRole("button", { name: /Interviews/ })).toBeVisible();
  await expect(row.getByRole("button", { name: /clip-a\.mp4/ })).toBeVisible();
  await expect(row.getByRole("button", { name: /voice-memo\.m4a/ })).toBeVisible();
  // Search (debounced 150ms) replaces shelves with a flat grid — the nested
  // intro.mp4 is findable across the whole tree.
  await page.getByLabel("Search library").fill("intro");
  const grid = page.getByRole("list", { name: "Search results" });
  await expect(grid).toBeVisible();
  await expect(grid.getByRole("button", { name: /intro\.mp4/ })).toBeVisible();
  await expect(page.getByRole("list", { name: "Footage" })).toHaveCount(0);
  // Esc clears back to the shelves.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("list", { name: "Footage" })).toBeVisible();
  expect(pageErrors, `pageerrors:\n${pageErrors.join("\n")}`).toHaveLength(0);
});

test("library: failed root scan shows the inline error row; remove forgets the root", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("saucebunny.libraryRoots", JSON.stringify(["/e2e/missing-root"]));
  });
  await boot(page);
  await goHome(page);
  // Fail loud: the AppError renders inline (formatError), never a silent skip.
  const row = page.locator(".cp-lib-row", { hasText: "missing-root" });
  await expect(row.getByRole("alert")).toContainText("Not found: /e2e/missing-root");
  await expect(row.getByRole("button", { name: "Retry" })).toBeVisible();
  // Remove (hover-revealed ×) asks for confirmation, then forgets the root —
  // storage included. Disk is never touched (nothing to touch here anyway).
  page.once("dialog", (d) => { void d.accept(); });
  await row.locator(".cp-lib-row-head").hover();
  await row.getByRole("button", { name: /Remove missing-root/ }).click();
  await expect(page.locator(".cp-lib-row", { hasText: "missing-root" })).toHaveCount(0);
  const roots = await page.evaluate(() => localStorage.getItem("saucebunny.libraryRoots"));
  expect(roots).toBe("[]");
  expect(pageErrors, `pageerrors:\n${pageErrors.join("\n")}`).toHaveLength(0);
});

test("library hero: empty-state Paste a URL jumps to Clip and focuses the URL bar", async ({ page }) => {
  await boot(page);
  await goHome(page);
  await expect(page.getByRole("heading", { name: "Your library" })).toBeVisible();
  await page.getByRole("button", { name: "Paste a URL" }).click();
  await expect(page.locator(".cp-view-clip")).toBeVisible();
  await expect(page.locator(".cp-url input")).toBeFocused();
  expect(pageErrors, `pageerrors:\n${pageErrors.join("\n")}`).toHaveLength(0);
});

test("library: hero + Continue + Transcripts shelves from seeded history; opening returns to Clip", async ({ page }) => {
  await page.addInitScript(() => {
    // v=abc is deliberately NOT a valid 11-char YouTube id → no poster URL is
    // derived → no external image requests from the e2e run.
    localStorage.setItem("saucebunny.recentSources", JSON.stringify([
      { kind: "url", value: "https://youtube.com/watch?v=abc", title: "Seeded web source", durationSeconds: 90, lastOpenedAt: Date.now() },
      { kind: "file", value: "/tmp/seeded.mp4", title: "seeded.mp4", lastOpenedAt: Date.now() - 60_000 },
    ]));
    localStorage.setItem("saucebunny.transcriptHistory", JSON.stringify([
      { id: "tx-1", srtPath: "/tmp/seeded.srt", sourcePath: null, sourceUrl: null, title: "Seeded transcript", origin: "whisper", createdAt: Date.now(), lastOpenedAt: Date.now() },
    ]));
  });
  await boot(page);
  await goHome(page);
  // Hero fronts the most recent source with both open actions.
  const hero = page.locator(".cp-lib-hero");
  await expect(hero).toContainText("Seeded web source");
  await expect(hero.getByRole("button", { name: "Resume" })).toBeVisible();
  await expect(hero.getByRole("button", { name: "Open in Clip" })).toBeVisible();
  // Continue shelf lists both recents; Transcripts shelf lists the history entry.
  const cont = page.getByRole("list", { name: "Continue" });
  await expect(cont.getByRole("button", { name: /Seeded web source/ })).toBeVisible();
  await expect(cont.getByRole("button", { name: /seeded\.mp4/ })).toBeVisible();
  await expect(page.getByRole("list", { name: "Transcripts" })
    .getByRole("button", { name: /Seeded transcript/ })).toBeVisible();
  // Opening a recent routes through the standard handlers → back on Clip.
  await cont.getByRole("button", { name: /seeded\.mp4/ }).click();
  await expect(page.locator(".cp-view-clip")).toBeVisible();
  expect(pageErrors, `pageerrors:\n${pageErrors.join("\n")}`).toHaveLength(0);
});

test("library browser: tree + grid render, selection shows detail, list toggle swaps view", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("saucebunny.libraryRoots", JSON.stringify(["/e2e/Footage"]));
  });
  await boot(page);
  // ⌘2 (or the rail item) opens the Library detail browser.
  await page.getByRole("navigation", { name: "Primary" })
    .getByRole("button", { name: "Library", exact: true }).click();
  await expect(page.locator(".cp-view-library")).toBeVisible();
  // Left column: an ARIA tree with "All" + the seeded root (no extra IPC).
  const tree = page.getByRole("tree", { name: "Library folders" });
  await expect(tree.getByRole("treeitem", { name: "All" })).toBeVisible();
  await expect(tree.getByRole("treeitem", { name: "Footage" })).toBeVisible();
  // Main pane: "All" flattens every item across the tree into the poster wall.
  const grid = page.getByRole("list", { name: "Files" });
  await expect(grid.getByRole("button", { name: /clip-a\.mp4/ })).toBeVisible();
  await expect(grid.getByRole("button", { name: /intro\.mp4/ })).toBeVisible();
  // Single click selects → the detail panel appears with the file's actions.
  await grid.getByRole("button", { name: /clip-a\.mp4/ }).click();
  const detail = page.getByRole("complementary", { name: "File details" });
  await expect(detail).toBeVisible();
  await expect(detail.getByRole("button", { name: "Open in Clip" })).toBeVisible();
  // Esc clears the selection.
  await page.keyboard.press("Escape");
  await expect(detail).toHaveCount(0);
  // Grid⇄list toggle swaps the poster wall for the compact list. List rows are
  // plain buttons (announced as buttons with aria-current), not a table widget.
  await page.getByRole("button", { name: "List view" }).click();
  const list = page.getByRole("list", { name: "Files" });
  await expect(list).toBeVisible();
  await expect(list.getByRole("button", { name: /clip-a\.mp4/ })).toBeVisible();
  expect(pageErrors, `pageerrors:\n${pageErrors.join("\n")}`).toHaveLength(0);
});

test("recent sources: popover lists seeded entries, empty state offers resume", async ({ page }) => {
  // Seed two recents BEFORE boot — the popover and the Monitor empty-state
  // "Resume last session" button both read saucebunny.recentSources.
  await page.addInitScript(() => {
    localStorage.setItem("saucebunny.recentSources", JSON.stringify([
      { kind: "url", value: "https://youtube.com/watch?v=abc", title: "Seeded web source", durationSeconds: 90, lastOpenedAt: Date.now() },
      { kind: "file", value: "/tmp/seeded.mp4", title: "seeded.mp4", lastOpenedAt: Date.now() - 60_000 },
    ]));
  });
  await boot(page);
  // Empty state offers one-click resume of the most recent entry.
  await expect(page.locator(".cp-empty-resume")).toContainText("Seeded web source");
  // History trigger opens the popover with both rows, newest first.
  await page.getByTitle("Recent sources", { exact: true }).click();
  const pop = page.locator(".cp-recents-pop");
  await expect(pop).toBeVisible();
  const rows = pop.locator(".cp-recents-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("Seeded web source");
  await expect(rows.nth(0).locator(".cp-recents-badge")).toHaveText("web");
  await expect(rows.nth(1)).toContainText("seeded.mp4");
  await expect(rows.nth(1).locator(".cp-recents-badge")).toHaveText("file");
  // Per-row remove prunes without closing.
  await rows.nth(1).hover();
  await rows.nth(1).locator(".cp-recents-remove").click();
  await expect(pop.locator(".cp-recents-row")).toHaveCount(1);
  // Escape closes (shared popover convention).
  await page.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);
  expect(pageErrors, `pageerrors:\n${pageErrors.join("\n")}`).toHaveLength(0);
});
