import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Secrets stay in the Keychain — never in localStorage, an export, or a report.
 *
 * The rule holds today, in four places that each blank `turnPassword` by name:
 * App's defaults write, its legacy migration, the settings export, and the
 * settings import. Nothing checks any of them.
 *
 * The reason to check is an asymmetry rather than a bug. `diagnostics.ts`
 * protects this by PATTERN — `SECRET_KEY_PATTERNS`, case-insensitive substring
 * — precisely so "a future `turnPassword2` or `apiKeyBackup` is caught without
 * anyone remembering to update this list". The settings export protects it by
 * NAME, spreading the whole defaults object and blanking one field. Add a
 * second secret to `Defaults` and diagnostics redacts it automatically while
 * the export writes it into a file people mail to strangers.
 *
 * So this asserts the assumption those four sites rest on: that `turnPassword`
 * is the ONLY secret-shaped field in `Defaults`. Adding another fails here,
 * which is the moment to make the export pattern-based too.
 *
 * (The cloud AI keys are not covered because they never reach the frontend:
 * they are set and read entirely in Rust, `commands/cloud_ai.rs`. Asserting
 * their absence from a file that has no idea they exist would be theatre.)
 */

const ROOT = resolve(__dirname, "../..");
const settingsModal = readFileSync(join(ROOT, "src/components/SettingsModal.tsx"), "utf8");
const app = readFileSync(join(ROOT, "src/App.tsx"), "utf8");
const diagnostics = readFileSync(join(ROOT, "src/lib/diagnostics.ts"), "utf8");

/** The same words diagnostics.ts redacts on. */
const SECRET_WORDS = ["password", "secret", "token", "apikey", "api_key", "credential"];

function defaultsFields(): string[] {
  const m = /export type Defaults = \{([\s\S]*?)\n\};/.exec(settingsModal);
  if (!m) return [];
  return [...m[1].matchAll(/^\s{2}(\w+)\??:/gm)].map((x) => x[1]);
}

describe("secrets never reach disk through the frontend", () => {
  it("read the Defaults shape", () => {
    expect(defaultsFields().length, "no Defaults fields parsed").toBeGreaterThan(15);
  });

  it("has exactly one secret-shaped field, and it is turnPassword", () => {
    // The assumption every by-name blank below depends on. When this fails,
    // the fix is not to add another name — it is to make the export scrub by
    // pattern, the way diagnostics.ts already does.
    const secretish = defaultsFields().filter((f) =>
      SECRET_WORDS.some((w) => f.toLowerCase().includes(w.replace("_", ""))));
    expect(secretish).toEqual(["turnPassword"]);
  });

  it("blanks it everywhere defaults are persisted or exported", () => {
    // Four sites, one rule. A fifth that forgets is how a secret ends up in a
    // JSON file the user is invited to share.
    const writes = [...app.matchAll(/saveJson\(DEFAULTS_KEY,\s*\{([^}]*)\}/g)].map((m) => m[1]);
    expect(writes.length, "no DEFAULTS_KEY writes found in App").toBeGreaterThanOrEqual(2);
    for (const w of writes) {
      expect(w, `a defaults write does not blank turnPassword: ${w.trim()}`).toMatch(/turnPassword:\s*""/);
    }

    const exportPayload = /kind: "settings"[\s\S]{0,400}?defaults:\s*\{([^}]*)\}/.exec(settingsModal)?.[1];
    expect(exportPayload, "settings export payload not found").toBeTruthy();
    expect(exportPayload, "the settings export carries the TURN password").toMatch(/turnPassword:\s*""/);

    const importWrite = /saveJson\(DEFAULTS_LS_KEY,\s*\{([^}]*)\}/.exec(settingsModal)?.[1];
    expect(importWrite, "settings import write not found").toBeTruthy();
    expect(importWrite, "an imported file's TURN password is written to disk").toMatch(/turnPassword:\s*""/);
  });

  it("keeps the diagnostics redaction list pattern-based", () => {
    // The one surface that is future-proof. If this ever narrows to a literal
    // field name, the comment above stops being true.
    for (const w of SECRET_WORDS) expect(diagnostics).toContain(`"${w}"`);
    expect(diagnostics).toMatch(/toLowerCase\(\)/);
  });
});
