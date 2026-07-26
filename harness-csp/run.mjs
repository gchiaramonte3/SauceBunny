import { createServer } from "vite";
import { webkit, chromium } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The EXACT csp string from src-tauri/tauri.conf.json
const TAURI_CSP = (await import(path.join(ROOT, "src-tauri/tauri.conf.json"), { with: { type: "json" } })).default.app.security.csp;
const APPLY = process.env.CSP !== "off";
console.log("• CSP applied:", APPLY, APPLY ? `\n  ${TAURI_CSP}` : "");

const server = await createServer({
  configFile: path.join(ROOT, "vite.config.ts"),
  root: ROOT, logLevel: "warn",
  server: { port: 5201, strictPort: true, host: "127.0.0.1" },
  plugins: [{
    name: "csp-header",
    configureServer(s) {
      s.middlewares.use((req, res, next) => {
        if (APPLY) res.setHeader("Content-Security-Policy", TAURI_CSP);
        next();
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
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto("http://127.0.0.1:5201/harness-csp/probe.html", { waitUntil: "load" });
let result;
try {
  result = await page.waitForFunction(() => window.__RESULT__, null, { timeout: 30000 }).then(h => h.jsonValue());
} catch (e) { result = { FATAL: "no result: " + e.message }; }
console.log(JSON.stringify(result, null, 2));
console.log("-- console --\n" + logs.join("\n"));
await browser.close(); await server.close(); process.exit(0);
