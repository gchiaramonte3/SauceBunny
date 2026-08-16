import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve(__dirname, "..");

/**
 * State updaters do not do work.
 *
 * React 18 StrictMode double-invokes every `setX(prev => ...)` in development
 * and keeps the SECOND result. An updater that also acts - writes a file,
 * drains a queue, bumps a counter - runs that work twice, and any part of its
 * own answer that depended on the work is then computed from state the first
 * pass already consumed.
 *
 * That was live in use-co-review: the snapshot handler merged the host's doc,
 * replayed the ops the author had queued before any doc existed, and emptied
 * the queue, all inside one updater. Second pass: queue empty, ops not
 * replayed, and React kept that result. The author's own comments disappeared,
 * in exactly the case the replay was written for.
 *
 * A sweep of every updater in the codebase found five more that act, all of
 * them persisting. They are listed below because they are NOT the same bug:
 * each writes a value derived only from `prev`, so running twice writes the
 * same bytes twice and nothing is consumed. They are listed rather than
 * rewritten because converting a persist-in-updater into a persist-in-effect
 * changes WHEN the write happens, which is real risk for no user-visible gain
 * on a write that is already correct.
 *
 * What the list is for is the next change. The moment one of these grows a
 * drain, a counter, or anything it then reads back, it becomes the
 * use-co-review bug - and the reason it is safe today is written down, so
 * that stops being an accident nobody re-checks.
 */

/** file → setter, with the reason its impurity is survivable. */
const ALLOWED: ReadonlyArray<readonly [file: string, setter: string, why: string]> = [
  ["App.tsx", "setDefaultsState",
    "saveJson of the whole next Defaults, derived only from prev and the patch; a second pass writes identical bytes"],
  ["App.tsx", "setQueueOpen",
    "saveJson of one boolean derived from prev; idempotent under a repeat invocation"],
  ["components/ReviewPanel.tsx", "setMarkerSettings",
    "saveJson of the merged settings object, a pure function of prev and the patch"],
  ["components/ReviewPanel.tsx", "setDoc",
    "saveReview of the next doc; the store is debounced and keyed, so a repeat marks the same key dirty once"],
  ["components/SettingsModal.tsx", "setOpenSections",
    "saveJson of the toggled section map, derived only from prev"],
  ["components/LibraryBrowser.tsx", "setSel",
    "marquee drag: latches dragBaseRef to cur.selected on the first move. Safe ONLY because the value it " +
    "assigns is the same one it just used as the fallback, so a second pass reads back exactly what the " +
    "first would have computed. Change either half and the two stop agreeing"],
];

const SIDE_EFFECTS: ReadonlyArray<readonly [re: RegExp, what: string]> = [
  // NO \b before `Ref`: in `pendingOpsRef.current` the characters either side
  // of that boundary are both word characters, so \bRef matches nothing at
  // all. The first version of this file had it, and the whole ref half of the
  // sweep was dead - caught only by planting a ref assignment and watching the
  // test stay green.
  [/Ref\.current\s*=[^=]/, "assigns to a ref"],
  [/Ref\.current\.(push|pop|shift|unshift|splice|set|delete|clear|add)\s*\(/, "mutates a ref's collection"],
  [/\binvoke\s*[<(]/, "calls invoke"],
  [/\blocalStorage\.(setItem|removeItem|clear)\s*\(/, "writes localStorage"],
  // `(\.current)?` because these are often reached through a ref -
  // `persistDocRef.current(prev)` is the exact call that made the
  // use-co-review updater write to disk, and `\bpersist\w*\s*\(` cannot see
  // it: `.current` sits between the name and the paren.
  [/\bsave[A-Z]\w*(\.current)?\s*\(/, "calls a save*"],
  [/\bpersist\w*(\.current)?\s*\(/, "calls a persist*"],
];

/** Setters that are not React state setters and only look like them. */
const NOT_STATE = new Set([
  "setTimeout", "setInterval", "setImmediate", "setProperty", "setItem",
  "setAttribute", "setCustomValidity", "setSelectionRange", "setPointerCapture",
  "setRequestHeader", "setHours", "setDate", "setMinutes", "setSeconds",
]);

function stripComments(t: string): string {
  return t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function sourceFiles(): Array<[rel: string, code: string]> {
  const out: Array<[string, string]> = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
        out.push([full.slice(SRC.length + 1), stripComments(readFileSync(full, "utf8"))]);
      }
    }
  };
  walk(SRC);
  return out;
}

type Offender = { file: string; setter: string; what: string };

function impureUpdaters(): Offender[] {
  const out: Offender[] = [];
  for (const [file, code] of sourceFiles()) {
    for (const m of code.matchAll(/\b(set[A-Z]\w*)\s*\(/g)) {
      const setter = m[1];
      if (NOT_STATE.has(setter)) continue;
      // Paren-match the single argument.
      let depth = 0, k = m.index! + m[0].length - 1;
      for (; k < code.length; k += 1) {
        if (code[k] === "(") depth += 1;
        else if (code[k] === ")") { depth -= 1; if (depth === 0) break; }
      }
      const arg = code.slice(m.index! + m[0].length, k).trim();
      // An UPDATER, not a value that merely contains an arrow somewhere. The
      // first version of this flagged `setParakeetReady(await invoke(...)
      // .catch(() => true))`, which is a plain value whose fallback happens to
      // be an arrow function.
      if (!/^(\(?\s*\w*\s*\)?|\([^)]*\))\s*=>/.test(arg)) continue;
      for (const [re, what] of SIDE_EFFECTS) {
        if (re.test(arg)) { out.push({ file, setter, what }); break; }
      }
    }
  }
  return out;
}

describe("state updaters stay pure", () => {
  it("finds updaters at all, so this is not passing over an empty sweep", () => {
    // The recurring trap: a scanner that matches nothing reports compliance.
    const all = sourceFiles();
    expect(all.length).toBeGreaterThan(50);
    const anyUpdater = all.filter(([, c]) => /\bset[A-Z]\w*\(\s*\(?\w*\)?\s*=>/.test(c));
    expect(anyUpdater.length).toBeGreaterThan(5);
  });

  it("has no updater doing work that is not argued for", () => {
    const allowed = new Set(ALLOWED.map(([f, s]) => `${f}|${s}`));
    const unlisted = impureUpdaters()
      .filter((o) => !allowed.has(`${o.file}|${o.setter}`))
      .map((o) => `${o.file} ${o.setter} ${o.what}`);
    expect(
      unlisted,
      "StrictMode runs this twice and keeps the second result. Do the work " +
        "before the setter and pass the value in - or add it to ALLOWED with " +
        "the reason a repeat is harmless.",
    ).toEqual([]);
  });

  it("keeps the allowlist honest as sites get fixed", () => {
    // A stale entry reads as "considered and accepted" when it really means
    // "fixed, and nobody told the list".
    const actual = new Set(impureUpdaters().map((o) => `${o.file}|${o.setter}`));
    const stale = ALLOWED.map(([f, s]) => `${f}|${s}`).filter((k) => !actual.has(k));
    expect(stale, "listed as an allowed impure updater but no longer is one").toEqual([]);
  });

  it("gives every entry a reason someone can disagree with", () => {
    for (const [file, setter, why] of ALLOWED) {
      expect(why.length, `${file} ${setter} needs a real reason, not a placeholder`).toBeGreaterThan(40);
    }
  });
});
