import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The contract register in CLAUDE.md describes itself accurately.
 *
 * That register is the first thing anyone reads before touching a guarded
 * rule: it exists so you meet the rule here rather than reverse-engineering it
 * from a failure message. It opens with a spelled-out count — "Thirty-six
 * rules in this file are checked by a test" — and that count had drifted a
 * row out of step with the table beneath it, which is the quiet way a
 * document stops being trusted. Nobody notices the number is wrong; they
 * notice, later, that the file in general cannot be relied on.
 *
 * Every row also has to name a test that EXISTS. A register row pointing at a
 * deleted file is worse than no row: it asserts a guarantee nothing provides.
 */

const ROOT = resolve(__dirname, "../..");
const claude = readFileSync(join(ROOT, "CLAUDE.md"), "utf8");

const WORDS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
};

/** "Thirty-seven" → 37. Only the shape this sentence actually uses. */
function spelledToNumber(text: string): number | null {
  const parts = text.toLowerCase().split("-");
  if (parts.length === 1) return WORDS[parts[0]] ?? null;
  const tens = WORDS[parts[0]];
  const ones = WORDS[parts[1]];
  return tens != null && ones != null ? tens + ones : null;
}

/** The contiguous rows of the register table, excluding its header. */
function registerRows(): string[] {
  const lines = claude.split("\n");
  const head = lines.findIndex((l) => l.startsWith("| Test (`src/lib/`)"));
  if (head < 0) return [];
  const out: string[] = [];
  for (const l of lines.slice(head + 2)) {
    if (!l.startsWith("|")) break;
    out.push(l);
  }
  return out;
}

const rows = registerRows();

describe("the contract register", () => {
  it("has a table to check", () => {
    // Canary. Every assertion below is about the table's contents, and a
    // heading that stopped matching would make all of them vacuous — the
    // failure this repo has shipped four separate ways.
    expect(rows.length, "no register table found in CLAUDE.md").toBeGreaterThan(20);
  });

  it("states a count that matches the rows beneath it", () => {
    const m = /^([A-Za-z-]+) rules in this file are checked by a test/m.exec(claude);
    expect(m, "the register's opening sentence changed shape").not.toBeNull();
    const claimed = spelledToNumber(m![1]);
    expect(claimed, `could not read "${m![1]}" as a number`).not.toBeNull();
    expect(claimed, "the stated count and the table disagree").toBe(rows.length);
  });

  it("names only tests that exist", () => {
    // A row pointing at a deleted file asserts a guarantee nothing provides.
    // Rows name a bare stem (`voice-contract`), sometimes with a qualifier
    // like "(3rd block)" when one file holds several rules.
    const missing: string[] = [];
    for (const row of rows) {
      const cell = row.split("|")[1] ?? "";
      const name = /`([^`]+)`/.exec(cell)?.[1];
      if (!name) continue;
      const candidates = [
        `src/lib/${name}.test.ts`,
        `src/lib/${name}.test.tsx`,
        `src/hooks/${name}.test.ts`,
        `e2e/${name}.spec.ts`,
      ];
      if (!candidates.some((c) => existsSync(join(ROOT, c)))) missing.push(name);
    }
    expect(missing, "register rows naming a test file that does not exist").toEqual([]);
  });
});
