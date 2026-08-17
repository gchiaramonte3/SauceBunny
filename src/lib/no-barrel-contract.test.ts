import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/**
 * No barrel files. CLAUDE.md: "No `index.ts` re-export files. Import directly
 * from the source module."
 *
 * The tree already obeys this — the guard exists because a barrel is the single
 * easiest rule here to break by accident and the hardest to notice afterwards.
 * It arrives as a convenience ("just re-export the transcript helpers"), it makes
 * every import in a diff look tidier, and it quietly costs the two things this
 * codebase is organised around: you can no longer tell from an import line which
 * file a symbol lives in, and the bundler can no longer drop what nothing uses.
 *
 * Checked by SHAPE as well as by name. A file called `transcript/all.ts` that
 * contains nothing but re-exports is the same object with the rule filed off, and
 * a guard that matched only `index.ts` would wave it through — so any module whose
 * every statement is a re-export fails too, whatever it is called.
 */

const ROOT = resolve(__dirname, "../..");
const SRC = resolve(ROOT, "src");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(e.name) && !e.name.includes(".test.")) out.push(full);
  }
  return out;
}

const files = sourceFiles(SRC);

/** Statements, with comments and blank lines removed. */
function statements(text: string): string[] {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//") && !l.startsWith("*"));
}

describe("barrel files", () => {
  it("is looking at the real source tree", () => {
    // Canary: an empty list would make both assertions below pass trivially.
    expect(files.length, "no source files found - the walk broke").toBeGreaterThan(100);
  });

  it("do not exist by name", () => {
    const named = files
      .filter((f) => /(^|\/)index\.tsx?$/.test(f.replace(/\\/g, "/")))
      .map((f) => relative(ROOT, f));
    expect(named, "index.ts / index.tsx re-export files").toEqual([]);
  });

  it("do not exist by shape, under any filename", () => {
    // A module whose EVERY statement is `export … from` is a barrel regardless of
    // what it is called. Requiring more than one re-export keeps a legitimate
    // single type-forward (a module that owns a symbol and re-exports one thing
    // alongside real code) from being called a barrel.
    const shaped: string[] = [];
    for (const f of files) {
      const stmts = statements(readFileSync(f, "utf8"));
      if (stmts.length < 2) continue;
      const reexports = stmts.filter((l) => /^export\s+(\*|type\s*\{|\{)[^;]*\bfrom\b/.test(l));
      if (reexports.length === stmts.length) {
        shaped.push(`${relative(ROOT, f)}  (${reexports.length} re-exports, nothing else)`);
      }
    }
    expect(shaped, "a file that is nothing but re-exports - a barrel by another name").toEqual([]);
  });
});
