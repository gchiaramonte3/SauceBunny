import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * A window may not hold permissions its own component tree cannot use.
 *
 * Tauri 2's ACL is per-window, and the panel had accumulated four grants no
 * code inside it could reach: `opener:default`, `notification:default`,
 * `notification:allow-notify` and `clipboard-manager:allow-read-text`. Every
 * caller of those APIs lives under `Toolbar` or `SettingsModal`, both of which
 * only `App.tsx` mounts. `opener:default` was the worst of them — it bundles
 * `allow-reveal-item-in-dir`, and that command takes a `Vec<PathBuf>` with no
 * scope check at all, so a compromised panel webview could have revealed any
 * path on disk in Finder, for a command the app never calls. That grant is now
 * impossible to make: r152 ejected the opener and clipboard-manager plugins
 * outright, and the last test here keeps their names out of both files.
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
    ]);
  });

  it("nothing the panel can reach uses opener or notifications", () => {
    const files = reachable(join(SRC, "PanelApp.tsx"));
    expect(files.length).toBeGreaterThan(20); // the walk found a real tree

    const offenders: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      if (/plugin-opener/.test(text)) offenders.push(`${f}: plugin-opener`);
      if (/plugin-notification/.test(text)) offenders.push(`${f}: plugin-notification`);
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("keeps dialog reachable, so the grants that stayed are earned", () => {
    // The mirror image of the test above: it proves the REMAINING grants are
    // not themselves stale. A scope test that only ever shrinks the list would
    // happily pass on a capability file that grants nothing at all.
    const used = reachable(join(SRC, "PanelApp.tsx"))
      .some((f) => /plugin-dialog/.test(readFileSync(f, "utf8")));
    expect(used).toBe(true);
  });

  it("no window grants a plugin the app no longer bundles", () => {
    // opener and clipboard-manager were ejected in r152 (open_external_url /
    // read_clipboard_text / navigator.clipboard replaced them). A stale grant
    // for a plugin that is gone fails the Tauri build rather than degrading
    // quietly - but it fails it at `cargo check`, long after the edit, so
    // catching it here is cheaper.
    for (const file of ["default.json", "panel.json"]) {
      const perms = permissions(file).join(" ");
      expect(perms, file).not.toMatch(/opener:|clipboard-manager:/);
    }
  });
});
