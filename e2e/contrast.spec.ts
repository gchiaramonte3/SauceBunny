import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * Text contrast — WCAG 1.4.3 (Contrast Minimum, AA): 4.5:1 for body text,
 * 3:1 for large text (18.66px bold, or 24px).
 *
 * A dark UI is where this goes wrong quietly. Secondary greys look fine to
 * whoever picked them on a good display in a dim room, and become unreadable
 * on a laptop outdoors or to anyone with reduced contrast sensitivity. Unlike
 * a layout bug, nobody files it: they just stop reading that label.
 *
 * Measured from computed styles, because the answer depends on the EFFECTIVE
 * background - the nearest ancestor that actually paints one - and on the
 * final resolved colour after every token, inherit and alpha has been applied.
 * No stylesheet reading can tell you that.
 *
 * Scope: text the smoke harness renders, with IPC mocked.
 */

type Fail = { text: string; cls: string; fg: string; bg: string; ratio: number; px: number };

async function boot(page: Page): Promise<void> {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
}

async function failures(page: Page): Promise<Fail[]> {
  return page.evaluate(() => {
    const parse = (c: string): [number, number, number, number] => {
      const m = c.match(/rgba?\(([^)]+)\)/);
      if (!m) return [0, 0, 0, 0];
      const p = m[1].split(",").map((x) => parseFloat(x));
      return [p[0], p[1], p[2], p[3] ?? 1];
    };
    const lum = (r: number, g: number, b: number) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const over = (fg: [number, number, number, number], bg: [number, number, number]) =>
      [0, 1, 2].map((i) => fg[i] * fg[3] + bg[i] * (1 - fg[3])) as [number, number, number];

    /**
     * Nearest ancestor that actually paints, composited down to opaque.
     *
     * Returns null when a GRADIENT or image is in the stack, because
     * `backgroundColor` reports transparent for those and the walk would sail
     * past to the page canvas. That produced the funniest possible wrong
     * answer on the first run: .btn-primary paints a green gradient and sets
     * dark text on it, so the measurement read dark-on-dark and called a
     * deliberately high-contrast button a 1:1 failure.
     */
    const effectiveBg = (el: HTMLElement): [number, number, number] | null => {
      const stack: [number, number, number, number][] = [];
      for (let n: HTMLElement | null = el; n; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.backgroundImage && cs.backgroundImage !== "none") return null;
        const c = parse(cs.backgroundColor);
        if (c[3] > 0) {
          stack.push(c);
          if (c[3] === 1) break;
        }
      }
      let base: [number, number, number] = [10, 10, 13]; // app canvas, if nothing is opaque
      for (let i = stack.length - 1; i >= 0; i -= 1) base = over(stack[i], base);
      return base;
    };

    const out: Array<{ text: string; cls: string; fg: string; bg: string; ratio: number; px: number }> = [];
    for (const el of Array.from(document.querySelectorAll("*"))) {
      const e = el as HTMLElement;
      // Only elements with their OWN visible text, so a container is not
      // blamed for its children's text.
      const own = Array.from(e.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent || "")
        .join("")
        .trim();
      if (own.length < 2) continue;
      const cs = getComputedStyle(e);
      if (cs.display === "none" || cs.visibility === "hidden") continue;
      if (Number(cs.opacity) < 0.99) continue; // faded-out states are transient
      const r = e.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;

      const fg = parse(cs.color);
      if (fg[3] === 0) continue;
      const bg = effectiveBg(e);
      if (!bg) continue; // painted over an image or gradient; not measurable here
      const fgc = over(fg, bg);
      const l1 = lum(...fgc), l2 = lum(...bg);
      const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

      const px = parseFloat(cs.fontSize);
      const bold = Number(cs.fontWeight) >= 700;
      const large = px >= 24 || (bold && px >= 18.66);
      const need = large ? 3 : 4.5;
      if (ratio < need) {
        out.push({
          text: own.slice(0, 34), cls: (e.className || "").toString().slice(0, 34),
          fg: cs.color, bg: `rgb(${bg.map(Math.round).join(",")})`,
          ratio: Math.round(ratio * 100) / 100, px,
        });
      }
    }
    return out;
  });
}

test("the harness renders text to measure", async ({ page }) => {
  await boot(page);
  const n = await page.evaluate(() =>
    Array.from(document.querySelectorAll("*")).filter((e) =>
      Array.from(e.childNodes).some((c) => c.nodeType === Node.TEXT_NODE && (c.textContent || "").trim().length > 1),
    ).length);
  expect(n, "too little text to be measuring the real app").toBeGreaterThan(20);
});

