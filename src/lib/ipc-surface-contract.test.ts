import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const SRC = resolve(__dirname, "..");
const ROOT = resolve(__dirname, "../..");

/**
 * The invoke surface matches on both sides.
 *
 * `generate_handler!` decides what the renderer is allowed to call. Two things
 * can go wrong with it, and neither is caught by any compiler:
 *
 *   · a command registered that nothing invokes. Dead code, and dead code that
 *     is specifically REACHABLE - every entry in that list is callable from
 *     the webview, so an unused one is surface for no benefit. Four were:
 *     `list_displays` (superseded by list_share_sources, which returns windows
 *     and thumbnails too), `stop_llm_server` (the RunEvent::Exit hook calls
 *     shutdown() directly), `cleanup_stale_cache` (lib.rs calls it at setup;
 *     the renderer never did), and `write_bytes_to_path`, whose last caller
 *     went away when the frame snapshot moved to the raw IPC body;
 *
 *   · an invoke of a command that is NOT registered. That one is worse: it
 *     type-checks, it builds, and it fails at runtime as a rejected promise -
 *     usually inside a `.catch(() => null)` that turns it into a feature which
 *     silently does nothing.
 *
 * Comments are stripped before scanning. The first version of this counted
 * `invoke<string>("new_job_id")` from a doc comment explaining why that
 * command no longer exists, and reported a missing command that nothing calls.
 */

/** Commands that may be registered without a TypeScript caller, and why. */
const ALLOWED_UNCALLED: ReadonlyArray<readonly [cmd: string, why: string]> = [];

function stripComments(t: string): string {
  return t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function registered(): string[] {
  const lib = readFileSync(join(ROOT, "src-tauri/src/lib.rs"), "utf8");
  const m = /generate_handler!\s*\[([\s\S]*?)\]/.exec(stripComments(lib));
  if (!m) throw new Error("generate_handler! not found - the matcher broke, not the code");
  return m[1]
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => x.split("::").pop()!);
}

function nonTestSources(): Array<[rel: string, code: string]> {
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

/**
 * Command names that appear as a string literal anywhere in non-test source.
 *
 * Deliberately looser than "first argument of invoke(". Two real call shapes
 * are invisible to that stricter reading, and the first version of this test
 * reported all three of them as dead:
 *
 *   · a wrapper - `invokeWithCookieRetry("extract_frame", ...)`;
 *   · a variable - `const cmd = host ? "session_broadcast" : "session_send"`
 *     and then `invoke(cmd, ...)`.
 *
 * The cost of the looser rule is that a name mentioned in some other string
 * would count as a call. That trade is worth it: the strict version's failure
 * mode was telling me to delete three commands the app actively uses.
 */
function namedInSource(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [rel, code] of nonTestSources()) {
    for (const m of code.matchAll(/["'`]([a-z][a-z0-9_]{3,})["'`]/g)) {
      if (!out.has(m[1])) out.set(m[1], new Set());
      out.get(m[1])!.add(rel);
    }
  }
  return out;
}

/** Literal first arguments to invoke() or any invoke* wrapper. */
function invoked(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [rel, code] of nonTestSources()) {
    for (const m of code.matchAll(/\binvoke\w*\s*(?:<[^>]*>)?\s*\(\s*["'`]([^"'`]+)["'`]/g)) {
      if (!out.has(m[1])) out.set(m[1], new Set());
      out.get(m[1])!.add(rel);
    }
  }
  return out;
}

describe("the IPC surface", () => {
  it("really parsed both sides", () => {
    // A matcher that finds nothing agrees with everything.
    expect(registered().length).toBeGreaterThan(50);
    expect(invoked().size).toBeGreaterThan(50);
    expect(namedInSource().size).toBeGreaterThan(50);
  });

  it("registers nothing the frontend never calls", () => {
    const called = new Set(namedInSource().keys());
    const allowed = new Set(ALLOWED_UNCALLED.map(([c]) => c));
    const unused = registered().filter((c) => !called.has(c) && !allowed.has(c));
    expect(
      unused,
      "Registered but unreachable from TypeScript. Drop it from " +
        "generate_handler! (keep the fn if Rust calls it directly), or add it " +
        "to ALLOWED_UNCALLED with the reason.",
    ).toEqual([]);
  });

  it("invokes nothing the backend does not register", () => {
    // The failure this one prevents is a rejected promise at runtime, usually
    // swallowed by a .catch that makes the feature quietly do nothing.
    const reg = new Set(registered());
    const missing = [...invoked().entries()]
      .filter(([c]) => !reg.has(c) && !c.startsWith("plugin:"))
      .map(([c, files]) => `${c} (${[...files].join(", ")})`);
    expect(missing, "Invoked but not in generate_handler! - this fails at runtime.").toEqual([]);
  });

  it("keeps the exception list honest", () => {
    const reg = new Set(registered());
    const stale = ALLOWED_UNCALLED.map(([c]) => c).filter((c) => !reg.has(c));
    expect(stale, "listed as an allowed unused command but no longer registered").toEqual([]);
  });
});
