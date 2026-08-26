import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * A run's cancel handle is installed BEFORE the run's first await.
 *
 * CLAUDE.md states the rule ("never let an await sit between starting work and
 * holding the handle that cancels it") and lists four places it had already
 * shipped. The AI surfaces were a fifth, and they were the worst-behaved of
 * them, because the button is drawn from a DIFFERENT piece of state than the
 * one that arms it:
 *
 *   AiChapters set `busy` (which renders Stop) and then awaited `ensureServer`
 *   for the length of a multi-GB model load before assigning `abortRef`. Stop
 *   was on screen, enabled, and ran `abortRef.current?.abort()` against null
 *   for that entire window. Optional chaining made it a silent no-op rather
 *   than a crash, so the only symptom was a button that did nothing.
 *
 * Behavioural tests cover AiChapters. This is here because the same shape can
 * come back in any of the three, it type-checks perfectly, and no test that
 * does not deliberately hold the server start open will notice: with a fast
 * `ensureServer` the await resolves in a microtask and the window closes
 * before a test could click into it.
 *
 * Read as text on purpose. The property is the ORDER of two statements in a
 * function, which is not observable from outside it.
 */

const ROOT = resolve(__dirname, "../..");

/** Every async run in the app that owns an abort handle, by its opening line. */
const RUNS: Array<{ file: string; opens: string; what: string }> = [
  { file: "src/components/AiChapters.tsx", opens: "async function detect() {", what: "chapter detection" },
  { file: "src/components/AiSummary.tsx", opens: "const send = useCallback(async (text: string) => {", what: "the summary chat" },
  { file: "src/components/ReaderAnalysis.tsx", opens: "const analyze = useCallback(async () => {", what: "the reader analysis" },
];

/** Comments quote the bug they exist to explain, so they must not be scanned. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** The function body that starts at `opens`, matched by counting braces. */
function bodyOf(source: string, opens: string): string {
  const start = source.indexOf(opens);
  if (start < 0) return "";
  let depth = 0;
  for (let i = start + opens.length - 1; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") { depth--; if (depth === 0) return source.slice(start, i + 1); }
  }
  return "";
}

describe("a Stop button is wired before the run it stops", () => {
  it("finds every run it claims to check, so nothing below passes vacuously", () => {
    // The canary. These are matched by an exact opening line, which a rename
    // or a reformat breaks - and a scan that finds nothing reports a clean
    // bill of health for code it never read.
    for (const run of RUNS) {
      const src = stripComments(readFileSync(join(ROOT, run.file), "utf8"));
      expect(bodyOf(src, run.opens), `${run.file}: could not find ${run.what}`).not.toBe("");
    }
  });

  it.each(RUNS)("$what arms its handle before its first await", ({ file, opens, what }) => {
    const body = bodyOf(stripComments(readFileSync(join(ROOT, file), "utf8")), opens);
    const armed = body.indexOf("abortRef.current = ");
    const firstAwait = body.indexOf("await ");
    expect(armed, `${file}: ${what} never stores its controller in abortRef`).toBeGreaterThan(-1);
    expect(firstAwait, `${file}: ${what} has no await, so this guard is watching the wrong function`).toBeGreaterThan(-1);
    expect(
      armed,
      `${file}: ${what} awaits before arming abortRef, so Stop is a no-op until that await resolves`,
    ).toBeLessThan(firstAwait);
  });
});
