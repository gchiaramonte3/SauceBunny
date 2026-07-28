import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const {
  __resetCastStore, deleteCast, flushCasts, getCastError, getCasts,
  hydrateCastStore, saveCast, subscribeCasts,
} = await import("./cast-store");
const { newCast, newMember } = await import("./cast");

const LIB = "/Users/x/Documents/Sauce Bunny/Transcripts";
const CASTS_FILE = "/Users/x/Documents/Sauce Bunny/Casts/casts.json";

/** A backend with `casts.json` holding `onDisk`. */
function backend(onDisk: unknown[] | null) {
  const writes: string[] = [];
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "default_transcript_library_path") return LIB;
    if (cmd === "read_text_file_capped") {
      if (onDisk === null) throw new Error("ENOENT");
      return JSON.stringify({ version: 1, casts: onDisk });
    }
    if (cmd === "ensure_dir_exists") return null;
    if (cmd === "write_text_to_path") { writes.push(String(args.text)); return null; }
    throw new Error(`unexpected ${cmd}`);
  });
  return writes;
}

const lastWritten = (writes: string[]) =>
  writes.length ? (JSON.parse(writes[writes.length - 1]).casts as { name: string }[]) : null;

beforeEach(() => { __resetCastStore(); invoke.mockReset(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("hydration", () => {
  it("loads the casts on disk", async () => {
    backend([{ id: "a", name: "The Bear S3", members: [{ name: "Carmy", color: "#FD8A8C" }] }]);
    await hydrateCastStore();
    expect(getCasts().map((c) => c.name)).toEqual(["The Bear S3"]);
    expect(getCasts()[0].members[0].name).toBe("Carmy");
  });

  it("starts empty when there is no file yet, without erroring", async () => {
    backend(null);
    await hydrateCastStore();
    expect(getCasts()).toEqual([]);
    expect(getCastError()).toBeNull();
  });

  it("degrades to memory-only when the path command is unavailable", async () => {
    // The e2e harness mocks the IPC layer; a store that threw here would take
    // the whole app down at boot.
    invoke.mockImplementation(async () => { throw new Error("no backend"); });
    await hydrateCastStore();
    saveCast(newCast("Local only", [newMember("Ada", "#FD8A8C")]));
    expect(getCasts().map((c) => c.name)).toEqual(["Local only"]);
    await vi.advanceTimersByTimeAsync(1000);
    // No write attempt, no error banner: memory-only is a degraded mode, not
    // a failure to report.
    expect(getCastError()).toBeNull();
  });
});

describe("the clobber guard", () => {
  it("never writes an incomplete list while the disk read is in flight", async () => {
    // THE bug this store exists to not have. A save made between "directory
    // resolved" and "file read" must not persist a list missing everything
    // already on disk — that erases the file with a subset of itself.
    let releaseRead: (v: string) => void = () => {};
    const writes: string[] = [];
    invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "default_transcript_library_path") return LIB;
      if (cmd === "read_text_file_capped") {
        return new Promise<string>((res) => { releaseRead = res; });
      }
      if (cmd === "ensure_dir_exists") return null;
      if (cmd === "write_text_to_path") { writes.push(String(args.text)); return null; }
      throw new Error(`unexpected ${cmd}`);
    });

    const hydrating = hydrateCastStore();
    await vi.advanceTimersByTimeAsync(0); // let the path command settle

    saveCast(newCast("Made during boot"));
    await vi.advanceTimersByTimeAsync(1000); // well past the debounce
    expect(writes).toEqual([]); // nothing written yet — this is the guard

    releaseRead(JSON.stringify({ version: 1, casts: [{ id: "old", name: "From disk", members: [] }] }));
    await hydrating;
    await vi.advanceTimersByTimeAsync(1000);

    // The deferred write ran, and it carries BOTH.
    expect(lastWritten(writes)!.map((c) => c.name).sort())
      .toEqual(["From disk", "Made during boot"]);
  });

  it("keeps the in-session cast when disk has a different one", async () => {
    backend([{ id: "old", name: "From disk", members: [] }]);
    saveCast(newCast("Made first"));
    await hydrateCastStore();
    expect(getCasts().map((c) => c.name).sort()).toEqual(["From disk", "Made first"]);
  });
});

