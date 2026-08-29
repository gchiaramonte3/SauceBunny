import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * A long transcript still opens, and the DOM cost is the one we measured.
 *
 * Nobody had these numbers. Measured in this harness (Chromium, e2e mock),
 * loading a transcript and switching away from it:
 *
 *     cues    ≈ speech   first cue   DOM nodes   view switch
 *     1,200   1 h          465 ms      18,646        107 ms
 *     3,600   3 h        1,170 ms      54,646        311 ms
 *    15,000   12.5 h     5,273 ms     225,646      1,286 ms
 *
 * Linear, no cliff, no errors even at 15,000 — which is past any real single
 * recording. Realistic files (a 1–3 hour interview) open in half a second to
 * just over one, and switching views stays in the low hundreds of ms. So there
 * is nothing to fix here, and this file does NOT pretend otherwise: it guards
 * against a catastrophic regression, not against the current cost.
 *
 * THE 2x IS REAL AND DELIBERATE. `cueEls` is exactly twice the cue count at
 * every size, because TranscriptViewer renders in the reader view and the
 * drawer tab at once and both keep-alive wrappers hide the loser rather than
 * unmounting it. That is what makes switching views instant, and at realistic
 * sizes it is paid for — 311 ms at 3,600 cues. Halving the DOM by not
 * rendering the hidden copy would trade a fast switch for a slow one, which is
 * the wrong way round for the cost involved. Recorded so the trade is a known
 * one rather than a surprise.
 *
 * Thresholds are deliberately loose — several times the measured value. A perf
 * test tuned close to the observation is a flake generator on a busy CI box;
 * this one only fires if something has gone badly wrong, like the karaoke
 * render losing its memoisation and re-marking every cue on each playhead tick.
 */

const SRT_PATH = "/e2e-mock/Documents/Sauce Bunny/Transcripts/2026-08/long.srt";
const SOURCE_URL = "https://youtube.com/watch?v=abc";

/** A transcript of `n` three-second cues, alternating speakers. */
function longSrt(n: number): string {
  const pad = (v: number, w = 2) => String(v).padStart(w, "0");
  const tc = (t: number) => `${pad(Math.floor(t / 3600))}:${pad(Math.floor(t / 60) % 60)}:${pad(t % 60)},000`;
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    out.push(`${i + 1}\n${tc(i * 3)} --> ${tc(i * 3 + 3)}\n[SPEAKER_0${i % 2}] Line ${i} of the interview.\n`);
  }
  return out.join("\n");
}

async function openTranscript(page: Page, cues: number) {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(([srt, srtPath, url]: string[]) => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.permissioned", "1");
    localStorage.setItem("e2e.files", JSON.stringify({ [srtPath]: srt }));
    localStorage.setItem("saucebunny.transcriptHistory", JSON.stringify([{
      id: "h1", srtPath, sourcePath: null, sourceUrl: url,
      title: "long", origin: "whisper", createdAt: Date.now(), lastOpenedAt: Date.now(),
    }]));
    localStorage.setItem("saucebunny.recentSources", JSON.stringify([
      { kind: "url", value: url, title: "Long interview", durationSeconds: 10_800, lastOpenedAt: Date.now() },
    ]));
  }, [longSrt(cues), SRT_PATH, SOURCE_URL]);

  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press("Meta+3");
  await page.getByTitle("Recent sources", { exact: true }).click();

  const started = Date.now();
  await page.locator(".cp-recents-row").first().click();
  await expect(page.locator("[data-cue-idx]").first()).toBeAttached({ timeout: 30_000 });
  return Date.now() - started;
}

test("a 3-hour transcript opens and stays navigable", async ({ page }) => {
  const CUES = 3600;
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  const firstCueMs = await openTranscript(page, CUES);
  // Measured at ~1.2s; this fires only on a real collapse.
  expect(firstCueMs, `first cue took ${firstCueMs}ms`).toBeLessThan(15_000);

  // Canary: the whole file is meaningless if the transcript did not load.
  await expect(page.locator("[data-cue-idx]").first()).toContainText("Line 0 of the interview");
  const rendered = await page.locator("[data-cue-idx]").count();
  expect(rendered, "no cues rendered").toBeGreaterThan(CUES);

  // Switching away must not hang. Measured at ~311ms.
  const t = Date.now();
  await page.keyboard.press("Meta+2");
  await expect(page.locator(".cp-view-library")).toBeVisible({ timeout: 20_000 });
  const switchMs = Date.now() - t;
  expect(switchMs, `view switch took ${switchMs}ms`).toBeLessThan(6_000);

  expect(errors, errors.join("\n")).toHaveLength(0);
});

test("the transcript renders in BOTH mounted instances, which is the 2x", async ({ page }) => {
  // Pinned as a fact rather than a complaint. If this ever reads 1x, someone
  // has stopped keeping the hidden copy alive — which would halve the DOM and
  // slow view switching, a real trade that should be made on purpose.
  const CUES = 1200;
  await openTranscript(page, CUES);
  await expect(page.locator("[data-cue-idx]")).toHaveCount(CUES * 2, { timeout: 20_000 });
});
