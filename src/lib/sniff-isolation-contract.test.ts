import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The page resolver's webview stays powerless.
 *
 * `sniff_page_media` loads a page the USER PASTED — untrusted by definition —
 * in a real webview, so it can run its JavaScript and reveal the video URL its
 * server never put in the HTML. What keeps that safe is not the comment saying
 * so; it is two structural facts, and both are one small edit from being lost:
 *
 *   1. The window label `media-resolver` appears in NO capability file.
 *      Capabilities here are scoped per label, so an unlisted window is granted
 *      nothing: the page cannot invoke a command, read a file, or reach the
 *      asset protocol. Adding the label to a capability — or widening a
 *      capability's `windows` to a wildcard — hands a hostile page the app.
 *   2. Findings come back over a DENIED NAVIGATION, not over IPC. No channel is
 *      opened to the page at all.
 *
 * Neither would fail loudly if broken. The resolver would keep working, and the
 * only difference would be that a pasted link could now reach into the app.
 */

const ROOT = resolve(__dirname, "../..");
const CAPS = resolve(ROOT, "src-tauri/capabilities");
const SNIFF = readFileSync(resolve(ROOT, "src-tauri/src/commands/sniff.rs"), "utf8");

type Capability = { windows?: string[]; permissions?: unknown[] };

const capabilities = readdirSync(CAPS)
  .filter((f) => f.endsWith(".json"))
  .map((f) => ({ file: f, json: JSON.parse(readFileSync(join(CAPS, f), "utf8")) as Capability }));

describe("the resolver webview is unprivileged", () => {
  it("is being checked against real capability files", () => {
    // Canary: an empty sweep would pass every assertion below forever.
    expect(capabilities.length, "no capability files found").toBeGreaterThan(1);
    expect(capabilities.every((c) => Array.isArray(c.json.windows)),
      "a capability stopped scoping itself to named windows").toBe(true);
  });

  it("grants the media-resolver label nothing", () => {
    const granted = capabilities.filter((c) => (c.json.windows ?? []).includes("media-resolver"));
    expect(granted.map((c) => c.file),
      "the resolver window was given capabilities; a pasted page can now call in").toEqual([]);
  });

  it("has no capability that would match it by wildcard", () => {
    // `windows: ["*"]` or a "media-*" pattern would cover the resolver without
    // ever naming it, which is exactly how this gets lost.
    const wild = capabilities.filter((c) =>
      (c.json.windows ?? []).some((w) => w.includes("*")));
    expect(wild.map((c) => c.file), "a wildcard window scope would include the resolver").toEqual([]);
  });

  it("opens no IPC channel to the page: results ride a denied navigation", () => {
    expect(SNIFF, "the private scheme is gone").toContain("sbsniff://");
    expect(SNIFF, "on_navigation is how the payload is read").toContain("on_navigation");
    // The handler must DENY the navigation it read the payload from.
    expect(SNIFF).toMatch(/\/\/ DENY[\s\S]{0,200}return false/);
  });

  it("keeps the window invisible and always tears it down", () => {
    expect(SNIFF).toContain(".visible(false)");
    expect(SNIFF, "a resolver window could be left on screen").toContain("win.close()");
  });

  it("refuses anything that is not an http(s) page", () => {
    expect(SNIFF).toContain('url.starts_with("https://")');
    expect(SNIFF, "file:// or a custom scheme must not be loadable here")
      .toContain("Only http(s) pages can be resolved.");
  });

  it("bounds both the wait and the payload it accepts back", () => {
    // A page that never loads must not leak a window, and a hostile one must
    // not be able to make us allocate without limit.
    expect(SNIFF).toContain("SNIFF_TIMEOUT_MS");
    expect(SNIFF).toContain("MAX_PAYLOAD_BYTES");
    expect(SNIFF).toMatch(/recv_timeout/);
  });
});
