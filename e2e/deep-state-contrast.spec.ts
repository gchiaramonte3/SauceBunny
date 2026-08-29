import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * Contrast on the screens behind a loaded source.
 *
 * `contrast.spec.ts` measures the opening screen and is clean. It could not
 * see anything that needs a source: the export fields, the timeline ruler, the
 * transcript, the review tab. Pointing the same measurement at those states
 * found the export CTA's own label — "Download entire clip", meaningful copy
 * by any reading — at 4.31:1, because `--fg-4` sits on a purple-tinted
 * composite there (#221C31 as rendered) that the earlier fg-4 work never
 * measured. Lifting fg-4 to #86868F fixed that and every other non-fg-5 miss.
 *
 * WHAT THIS DELIBERATELY ALLOWS. `--fg-5` (#71717A) reads 3.99:1 on the app
 * canvas and that is the documented intent — tokens.css says "Keep fg-5 for
 * decorative/duplicated text only; meaningful secondary copy belongs on fg-4
 * or up." So this test permits sub-AA text ONLY in that colour, and fails on
 * any other. That is the useful shape: it cannot be quietened by moving text
 * to a dimmer token, because fg-5 is the only exemption and it is the bottom
 * of the ladder.
 *
 * It does mean the nine current fg-5 items (source `.meta`, timeline
 * `.tick-label`) are accepted here on the strength of that policy rather than
 * re-argued. Whether a timecode ruler label is "decorative" is a judgement
 * call for a human, not something a sweep should decide by itself.
 */

type Fail = { text: string; cls: string; fg: string; bg: string; ratio: number; px: number };

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

/** The one colour allowed below AA, per tokens.css's stated policy. */
const FG_5 = "rgb(113, 113, 122)";

const SRT = `1
00:00:01,000 --> 00:00:03,000
[SPEAKER_00] The first line of dialogue.

2
00:00:04,000 --> 00:00:06,000
[SPEAKER_01] And the second speaker answers.
`;
const SRT_PATH = "/e2e-mock/Documents/Sauce Bunny/Transcripts/2026-08/demo.srt";
const SOURCE_URL = "https://youtube.com/watch?v=abc";

async function bootWithSource(page: Page): Promise<void> {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(([srt, srtPath, url]: string[]) => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.permissioned", "1");
    localStorage.setItem("e2e.files", JSON.stringify({ [srtPath]: srt }));
    localStorage.setItem("saucebunny.transcriptHistory", JSON.stringify([{
      id: "h1", srtPath, sourcePath: null, sourceUrl: url,
      title: "demo", origin: "whisper", createdAt: Date.now(), lastOpenedAt: Date.now(),
    }]));
    localStorage.setItem("saucebunny.recentSources", JSON.stringify([
      { kind: "url", value: url, title: "Seeded", durationSeconds: 90, lastOpenedAt: Date.now() },
    ]));
  }, [SRT, SRT_PATH, SOURCE_URL]);
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Meta+3");
  await expect(page.locator(".cp-toolbar")).toBeVisible();
  await page.getByTitle("Recent sources", { exact: true }).click();
  await page.locator(".cp-recents-row").first().click();
  await expect(page.locator("[data-cue-idx]")).toHaveCount(4, { timeout: 15_000 });
}

const fmt = (f: Fail) => `${f.ratio}:1  ${f.px}px  ${f.fg} on ${f.bg}  "${f.text}" .${f.cls}`;

test("the sweep has text to measure behind a source", async ({ page }) => {
  // Canary. Every assertion below is "nothing failed", which a page with no
  // measurable text satisfies perfectly.
  await bootWithSource(page);
  const measured = await page.evaluate(() =>
    Array.from(document.querySelectorAll("*")).filter((n) => {
      const own = Array.from(n.childNodes).filter((c) => c.nodeType === Node.TEXT_NODE)
        .map((c) => c.textContent || "").join("").trim();
      return own.length >= 2;
    }).length);
  expect(measured, "no text nodes found behind a loaded source").toBeGreaterThan(30);
});

test("a loaded source: nothing below AA except fg-5", async ({ page }) => {
  await bootWithSource(page);
  const bad = (await failures(page)).filter((f) => f.fg !== FG_5);
  expect(bad.map(fmt), "sub-AA text in a tier that is not the decorative one").toEqual([]);
});

test("the review tab: nothing below AA except fg-5", async ({ page }) => {
  await bootWithSource(page);
  await page.locator("#cp-tab-review").click();
  await expect(page.getByPlaceholder(/^Comment at/)).toBeVisible();
  const bad = (await failures(page)).filter((f) => f.fg !== FG_5);
  expect(bad.map(fmt), "sub-AA text in the review tab").toEqual([]);
});
