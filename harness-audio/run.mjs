#!/usr/bin/env node
/**
 * ONE COMMAND:  node harness-audio/run.mjs
 *
 * Boots a Vite dev server rooted at the repo (so `mediabunny`, `opus-decoder`
 * and src/lib/mediabunny-decoders.ts resolve EXACTLY as the app resolves them),
 * serves the sample MP4, drives real Chromium via Playwright, and prints the
 * observed numbers for each probe mode.
 *
 * Sample file resolution order:
 *   1. $SAMPLE (absolute path)
 *   2. ~/Desktop/Test/Vingadores_-Doutor-Destino-_-Trailer-Oficial-Legendado-3.mp4
 *   3. harness-audio/generated-sample.mp4, produced on demand with the bundled
 *      ffmpeg (AV1 + Opus, 5.5s, audible 440Hz tone) if neither exists.
 */
import { createServer } from "vite";
import { chromium, webkit } from "playwright";
import { createReadStream, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const FFMPEG = path.join(ROOT, "src-tauri/binaries/ffmpeg-aarch64-apple-darwin");

function resolveSample() {
  if (process.env.SAMPLE && existsSync(process.env.SAMPLE)) return process.env.SAMPLE;
  const desktop = path.join(
    os.homedir(),
    "Desktop/Test/Vingadores_-Doutor-Destino-_-Trailer-Oficial-Legendado-3.mp4",
  );
  if (existsSync(desktop)) return desktop;

  const gen = path.join(HERE, "generated-sample.mp4");
  if (existsSync(gen)) return gen;
  if (!existsSync(FFMPEG)) {
    throw new Error(`No sample found and no bundled ffmpeg at ${FFMPEG}`);
  }
  console.log("• generating an AV1+Opus sample with the bundled ffmpeg…");
  execFileSync(FFMPEG, [
    "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24:duration=5.5",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=5.5",
    "-c:v", "libsvtav1", "-preset", "12", "-crf", "50",
    "-c:a", "libopus", "-b:a", "96k", "-ac", "2",
    "-shortest", gen,
  ], { stdio: "inherit" });
  return gen;
}

const SAMPLE = resolveSample();
console.log(`• sample: ${SAMPLE} (${(statSync(SAMPLE).size / 1e6).toFixed(2)} MB)\n`);

const server = await createServer({
  configFile: path.join(ROOT, "vite.config.ts"),
  root: ROOT,
  logLevel: "warn",
  server: { port: 5199, strictPort: true, host: "127.0.0.1" },
  plugins: [{
    name: "harness-sample",
    configureServer(s) {
      s.middlewares.use("/harness-audio/sample.mp4", (req, res) => {
        const size = statSync(SAMPLE).size;
        const range = req.headers.range;
        if (range) {
          const m = /bytes=(\d*)-(\d*)/.exec(range);
          const start = m && m[1] ? parseInt(m[1], 10) : 0;
          const end = m && m[2] ? parseInt(m[2], 10) : size - 1;
          res.writeHead(206, {
            "Content-Type": "video/mp4",
            "Content-Range": `bytes ${start}-${end}/${size}`,
            "Accept-Ranges": "bytes",
            "Content-Length": end - start + 1,
          });
          createReadStream(SAMPLE, { start, end }).pipe(res);
        } else {
          res.writeHead(200, {
            "Content-Type": "video/mp4",
            "Accept-Ranges": "bytes",
            "Content-Length": size,
          });
          createReadStream(SAMPLE).pipe(res);
        }
      });
    },
  }],
});
await server.listen();
const BASE = "http://127.0.0.1:5199";

// ENGINE=webkit runs the same probes in Playwright's WebKit — the engine
// family WKWebView belongs to. Chromium is the default.
const ENGINE = process.env.ENGINE ?? "chromium";
const browser = ENGINE === "webkit"
  ? await webkit.launch()
  : await chromium.launch({
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--enable-features=SharedArrayBuffer",
      "--use-fake-device-for-media-stream",
    ],
  });
console.log(`• engine: ${ENGINE} (${browser.version()})\n`);

const MODES = process.argv[2]
  ? [process.argv[2]]
  : ["caps", "native", "custom", "prime", "prime-race", "interleave",
     "concurrent", "rate-mismatch", "playback", "playback-primed"];

const all = {};
for (const mode of MODES) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const logs = [];
  page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
  await page.goto(`${BASE}/harness-audio/probe.html?mode=${mode}`, { waitUntil: "load" });
  let result;
  try {
    result = await page.waitForFunction(() => window.__RESULT__, null, { timeout: 90_000 })
      .then((h) => h.jsonValue());
  } catch (e) {
    result = { mode, ok: false, error: `TIMEOUT: ${e.message}` };
  }
  all[mode] = result;
  console.log("═".repeat(78));
  console.log(`MODE: ${mode}`);
  console.log("═".repeat(78));
  console.log(JSON.stringify(result, null, 2));
  if (logs.length) console.log("-- console --\n" + logs.slice(0, 40).join("\n"));
  console.log();
  await ctx.close();
}

await browser.close();
await server.close();

console.log("═".repeat(78));
console.log("SUMMARY");
console.log("═".repeat(78));
for (const [m, r] of Object.entries(all)) {
  if (!r?.ok) { console.log(`${m.padEnd(16)} FAILED: ${String(r?.error).slice(0, 200)}`); continue; }
  const d = r.drain;
  const bits = [];
  if (d) bits.push(`chunks=${d.count} nonSilent=${d.nonSilentChunks} peak=${d.globalPeak} covered=${d.coveredSeconds}s first@${d.firstBufferMs}ms err=${d.error ?? "none"}`);
  if (r.renderedPeakAmplitude !== undefined) bits.push(`started=${r.startedNodes} dropped=${r.droppedNodes} renderedPeak=${r.renderedPeakAmplitude} audible=${r.audible}`);
  if (r.spy) bits.push(`nativeAudioDecoder=${r.spy.audioDecoderConfigures?.length ?? 0}[${(r.spy.audioDecoderConfigures ?? []).join(",")}] wasmCompile=${r.spy.wasmCompile}`);
  console.log(`${m.padEnd(16)} ${bits.join(" | ")}`);
}
process.exit(0);
