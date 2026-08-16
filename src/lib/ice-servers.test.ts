import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildIceServers, isLanOnly, DEFAULT_STUN_URL } from "./ice-servers";

const ROOT = resolve(__dirname, "../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe("buildIceServers", () => {
  it("puts STUN first, then TURN", () => {
    // Order is what the browser tries first, and a direct route beats a relay.
    const out = buildIceServers(DEFAULT_STUN_URL, { url: "turn:h:3478", username: "u", password: "p" });
    expect(out.map((s) => s.urls)).toEqual([DEFAULT_STUN_URL, "turn:h:3478"]);
    expect(out[1]).toMatchObject({ username: "u", credential: "p" });
  });

  it("omits STUN when the field is empty", () => {
    // The whole point of making it configurable: a user can decline it.
    expect(buildIceServers("", { url: "turn:h:3478", username: "", password: "" }))
      .toEqual([{ urls: "turn:h:3478", username: undefined, credential: undefined }]);
  });

  it("omits TURN when the field is empty", () => {
    expect(buildIceServers(DEFAULT_STUN_URL, { url: "", username: "", password: "" }))
      .toEqual([{ urls: DEFAULT_STUN_URL }]);
  });

  it("contacts nobody when both are empty", () => {
    expect(buildIceServers("", { url: "", username: "", password: "" })).toEqual([]);
    expect(buildIceServers(null)).toEqual([]);
    expect(isLanOnly("", null)).toBe(true);
    expect(isLanOnly(DEFAULT_STUN_URL, null)).toBe(false);
  });

  it("treats whitespace as empty", () => {
    // A field the user cleared by selecting-all and typing a space is a
    // cleared field, not a request to dial "   ".
    expect(buildIceServers("   ", { url: "  ", username: "", password: "" })).toEqual([]);
    expect(buildIceServers("  stun:h:1  ")).toEqual([{ urls: "stun:h:1" }]);
  });

  it("sends undefined rather than empty credentials", () => {
    // An empty username is not a username; WebRTC should see the field absent.
    const [turn] = buildIceServers("", { url: "turn:h:3478", username: "", password: "" });
    expect(turn.username).toBeUndefined();
    expect(turn.credential).toBeUndefined();
  });
});

describe("the STUN endpoint stays configurable", () => {
  it("is hardcoded nowhere else", () => {
    // It lived inline in use-rtc-mesh, which is why nobody could see it, aim
    // it elsewhere, or turn it off. One home, one default.
    const scanned = walk(join(ROOT, "src"));
    // A scanner that matches nothing certifies everything. Proven, not
    // hypothetical: breaking the file filter left this passing over ZERO
    // files while still reporting the rule as enforced.
    expect(scanned.length, "no source files scanned").toBeGreaterThan(50);
    const bad = scanned
      .map((f) => [f.slice(ROOT.length + 1), readFileSync(f, "utf8")] as const)
      .filter(([rel]) => rel !== "src/lib/ice-servers.ts" && rel !== "src/lib/ice-servers.test.ts")
      .filter(([, text]) => /["'`]stun:[^"'`]+["'`]/.test(text))
      .map(([rel]) => rel);
    expect(bad, "import DEFAULT_STUN_URL from lib/ice-servers instead").toEqual([]);
  });

  it("reads the stored value with ?? so an empty one survives", () => {
    // `||` would hand the default back to a user who deliberately cleared the
    // field, quietly re-enabling the call they turned off. This is the one
    // character that decides whether the setting works.
    const app = readFileSync(join(ROOT, "src/App.tsx"), "utf8");
    expect(app).toMatch(/stunUrl:\s*stored\.stunUrl\s*\?\?\s*DEFAULT_STUN_URL/);
    expect(app).not.toMatch(/stunUrl:\s*stored\.stunUrl\s*\|\|/);
  });

  it("still defaults to something, so a fresh install just works", () => {
    // Making it configurable must not mean shipping a broken default: a peer
    // behind NAT genuinely cannot be reached without a reflexive candidate.
    expect(DEFAULT_STUN_URL).toMatch(/^stun:/);
  });
});
