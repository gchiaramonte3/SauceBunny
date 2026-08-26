#!/usr/bin/env node
/**
 * The seek log, from a live session.
 *
 * Boots the REAL Rust proxy over a real 600s fixture (a cargo test that holds
 * the server open), boots Vite, opens Chromium, mounts the REAL
 * MSEStreamPlayer, drives a click and two drags, and prints the seek lines a
 * user would see in the Pipeline pane.
 *
 * Why this exists: a report of "a major regression in seeking and scrubbing
 * for web clips" was answered from reading the code, and then from unit tests
 * driving the seek handle. Both were right and neither was a session. This is.
 *
 *   node harness-seek/run.mjs
 */
import { createServer } from "vite";
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

/** Boot the cargo-test proxy and wait for the line it prints. */
function startProxy() {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "cargo",
      ["test", "--lib", "harness_seek_session_server", "--", "--ignored", "--nocapture"],
      { cwd: path.join(ROOT, "src-tauri"), env: { ...process.env, HARNESS_HOLD_SECS: "180" } },
    );
    let buf = "";
    const onData = (b) => {
      buf += b.toString();
      const m = /HARNESS_PATH=(\S+)/.exec(buf);
      if (m) resolve({ proc, proxyPath: m[1] });
    };
    proc.stdout.on("data", onData);
    proc.stderr.on("data", (b) => { const s = b.toString(); if (/error|panic/i.test(s)) process.stderr.write(s); });
    proc.on("exit", (c) => reject(new Error(`proxy server exited early (${c})`)));
    setTimeout(() => reject(new Error("proxy did not print HARNESS_PATH within 180s")), 180_000);
  });
}

console.log("• building the 600s fixture and booting the real proxy (first run encodes it)…");
const { proc, proxyPath } = await startProxy();
console.log(`• proxy: ${proxyPath.replace(/\/v1\/.*/, "/v1/…")}`);

const server = await createServer({
  configFile: path.join(ROOT, "vite.config.ts"),
  root: ROOT,
  logLevel: "warn",
  server: { port: 5199, strictPort: true, host: "127.0.0.1" },
});
await server.listen();

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", (e) => console.error("  page error:", e.message));

const url = `http://127.0.0.1:5199/harness-seek/probe.html?path=${encodeURIComponent(proxyPath)}&duration=600`;
await page.goto(url);
console.log("• driving a click and two drags against the real pipeline…\n");

await page.waitForFunction(() => window.__SEEK_DONE__?.value != null, null, { timeout: 120_000 })
  .catch(() => console.error("  (timed out; printing what arrived)"));

const lines = await page.evaluate(() => window.__SEEK_LOG__ ?? []);
const stamp = (ms) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
};
console.log("──────── live seek log ────────");
for (const l of lines) console.log(`${stamp(l.at)}  ${l.tag.padEnd(4)}  ${l.msg}`);
console.log("───────────────────────────────");

await browser.close();
await server.close();
proc.kill("SIGKILL");
