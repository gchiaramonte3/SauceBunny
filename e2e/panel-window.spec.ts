import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * The floating side-panel window, which nothing tested.
 *
 * The app ships TWO windows. Every other spec in this suite boots `/`, so the
 * whole `?window=panel` surface - PanelApp plus the QueueDrawer it renders -
 * had no automated coverage of any kind: not that it boots, not that it stays
 * off the console, not that its controls are named.
 *
 * It is currently in good shape. This is that state written down, plus the two
 * things the code itself promises about this window: that it renders CONTENT
 * rather than an empty shell, and that the pop-out button does not appear
 * inside the already-popped-out window.
 *
 * The empty-shell case is not hypothetical. CLAUDE.md records "fresh panel
 * rendered empty" as a real failure - events are dropped, not queued, before a
 * webview registers its listener - which is why the panel seeds itself
 * synchronously from localStorage and then performs a request/response
 * handshake. The seeded test below is the half a mocked harness can prove.
 */

const SNAPSHOT_KEY = "saucebunny.panelSnapshot";

async function openPanel(page: Page, sink: string[], snapshot?: unknown) {
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") sink.push(`[${m.type()}] ${m.text()}`);
  });
  page.on("pageerror", (e) => sink.push(`[pageerror] ${String(e)}`));
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(
    ([key, snap]) => {
      localStorage.setItem("saucebunny.welcomed", "1");
      if (snap) localStorage.setItem(key as string, JSON.stringify(snap));
    },
    [SNAPSHOT_KEY, snapshot ?? null] as const,
  );
  await page.goto("/?window=panel");
  await expect(page.locator(".cp-panel-window-root")).toBeVisible({ timeout: 15_000 });
}

test("the panel window boots and renders its drawer, quietly", async ({ page }) => {
  const noise: string[] = [];
  await openPanel(page, noise);

  // Content, not an empty shell: the three tabs the drawer always offers.
  for (const label of ["Queue", "Transcript", "AI Summary"]) {
    await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
  }
  expect(noise, `console noise:\n${noise.join("\n")}`).toEqual([]);
});

test("every control in the panel has an accessible name", async ({ page }) => {
  const noise: string[] = [];
  await openPanel(page, noise);

  const unnamed = await page.evaluate(() => {
    const out: string[] = [];
    let seen = 0;
    for (const el of document.querySelectorAll<HTMLElement>("button,input,select,textarea")) {
      if (!el.checkVisibility()) continue;
      seen++;
      // Resolve in the platform's order, not textContent-first: aria-label
      // WINS over the text inside. That distinction matters here - the close
      // control's text is "×", which is a name a screen reader reads as a
      // symbol. It is only adequately named because an aria-label overrides
      // that, and a check that accepted "×" would not notice if it went.
      // A wrapping or associated <label> counts, and must be resolved: an
      // <input> has no textContent of its own, so without this every properly
      // labelled field reads as nameless. That exact false positive showed up
      // while writing this - the co-review lobby's "Your name" field looked
      // unnamed until the wrapping label was taken into account.
      const labelled =
        (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent) ||
        el.closest("label")?.textContent ||
        "";
      const name = (
        el.getAttribute("aria-label") ||
        (el.getAttribute("aria-labelledby") &&
          document.getElementById(el.getAttribute("aria-labelledby")!)?.textContent) ||
        (el.textContent ?? "").trim() ||
        labelled ||
        el.getAttribute("title") ||
        ""
      ).trim();
      // A name of pure punctuation names nothing.
      if (!/[\p{L}\p{N}]/u.test(name)) {
        out.push(`<${el.tagName.toLowerCase()} class="${el.getAttribute("class")}"> name=${JSON.stringify(name)}`);
      }
    }
    return { out, seen };
  });
  // A panel that rendered nothing would have nothing unnamed.
  expect(unnamed.seen, "no controls found in the panel").toBeGreaterThan(3);
  expect(unnamed.out, `unnamed controls:\n${unnamed.out.join("\n")}`).toEqual([]);
});

test("the pop-out button is absent inside the popped-out window", async ({ page }) => {
  // PanelApp leaves onPopOut undefined on purpose, with a comment saying so.
  // Offering "pop out" inside the thing already popped out is the kind of
  // detail that returns the moment someone reuses the drawer somewhere else.
  //
  // Break-tested honestly: this is guarded TWICE - QueueDrawer renders the
  // button only for `!embedded && onPopOut`, and PanelApp withholds both.
  // Restoring onPopOut alone does NOT fail this test; dropping `embedded` as
  // well does. So it catches a refactor that loses both guards, not a
  // one-line slip, and it is worth exactly that much.
  const noise: string[] = [];
  await openPanel(page, noise);
  await expect(page.getByRole("button", { name: /pop ?out/i })).toHaveCount(0);
});

test("a seeded snapshot reaches the UI without waiting for an event", async ({ page }) => {
  // The synchronous boot seed. Events are dropped before a webview registers
  // its listener, so localStorage - not `panel:state` - is what makes a fresh
  // panel show anything at all.
  const noise: string[] = [];
  await openPanel(page, noise, {
    queue: [],
    fps: 25,
    running: false,
    hasFolder: true,
    hasSource: true,
    transcriptPath: null,
  });
  await expect(page.locator(".cp-panel-window-root")).toBeVisible();
  expect(noise, `console noise:\n${noise.join("\n")}`).toEqual([]);
});

/**
 * The panel does not hydrate the review store, and this is why it is allowed
 * not to.
 *
 * `main.tsx` skips `hydrateReviewStore` entirely in this window: reading
 * index.json plus every review doc through a worker pool, with first paint
 * racing it, for a store nothing here can ask about. That is only safe while
 * the Review tab stays out of the panel, which QueueDrawer enforces three
 * ways (tab list is `embedded ? [] : [review]`, an active "review" tab is
 * redirected to "transcript", and the tick that selects it is a prop only App
 * passes).
 *
 * If this test ever fails, the tab came back and the hydration has to come
 * back with it, at the tab. `hydrateReviewStore` is idempotent and latched, so
 * calling it from wherever the tab is mounted is enough.
 */
test("the panel offers no Review tab, which is what lets it skip review hydration", async ({ page }) => {
  const noise: string[] = [];
  await openPanel(page, noise);

  const tabs = page.locator('[role="tab"]');
  await expect(tabs.first()).toBeVisible();
  const names = await tabs.allInnerTexts();
  expect(
    names.map((n) => n.trim().toLowerCase()),
    "the panel grew a Review tab; main.tsx must hydrate the review store again",
  ).not.toContain("review");

  // And no review panel body was mounted behind the scenes either.
  await expect(page.locator("#cp-tabpanel-review")).toHaveCount(0);
});
