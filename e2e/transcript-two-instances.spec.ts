import { test, expect, type Page } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * The transcript viewer, with a real transcript, mounted twice at once.
 *
 * This is the first e2e that gets actual cues on screen. Until the mock grew
 * an opt-in `e2e.files` seed, `read_text_file_capped` returned null for every
 * path, so the largest component in the app could only ever render its empty
 * state and its behaviour was untestable outside jsdom.
 *
 * What that unlocks is the part jsdom structurally cannot reach. The viewer
 * renders in the reader view AND the drawer's transcript tab simultaneously —
 * both are keep-alive wrappers that hide the loser rather than unmounting it —
 * so a `window` keydown listener inside it fires TWICE for one keystroke. The
 * first assertion below measures that directly: three cues in the fixture,
 * six cue elements in the DOM.
 *
 * The ⌘F/⌘G handlers each carry a gate for this, added after a real bug: ⌘G
 * advanced the HIDDEN instance's match cursor and switched its auto-scroll
 * off, and nothing switches auto-scroll back on, so karaoke follow silently
 * died in the view the user was not looking at.
 *
 * WHAT THESE TESTS DO AND DO NOT PROVE. They assert real user-visible
 * behaviour: cues render, ⌘F lands on a search box the user can see in either
 * view and with the drawer shut, and ⌘F stays out of the way of a modal. They
 * do NOT prove the ⌘F visibility gate is load-bearing, and four break-tests
 * establish that rather than assume it — deleting the gate leaves all of them
 * green.
 *
 * The reason is worth writing down, because it is a fact about the platform
 * rather than about this code. Measured in this browser: `focus()` on an
 * element inside a `[hidden]` subtree is a NO-OP, so the reader view and the
 * unselected drawer tabs are protected by the DOM itself; inside
 * `aria-hidden="true"` focus lands normally, so the closed drawer is NOT — and
 * it does keep one focusable input mounted. Even so, no configuration reached
 * here makes ⌘F put the caret there with the gate removed.
 *
 * So for ⌘F the gate is defensive, and the honest statement is that its
 * absence is not observable from outside. Where it IS load-bearing is ⌘G,
 * whose effect is state mutation (match cursor, auto-scroll) that no platform
 * rule blocks — and that remains covered only statically, by
 * `hidden-instance-contract`. Do not read these four tests as covering it.
 */

const SRT = `1
00:00:01,000 --> 00:00:03,000
[SPEAKER_00] The first line of dialogue.

2
00:00:04,000 --> 00:00:06,000
[SPEAKER_01] And the second speaker answers.

3
00:00:07,000 --> 00:00:09,000
[SPEAKER_00] A third cue to search for zebra.
`;

const SRT_PATH = "/e2e-mock/Documents/Sauce Bunny/Transcripts/2026-08/demo.srt";
const SOURCE_URL = "https://youtube.com/watch?v=abc";

const pageErrors: string[] = [];

async function bootWithTranscript(page: Page): Promise<void> {
  pageErrors.length = 0;
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(([srt, srtPath, url]: string[]) => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("e2e.files", JSON.stringify({ [srtPath]: srt }));
    // The auto-load path is history-driven: App looks the SOURCE up in
    // transcript history, probes the SRT, then sets activeTranscript. Seeding
    // the entry is what makes opening the recent source attach the transcript.
    localStorage.setItem("saucebunny.transcriptHistory", JSON.stringify([{
      id: "h1", srtPath, sourcePath: null, sourceUrl: url,
      title: "demo", origin: "whisper", createdAt: Date.now(), lastOpenedAt: Date.now(),
    }]));
    localStorage.setItem("saucebunny.recentSources", JSON.stringify([
      { kind: "url", value: url, title: "Seeded web source", durationSeconds: 90, lastOpenedAt: Date.now() },
    ]));
  }, [SRT, SRT_PATH, SOURCE_URL]);

  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Control+3");
  await expect(page.locator(".cp-toolbar")).toBeVisible();

  await page.getByTitle("Recent sources", { exact: true }).click();
  await page.locator(".cp-recents-row").first().click();
  // Cues arriving IS the readiness signal — no fixed wait. Note this waits on
  // COUNT, not visibility: `.first()` is the DOM-first cue, which belongs to
  // the HIDDEN instance, so `toBeVisible()` can never pass. That mistake cost
  // three red tests before the spec's own subject explained it.
  await expect(page.locator("[data-cue-idx]")).toHaveCount(6, { timeout: 15_000 });
}

