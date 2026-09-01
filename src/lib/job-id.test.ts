import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { newJobId } from "./job-id";

/**
 * The job id must stay synchronous.
 *
 * This is a structural guard, not a behavioural one, and deliberately so: the
 * hook tests around cancellation cannot see the difference between an id that
 * is available now and one that is available a tick from now, because the
 * awaits they park on come later. That was checked by mutation - inserting an
 * `await Promise.resolve()` ahead of the id assignment in use-batch-transcribe
 * left its whole suite green. So the property gets held down where it is
 * actually visible: in the shape of the code.
 *
 * Two ways it could come back, both of which type-check:
 *
 *   · `await invoke("new_job_id")` returns, either as a new command or as a
 *     stale copy-paste from one of the seventeen call sites that used to say
 *     exactly that;
 *   · `await newJobId()`. Awaiting a non-promise is legal TypeScript and
 *     silently costs a microtask turn, which is the entire window back.
 *
 * The second is the likelier one, because every call site around it is inside
 * an async function and `await` is muscle memory there.
 */

const ROOT = resolve(__dirname, "../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * Source with comments removed.
 *
 * Both checks below are about what the code DOES, and this file plus the batch
 * test both quote the old `invoke("new_job_id")` in prose deliberately - the
 * history is the reason the rule exists. Scanning raw text made the guard
 * flag its own explanation, which is the failure mode where you delete the
 * documentation to get green.
 */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Every source file under src/, comments stripped, excluding this one. */
function sources(): Array<[rel: string, code: string]> {
  return walk(join(ROOT, "src"))
    .map((f) => [f.slice(ROOT.length + 1), stripComments(readFileSync(f, "utf8"))] as [string, string])
    .filter(([rel]) => rel !== "src/lib/job-id.test.ts");
}

describe("newJobId", () => {
  it("returns a v4 UUID", () => {
    // Same shape Rust's Uuid::new_v4().to_string() produced, since job ids
    // outlive this change in logs and in the JobRegistry's keys.
    expect(newJobId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("returns a different id every time", () => {
    const ids = new Set(Array.from({ length: 500 }, newJobId));
    expect(ids.size).toBe(500);
  });

  it("returns a string, not a promise", () => {
    // The one assertion that is the whole point of the module.
    expect(typeof newJobId()).toBe("string");
    expect(newJobId()).not.toBeInstanceOf(Promise);
  });

  it("is not declared async and awaits nothing", () => {
    const src = readFileSync(join(ROOT, "src/lib/job-id.ts"), "utf8");
    const body = src.slice(src.indexOf("export function newJobId"));
    expect(body).not.toMatch(/\basync\b/);
    expect(body).not.toMatch(/\bawait\b/);
  });
});

describe("no call site reopens the window", () => {
  it("never awaits newJobId", () => {
    // `await newJobId()` type-checks and costs a microtask turn - which is
    // precisely the gap a Stop used to land in.
    const bad = sources()
      .filter(([, text]) => /\bawait\s+newJobId\s*\(/.test(text))
      .map(([rel]) => rel);
    expect(bad, "newJobId is synchronous; awaiting it puts the cancel window back").toEqual([]);
  });

  it("keeps every id it mints, so Stop has something to cancel", () => {
    /* THE OTHER HALF, and it was open.
       The tests above pin that the id exists BEFORE the await. They say
       nothing about whether anyone can still reach it afterwards, and a job id
       that is minted correctly and then dropped is a job nothing can cancel -
       while Rust registers the child either way, so the work runs to
       completion with no handle on it.
       That is not hypothetical: prepareReaderPlayback was one of seventeen
       mint sites and the only one that stored its id nowhere. Because the
       reader supersedes an older open, three transcripts opened in a row left
       three whole-file ffmpeg transcodes running, each writing a multi-GB
       scratch file nobody would play.
       The rule: between `const x = newJobId()` and the first `invoke(` after
       it, the name must reach somewhere a stop path can read - a ref
       assignment, a setState, or a dispatch. Deliberately structural rather
       than a list of approved sites, so the eighteenth call site is covered
       the day it is written. */
    const offenders: string[] = [];
    let minted = 0;
    for (const [rel, text] of sources()) {
      const re = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*newJobId\s*\(\s*\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        minted++;
        const name = m[1];
        // The window ends at the first invoke: after that the id has already
        // been handed to the backend and holding it later is too late.
        const after = text.slice(m.index);
        const stop = after.search(/\binvoke\s*(<[^>]*>)?\s*\(/);
        const window = stop === -1 ? after : after.slice(0, stop);
        const held = new RegExp(
          `(\\.current\\s*=\\s*${name}\\b|set[A-Z]\\w*\\(\\s*${name}\\b|dispatch\\([^)]*\\b${name}\\b)`,
        ).test(window);
        if (!held) offenders.push(`${rel}: ${name} is minted and never held`);
      }
    }
    // CANARY: the scan found the call sites. A regex that stopped matching
    // would report a clean bill of health over nothing, which is the failure
    // this repo keeps meeting.
    expect(minted, "no newJobId call sites were found at all").toBeGreaterThan(10);
    expect(offenders, "a job id is minted and dropped; Stop cannot reach it").toEqual([]);
  });

  it("never invokes new_job_id", () => {
    // The CALL, not the name: the module doc and the batch test both discuss
    // the old command by name on purpose, and that history is worth keeping.
    const bad = sources()
      .filter(([, text]) => /invoke\s*(<[^>]*>)?\s*\(\s*["']new_job_id["']/.test(text))
      .map(([rel]) => rel);
    expect(bad, "the Rust command is gone; mint the id locally with newJobId()").toEqual([]);
  });

  it("really is scanning the source, not an empty list", () => {
    // A walker that finds nothing reports perfect compliance.
    const all = sources();
    expect(all.length).toBeGreaterThan(50);
    expect(all.filter(([, t]) => /newJobId/.test(t)).length).toBeGreaterThan(4);
  });
});

describe("the Rust side agrees", () => {
  it("no longer registers or defines new_job_id", () => {
    // Removed from both the registry and the module. If either came back, the
    // round trip has a way in again.
    const lib = readFileSync(join(ROOT, "src-tauri/src/lib.rs"), "utf8");
    const system = readFileSync(join(ROOT, "src-tauri/src/commands/system.rs"), "utf8");
    expect(lib).not.toMatch(/new_job_id/);
    expect(system).not.toMatch(/fn new_job_id/);
  });

  it("keeps the build-id handshake in step", () => {
    // Removing a command changes the invoke surface, which is exactly what the
    // handshake exists to flag against a stale binary.
    const ts = readFileSync(join(ROOT, "src/lib/build-id.ts"), "utf8");
    const rs = readFileSync(join(ROOT, "src-tauri/src/commands/system.rs"), "utf8");
    const tsId = /EXPECTED_BACKEND_BUILD_ID = "([^"]+)"/.exec(ts)?.[1];
    const rsId = /BACKEND_BUILD_ID: &str = "([^"]+)"/.exec(rs)?.[1];
    expect(tsId).toBeTruthy();
    expect(tsId).toBe(rsId);
  });
});