for (const [key, label, root] of [
  ["Control+1", "Home", "cp-view-home"],
  ["Control+2", "Library", "cp-view-library"],
  ["Control+3", "Clip", "cp-view-clip"],
  ["Control+4", "Review", "cp-view-coreview"],
  ["Control+5", "Transcripts", "cp-view-reader"],
] as const) {
  test(`${label} text meets WCAG AA contrast`, async ({ page }) => {
    await boot(page);
    await page.keyboard.press(key);
    // Poll, do not sleep-then-snapshot. `expect(await ...)` captures one moment,
    // so the fixed wait was load-bearing and fragile under parallel workers.
    await expect
      .poll(() => page.evaluate(() => document.querySelector(".cp-view:not([hidden])")?.className ?? ""),
        { message: `${key} did not switch to ${label}` })
      .toContain(root);

    const bad = await failures(page);
    expect(
      bad.map((b) => `${b.ratio}:1 ${b.px}px "${b.text}" .${b.cls} ${b.fg} on ${b.bg}`),
      `Below AA in ${label}`,
    ).toEqual([]);
  });
}

test("the settings modal meets AA too", async ({ page }) => {
  // The densest text surface in the app: rows of labels and long
  // explanatory `desc` copy, which is exactly where a muted grey goes.
  await boot(page);
  const gear = page.locator('[aria-label="Settings"], button:has-text("Settings")').first();
  // NOT `if (await gear.count())`. That guard meant a renamed or removed
  // Settings button quietly skipped the open, leaving this test measuring the
  // main view again and reporting a pass for a surface it never saw. The gear
  // has to be there, and the dialog has to appear - both asserted, and the
  // dialog with an auto-retrying assertion rather than a fixed wait.
  await expect(gear, "no Settings control found, so this measured the main view").toHaveCount(1);
  await gear.click();
  await expect(page.locator('.cp-modal, [role="dialog"]').first()).toBeVisible();
  const bad = await failures(page);
  expect(
    bad.map((b) => `${b.ratio}:1 ${b.px}px "${b.text}" .${b.cls} ${b.fg} on ${b.bg}`),
    "Below AA in Settings",
  ).toEqual([]);
});

/**
 * Command-palette text that is below AA and needs a TOKEN decision, not a
 * per-site edit.
 *
 * Every one of these is fg-5 at 3.81:1 on the palette's raised background.
 * The obvious fix does not work: fg-4 measures 4.45:1 on that same surface,
 * still under the floor, because the palette sits on rgb(20,20,21) rather
 * than the page's rgb(10,10,13). Only fg-3 clears it, and fg-3 is the body
 * text rung - putting eight group headings there flattens the hierarchy the
 * ladder exists to express.
 *
 * RESOLVED (r156), and the reasoning above is what made it decidable. The
 * finding was about the ladder rather than these eight rules: tokens.css said
 * "fg-4 now clears it (4.66:1)", true on bg-1 and false on every raised
 * surface. So the ladder was measured on all of them — the titlebar (#18181B),
 * the settings pane (#161618), --color-surface-elevated (#1A1A1D) and this
 * palette (rgb(20,20,21)) — and fg-4 moved #7C7C85 → #82828B, the smallest
 * neutral step that clears 4.5:1 on every one. Six values per channel, about
 * 2% lightness; fg-3 untouched, so the hierarchy keeps its spacing.
 *
 * That alone fixed `cp-palette-row-desc`, the entry whose note said it was
 * "already on fg-4, still short". The remaining five were fg-5 carrying real
 * copy — a result count, the group headings, the footer's key legend — which
 * tokens.css already forbids ("keep fg-5 for decorative/duplicated text
 * only"), so they moved up a rung rather than needing a palette change.
 *
 * The list below is now EMPTY, which is the useful state: the shrink-only
 * assertion at the end of this file means the next below-AA text has nothing
 * to hide behind.
 */
const KNOWN_BELOW_AA: ReadonlyArray<{ cls?: string; text?: string; note: string }> = [
  // Empty, and the emptying is the point: every entry above was fixed by ONE
  // token step plus three rules moved off fg-5. Leaving the list here, with
  // the shrink-only test below, is what will catch the next one.
];

test("the command palette meets AA", async ({ page }) => {
  // palette.css carries seven fg-5 text rules and the view tests never open
  // it, so it was the largest surface this measurement had not seen.
  await boot(page);
  await page.keyboard.press("Control+k");
  // Wait for the palette itself. Counting after a fixed wait would report
  // "did not open" on a slow run, and - worse - measure the page behind it.
  await expect(page.locator('.cp-palette, [role="dialog"]').first(),
    "the palette did not open, so this would measure nothing").toBeVisible();
  const bad = await failures(page);
  const known = (b: Fail) =>
    KNOWN_BELOW_AA.some((k) => (k.cls ? b.cls.includes(k.cls) : false) || (k.text ? b.text === k.text : false));
  const unknown = bad.filter((b) => !known(b));
  expect(
    unknown.map((b) => `${b.ratio}:1 ${b.px}px "${b.text}" .${b.cls} ${b.fg} on ${b.bg}`),
    "New below-AA text in the command palette",
  ).toEqual([]);

  // The list may only shrink. An entry that stops failing has been fixed, and
  // leaving it here would let the next regression hide behind it.
  const fixed = KNOWN_BELOW_AA
    .filter((k) => !bad.some((b) => (k.cls ? b.cls.includes(k.cls) : b.text === k.text)))
    .map((k) => k.cls ?? k.text);
  expect(fixed, "listed as a known gap but now passes - delete the entry").toEqual([]);
});
