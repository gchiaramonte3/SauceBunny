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
  await expect(page.locator(".cp-modal-tab.active")).toContainText("Commands & Shortcuts");
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
