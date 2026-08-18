import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { HIDDEN_NOTICE_KEYS } from "./hidden-notices";

/**
 * Every "don't show again" flag has a way back.
 *
 * Four of them shipped without one: the rename warning, the first-run tips,
 * and two per-transcript notices. Each is a one-way door — ticked once, and
 * the only route back was deleting a localStorage key from a web inspector.
 * Nothing in Settings offered it, and nothing anywhere would have said so.
 *
 * The failure mode is why this is a test and not a note. A suppression flag
 * with no restore is invisible from the moment it is written until the day
 * somebody wants the warning back, which is far too late to be told the
 * feature was never finished. So: a suppression-shaped key in the source must
 * appear in HIDDEN_NOTICE_KEYS, and the Settings row that clears them must
 * still exist.
 */

const ROOT = resolve(__dirname, "../..");
const SRC = resolve(ROOT, "src");

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) sources(full, out);
    else if (/\.tsx?$/.test(e.name) && !e.name.includes(".test.")) out.push(full);
  }
  return out;
}

/** `saucebunny.*` keys whose NAME says they suppress something. */
const SUPPRESSION = /"(saucebunny\.[A-Za-z.]*(?:Ack|Dismissed|dismissed)[A-Za-z.]*)"/g;

function covered(key: string): boolean {
  return HIDDEN_NOTICE_KEYS.some((n) => (n.prefix ? key.startsWith(n.key) : key === n.key));
}

describe("suppression flags", () => {
  const files = sources(SRC);

  it("are being scanned in real files", () => {
    // Canary: an empty sweep would pass the assertion below forever.
    expect(files.length).toBeGreaterThan(100);
    expect(HIDDEN_NOTICE_KEYS.length, "the restore list is empty").toBeGreaterThan(2);
  });

  it("are every one of them restorable", () => {
    const orphans: string[] = [];
    for (const f of files) {
      if (f.endsWith("hidden-notices.ts")) continue; // the list itself
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(SUPPRESSION)) {
        if (!covered(m[1])) orphans.push(`${relative(ROOT, f)}  ${m[1]}`);
      }
    }
    expect([...new Set(orphans)],
      "a 'don't show again' key with no way back - add it to HIDDEN_NOTICE_KEYS").toEqual([]);
  });

  it("can actually be cleared from Settings", () => {
    // The list is useless if nothing calls it. Pins the control, not the copy.
    const settings = readFileSync(join(SRC, "components/SettingsModal.tsx"), "utf8");
    expect(settings, "Settings never imports the restore").toContain("restoreHiddenNotices");
    expect(settings, "Settings never counts what is hidden").toContain("countHiddenNotices");
  });
});
