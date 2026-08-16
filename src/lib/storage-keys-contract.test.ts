import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve(__dirname, "..");
const ROOT = resolve(__dirname, "../..");

/**
 * Storage keys live under `saucebunny.`, with nine named exceptions.
 *
 * CLAUDE.md says prefs are "localStorage namespaced saucebunny.*". 57 keys
 * are. Nine are not: they carry the `cp-` prefix from the app's ClipPull
 * origins, the same carryover the CSS classes have and for the same reason.
 *
 * They are NOT being renamed, and that is a decision rather than a shrug.
 * Renaming a localStorage key throws the user's value away unless a migration
 * copies it first, and one of these nine is `cp-defaults-v2` - the entire
 * settings blob. Getting that wrong resets every preference for every existing
 * install, in exchange for a tidier string that nobody sees. CLAUDE.md already
 * reasons exactly this way about the ~600 `cp-` CSS classes.
 *
 * Worth knowing WHY it drifted: there were two legacy prefixes.
 * `clippull.*` got a real migration (lib/migrate-storage.ts, still running at
 * boot). `cp-*` never did, so it simply stayed, and the documented rule
 * quietly stopped describing the code.
 *
 * So this test does the useful half: the nine are pinned by name, and any NEW
 * key has to use the namespace. It is the list that keeps the rule honest -
 * one more `cp-` key added by copy-paste and nobody would notice again.
 */

/** Legacy keys predating the rename, kept because renaming them costs user data. */
const GRANDFATHERED: readonly string[] = [
  "cp-aspect",
  "cp-captions-on",
  "cp-defaults-v2",
  "cp-folder",
  "cp-logs-open",
  "cp-muted",
  "cp-recents",
  "cp-sidebar-sections",
  "cp-volume",
];

/** Prefixes a test fixture may use: the migration's own inputs. */
const FIXTURE_PREFIXES = ["clippull.", "somethingelse.", "http"];

function sourceFiles(includeTests: boolean): Array<[rel: string, code: string]> {
  const out: Array<[string, string]> = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(e.name)) {
        const isTest = /\.test\.tsx?$/.test(e.name);
        if (isTest && !includeTests) continue;
        out.push([full.slice(SRC.length + 1), readFileSync(full, "utf8")]);
      }
    }
  };
  walk(SRC);
  return out;
}

/** Literal keys handed to a storage call or declared as a *KEY constant. */
function storageKeys(includeTests = false): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const patterns = [
    /(?:localStorage\.(?:getItem|setItem|removeItem)|loadJson|saveJson|removeJson)\s*\(\s*["'`]([^"'`]+)["'`]/g,
    /const\s+\w*KEY\w*\s*=\s*["'`]([^"'`]+)["'`]/g,
  ];
  for (const [rel, code] of sourceFiles(includeTests)) {
    for (const re of patterns) {
      for (const m of code.matchAll(re)) {
        if (!found.has(m[1])) found.set(m[1], new Set());
        found.get(m[1])!.add(rel);
      }
    }
  }
  return found;
}

describe("localStorage keys", () => {
  it("finds the keys, so this is not passing over an empty sweep", () => {
    const keys = storageKeys();
    expect(keys.size).toBeGreaterThan(30);
    expect([...keys.keys()].filter((k) => k.startsWith("saucebunny."))).not.toEqual([]);
  });

  it("uses the saucebunny namespace for everything except the named nine", () => {
    const offenders = [...storageKeys().entries()]
      .filter(([k]) => !k.startsWith("saucebunny.") && !GRANDFATHERED.includes(k))
      .filter(([k]) => !FIXTURE_PREFIXES.some((p) => k.startsWith(p)))
      .map(([k, files]) => `${k} (${[...files].join(", ")})`);
    expect(
      offenders,
      "New prefs go under `saucebunny.`. The `cp-` keys still here are legacy " +
        "and listed by name; adding to that list means committing to a data " +
        "migration you have not written.",
    ).toEqual([]);
  });

  it("keeps the legacy list honest as keys disappear", () => {
    // A name left here after its key is gone reads as "we decided to keep
    // this", when it really means nobody looked.
    const actual = storageKeys(true);
    const stale = GRANDFATHERED.filter((k) => !actual.has(k));
    expect(stale, "listed as a legacy key but nothing reads or writes it").toEqual([]);
  });

  it("agrees with what CLAUDE.md tells the next person", () => {
    // The rule said prefs are namespaced saucebunny.*, full stop, while nine
    // were not. A rule that is 86% true is one somebody follows and is wrong.
    const md = readFileSync(join(ROOT, "CLAUDE.md"), "utf8");
    expect(md).toMatch(/cp-/);
    expect(md.toLowerCase()).toContain("saucebunny.");
  });
});

/**
 * CLAUDE.md's contract table lists every enforced rule.
 *
 * Sixteen tests encode rules that the constitution did not mention, so the
 * next person read the file, wrote a violation, and met a failure message they
 * had to reverse-engineer the rule from. The table fixes that only while it
 * stays complete - a list of rules that is missing rules is worse than no list,
 * because it reads as exhaustive.
 */
describe("the contract table in CLAUDE.md", () => {
  it("names every contract test in the repo", () => {
    const md = readFileSync(join(ROOT, "CLAUDE.md"), "utf8");
    const tests = readdirSync(join(ROOT, "src/lib"))
      .filter((f) => /(-contract)\.test\.tsx?$/.test(f))
      .map((f) => f.replace(/\.test\.tsx?$/, ""));
    expect(tests.length, "no contract tests found - the matcher broke").toBeGreaterThan(10);
    const missing = tests.filter((t) => !md.includes(t));
    expect(missing, "add these to the Enforced contracts table in CLAUDE.md").toEqual([]);
  });
});
