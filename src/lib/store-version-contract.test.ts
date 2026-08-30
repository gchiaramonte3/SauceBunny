import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async () => () => {}),
}));

const {
  futureVersionIn, STORE_SCHEMA_VERSION, onFutureStoreVersion,
  resetFutureVersionListenersForTests,
} = await import("./store-schema");
const { __resetCastStore, castsAreReadOnly, getCastError, getCasts, hydrateCastStore, saveCast, flushCasts } =
  await import("./cast-store");
const { newCast } = await import("./cast");
const { __resetProjectStore, hydrateProjects, editProject, getProjects } =
  await import("./transcript-project-store");

const LIB = "/Users/x/Documents/Sauce Bunny/Transcripts";

beforeEach(() => {
  __resetCastStore();
  __resetProjectStore();
  resetFutureVersionListenersForTests();
  invoke.mockReset();
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); resetFutureVersionListenersForTests(); });

// ── the primitive ────────────────────────────────────────────────────────────

describe("futureVersionIn", () => {
  it("passes everything this build can handle", () => {
    // Our own version, an older one, and a file from before the field existed
    // all load and write normally. Widening this to "anything unexpected" would
    // lock users out of their own data on a corrupt byte.
    expect(futureVersionIn(JSON.stringify({ version: STORE_SCHEMA_VERSION, casts: [] }))).toBeNull();
    expect(futureVersionIn(JSON.stringify({ version: 0, casts: [] }))).toBeNull();
    expect(futureVersionIn(JSON.stringify({ casts: [] }))).toBeNull();
    expect(futureVersionIn("not json")).toBeNull();
    expect(futureVersionIn("[1,2,3]")).toBeNull();
    expect(futureVersionIn(null)).toBeNull();
    expect(futureVersionIn("")).toBeNull();
    expect(futureVersionIn(JSON.stringify({ version: "2" }))).toBeNull();
    expect(futureVersionIn(JSON.stringify({ version: Number.NaN }))).toBeNull();
  });

  it("reports a version newer than this build", () => {
    expect(futureVersionIn(JSON.stringify({ version: STORE_SCHEMA_VERSION + 1 }))).toBe(
      STORE_SCHEMA_VERSION + 1,
    );
  });
});

// ── the failure mode this exists to prevent ──────────────────────────────────

/**
 * The bug, concretely: a newer Sauce Bunny writes version 2 with a field this
 * build does not know. This build's sanitizer drops the field, and the next
 * debounced save writes the result back over the user's Documents folder.
 * Nothing warned, and the field is gone.
 *
 * So the assertion is not "we noticed" — it is that NO WRITE HAPPENS.
 */
describe("a store file from a newer build is never overwritten", () => {
  it("cast-store: hydrates, refuses the save, and keeps the file byte-identical", async () => {
    const onDisk = JSON.stringify({
      version: STORE_SCHEMA_VERSION + 1,
      casts: [{ id: "a", name: "The Bear S3", members: [], newFieldFromTheFuture: "keep me" }],
    });
    const writes: { path: string; text: string }[] = [];
    invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "default_transcript_library_path") return LIB;
      if (cmd === "read_text_file_capped") return onDisk;
      if (cmd === "ensure_dir_exists") return null;
      if (cmd === "write_text_to_path") {
        writes.push({ path: String(args.path), text: String(args.text) });
        return null;
      }
      throw new Error(`unexpected ${cmd}`);
    });

    await hydrateCastStore();
    expect(castsAreReadOnly()).toBe(true);
    // Read-only, not blank: the user sees the cast this build understands
    // rather than an empty shelf that reads as data loss.
    expect(getCasts().map((c) => c.name)).toEqual(["The Bear S3"]);

    saveCast(newCast("Something New"));
    await vi.advanceTimersByTimeAsync(2000);
    await flushCasts();
    await vi.advanceTimersByTimeAsync(2000);

    expect(writes, "a locked store wrote to disk anyway").toEqual([]);
  });

  it("cast-store: says so, in a sentence a person can act on", async () => {
    const seen: { label: string; message: string }[] = [];
    onFutureStoreVersion((p) => seen.push(p));
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "default_transcript_library_path") return LIB;
      if (cmd === "read_text_file_capped") {
        return JSON.stringify({ version: STORE_SCHEMA_VERSION + 1, casts: [] });
      }
      throw new Error(`unexpected ${cmd}`);
    });
    await hydrateCastStore();

    expect(seen).toHaveLength(1);
    expect(seen[0].label).toBe("casts");
    // The store's own banner carries the same words the toast does.
    expect(getCastError()).toBe(seen[0].message);
    expect(seen[0].message).toContain("newer Sauce Bunny");
    expect(seen[0].message).toContain("Update Sauce Bunny");
    // House rule: no em dashes in anything a user reads.
    expect(seen[0].message).not.toContain("—");
  });

  it("cast-store: locks on the pre-write merge read, not only at hydration", async () => {
    // The other window may be a newer build that upgraded the file AFTER we
    // hydrated. The merge read is the last look at disk before we clobber it,
    // so it has to check too, or the guard only covers a cold start.
    let onDisk = JSON.stringify({ version: STORE_SCHEMA_VERSION, casts: [] });
    const writes: string[] = [];
    invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "default_transcript_library_path") return LIB;
      if (cmd === "read_text_file_capped") return onDisk;
      if (cmd === "ensure_dir_exists") return null;
      if (cmd === "write_text_to_path") { writes.push(String(args.text)); return null; }
      throw new Error(`unexpected ${cmd}`);
    });

    await hydrateCastStore();
    expect(castsAreReadOnly()).toBe(false);

    onDisk = JSON.stringify({ version: STORE_SCHEMA_VERSION + 1, casts: [] });
    saveCast(newCast("Written after the upgrade"));
    await vi.advanceTimersByTimeAsync(2000);

    expect(writes, "wrote over a file the other window had just upgraded").toEqual([]);
    expect(castsAreReadOnly()).toBe(true);
  });

  it("transcript-project-store: refuses to rewrite projects.json", async () => {
    const writes: string[] = [];
    invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "read_text_file_capped") {
        return JSON.stringify({
          version: STORE_SCHEMA_VERSION + 1,
          projects: [{ folder: "Doc", title: "Docs", createdMs: 1 }],
        });
      }
      if (cmd === "ensure_dir_exists") return null;
      if (cmd === "write_text_to_path") { writes.push(String(args.text)); return null; }
      throw new Error(`unexpected ${cmd}`);
    });

    await hydrateProjects(LIB, ["Doc"]);
    expect(getProjects().map((p) => p.folder)).toEqual(["Doc"]);

    editProject("Doc", { title: "Renamed" });
    await vi.advanceTimersByTimeAsync(2000);

    expect(writes, "a locked projects.json was rewritten").toEqual([]);
  });
});