test("the seeded transcript renders, and renders TWICE", async ({ page }) => {
  // The canary for every test in this file, and a measurement in its own
  // right: if the seed stops working there are no cues and the gate tests
  // below would pass on an empty page.
  await bootWithTranscript(page);
  const cues = page.locator("[data-cue-idx]");
  // Scoped to the VISIBLE instance — the hidden twin holds the same text and
  // asserting on it would prove nothing about what the user can read.
  await expect(page.locator("[data-cue-idx]:visible").first())
    .toContainText("first line of dialogue");
  // Three cues in the fixture, two mounted instances. If this ever reads 3,
  // the keep-alive duplication is gone and hidden-instance-contract should be
  // deleted rather than left guarding a hazard that no longer exists.
  await expect(cues, "expected 3 cues x 2 mounted instances").toHaveCount(6);
  expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
});

const focusLanding = (page: Page) => page.evaluate(() => {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return { ok: false, why: "no activeElement", tag: "-" };
  const hidden = el.closest("[hidden]");
  const ariaHidden = el.closest('[aria-hidden="true"]');
  return {
    ok: !hidden && !ariaHidden,
    tag: el.tagName,
    why: hidden ? "inside [hidden]" : ariaHidden ? "inside aria-hidden" : "visible",
  };
});

test("Cmd+F focuses the VISIBLE search box in EITHER view", async ({ page }) => {
  // Both configurations, because one alone proves nothing (see the header).
  await bootWithTranscript(page);

  // Clip view: the drawer's copy is on screen, the reader's is hidden.
  await page.keyboard.press("Control+f");
  const inClip = await focusLanding(page);
  expect(inClip.ok, `Clip view: Cmd+F put focus ${inClip.why} (${inClip.tag})`).toBe(true);

  // Transcripts view: the roles swap, and so does the registration order that
  // was silently rescuing the ungated version.
  await page.keyboard.press("Control+5");
  await expect(page.locator(".cp-view-reader")).toBeVisible();
  await page.keyboard.press("Control+f");
  const inReader = await focusLanding(page);
  expect(inReader.ok, `Transcripts view: Cmd+F put focus ${inReader.why} (${inReader.tag})`).toBe(true);

  expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
});

test("Cmd+F does not focus the CLOSED drawer's copy", async ({ page }) => {
  // The configuration where the gate is genuinely load-bearing, and the one
  // the two tests above cannot reach.
  //
  // Measured in this browser: `focus()` on an element inside a `[hidden]`
  // subtree is a NO-OP — the platform refuses it — but inside an
  // `aria-hidden="true"` subtree focus lands normally. The drawer marks itself
  // `aria-hidden={!open}` and stays MOUNTED when closed, so its transcript
  // copy is hidden from the user and still perfectly focusable. Nothing but
  // the handler's own gate stops ⌘F putting the caret in a search box behind a
  // closed drawer.
  //
  // This is also why the earlier break-tests kept passing with the gate
  // deleted: every configuration tested happened to be `[hidden]`, where the
  // browser was doing the work.
  await bootWithTranscript(page);
  const hide = page.getByRole("button", { name: "Hide panel" }).first();
  await expect(hide, "no Hide panel control, so the drawer was never closed").toHaveCount(1);
  await hide.click();

  await page.keyboard.press("Control+f");

  const landed = await focusLanding(page);
  expect(landed.ok, `Cmd+F put focus ${landed.why} (${landed.tag}) with the drawer closed`).toBe(true);
  expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
});

test("Cmd+F is inert while a modal dialog holds focus", async ({ page }) => {
  // The second gate in the same handlers. Yanking focus to a search box behind
  // the scrim would take the user out of the dialog they are looking at.
  await bootWithTranscript(page);
  const gear = page.locator('[aria-label="Settings"], button:has-text("Settings")').first();
  await gear.click();
  const dialog = page.locator('[role="dialog"][aria-modal="true"]').first();
  await expect(dialog, "no modal dialog opened, so this asserted nothing").toBeVisible();

  await page.keyboard.press("Control+f");

  const insideDialog = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return !!el?.closest('[role="dialog"][aria-modal="true"]');
  });
  expect(insideDialog, "Cmd+F pulled focus out of the open modal").toBe(true);
  expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
});
