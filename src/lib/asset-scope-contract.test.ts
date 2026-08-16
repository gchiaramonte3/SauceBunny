import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Asset-protocol scope contract.
 *
 * The scope used to be `["**"]`: anything running in the webview could read any
 * file on the machine over `asset://`. It is now two halves that must stay in
 * agreement, and NEITHER half fails loudly on its own:
 *
 *   STATIC  — `$APPCACHE/**`. Everything the app writes for itself. These URLs
 *             are persisted into recents and queue rows and re-rendered on a
 *             later launch with no backend call in between, so this half cannot
 *             be a runtime grant.
 *   DYNAMIC — `probe_local_file` calls `allow_asset_read` for the user's own
 *             media, whose paths are arbitrary and known only at runtime.
 *
 * A denial is HTTP 403 with an EMPTY body, so it reads as a broken `<img>` or a
 * `<video>` that errors into the mediabunny fallback. That is the same shape as
 * the r150 CSP bug, which took three reports to find. Hence a test.
 *
 * What this CAN catch: a new `asset://` mint site appearing outside the one
 * module, the scope string being widened back to `**`, or the grant being
 * removed from the choke point. What it CANNOT catch: an existing mint site
 * being fed a new KIND of path. That residual is stated in asset-url.ts and in
 * SECURITY.md rather than papered over.
 */

const ROOT = resolve(__dirname, "../..");
const MINT_MODULE = "src/lib/asset-url.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("asset scope contract", () => {
  it("keeps the static scope narrow", () => {
    const conf = JSON.parse(readFileSync(resolve(ROOT, "src-tauri/tauri.conf.json"), "utf8")) as {
      app?: { security?: { assetProtocol?: { enable?: boolean; scope?: string[] } } };
    };
    const ap = conf.app?.security?.assetProtocol;
    expect(ap?.enable, "the asset protocol must stay enabled").toBe(true);
    // Pinned exactly. Tauri's Scope::new SILENTLY SKIPS an entry it cannot
    // resolve, so a typo like $APPCACHE2/** yields an EMPTY allow-list and
    // 403s every poster and every native playback with no startup error.
    expect(ap?.scope).toEqual(["$APPCACHE/**"]);
  });

  it("never widens back to the whole filesystem", () => {
    const scope = (JSON.parse(readFileSync(resolve(ROOT, "src-tauri/tauri.conf.json"), "utf8")) as {
      app?: { security?: { assetProtocol?: { scope?: string[] } } };
    }).app?.security?.assetProtocol?.scope ?? [];
    for (const pattern of scope) {
      expect(
        pattern === "**" || pattern === "/**" || pattern.startsWith("$HOME"),
        `Scope entry "${pattern}" is broad enough to defeat the point. Grant per file `
        + "via allow_asset_read in probe_local_file instead of widening this list.",
      ).toBe(false);
    }
  });

  it("mints asset:// URLs from exactly one module", () => {
    // convertFileSrc IS the asset:// mint. Keeping it to one module is what
    // makes the two-halves rule reviewable, and what makes a new consumer of
    // arbitrary paths visible in a diff rather than at runtime.
    const scanned = walk(resolve(ROOT, "src"));
    // A scanner that matches nothing certifies everything. Proven, not
    // hypothetical: breaking the file filter left this passing over ZERO
    // files while still reporting the rule as enforced.
    expect(scanned.length, "no source files scanned").toBeGreaterThan(50);
    const offenders = scanned
      .filter((f) => !f.endsWith("asset-url.ts") && !f.endsWith("asset-scope-contract.test.ts"))
      .filter((f) => /\bconvertFileSrc\s*\(/.test(readFileSync(f, "utf8")))
      .map((f) => f.slice(ROOT.length + 1));
    expect(
      offenders,
      `These files call convertFileSrc directly. Route them through assetUrl() in ${MINT_MODULE} `
      + "so every asset:// path has a documented reason to be readable.",
    ).toEqual([]);
  });

  it("still grants the user's own media at the choke point", () => {
    // Without this call, the narrow scope means every imported file plays as a
    // black frame (native path) and silently degrades to the IPC reader.
    const probe = readFileSync(resolve(ROOT, "src-tauri/src/commands/media.rs"), "utf8");
    expect(
      /allow_asset_read\(&app, &p\)/.test(probe),
      "probe_local_file must call allow_asset_read: it is the one command every "
      + "local source passes through, and the only thing granting arbitrary paths.",
    ).toBe(true);

    const helper = readFileSync(resolve(ROOT, "src-tauri/src/commands/mod.rs"), "utf8");
    expect(/fn allow_asset_read/.test(helper)).toBe(true);
    // The early return is what bounds the pattern set to sources opened, which
    // matters because is_allowed is a linear glob scan run per asset request.
    expect(
      /if scope\.is_allowed\(path\) \{\s*\n\s*return;/.test(helper),
      "allow_asset_read must return early for already-allowed paths, or the "
      + "pattern set grows per call and lands on the playback byte-range path.",
    ).toBe(true);
  });
});
