import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * A row's identity key must never be used as a filesystem path.
 *
 * LibraryTree keys its rows `<rootIndex>:<path>`, because a root folder can
 * legitimately appear twice - once as a root, once nested inside its parent -
 * and keying on the bare path made React reuse the wrong DOM node for the
 * wrong folder. So the composite key is correct and is not going away.
 *
 * The cost is that `row.key` is a string that LOOKS like a path and is not.
 * Passing it where a path belongs never throws: the filesystem simply has no
 * "0:/Users/...", so the read comes back empty and the UI draws the
 * empty-but-valid state. That is the whole problem. Every instance of this bug
 * has presented as a feature that was "never wired up".
 *
 * It has now happened seven times. Six were fixed and the Row type grew a
 * comment saying "IDENTITY ONLY ... five things once read it as a filesystem
 * path"; the seventh was written afterwards, eighty lines below that comment,
 * and shipped: `folderPaths` collected `r.key`, so read_finder_tags was asked
 * about paths that cannot exist and EVERY folder in the sidebar drew with no
 * Finder colour. The user reported it twice as a regression.
 *
 * Prose did not work. This is the same rule as a test.
 *
 * DIRECTION MATTERS, and the rule is one-way. Deriving a key FROM a path is
 * correct and common - `rows.find((r) => r.path === selKey)?.key` is how the
 * selection finds its row. Only the reverse is banned: a binding whose NAME
 * says path, initialised from an expression containing `.key`.
 */

const SRC = "src";

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    // readdirSync + statSync, not globSync: CI pins Node 20 and globSync is
    // Node 22. CLAUDE.md records this going red twice.
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") || p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** `const <name> = <initialiser>;` with the initialiser balanced to its end. */
function declarations(src: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const re = /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let i = re.lastIndex;
    let depth = 0;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        if (depth === 0) break;
        depth--;
      } else if (c === ";" && depth === 0) break;
    }
    out.push({ name: m[1], body: src.slice(re.lastIndex, i) });
  }
  return out;
}

/** Strip comments, so a line EXPLAINING the rule cannot violate it. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("a row key is never used as a path", () => {
  const files = walk(SRC).filter((f) => !f.endsWith(".test.ts") && !f.endsWith(".test.tsx"));

  it("scanned a real population", () => {
    // The canary. Four guards in this repo once passed by examining nothing.
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain(join("src", "components", "LibraryTree.tsx"));
  });

  it("finds path-named bindings to check", () => {
    // Second canary: if the declaration parser breaks, the rule below passes
    // over an empty list and reports a clean bill of health for ever.
    const named = files.flatMap((f) =>
      declarations(stripComments(readFileSync(f, "utf8"))).filter((d) => /path/i.test(d.name)),
    );
    expect(named.length).toBeGreaterThan(5);
  });

  it("no binding named for a path is built from .key", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const src = stripComments(readFileSync(file, "utf8"));
      for (const d of declarations(src)) {
        if (!/path/i.test(d.name)) continue;
        if (/\.key\b/.test(d.body)) {
          offenders.push(`${file}: const ${d.name} = ... .key ...`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("useFinderTags is never handed .key", () => {
    // The specific call the bug went through, pinned directly: the generic
    // rule above only catches it while the argument happens to be a named
    // binding, and inlining the .map would slip straight past.
    const offenders: string[] = [];
    for (const file of files) {
      const src = stripComments(readFileSync(file, "utf8"));
      const re = /useFinderTags\(([^)]*(?:\([^)]*\)[^)]*)*)\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        if (/\.key\b/.test(m[1])) offenders.push(`${file}: useFinderTags(${m[1].trim()})`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
