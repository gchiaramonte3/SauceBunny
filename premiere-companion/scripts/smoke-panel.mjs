import { createRequire } from "node:module";
import { readFile, mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve, extname } from "node:path";
import assert from "node:assert/strict";

// Reuse Sauce Bunny's existing Playwright install; not shipped in the CCX.
const require = createRequire(resolve(import.meta.dirname, "../../package.json"));
const { chromium } = require("@playwright/test");
const root = resolve(import.meta.dirname, "../dist");
const manifest = JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8"));
const panelIds = manifest.entrypoints.filter(entry => entry.type === "panel").map(entry => entry.id);
const server = createServer(async (request, response) => {
  const path = request.url === "/" ? "/index.html" : request.url;
  if (!path || !/^\/(index\.html|assets\/[A-Za-z0-9._-]+)$/.test(path)) { response.writeHead(404); response.end(); return; }
  try {
    response.setHeader("Content-Type", extname(path) === ".js" ? "text/javascript" : "text/html");
    response.end(await readFile(resolve(root, `.${path}`)));
  } catch { response.writeHead(404); response.end(); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const browser = await chromium.launch({ headless: true });
const screenshots = resolve(import.meta.dirname, "../../test-results/premiere-companion");
await mkdir(screenshots, { recursive: true });
try {
  for (const size of [{ width: 340, height: 600 }, { width: 280, height: 420 }]) for (const scale of [1, 1.25]) {
    const page = await browser.newPage({ viewport: size });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(panelIds => {
      window.require = module => module === "uxp" ? { entrypoints: { setup(config) {
        if (typeof config.plugin?.create !== "function") throw new Error("create method is not defined for plugin.");
        for (const id of panelIds) for (const hook of ["create", "show", "hide", "destroy"]) {
          if (typeof config.panels?.[id]?.[hook] !== "function") throw new Error(`${hook} missing for panel ${id}`);
        }
        window.__companionLifecycle = config;
        config.plugin.create();
        for (const id of panelIds) { config.panels[id].create(document.body); config.panels[id].show(document.body); }
      } } } : {};
      window.__companionNetworkCalls = 0;
      window.__hostCommandKeys = 0;
      document.addEventListener("keydown", event => {
        if ([" ", "Enter"].includes(event.key) && event.target.tagName === "BUTTON" && !event.defaultPrevented) window.__hostCommandKeys++;
      });
      window.WebSocket = class {
        readyState = 0;
        enabled = false;
        constructor(url) {
          if (!/^ws:\/\/localhost:[1-9][0-9]{0,4}\/premiere$/.test(url)) throw new Error("Unexpected socket endpoint");
          window.__companionNetworkCalls++; setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0);
        }
        close() { this.readyState = 3; }
        send(data) {
          const command = JSON.parse(data);
          if (command.type === "setSync") this.enabled = command.enabled;
          const binding = { bindingId: "fixture-binding", projectId: "fixture-project", sequenceId: "fixture-sequence",
            projectName: "LongProjectNameWithoutBreaks".repeat(6), sequenceName: "LongSequenceNameWithoutBreaks".repeat(6),
            timebaseTicks: "10584000000", zeroPointTicks: "0", displayFormat: "24Timecode" };
          const note = { id: "b".repeat(64), status: "needs_confirmation", sequenceTicks: null, markerGuid: null, error: null,
            request: { reviewKey: "fixture-review", versionId: "v1", commentId: "fixture-note", sessionId: null,
              author: "Alex · Editor", body: "Hold this shot longer. ".repeat(15), anchor: { binding, sourceId: "fixture-ndi", capturedAt: 100, verification: "unverified" } } };
          const reply = { v: 1, id: command.id, type: "snapshot", notes: [note], page: { offset: 0, total: 1, hasMore: false },
            status: { phase: "connected", binding, syncEnabled: this.enabled, automaticPlacement: false, pendingCount: 1,
              otherBindingPendingCount: 0, ledgerRevision: 1, error: null } };
          setTimeout(() => this.onmessage?.({ data: JSON.stringify(reply) }), 0);
        }
      };
    }, panelIds);
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByRole("heading", { name: "Sauce Bunny", exact: true }).waitFor();
    await page.evaluate(factor => {
      for (const token of ["base", "md", "lg", "3xl"]) {
        const name = `--text-${token}`;
        const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(name));
        document.documentElement.style.setProperty(name, `${value * factor}px`);
      }
    }, scale);
    assert.equal(await page.getByRole("button", { name: "Connect", exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole("heading", { name: "Pending notes", exact: false }).count(), 0);
    assert.equal(await page.evaluate(() => window.__companionNetworkCalls), 0);
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByLabel("Pairing code", { exact: true }).focus();
    assert.equal(await page.locator("input").count(), 1);
    assert.equal(await page.getByLabel("Pairing code", { exact: true }).getAttribute("type"), "password");
    await page.screenshot({ path: resolve(screenshots, `disconnected-${size.width}-${scale}.png`) });
    const code = `SBP1:12345:${Date.now() + 300000}:${"a".repeat(64)}`;
    await page.getByLabel("Pairing code", { exact: true }).fill(code);
    await page.evaluate(() => {
      for (const panel of Object.values(window.__companionLifecycle.panels)) {
        panel.hide(); panel.destroy(); panel.create(document.body); panel.show(document.body);
      }
    });
    assert.equal(await page.getByLabel("Pairing code", { exact: true }).inputValue(), code);
    assert.equal(await page.locator(".cp-companion").count(), 1);
    assert.equal(await page.evaluate(() => window.__companionNetworkCalls), 0);
    const pair = page.getByRole("button", { name: "Connect", exact: true });
    assert.equal(await pair.isEnabled(), true);
    await pair.focus();
    assert.equal(await pair.evaluate(element => getComputedStyle(element).borderColor), "rgb(255, 255, 255)");
    assert.equal(await pair.evaluate(element => getComputedStyle(element).outlineStyle), "none");
    await page.keyboard.press("Space");
    await page.getByRole("heading", { name: "Bound sequence", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__hostCommandKeys), 0, "command activation must not bubble into host shortcuts");
    const toggle = page.getByLabel("Send review notes to Premiere");
    await toggle.focus();
    await page.keyboard.press("Space");
    await page.waitForFunction(() => document.querySelector('input[type="checkbox"]').checked);
    assert.deepEqual(await toggle.evaluate(element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })), { width: 13, height: 13 });
    assert((await toggle.locator("..").boundingBox()).height >= 30);
    assert.equal(await page.evaluate(() => {
      const panel = document.querySelector(".cp-companion");
      return panel.scrollWidth <= panel.clientWidth + 1;
    }), true, "long project/sequence names must not push controls outside the panel");
    const dimensions = await page.locator("button").evaluateAll(elements => elements.map(element => {
      const box = element.getBoundingClientRect(); return { width: box.width, height: box.height };
    }));
    assert(dimensions.length >= 3);
    assert(dimensions.every(box => box.width >= 24 && box.height >= 30));
    await page.getByRole("heading", { name: "Pending notes", exact: false }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(screenshots, `pending-${size.width}-${scale}.png`) });
    await page.getByRole("button", { name: "Disconnect", exact: true }).click();
    assert.equal(await page.getByLabel("Pairing code", { exact: true }).inputValue(), "", "successful pairing clears the credential");
    await page.getByLabel("Pairing code", { exact: true }).fill("https://example.invalid");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("alert").waitFor();
    assert.equal(await page.evaluate(() => window.__companionNetworkCalls), 1, "invalid addresses must not connect");
    await page.getByLabel("Pairing code", { exact: true }).fill(`SBP1:12345:1:${"a".repeat(64)}`);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    assert.match(await page.getByRole("alert").innerText(), /expired/);
    assert.equal(await page.evaluate(() => window.__companionNetworkCalls), 1, "expired codes must not connect");
    assert.deepEqual(errors, []);
    await page.evaluate(() => window.__companionLifecycle.plugin.destroy());
    await page.waitForFunction(() => !document.querySelector(".cp-companion"));
    await page.close();
  }
  console.log("Packaged panel passed at 340/280px and 100/125% text: disconnected, paired, pending, error, keyboard, targets, focus, wrapping and explicit-only connection.");
  console.log("Chromium with isolated host stubs is not a real Premiere UXP acceptance test.");
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
