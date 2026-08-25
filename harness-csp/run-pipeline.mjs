import { createServer } from "vite";
import { webkit, chromium } from "playwright";
import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TAURI_CSP = (await import(path.join(ROOT, "src-tauri/tauri.conf.json"), { with: { type: "json" } })).default.app.security.csp;
const APPLY = process.env.CSP !== "off";
const CSP_STR = process.env.CSP === "wasm" ? TAURI_CSP.replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'") : TAURI_CSP;
// No machine-specific default: a path under one developer's home directory is a
// sample nobody else has. Set SAMPLE, or run `node harness-audio/run.mjs` once to
// generate a synthetic AV1+Opus clip with the bundled ffmpeg.
const SAMPLE = process.env.SAMPLE ?? path.join(ROOT, "harness-audio/generated-sample.mp4");
console.log("• CSP:", APPLY ? CSP_STR.match(/script-src[^;]*/)[0] : "off", "| sample:", path.basename(SAMPLE));

const server = await createServer({
  configFile: path.join(ROOT, "vite.config.ts"), root: ROOT, logLevel: "warn",
  server: { port: 5202, strictPort: true, host: "127.0.0.1" },
  plugins: [{
    name: "csp+sample",
    configureServer(s) {
      s.middlewares.use((req, res, next) => { if (APPLY) res.setHeader("Content-Security-Policy", CSP_STR); next(); });
      s.middlewares.use("/harness-csp/sample.mp4", (req, res) => {
        const size = statSync(SAMPLE).size;
        const range = req.headers.range;
        if (range) {
          const m = /bytes=(\d*)-(\d*)/.exec(range);
          const start = m && m[1] ? +m[1] : 0;
          const end = m && m[2] ? +m[2] : size - 1;
          res.writeHead(206, { "Content-Type": "video/mp4", "Content-Range": `bytes ${start}-${end}/${size}`, "Accept-Ranges": "bytes", "Content-Length": end - start + 1 });
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
const ENGINE = process.env.ENGINE ?? "webkit";
const browser = ENGINE === "webkit" ? await webkit.launch() : await chromium.launch();
console.log(`• engine: ${ENGINE} ${browser.version()}`);
const page = await (await browser.newContext()).newPage();
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`.slice(0, 200)));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`.slice(0, 200)));
await page.goto("http://127.0.0.1:5202/harness-csp/pipeline.html", { waitUntil: "load" });
let result;
try { result = await page.waitForFunction(() => window.__RESULT__, null, { timeout: 60000 }).then(h => h.jsonValue()); }
catch (e) { result = { FATAL: "no result: " + e.message }; }
console.log(JSON.stringify(result, null, 2));
console.log("-- console --\n" + logs.join("\n"));
await browser.close(); await server.close(); process.exit(0);
