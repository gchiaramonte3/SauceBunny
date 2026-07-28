import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * The panel window may not hold permissions its own component tree cannot use.
 *
 * Tauri 2's ACL is per-window, and the panel had accumulated four grants no
 * code inside it could reach: `opener:default`, `notification:default`,
 * `notification:allow-notify` and `clipboard-manager:allow-read-text`. Every
 * caller of those APIs lives under `Toolbar` or `SettingsModal`, both of which
 * only `App.tsx` mounts. `opener:default` was the worst of them — it bundles
 * `allow-reveal-item-in-dir`, and that command takes a `Vec<PathBuf>` with no
 * scope check at all, so a compromised panel webview could have revealed any
 * path on disk in Finder, for a command the app never calls.
 *
 * Unused reach is the cheapest attack surface to remove and the easiest to
 * re-grant by accident, which is what this guards.
 *
 * TWO ASSERTIONS, and the second is the one that matters. Freezing the grant
 * list alone would only prove nobody edited a file. Walking the panel's actual
 * import graph proves the list still matches what the panel can do — so if
 * someone genuinely moves a clipboard-reading component into the panel, the
 * REACH test fails and tells them to grant the permission, rather than the
 * frozen list quietly making the app wrong.
 */

const CAPS = resolve(process.cwd(), "src-tauri/capabilities");
const SRC = resolve(process.cwd(), "src");

function permissions(file: string): string[] {
  return JSON.parse(readFileSync(join(CAPS, file), "utf8")).permissions;
}

/** Every src file reachable from an entry, following relative imports. */
function reachable(entry: string): string[] {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/from\s+"(\.[^"]+)"|import\("(\.[^"]+)"\)/g)) {
      const spec = m[1] ?? m[2];
      const base = resolve(dirname(file), spec);
      // Resolve the way the bundler does; a miss is a type-only or asset
      // import and is not a component that can call anything.
      const hit = [".ts", ".tsx", "/index.ts", "/index.tsx", ""]
        .map((ext) => base + ext)
        .find((p) => existsSync(p) && !p.endsWith("/"));
      if (hit) queue.push(hit);
    }
  }
  return [...seen];
}

describe("panel capability scope", () => {
  it("grants the panel exactly what its tree uses, and nothing else", () => {
    // An exact set, not a "contains" check: a subset match can never fail on
    // an over-grant, which is the entire failure mode being guarded.
    expect(permissions("panel.json")).toEqual([
      "core:default",
      "core:window:allow-start-dragging",
      "dialog:default",
      "dialog:allow-open",
      "dialog:allow-save",
      "clipboard-manager:default",
      "clipboard-manager:allow-write-text",
    ]);
  });

  it("nothing the panel can reach uses opener, notifications or clipboard read", () => {
    const files = reachable(join(SRC, "PanelApp.tsx"));
    expect(files.length).toBeGreaterThan(20); // the walk found a real tree

    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      if (/plugin-opener/.test(text)) offenders.push(`${f}: plugin-opener`);
      if (/plugin-notification/.test(text)) offenders.push(`${f}: plugin-notification`);
      if (/\breadText\b/.test(text)) offenders.push(`${f}: clipboard readText`);
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("keeps clipboard WRITE reachable, so the grant that stayed is earned", () => {
    // The mirror image: proves the remaining grants are not themselves stale.
    const used = reachable(join(SRC, "PanelApp.tsx"))
      .some((f) => /writeText/.test(readFileSync(f, "utf8")));
    expect(used).toBe(true);
  });

  it("grants the main window no clipboard image write", () => {
    // Zero call sites in the repo; it was granted anyway.
    expect(permissions("default.json")).not.toContain("clipboard-manager:allow-write-image");
  });
});
