import { test, expect } from "@playwright/test";
import { EXPECTED_BACKEND_BUILD_ID } from "../src/lib/build-id";
import { tauriMockInit } from "./tauri-mock";

/**
 * Nothing that floats over the video may land on anything else.
 *
 * Reported twice from live sessions. First the canvas toast printed across the
 * top-right corner of the prep banner while both said "Downloading preview…";
 * then the same corner showed the stream-quality chip and the shuttle badge on
 * top of each other. Two faults behind both: duplicate copy (fixed at the
 * source -- the banner carries progress and a Cancel, so it is the surface
 * that event gets), and geometry.
 *
 * The geometry fix used to be a lift: the toast read the banner's measured
 * height from a --prep-h custom property and raised itself clear. That is a
 * box tracking another box, it needed a fallback for the frame before the
 * measurement landed, and the fallback is what the user photographed -- 62px
 * of lift against a banner that had wrapped to 115px.
 *
 * Now every top-left surface is a child of .cp-monitor-stack and flow keeps
 * them apart. This measures the rendered result with the shipped stylesheet,
 * at the sizes that actually broke: a wrapped banner, a two-line toast, and
 * both chips present at once. src/lib/monitor-stack-contract.test.ts holds the
 * declaration side, which is the half that catches a NEW surface claiming an
 * occupied corner.
 */
test("no two canvas overlays intersect, at their tallest", async ({ page }) => {
  await page.addInitScript(tauriMockInit, EXPECTED_BACKEND_BUILD_ID);
  await page.addInitScript(() => {
    localStorage.setItem("cp-defaults-v2", JSON.stringify({ ytAuthOnboarded: true }));
    localStorage.setItem("saucebunny.welcomed", "1");
    localStorage.setItem("saucebunny.permissioned", "1");
  });
  await page.goto("/");
  await expect(page.locator(".cp-view-home")).toBeVisible({ timeout: 15_000 });

  const result = await page.evaluate(() => {
    const stage = document.createElement("div");
    stage.className = "cp-monitor";
    // A realistic player box. Narrow enough that the banner's subtitle wraps,
    // which is the case the retired constant was too small for.
    Object.assign(stage.style, { position: "relative", width: "900px", height: "506px" });

    // Every top-left surface, all present at once. They are mutually exclusive
    // in some app states and not in others; the stack must hold either way.
    const stackEl = document.createElement("div");
    stackEl.className = "cp-monitor-stack";
    stackEl.innerHTML =
      '<div class="cp-stream-rung">360p</div>' +
      '<div class="cp-stream-rung cp-stream-keep">Saving a copy · 10%</div>' +
      '<div class="cp-shuttle-badge">▶▶ 4×</div>' +
      '<div class="cp-canvas-toast"><span class="icon"></span>' +
      '<div class="text"><div class="title">Downloading preview…</div>' +
      "<div class=\"body\">Couldn't stream this source in-app. Fetching the file " +
      'so you can scrub and mark.</div></div></div>';

    // The prep banner is a stack member too: at bottom-left it ran under a
    // full-width caption, and captions are the one thing app chrome may not
    // cover. Captions are the only surface left outside the stack.
    const banner = document.createElement("div");
    banner.className = "cp-prep-banner";
    banner.innerHTML =
      '<div style="width:44px;height:44px"></div>' +
      '<div class="cp-prep-text"><div class="cp-prep-title">Downloading preview…</div>' +
      '<div class="cp-prep-sub">CDN blocked in-app streaming. Fetching via yt-dlp ' +
      'so you can scrub.</div></div><button class="cp-prep-cancel">Cancel</button>';
    stackEl.append(banner);

    const caps = document.createElement("div");
    caps.className = "cp-caption-overlay";
    caps.innerHTML =
      '<div class="cp-caption-cue">um what a little treat maybe I\'ll do it, and ' +
      "then some more words so the cue runs the full width of the frame</div>";

    stage.append(stackEl, caps);
    document.body.append(stage);

    const named: Array<{ name: string; r: DOMRect }> = [];
    for (const el of [...Array.from(stackEl.children), caps]) {
      named.push({ name: (el as HTMLElement).className, r: el.getBoundingClientRect() });
    }
    const stackBox = stackEl.getBoundingClientRect();
    stage.remove();

    const overlaps: string[] = [];
    for (let i = 0; i < named.length; i++) {
      for (let j = i + 1; j < named.length; j++) {
        const a = named[i], b = named[j];
        const x = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
        const y = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
        if (x > 0 && y > 0) overlaps.push(`${a.name} × ${b.name} (${Math.round(x)}×${Math.round(y)}px)`);
      }
    }
    return { overlaps, count: named.length, boxes: named.map((n) => ({ n: n.name, h: n.r.height })), stackH: stackBox.height };
  });

  // Canaries. Every one of these has been the reason a scan like this passed
  // while measuring nothing: an element that failed to lay out has a zero box,
  // and a zero box never intersects anything.
  expect(result.count, "not every overlay was built").toBe(6);
  for (const b of result.boxes) {
    expect(b.h, `${b.n} laid out at zero height; it cannot overlap anything`).toBeGreaterThan(10);
  }
  expect(result.stackH, "the stack collapsed; its children are not being spaced").toBeGreaterThan(100);

  expect(result.overlaps, "overlays are on top of each other").toEqual([]);
});
