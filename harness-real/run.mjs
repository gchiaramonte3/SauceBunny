#!/usr/bin/env node
// Boots Vite at the repo root, serves the sample MP4 with Range support,
// and drives harness-real/probe.html (which mounts the REAL player).
import { createServer } from "vite";
import { chromium, webkit } from "playwright";
import { createReadStream, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
// No machine-specific default: a path under one developer's home directory is a
// sample nobody else has. Set SAMPLE, or run `node harness-audio/run.mjs` once to
// generate a synthetic AV1+Opus clip with the bundled ffmpeg.
const SAMPLE = process.env.SAMPLE ?? path.join(ROOT, "harness-audio/generated-sample.mp4");
if (!existsSync(SAMPLE)) {
  throw new Error(`no sample at ${SAMPLE} — set SAMPLE=/path/to/any.mp4, or run \`node harness-audio/run.mjs\` once to generate one`);
}
console.log(`• sample: ${SAMPLE} (${(statSync(SAMPLE).size / 1e6).toFixed(2)} MB)`);

const server = await createServer({
  configFile: path.join(ROOT, "vite.config.ts"),
  root: ROOT,
  logLevel: "warn",
  server: { port: 5198, strictPort: true, host: "127.0.0.1" },
  plugins: [{
    name: "harness-real-sample",
    configureServer(s) {
      s.middlewares.use("/harness-real/sample.mp4", (req, res) => {
        const size = statSync(SAMPLE).size;
        if (req.method === "HEAD") {
          res.writeHead(200, { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Length": size });
          return res.end();
        }
        const range = req.headers.range;
        if (range) {
          const m = /bytes=(\d*)-(\d*)/.exec(range);
          const start = m && m[1] ? parseInt(m[1], 10) : 0;
          const end = Math.min(m && m[2] ? parseInt(m[2], 10) : size - 1, size - 1);
          res.writeHead(206, {
            "Content-Type": "video/mp4",
            "Content-Range": `bytes ${start}-${end}/${size}`,
            "Accept-Ranges": "bytes",
            "Content-Length": end - start + 1,
          });
          createReadStream(SAMPLE, { start, end }).pipe(res);
        } else {
          res.writeHead(200, { "Content-Type": "video/mp4", "Accept-Ranges": "bytes", "Content-Length": size });
          createReadStream(SAMPLE).pipe(res);
        }
      });
    },
  }],
});
await server.listen();

const ENGINE = process.env.ENGINE ?? "chromium";
const browser = ENGINE === "webkit"
  ? await webkit.launch()
  : await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
console.log(`• engine: ${ENGINE} (${browser.version()})`);

const QS = process.argv[2] ?? "";
const ctx = await browser.newContext();
const page = await ctx.newPage();
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`http://127.0.0.1:5198/harness-real/probe.html?${QS}`, { waitUntil: "load" });
let result;
try {
  result = await page.waitForFunction(() => window.__RESULT__, null, { timeout: 90_000 }).then((h) => h.jsonValue());
} catch (e) {
  result = { ok: false, error: `TIMEOUT: ${e.message}` };
}
console.log(JSON.stringify(result, null, 2));
if (logs.length) console.log("-- console --\n" + logs.slice(0, 40).join("\n"));
await browser.close();
await server.close();
process.exit(0);
