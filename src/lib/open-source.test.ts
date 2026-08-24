import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { OPEN_SOURCE_CREDITS, fundableCredits } from "./open-source";

/**
 * A donation link that goes to the wrong person is worse than no link: the
 * money leaves and does not arrive, and nobody finds out. So these check the
 * things that would make that happen, and one of them checks the claim
 * against the dependency's OWN published metadata rather than against what
 * someone typed here.
 */

describe("the open-source credits", () => {
  it("every entry has a real project link, over https", () => {
    for (const c of OPEN_SOURCE_CREDITS) {
      expect(c.url, c.name).toMatch(/^https:\/\//);
      expect(c.role.length, `${c.name} has no role`).toBeGreaterThan(20);
      expect(c.license.length, `${c.name} has no licence`).toBeGreaterThan(0);
    }
  });

  it("every funding link is https and points at a funding host", () => {
    // The failure this blocks is a fund URL that is really a project URL, or
    // a typo'd host that someone else could register.
    const hosts = ["github.com/sponsors/", "opencollective.com/", "ffmpeg.org/donations", "?sponsor=1"];
    for (const c of fundableCredits()) {
      expect(c.fund, c.name).toMatch(/^https:\/\//);
      expect(
        hosts.some((h) => c.fund!.includes(h)),
        `${c.name}'s funding link is not a recognised funding route: ${c.fund}`,
      ).toBe(true);
    }
  });

  it("mediabunny's sponsor link matches the package's own funding field", () => {
    // The one entry the user asked for by name, checked against the source of
    // truth that ships in node_modules rather than against this file.
    const pkg = JSON.parse(readFileSync("node_modules/mediabunny/package.json", "utf8"));
    const declared = typeof pkg.funding === "string" ? pkg.funding : pkg.funding?.url;
    const entry = OPEN_SOURCE_CREDITS.find((c) => c.name === "mediabunny");
    expect(entry, "mediabunny is not credited at all").toBeTruthy();
    expect(entry!.fund).toBe(declared);
  });

  it("names are unique, so nobody is thanked twice or paid twice", () => {
    const names = OPEN_SOURCE_CREDITS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("credits the bundled binaries, not just the npm packages", () => {
    // The GPL/heavy-lifting sidecars are the easiest to forget, because they
    // are not in package.json - they are fetched by scripts.
    const names = OPEN_SOURCE_CREDITS.map((c) => c.name.toLowerCase());
    for (const must of ["yt-dlp", "ffmpeg", "whisper.cpp", "mediabunny"]) {
      expect(names, `${must} is bundled and uncredited`).toContain(must);
    }
  });

  it("no em dashes - this is user-facing copy", () => {
    for (const c of OPEN_SOURCE_CREDITS) {
      expect(c.role, c.name).not.toContain("—");
    }
  });
});
