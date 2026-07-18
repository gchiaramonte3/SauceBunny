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
  // No text wordmark — the nav rail's bunny mark is the only brand presence,
  // and the left panel toggle is the toolbar's FIRST item (Lore-style),
  // hugging the rail; the right panel toggle mirrors it on the far edge.
  await expect(page.locator(".cp-wordmark")).toHaveCount(0);
  // The rail mark is the canonical bunny SVG and actually decodes —
  // naturalWidth 0 would mean a broken src quietly rendering as a fallback.
  // Vite may inline the asset as a data: URI, so accept the file path OR the
  // inlined SVG (identified by the brand-green fill it carries).
  const railLogo = page.locator(".cp-nav-logo img");
  await expect(railLogo).toBeVisible();
  expect(await railLogo.getAttribute("src")).toMatch(/saucebunny|6CFF8D/i);
  expect(await railLogo.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect(page.locator(".cp-toolbar > *").first()).toHaveClass(/cp-sidebar-toggle/);
  // Fresh profile (no saved prefs): BOTH side panels boot open.
  await expect(page.locator(".cp-sidebar")).toBeVisible();
  await expect(page.locator(".cp-queue-drawer.open")).toBeVisible();
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
  // Rootless profile → the browser is JUST the invite: one centered line + the
  // primary button, no panel/bar chrome.
  await page.keyboard.press("Control+2");
  await expect(page.locator(".cp-view-library")).toBeVisible();
  await expect(page.getByText("Add a folder to build your library.")).toBeVisible();
  await expect(page.locator(".cp-lib-browse-zero").getByRole("button", { name: "Add folder" })).toBeVisible();
  await expect(page.getByRole("tree", { name: "Library folders" })).toHaveCount(0);
  await page.keyboard.press("Control+3");
  await expect(page.locator(".cp-view-clip")).toBeVisible();
  await page.keyboard.press("Control+1");
  await expect(page.getByRole("heading", { name: "Your library" })).toBeVisible();
  // Co-Review is a first-class destination: the rail item reads "Review" (short
  // rail label) + ⌘4 → the lobby, a centered green room titled "Review together"
  // with the Host and Join cards stacked. Keep-alive like the others (Clip
  // stays mounted).
  await rail.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review together" })).toBeVisible();
  await expect(page.locator(".cp-view-clip")).toBeHidden();
  await expect(page.locator(".cp-view-clip .cp-toolbar")).toBeAttached();
  // The lobby is session-first: hosting is available with no source loaded.
  await expect(page.getByRole("button", { name: "Start session", exact: true })).toBeEnabled();
  // Join stays gated (neutral) until both the code and a name are present.
  await expect(page.getByRole("button", { name: "Join", exact: true })).toBeDisabled();
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
  // The drawer boots open (fresh-profile default) — the second
  // complementary panel + tablist are present without any click.
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

test("sessions live in Review: no toolbar popover, the lobby owns start/join", async ({ page }) => {
  await boot(page);
  // The Clip toolbar carries NO session affordance anymore (the nav rail's
  // Review badge is the one session surface outside the workspace).
  await expect(page.getByLabel("Co-review session")).toHaveCount(0);
  await expect(page.locator(".cp-coreview-pop")).toHaveCount(0);
  // The Review view hosts the lobby; session-first Start works sourceless.
  await page.getByRole("button", { name: "Review" }).click();
  const lobby = page.locator(".cp-view-coreview");
  await expect(lobby).toBeVisible();
  await expect(lobby.getByRole("button", { name: "Start session" })).toBeEnabled();
  // No live session -> the body never carries the room class.
  await expect(page.locator(".cp-body.cp-room")).toHaveCount(0);
  expect(pageErrors, `pageerrors:\n${pageErrors.join("\n")}`).toHaveLength(0);
});

test("side panel boots open; an explicit close persists across reload", async ({ page }) => {
  await boot(page);
  // Fresh profile: the drawer is open by default.
  await expect(page.locator(".cp-queue-drawer.open")).toBeVisible();
  // The toolbar toggle is a USER choice — it closes the drawer and persists.
  await page.locator(".cp-queue-toggle").click();
  await expect(page.locator(".cp-queue-drawer.open")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".cp-toolbar")).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".cp-queue-drawer.open")).toHaveCount(0);
  // Toggling back open persists too.
  await page.locator(".cp-queue-toggle").click();
  await expect(page.locator(".cp-queue-drawer.open")).toBeVisible();
  expect(pageErrors, `pageerrors:\n${pageErrors.join("\n")}`).toHaveLength(0);
});

