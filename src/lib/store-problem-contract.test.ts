import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A FAILURE REPORTER WITH NO SUBSCRIBER REPORTS TO NOBODY.
 *
 * Three stores can fail to persist and say so through a listener set:
 * `onReviewStoreProblem` (a note that never reached disk),
 * `onFutureStoreVersion` (a file written by a newer build, so this one has
 * stopped saving), and `onStorageProblem` (localStorage full, so speaker
 * renames, chapters, marks, timecodes and the queue have stopped being
 * remembered).
 *
 * Each is only half a mechanism. The other half is App subscribing and turning
 * it into a notification, and NOTHING connects the two - a reporter whose
 * subscriber is deleted keeps firing perfectly into an empty Set, which is
 * exactly the state all three were built to escape. Every one of them replaced
 * a console.warn, in an app whose WKWebView console needs Safari's inspector
 * attached to read.
 *
 * This is the same shape as screening-record-contract and
 * review-writer-contract, one layer up: something fully built whose last wire
 * is missing, where the code reads as complete from either end.
 */

const SRC = join(__dirname, "..");

/** Every `export function onXProblem` / `onFutureX` listener registrar. */
function reporters(): { file: string; name: string }[] {
  const out: { file: string; name: string }[] = [];
  for (const name of readdirSync(join(SRC, "lib"))) {
    if (!name.endsWith(".ts") || name.includes(".test.")) continue;
    const src = readFileSync(join(SRC, "lib", name), "utf8");
    for (const m of src.matchAll(/^export function (on[A-Z]\w*)\s*\(\s*cb:/gm)) {
      out.push({ file: `lib/${name}`, name: m[1] });
    }
  }
  return out;
}

describe("every store failure reaches the user", () => {
  const found = reporters();
  const app = readFileSync(join(SRC, "App.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");

  it("finds the reporters", () => {
    // CANARY: a changed signature style empties this and the assertion below
    // passes over nothing. Three at the time of writing.
    expect(found.map((f) => f.name).sort(), "the set of store reporters changed")
      .toEqual(["onFutureStoreVersion", "onReviewStoreProblem", "onStorageProblem"]);
  });

  it("each has a subscriber that notifies", () => {
    // CALLED, not imported. `includes(name)` matches the import line, so a
    // file that imports a reporter and never subscribes would pass - the
    // mistake command-error-contract and screening-record-contract both had
    // to be corrected for.
    const body = app.replace(/^import[\s\S]*?from\s+"[^"]*";$/gm, "");
    const unsubscribed = found
      .filter((f) => !new RegExp(`\\b${f.name}\\s*\\(`).test(body))
      .map((f) => `${f.name} (${f.file})`);
    expect(unsubscribed, "store reporter with no subscriber - it fires into an empty Set")
      .toEqual([]);
  });

  it("each subscriber actually tells the user, not just the log", () => {
    // appendLog alone is not enough: the pipeline log is a panel most people
    // never open, and these are failures the user has to act on while they
    // still can. Each subscription must reach pushNotification.
    for (const f of found) {
      const at = app.search(new RegExp(`\\b${f.name}\\s*\\(`));
      expect(at, `${f.name} not subscribed`).toBeGreaterThan(-1);
      // The callback body, to the end of the subscription statement.
      const chunk = app.slice(at, at + 600);
      expect(chunk, `${f.name} logs but never notifies`).toMatch(/pushNotification\(/);
    }
  });
});
