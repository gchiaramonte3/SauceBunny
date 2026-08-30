import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * ALL FOUR SCREENING DEFECTS WERE THE SAME SHAPE: something declared, indexed,
 * rendered - and never actually written by production code.
 *
 *   - `participants` was on the type, in index.json, and on the shelf. The only
 *     assignment in the whole tree was a test mutating the doc directly. Every
 *     screening ever saved reads "0 people", and screeningIsWorthKeeping's
 *     `participants.length > 1` clause was unreachable, so two people who met
 *     and watched nothing had their session discarded as empty.
 *   - `markWatched` had no caller at all. Recording ran only in the host's
 *     doc-seeding effect, which cannot run without a resolved source key, so
 *     `watched` could never be anything but true.
 *   - Recording was host-only, so a guest left with no record.
 *   - The record reached disk exactly once, at session end.
 *
 * None of these fail a type check, a render, or any test that does not already
 * know to look. They fail only when someone opens the library months later and
 * finds a shelf of sessions that say nothing.
 *
 * So the rule is about the class, not the four instances: an updater exported
 * from lib/screening.ts is a promise that some state gets maintained. If
 * nothing in production calls it, the promise is not being kept - delete it or
 * wire it up, but do not leave it looking maintained.
 */

const SRC = join(__dirname, "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    // readdirSync, not globSync: CI pins Node 20 and globSync is Node 22.
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "bindings") continue; // generated
      sourceFiles(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(name)) continue;
    if (/\.test\.tsx?$/.test(name)) continue;
    out.push(full);
  }
  return out;
}

/**
 * Exported UPDATERS: functions that return a new ScreeningDoc.
 *
 * That return type is the definition, rather than a list someone maintains by
 * hand. It is also precisely the rot-prone class: an updater exists to keep a
 * field current, so one that nothing calls means a field is quietly going
 * stale. Readers (`openSegmentOf`, `screeningCommentCount`) cannot rot - they
 * report whatever is there - so they are deliberately out of scope.
 */
function exportedUpdaters(src: string): string[] {
  const out: string[] = [];
  // Split per declaration rather than matching a signature with one regex: a
  // non-greedy `[\s\S]*?` for the parameter list happily runs PAST the end of
  // one function to find a `): ScreeningDoc {` belonging to a later one, which
  // is how `openSegmentOf` (returns ScreeningSegment | null) first showed up
  // here as an updater.
  for (const chunk of src.split(/\nexport function /).slice(1)) {
    const name = /^(\w+)/.exec(chunk)?.[1];
    const at = chunk.indexOf("): ScreeningDoc {");
    // `indexOf("{")` is not the body brace: noteParticipants declares an inline
    // object type in its parameter list. Instead find the return signature and
    // reject it if a body close (`\n}`) came first - that means the search ran
    // past this declaration into the next one.
    if (name && at >= 0 && !chunk.slice(0, at).includes("\n}")) out.push(name);
  }
  return out;
}

describe("every screening updater is actually wired up", () => {
  const screening = readFileSync(join(SRC, "lib", "screening.ts"), "utf8");
  const exported = exportedUpdaters(screening);

  it("finds the updaters at all", () => {
    // CANARY. `expect(unused).toEqual([])` passes just as happily over an
    // empty export list, and a renamed file or a changed `export function`
    // idiom would empty it silently.
    expect(exported.length, "no exported updaters found in lib/screening.ts")
      .toBeGreaterThanOrEqual(5);
    expect(exported).toContain("noteParticipants");
    expect(exported).toContain("markWatched");
  });

  it("has a production caller for each one", () => {
    const files = sourceFiles(SRC).filter((f) => !f.endsWith(join("lib", "screening.ts")));
    // CANARY: the walk found the tree, not an empty directory.
    expect(files.length, "no source files scanned").toBeGreaterThan(50);
    // STRIP IMPORTS AND COMMENTS FIRST, or this cannot fail.
    //
    // Found the hard way: deleting the `markWatched(...)` call and its import
    // still left the name in a COMMENT two lines above explaining why it had
    // never had a caller, and a bare identifier search matched that happily.
    // Deleting only the call left it in the `import { … }` list, which matched
    // too. Both mutations passed a test written specifically to catch them.
    const corpus = files
      .map((f) => readFileSync(f, "utf8"))
      .map((src) => src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "")
        .replace(/^import[\s\S]*?from\s+"[^"]*";$/gm, ""))
      .join("\n");

    const unused = exported.filter((name) => !new RegExp(`\\b${name}\\s*\\(`).test(corpus));
    expect(unused, "exported from lib/screening.ts and CALLED by nothing in production")
      .toEqual([]);
  });
});

describe("both sides of a session record it", () => {
  const hook = readFileSync(join(SRC, "hooks", "use-co-review.ts"), "utf8");

  it("the screening effects are not gated on being the host", () => {
    // Recording used to live inside the doc-seeding effect, which opens with
    // `if (coSession.role !== "host" || !reviewSourceKey) return;`. That guard
    // is correct for seeding the shared doc - only the host owns it - and it
    // is why a guest recorded nothing for the entire life of the feature.
    //
    // Read each effect that touches the screening and check what it early
    // -returns on. "off" is the legitimate guard; "host" is the bug.
    const bodies = [...hook.matchAll(/useEffect\(\(\) => \{([\s\S]*?)\n  \}, \[/g)]
      .map((m) => m[1])
      .filter((b) => /ensureScreening\(\)/.test(b));

    // CANARY: there are effects to examine. If they were renamed away, an
    // empty list would report a clean bill of health forever.
    expect(bodies.length, "no screening effects found to check")
      .toBeGreaterThanOrEqual(2);

    for (const b of bodies) {
      expect(b, "a screening effect early-returns unless we are the host")
        .not.toMatch(/role\s*!==\s*"host"/);
    }
  });

  it("the record reaches disk before the session ends", () => {
    // saveScreening had exactly ONE production caller, in the role->off
    // branch. Quit mid-session and the whole record was gone - while the
    // comments survived, because review-store's write-through was already
    // fixed for precisely this reason.
    const calls = [...hook.matchAll(/saveScreening\(/g)];
    expect(calls.length, "saveScreening is only called once - that is the end-of-session save alone")
      .toBeGreaterThanOrEqual(2);
  });
});