describe("saving", () => {
  it("writes once for a burst of edits", async () => {
    const writes = backend([]);
    await hydrateCastStore();
    const c = newCast("Show");
    saveCast(c);
    saveCast({ ...c, name: "Show S1" });
    saveCast({ ...c, name: "Show S2" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes).toHaveLength(1);
    expect(lastWritten(writes)!.map((x) => x.name)).toEqual(["Show S2"]);
  });

  it("writes atomically", async () => {
    backend([]);
    await hydrateCastStore();
    saveCast(newCast("Show"));
    await vi.advanceTimersByTimeAsync(1000);
    const call = invoke.mock.calls.find((c) => c[0] === "write_text_to_path");
    // A non-atomic write leaves a truncated file if the app dies mid-save,
    // and this file is the ONLY copy of a season's worth of naming.
    expect(call![1].atomic).toBe(true);
    expect(call![1].path).toBe(CASTS_FILE);
  });

  it("updates in place rather than appending a second copy", async () => {
    backend([]);
    await hydrateCastStore();
    const c = newCast("Show");
    saveCast(c);
    saveCast({ ...c, name: "Renamed" });
    expect(getCasts()).toHaveLength(1);
    expect(getCasts()[0].name).toBe("Renamed");
  });

  it("re-arms after a failed write, instead of dropping the edit", async () => {
    let failing = true;
    const writes: string[] = [];
    invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
      if (cmd === "default_transcript_library_path") return LIB;
      if (cmd === "read_text_file_capped") throw new Error("ENOENT");
      if (cmd === "ensure_dir_exists") return null;
      if (cmd === "write_text_to_path") {
        if (failing) throw new Error("disk full");
        writes.push(String(args.text));
        return null;
      }
      throw new Error(`unexpected ${cmd}`);
    });
    await hydrateCastStore();
    saveCast(newCast("Show"));
    await vi.advanceTimersByTimeAsync(1000);
    expect(getCastError()).toMatch(/disk full/);
    expect(writes).toEqual([]);

    failing = false;
    await flushCasts();
    expect(lastWritten(writes)!.map((c) => c.name)).toEqual(["Show"]);
    expect(getCastError()).toBeNull();
  });

  it("flushes a pending write on demand, ahead of the debounce", async () => {
    const writes = backend([]);
    await hydrateCastStore();
    saveCast(newCast("Show"));
    expect(writes).toEqual([]);
    await flushCasts();
    expect(writes).toHaveLength(1);
  });
});

describe("deleting", () => {
  it("removes the cast and persists", async () => {
    const writes = backend([]);
    await hydrateCastStore();
    const c = newCast("Show");
    saveCast(c);
    deleteCast(c.id);
    await vi.advanceTimersByTimeAsync(1000);
    expect(getCasts()).toEqual([]);
    expect(lastWritten(writes)).toEqual([]);
  });

  it("does not schedule a write for an id that was not there", async () => {
    const writes = backend([]);
    await hydrateCastStore();
    deleteCast("never-existed");
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes).toEqual([]);
  });
});

describe("subscribers", () => {
  it("notifies on save and delete, and stops after unsubscribe", async () => {
    backend([]);
    await hydrateCastStore();
    let hits = 0;
    const off = subscribeCasts(() => { hits += 1; });
    const c = newCast("Show");
    saveCast(c);
    expect(hits).toBe(1);
    deleteCast(c.id);
    expect(hits).toBe(2);
    off();
    saveCast(newCast("Another"));
    expect(hits).toBe(2);
  });

  it("hands out a new array identity per change, for useSyncExternalStore", async () => {
    backend([]);
    await hydrateCastStore();
    const before = getCasts();
    saveCast(newCast("Show"));
    expect(getCasts()).not.toBe(before);
    // …and a STABLE one between changes, or the hook re-renders forever.
    expect(getCasts()).toBe(getCasts());
  });
});