// ── the guard against the next store forgetting ──────────────────────────────

describe("every file store consults the version it writes", () => {
  it("no store writes a version field without checking for a newer one", () => {
    const dir = new URL(".", import.meta.url).pathname;
    const offenders: string[] = [];
    const stampers: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts") || name.includes(".test.")) continue;
      if (name === "store-schema.ts") continue;
      const src = readFileSync(join(dir, name), "utf8");
      // "Stamps a schema version onto a file" is the marker of a store that
      // owns an on-disk format, and every one of those has the same downgrade
      // hazard. Catching it here is the point: a fifth store added next year
      // fails this test rather than shipping the bug that motivated the file.
      // Matches the CONSTANT as well as a literal. This used to test only
      // `/version:\s*\d+/`, and when the five write sites moved to
      // STORE_SCHEMA_VERSION the sweep stopped matching anything at all and
      // went green over an empty set - reporting perfect conformance for the
      // very change it should have been checking.
      const stamps = /version:\s*(\d+|STORE_SCHEMA_VERSION)\s*[,}]/.test(src)
        || /"version":\s*\d+/.test(src);
      if (!stamps) continue;
      stampers.push(name);
      if (!src.includes("futureVersionIn")) offenders.push(name);
    }
    // CANARY. Without this the loop above passes by finding no stampers, which
    // is exactly what it did the moment the literals were replaced.
    expect(stampers.length, "no store stamps a version - the sweep matched nothing")
      .toBeGreaterThanOrEqual(5);
    expect(
      offenders,
      "these stamp a schema version but never read one back — see store-schema.ts",
    ).toEqual([]);
  });

  it("stamps the CONSTANT, never a bare number", () => {
    // The guard compares a file's version against STORE_SCHEMA_VERSION. Every
    // writer hardcoded `version: 1` instead of using it, so bumping the
    // constant would have changed what this build REFUSES while changing
    // nothing about what it WRITES - a v2 build stamping v1 files that a v1
    // build then clobbers with the old shape. That is precisely the data loss
    // F1 exists to prevent, in the mechanism built to prevent it.
    const dir = new URL(".", import.meta.url).pathname;
    const bad: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".ts") || name.includes(".test.") || name === "store-schema.ts") continue;
      const src = readFileSync(join(dir, name), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^[ \t]*\/\/.*$/gm, "");
      if (!src.includes("futureVersionIn")) continue; // not a versioned store
      // A numeric stamp in a VALUE position. `version: number` in a type is
      // fine and is what these files now declare.
      if (/version:\s*\d+\s*[,}]/.test(src)) bad.push(name);
    }
    expect(bad, "writes a bare version number instead of STORE_SCHEMA_VERSION").toEqual([]);
  });

  it("covers the five stores that exist today, so the sweep is not vacuous", () => {
    const dir = new URL(".", import.meta.url).pathname;
    const wired = readdirSync(dir).filter(
      (n) => n.endsWith(".ts") && !n.includes(".test.") && n !== "store-schema.ts"
        && readFileSync(join(dir, n), "utf8").includes("futureVersionIn"),
    );
    expect(wired.sort()).toEqual([
      "cast-store.ts", "review-store.ts", "screening-store.ts",
      "transcript-project-store.ts", "web-collection-store.ts",
    ]);
  });
});

describe("a report raised before anyone subscribes still reaches the user", () => {
  /**
   * Reviews and casts hydrate from main.tsx BEFORE the first render, so their
   * future-version reports fire before App's useEffect subscribes. The first
   * version of this bridge was a plain fan-out, which dropped those reports
   * deterministically: a locked Reviews/index.json produced no toast, no bell
   * entry, nothing - while edits were accepted into memory and discarded on
   * quit. The bridge now latches every report and replays it on subscribe.
   */
  it("replays the latched report to a late subscriber, once", async () => {
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "default_transcript_library_path") return LIB;
      if (cmd === "read_text_file_capped") {
        return JSON.stringify({ version: STORE_SCHEMA_VERSION + 1, casts: [] });
      }
      throw new Error(`unexpected ${cmd}`);
    });
    // Hydration happens FIRST - nobody is listening, as at real boot.
    await hydrateCastStore();

    const seen: string[] = [];
    onFutureStoreVersion((p) => seen.push(p.label));
    expect(seen, "the pre-subscribe report was dropped").toEqual(["casts"]);

    // A second subscriber gets the same replay; the store re-reporting the
    // same label must not double it.
    const seen2: string[] = [];
    onFutureStoreVersion((p) => seen2.push(p.label));
    expect(seen2).toEqual(["casts"]);
    expect(seen).toEqual(["casts"]);
  });
});