test("transcript tab shows the empty state with Generate gated on a source", async ({ page }) => {
  await boot(page);
  // The drawer boots open — jump straight to the Transcript tab.
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
  // Home's header is JUST the search field (right-aligned). No H1, and Add
  // Folder + rescan belong to the Library browser now — the hero anchors the
  // page instead.
  await expect(page.getByLabel("Search library")).toBeVisible();
  await expect(page.locator(".cp-lib-head").getByRole("heading")).toHaveCount(0);
  await expect(page.locator(".cp-lib-head").getByRole("button", { name: "Add Folder" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Rescan library" })).toHaveCount(0);
  await expect(page.locator(".cp-lib-hero")).toBeVisible();
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
  // No hero in the search branch → the header drops its hero pull-up (flat
  // variant), so the results grid never tucks under the floating search chip
  // (which dead-clicked the first row's ⋯ buttons).
  await expect(page.locator(".cp-lib-head")).toHaveClass(/cp-lib-head-flat/);
  // Esc clears back to the shelves — and the hero pull-up returns with them.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("list", { name: "Footage" })).toBeVisible();
  await expect(page.locator(".cp-lib-head")).not.toHaveClass(/cp-lib-head-flat/);
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

test("library: hero + Continue + Transcribed shelves from seeded history; opening returns to Clip", async ({ page }) => {
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
  // Continue shelf lists both recents at featured size; the Transcribed shelf
  // (renamed from Transcripts) lists the history entry with its SRT badge.
  const cont = page.getByRole("list", { name: "Continue" });
  await expect(cont.getByRole("button", { name: /Seeded web source/ })).toBeVisible();
  await expect(cont.getByRole("button", { name: /seeded\.mp4/ })).toBeVisible();
  await expect(cont.locator(".cp-lib-cell.lg")).toHaveCount(2);
  const transcribed = page.getByRole("list", { name: "Transcribed" });
  await expect(transcribed.getByRole("button", { name: /Seeded transcript/ })).toBeVisible();
  await expect(transcribed.locator(".cp-lib-card-badge")).toHaveText("srt");
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
  // Left column is a proper library panel: "Library" header + an ARIA tree
  // with "All" + the seeded root (no extra IPC).
  await expect(page.locator(".cp-lib-tree-head")).toContainText("Library");
  const tree = page.getByRole("tree", { name: "Library folders" });
  await expect(tree.getByRole("treeitem", { name: "All" })).toBeVisible();
  await expect(tree.getByRole("treeitem", { name: "Footage" })).toBeVisible();
  // Add folder + Rescan moved OFF Home and live in the panel footer — positive
  // coverage that the affordances actually landed here (Home only asserts
  // their absence).
  const foot = page.locator(".cp-lib-tree-foot");
  await expect(foot.getByRole("button", { name: "Add folder" })).toBeVisible();
  await expect(foot.getByRole("button", { name: "Rescan library" })).toBeVisible();
  // Main pane: "All" flattens every item across the tree into the poster wall.
  const grid = page.getByRole("list", { name: "Files" });
  await expect(grid.getByRole("button", { name: /clip-a\.mp4/ })).toBeVisible();
  await expect(grid.getByRole("button", { name: /intro\.mp4/ })).toBeVisible();
  // Kind filter is panel CHIPS now (the bar's <select> is gone). Audio scopes
  // the wall and persists to the same prefs key the select used.
  await expect(page.locator(".cp-lib-bar").getByLabel("Filter by kind")).toHaveCount(0);
  const chips = page.getByRole("group", { name: "Filter by kind" });
  await expect(chips.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
  await chips.getByRole("button", { name: "Audio" }).click();
  await expect(grid.getByRole("button", { name: /voice-memo\.m4a/ })).toBeVisible();
  await expect(grid.getByRole("button", { name: /clip-a\.mp4/ })).toHaveCount(0);
  const prefs = await page.evaluate(() => localStorage.getItem("saucebunny.libraryBrowser"));
  expect(JSON.parse(prefs ?? "{}").kind).toBe("audio");
  await chips.getByRole("button", { name: "All" }).click();
  await expect(grid.getByRole("button", { name: /clip-a\.mp4/ })).toBeVisible();
  // Panel collapse lives in its header; the bar grows a Show-folders button
  // only while the panel is hidden.
  await page.getByRole("button", { name: "Hide folder tree" }).click();
  await expect(page.getByRole("tree", { name: "Library folders" })).toHaveCount(0);
  await page.getByRole("button", { name: "Show folder tree" }).click();
  await expect(tree.getByRole("treeitem", { name: "All" })).toBeVisible();
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

test("new-source reset: filename reseeds per source, user-typed name survives", async ({ page }) => {
  await boot(page);
  const url = page.locator("input[placeholder^='Paste a video URL']");
  const filename = page.locator(".cp-field", { hasText: "Filename" }).locator("input");

  // Fetch A → filename seeds from A's title (dirty flag off).
  await url.fill("https://youtube.com/watch?v=aaaa");
  await page.getByRole("button", { name: /^Fetch/ }).click();
  await expect(filename).toHaveValue("Source-A-title", { timeout: 10_000 });

  // Fetch B → the seed MUST reseed (the old prev.filename heuristic kept A).
  await url.fill("https://youtube.com/watch?v=bbbb");
  await page.getByRole("button", { name: /^Fetch/ }).click();
  await expect(filename).toHaveValue("Source-B-title", { timeout: 10_000 });

  // Type a custom name (arms the PER-SOURCE dirty flag), refetch the SAME
  // source → custom SURVIVES the refetch.
  await filename.fill("my-custom-name");
  await url.fill("https://youtube.com/watch?v=bbbb");
  await page.getByRole("button", { name: /^Fetch/ }).click();
  await expect(filename).toHaveValue("my-custom-name", { timeout: 10_000 });

  // A DIFFERENT source disarms the flag: the field reseeds from A's title
  // (review fix: the old session-sticky flag kept the custom name forever).
  await url.fill("https://youtube.com/watch?v=aaaa");
  await page.getByRole("button", { name: /^Fetch/ }).click();
  await expect(filename).toHaveValue("Source-A-title", { timeout: 10_000 });
  expect(pageErrors, `pageerrors:\n${pageErrors.join("\n")}`).toHaveLength(0);
});

test("recent exports: grouped per source, chevron reveals older exports", async ({ page }) => {
  await page.addInitScript(() => {
    // App.tsx RECENTS_KEY — storage stays flat, newest-first; the per-source
    // grouping under test is purely render-time (Sidebar groupedRecents),
    // keyed on SOURCE IDENTITY, never the display title (review fix).
    const mk = (id: string, title: string, when: number, source: string) => ({
      id, title, path: `/e2e/out/${id}.mp4`, dur: "0:42", when, thumbnail: null, source,
    });
    localStorage.setItem("cp-recents", JSON.stringify([
      mk("r4", "Source A", 4000, "https://youtube.com/watch?v=aaaa"),
      mk("r3", "Source A", 3000, "https://youtube.com/watch?v=aaaa"),
      mk("r2", "Source B", 2000, "https://youtube.com/watch?v=bbbb"),
      mk("r1", "Source A", 1000, "https://youtube.com/watch?v=aaaa"),
      // Same TITLE as Source A but a different source: must be its own
      // group, not swallowed as an "older export" of the first one.
      mk("r0", "Source A", 500, "/e2e/other/interview.mp4"),
    ]));
  });
  await boot(page);
  // Three groups: the aaaa source leads with a chevron for its two older
  // exports; Source B and the same-titled local file are singletons (no
  // chevron) — title collisions must not merge groups.
  await expect(page.locator(".cp-recent-group")).toHaveCount(3);
  const chev = page.locator(".cp-recent-chev");
  await expect(chev).toHaveCount(1);
  await expect(chev).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator(".cp-recent.nested")).toHaveCount(0);
  // Open: the two older Source A exports unfold as nested rows.
  await chev.click();
  await expect(chev).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator(".cp-recent.nested")).toHaveCount(2);
  // Close: they fold away again.
  await chev.click();
  await expect(page.locator(".cp-recent.nested")).toHaveCount(0);
  expect(pageErrors, `pageerrors:\n${pageErrors.join("\n")}`).toHaveLength(0);
});
