#!/usr/bin/env node
/**
 * Drives the REAL MSEStreamPlayer through real seeks and reports what the
 * player itself says happened.
 *
 * Two mini-proxy routes, matching the Rust one's contract:
 *   /t/<tok>/v1/<b64>            raw bytes, Range honoured (the scrub preview
 *                                decoder reads this)
 *   /t/<tok>/fmp4/v1/<b64>?start=N   ffmpeg-remuxed fragmented MP4 from N
 *                                (rebased timeline: no X-Timeline header, so
 *                                the player takes baseTime = start, which is
 *                                the branch a plain proxy exercises)
 */
import { createServer as createVite } from "vite";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/*
 * MEASURED, so nobody has to rediscover it:
 *
 *   fixture            first preview frame
 *   640x360             ~32ms
 *   3840x2160         ~2076ms      (65x, and the reported source was 4K)
 *
 * That is the scrub complaint's remaining half. Revealing the overlay only
 * once it holds a frame stops the BLACK (this harness proves that: 10 empty
 * frames with the fix reverted, 0 with it). It does not make a 4K preview
 * keep up, because the preview decodes full-resolution frames over ranged
 * reads. The fix for that is a lower-resolution source for the preview, not
 * a faster decoder.
 *
 *   FIXTURE=sample-4k.mp4 VC=avc1.42C033 DUR=240 SLOW_MS=400 node harness-seek/run.mjs
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const FIXTURE = process.env.FIXTURE ?? "sample-600s.mp4";
const VC = process.env.VC ?? "avc1.64001E";
const DUR = process.env.DUR ?? "600";
const SAMPLE = path.join(HERE, FIXTURE);
const FFMPEG = path.join(ROOT, "src-tauri/binaries/ffmpeg-aarch64-apple-darwin");
if (!existsSync(SAMPLE) && FIXTURE === "sample-600s.mp4") {
  // Generated, not committed: 35 MB, and it is reproducible in one command.
  // The timecode is burned INTO the picture on purpose - it is what makes a
  // landing checkable by eye instead of by the player's own say-so.
  console.log("• generating the 10-minute fixture (once)…");
  const { execFileSync } = await import("node:child_process");
  execFileSync(FFMPEG, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=600",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=600",
    "-vf", "drawtext=fontfile=/System/Library/Fonts/Supplemental/Arial.ttf:text='%{pts\\:hms}':x=20:y=20:fontsize=48:fontcolor=white:box=1:boxcolor=black@0.8",
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-g", "48", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "64k", "-shortest", SAMPLE,
  ]);
}

if (!existsSync(SAMPLE)) throw new Error(`no fixture at ${SAMPLE}`);

const proxy = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:5199");
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Range",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length, Accept-Ranges",
  };
  const size = statSync(SAMPLE).size;

  if (url.pathname.includes("/fmp4/v1/")) {
    const start = Number(url.searchParams.get("start") ?? "0");
    res.writeHead(200, { ...cors, "Content-Type": "video/mp4" });
    const ff = spawn(FFMPEG, [
      "-hide_banner", "-loglevel", "error",
      ...(start > 0 ? ["-ss", String(start)] : []),
      "-i", SAMPLE, "-c", "copy",
      "-movflags", "frag_keyframe+empty_moov+default_base_moof",
      "-f", "mp4", "pipe:1",
    ]);
    ff.stdout.pipe(res);
    res.on("close", () => ff.kill("SIGKILL"));
    return;
  }

  // Raw bytes with Range — what the scrub-preview decoder reads.
  //
  // SLOW_MS exists because without it this harness cannot see the bug it was
  // written for. Over the loopback a preview frame decodes in ~32ms, so the
  // overlay is never caught empty and the check passes whether the fix is
  // present or not. The reported failure was a 4K source over the network,
  // where each ranged read is a real round trip. Delaying these reads is what
  // reproduces that, and it is the difference between a test and a decoration.
  const delay = Number(process.env.SLOW_MS ?? "0");
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const s = m?.[1] ? parseInt(m[1], 10) : 0;
    const e = Math.min(m?.[2] ? parseInt(m[2], 10) : size - 1, size - 1);
    res.writeHead(206, {
      ...cors, "Content-Type": "video/mp4", "Accept-Ranges": "bytes",
      "Content-Range": `bytes ${s}-${e}/${size}`, "Content-Length": e - s + 1,
    });
    return setTimeout(() => createReadStream(SAMPLE, { start: s, end: e }).pipe(res), delay);
  }
  res.writeHead(200, { ...cors, "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Length": size });
  createReadStream(SAMPLE).pipe(res);
});
await new Promise((r) => proxy.listen(5199, "127.0.0.1", r));

const vite = await createVite({
  configFile: path.join(ROOT, "vite.config.ts"),
  root: ROOT, logLevel: "warn",
  server: { port: 5198, strictPort: true, host: "127.0.0.1" },
});
await vite.listen();

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
page.on("pageerror", (e) => console.log("  ✗ pageerror:", e.message));
page.on("console", (m) => console.log("  [console]", m.text().slice(0,200)));
await page.goto(`http://127.0.0.1:5198/harness-seek/probe.html?f=${FIXTURE}&vc=${VC}&dur=${DUR}`);
try {
  await page.waitForFunction(() => (window).__probe?.ready === true, null, { timeout: 25_000 });
  console.log("• player ready\n");
} catch {
  console.log("• NOT ready. what the player logged:");
  for (const l of await page.evaluate(() => (window).__probe?.diag ?? [])) console.log(`  ${l.tag} ${l.msg}`);
  await browser.close(); await vite.close(); proxy.close(); process.exit(2);
}

const P = (fn, ...a) => page.evaluate(fn, ...a);
const sleep = (ms) => page.waitForTimeout(ms);

// ── REPLAY MODE: somebody else's gestures, verbatim ──────────────────
//
// REPLAY is a JSON list of gestures: {from} is a click, {from,to} is a drag
// released at `to`. It exists so a reported log can be re-run with its own
// numbers rather than with numbers that happen to suit the harness, which is
// the difference between "I could not reproduce it" and "here is what your
// gesture actually does".
if (process.env.REPLAY) {
  const gestures = JSON.parse(process.env.REPLAY);
  for (const g of gestures) {
    await P((x) => (window).__probe.seekTo(x), g.from);
    if (g.to != null) {
      for (let i = 1; i <= 20; i++) {
        await P((x) => (window).__probe.seekTo(x), g.from + (g.to - g.from) * (i / 20));
        await sleep(25);
      }
    }
    await sleep(4500);
    const at = await P(() => (window).__probe.currentTime());
    const want = g.to ?? g.from;
    const ok = Math.abs(at - want) < 1.5;
    console.log(`  ${ok ? "✓" : "✗"} ${g.to != null ? `drag ${g.from} → ${g.to}` : `click ${g.from}`}  landed ${at.toFixed(1)}s`);
  }
  console.log("\n── what the player logged ──");
  for (const l of await P(() => (window).__probe.diag)) console.log(`  ${l.tag.padEnd(5)} ${l.msg}`);
  await page.screenshot({ path: path.join(HERE, "landed.png") });
  await browser.close(); await vite.close(); proxy.close();
  process.exit(0);
}

// ── 1. THE COLD SCRUB: the only window the overlay bug lives in ──────
//
// It has to be first. The overlay is revealed once it holds a frame and then
// legitimately keeps showing a stale one, so any earlier seek warms it up and
// the empty case becomes unobservable. An earlier version of this harness put
// the click first and reported a clean pass with the bug reinstated.
console.log(`── cold scrub, ${process.env.SLOW_MS ?? 0}ms preview reads ──`);
const cold = [];
await P(() => (window).__probe.seekTo(60));
for (let i = 0; i < 20; i++) {
  cold.push(await P(() => ({
    shown: (window).__probe.overlayShown(),
    luma: (window).__probe.overlayLuma(),
  })));
  await sleep(30);
}
const blackFrames = cold.filter((s) => s.shown && s.luma >= 0 && s.luma < 4).length;

// ── What is on SCREEN through a rebuild ──────────────────────────────
// Hiding the overlay only helps if the thing underneath is worth seeing.
// An out-of-buffer seek tears the MediaSource down and builds a new one,
// and if the <video> goes black for that window then the picture is black
// either way and the overlay fix bought nothing. This measures the
// composite the user actually looks at: the overlay when it is shown, the
// video when it is not.
const onScreen = [];
await P(() => (window).__probe.seekTo(240));
for (let i = 0; i < 60; i++) {
  onScreen.push(await P(() => {
    const p = (window).__probe;
    return p.overlayShown() ? p.overlayLuma() : p.videoLuma();
  }));
  await sleep(100);
}
const darkMs = onScreen.filter((l) => l >= 0 && l < 4).length * 100;
console.log(`  screen dark during a rebuild      : ${darkMs}ms of ${onScreen.length * 100}ms`);
if (process.env.DEBUG_SAMPLES) console.log("  onScreen:", JSON.stringify(onScreen.map((n) => Math.round(n))));
if (process.env.DEBUG_SAMPLES) console.log("  samples:", JSON.stringify(cold));
console.log(`  frames where an EMPTY overlay covered the video : ${blackFrames}`);
console.log("  (>0 is the bug: the black rectangle is back)");
await sleep(4000);

// ── 2. A CLICK: one seekTo, far out of buffer ────────────────────────
console.log("\n── click seek to 300.0s ──");
await P(() => (window).__probe.seekTo(300));
await sleep(6000);
console.log(`  reported playhead : ${(await P(() => (window).__probe.currentTime())).toFixed(1)}s`);

// ── 3. A DRAG: many seekTo calls, released somewhere else ────────────
console.log("\n── drag from 120.0s, released at 480.0s ──");
await P(() => (window).__probe.seekTo(120));
for (let i = 1; i <= 24; i++) {
  await P((x) => (window).__probe.seekTo(x), 120 + (480 - 120) * (i / 24));
  await sleep(40);
}
await sleep(6000);
console.log(`  reported playhead : ${(await P(() => (window).__probe.currentTime())).toFixed(1)}s`);

console.log("\n── what the player logged ──");
for (const l of await P(() => (window).__probe.diag)) console.log(`  ${l.tag.padEnd(5)} ${l.msg}`);

await page.screenshot({ path: path.join(HERE, "landed.png") });
console.log(`\n• screenshot: ${path.join(HERE, "landed.png")}`);
console.log("  the burned-in timecode in that frame is where the player actually landed.");

await browser.close();
await vite.close();
proxy.close();
process.exit(blackFrames > 0 ? 1 : 0);
