#!/usr/bin/env node
// Does a native <video> play this AV1+Opus MP4 with picture but no sound,
// and does it fire an `error` event? (The LocalMediaPlayer path.)
import { webkit, chromium } from "playwright";
import { createReadStream, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

// No machine-specific default: a path under one developer's home directory is a
// sample nobody else has. Set SAMPLE, or run `node harness-audio/run.mjs` once to
// generate a synthetic AV1+Opus clip with the bundled ffmpeg.
const SAMPLE = process.env.SAMPLE ?? path.join(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), "harness-audio/generated-sample.mp4");
const size = statSync(SAMPLE).size;
const server = http.createServer((req, res) => {
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? +m[1] : 0;
    const end = Math.min(m && m[2] ? +m[2] : size - 1, size - 1);
    res.writeHead(206, { "Content-Type": "video/mp4", "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1 });
    createReadStream(SAMPLE, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Length": size });
    createReadStream(SAMPLE).pipe(res);
  }
});
await new Promise((r) => server.listen(5197, "127.0.0.1", r));

const ENGINE = process.env.ENGINE ?? "webkit";
const browser = ENGINE === "chromium"
  ? await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] })
  : await webkit.launch();
const page = await (await browser.newContext()).newPage();
await page.goto("about:blank");
const out = await page.evaluate(async () => {
  const v = document.createElement("video");
  v.src = "http://127.0.0.1:5197/x.mp4";
  v.muted = false;
  v.volume = 1;
  document.body.appendChild(v);
  const log = [];
  for (const e of ["error", "loadedmetadata", "canplay", "playing", "stalled", "waiting", "ended"]) {
    v.addEventListener(e, () => log.push({ e, t: +v.currentTime.toFixed(3), err: v.error?.code ?? null }));
  }
  await new Promise((r) => setTimeout(r, 2500));
  const canOpusMp4 = v.canPlayType('audio/mp4; codecs="opus"');
  const canOpusWebm = v.canPlayType('audio/webm; codecs="opus"');
  const canAv1Mp4 = v.canPlayType('video/mp4; codecs="av01.0.05M.08"');
  const canBoth = v.canPlayType('video/mp4; codecs="av01.0.05M.08,opus"');
  try { await v.play(); } catch (e) { log.push({ e: "playRejected", m: String(e) }); }
  await new Promise((r) => setTimeout(r, 2500));
  const t1 = v.currentTime;
  await new Promise((r) => setTimeout(r, 1200));
  return {
    canPlayType: { av1Mp4: canAv1Mp4, opusMp4: canOpusMp4, opusWebm: canOpusWebm, av1PlusOpusMp4: canBoth },
    readyState: v.readyState, networkState: v.networkState, duration: v.duration,
    error: v.error ? { code: v.error.code, message: v.error.message } : null,
    // WebKit exposes these; they tell us whether an audio track exists/played.
    webkitAudioDecodedByteCount: v.webkitAudioDecodedByteCount ?? null,
    webkitVideoDecodedByteCount: v.webkitVideoDecodedByteCount ?? null,
    audioTracks: v.audioTracks ? v.audioTracks.length : null,
    videoTracks: v.videoTracks ? v.videoTracks.length : null,
    advancedTo: +t1.toFixed(3), finalTime: +v.currentTime.toFixed(3),
    paused: v.paused, log,
  };
});
console.log(`engine=${ENGINE} ${browser.version()}`);
console.log(JSON.stringify(out, null, 2));
await browser.close();
server.close();
process.exit(0);
