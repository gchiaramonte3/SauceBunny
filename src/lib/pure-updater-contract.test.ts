import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * A setState updater must be pure.
 *
 * React may call an updater more than once, and StrictMode (on, in main.tsx)
 * does so deliberately to surface impurity. The bugs that produces do not look
 * like bugs: they look like the app misbehaving only in dev, which is the
 * easiest thing in the world to shrug at. Three shipped here.
 *
 *   · A confirm() inside setClipQueue put the "clear the queue?" dialog on
 *     screen TWICE and left the outcome depending on which invocation React
 *     kept.
 *   · LibraryTree mutated a ref inside its updater, so StrictMode's second run
 *     found every root already seeded and expanded none of them; a freshly
 *     added library root quietly failed to open.
 *   · use-co-review writes a review doc to DISK from inside an updater. Still
 *     open, listed below.
 *
 * The check is deliberately narrow. It looks for a handful of unmistakable
 * side effects inside a brace-matched updater body, not for purity in general,
 * because a broad version would drown in false positives and get switched off.
 * My first attempt at this sweep used a lazy regex that ran past the end of the
 * function and reported three different effects on one line; the brace matching
 * below is the fix for that, and the reason this is a test rather than a grep.
 */

const ROOT = resolve(__dirname, "../..");

/** Effects with no business inside a function React may run twice. */
const FORBIDDEN = ["confirm(", "alert(", "prompt(", "localStorage.setItem", "localStorage.removeItem"];

/**
 * Known, reasoned exceptions. Shrinking this list is the point.
 *
 * `persistDocRef` needs the `prev` doc, which only exists inside the updater,
 * so moving it means restructuring how a merged co-review doc reaches disk.
 * That is a change to the write path for someone's review notes and it wants
 * more care than a sweep.
 */
const ALLOWED: ReadonlyArray<readonly [file: string, why: string]> = [
  ["src/hooks/use-co-review.ts", "persistDocRef(prev) needs the previous doc; moving it restructures the co-review write path"],
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** Brace-matched body of every `setX((prev) => { ... })` updater in a file. */
function updaterBodies(src: string): string[] {
  const out: string[] = [];
  const re = /\bset[A-Z]\w*\(\s*\(\s*\w*[^)]*\)\s*=>\s*\{/g;
  for (const m of src.matchAll(re)) {
    const open = src.indexOf("{", m.index! + m[0].length - 1);
    let depth = 0;
    for (let k = open; k < src.length; k++) {
      if (src[k] === "{") depth += 1;
      else if (src[k] === "}") {
        depth -= 1;
        if (depth === 0) { out.push(src.slice(open + 1, k)); break; }
      }
    }
  }
  return out;
}

function offenders(): Array<{ file: string; effect: string }> {
  const hits: Array<{ file: string; effect: string }> = [];
  for (const file of walk(join(ROOT, "src"))) {
    const rel = file.slice(ROOT.length + 1);
    const src = readFileSync(file, "utf8");
    for (const body of updaterBodies(src)) {
      for (const effect of FORBIDDEN) {
        if (body.includes(effect)) hits.push({ file: rel, effect });
      }
    }
  }
  return hits;
}

describe("state updaters stay pure", () => {
  it("puts no user-visible or persistent side effect inside an updater", () => {
    const allowed = new Set(ALLOWED.map(([f]) => f));
    const fresh = offenders().filter((h) => !allowed.has(h.file));
    expect(
      fresh.map((h) => `${h.file} (${h.effect})`),
      `React may run an updater more than once and StrictMode does. Do this ` +
        `before the setState, not inside it - read the current value from the ` +
        `ref that mirrors the state if you need it.`,
    ).toEqual([]);
  });

  it("still parses updaters, so a passing run means something", () => {
    // The way a scraper-backed test fails is by matching nothing and calling
    // that success. This app has plenty of functional updaters; if this hits
    // zero, the matcher broke rather than the codebase improving.
    const total = walk(join(ROOT, "src"))
      .reduce((n, f) => n + updaterBodies(readFileSync(f, "utf8")).length, 0);
    expect(total).toBeGreaterThan(20);
  });

  it("gives every exception a reason", () => {
    for (const [file, why] of ALLOWED) {
      expect(why.length, `${file} needs a real reason`).toBeGreaterThan(30);
    }
  });
});
