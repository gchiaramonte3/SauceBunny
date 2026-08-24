import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...a: unknown[]) => invoke(...a) }));

const {
  __resetWebCollectionStore, addToWebCollection, createWebCollection,
  deleteWebCollection, flushWebCollections, getWebCollections,
  hydrateWebCollections, parseWebCollections, removeFromWebCollection,
  renameWebCollection,
} = await import("./web-collection-store");

const LIB = "/Users/x/Documents/Sauce Bunny/Transcripts";
const FILE = "/Users/x/Documents/Sauce Bunny/Collections/collections.json";

function backend(onDisk: unknown[] | null) {
  const writes: { path: string; text: string; atomic: unknown }[] = [];
  invoke.mockImplementation(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "default_transcript_library_path") return LIB;
    if (cmd === "read_text_file_capped") {
      if (onDisk === null) throw new Error("ENOENT");
      return JSON.stringify({ version: 1, collections: onDisk });
    }
    if (cmd === "ensure_dir_exists") return null;
    if (cmd === "write_text_to_path") {
      writes.push({ path: String(args.path), text: String(args.text), atomic: args.atomic });
      return null;
    }
    throw new Error(`unexpected ${cmd}`);
  });
  return writes;
}

beforeEach(() => { __resetWebCollectionStore(); invoke.mockReset(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("hydration", () => {
  it("loads the collections on disk", async () => {
    backend([{ id: "a", name: "Interviews", urls: ["https://y.tv/1"], createdMs: 5 }]);
    await hydrateWebCollections();
    expect(getWebCollections().map((c) => c.name)).toEqual(["Interviews"]);
  });

  it("a save made before hydration cannot erase the file", async () => {
    // THE guard every file store in this app carries, pinned at birth this
    // time instead of after the bug: a write before the disk copy is
    // accounted for would replace the file with a subset of itself.
    const writes = backend([{ id: "a", name: "Keep me", urls: [], createdMs: 1 }]);
    createWebCollection("Made at boot");
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes, "wrote before hydration").toHaveLength(0);

    await hydrateWebCollections();
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes.length).toBeGreaterThan(0);
    const final = JSON.parse(writes.at(-1)!.text).collections.map((c: { name: string }) => c.name);
    expect(final).toContain("Keep me");
    expect(final).toContain("Made at boot");
  });

  it("writes atomically to the Collections file", async () => {
    const writes = backend(null);
    await hydrateWebCollections();
    createWebCollection("Docs");
    await vi.advanceTimersByTimeAsync(1000);
    expect(writes[0].path).toBe(FILE);
    expect(writes[0].atomic).toBe(true);
  });
});

describe("membership", () => {
  it("add is idempotent and remove is exact", async () => {
    backend(null);
    await hydrateWebCollections();
    const c = createWebCollection("Cuts")!;
    addToWebCollection(c.id, "https://y.tv/1");
    addToWebCollection(c.id, "https://y.tv/1");
    addToWebCollection(c.id, "https://y.tv/2");
    expect(getWebCollections()[0].urls).toEqual(["https://y.tv/1", "https://y.tv/2"]);
    removeFromWebCollection(c.id, "https://y.tv/1");
    expect(getWebCollections()[0].urls).toEqual(["https://y.tv/2"]);
  });

  it("rename trims and refuses blank; delete removes the collection only", async () => {
    backend(null);
    await hydrateWebCollections();
    const c = createWebCollection("Cuts")!;
    renameWebCollection(c.id, "  Selects  ");
    expect(getWebCollections()[0].name).toBe("Selects");
    renameWebCollection(c.id, "   ");
    expect(getWebCollections()[0].name).toBe("Selects");
    deleteWebCollection(c.id);
    expect(getWebCollections()).toEqual([]);
  });

  it("flushWebCollections forces the debounced write out", async () => {
    const writes = backend(null);
    await hydrateWebCollections();
    createWebCollection("Cuts");
    await flushWebCollections();
    expect(writes).toHaveLength(1);
  });
});

describe("parseWebCollections", () => {
  it("keeps the first of duplicate ids and drops junk members", () => {
    const out = parseWebCollections({
      collections: [
        { id: "a", name: "One", urls: ["u1", 7, "u1", ""], createdMs: 1 },
        { id: "a", name: "Duplicate", urls: [], createdMs: 2 },
        { id: "", name: "No id", urls: [], createdMs: 3 },
        { id: "b", name: "   ", urls: [], createdMs: 4 },
        "garbage",
      ],
    });
    expect(out).toEqual([{ id: "a", name: "One", urls: ["u1"], createdMs: 1 }]);
  });

  it("yields nothing for a shape that is not a collections file", () => {
    expect(parseWebCollections(null)).toEqual([]);
    expect(parseWebCollections([1, 2])).toEqual([]);
    expect(parseWebCollections({ collections: "nope" })).toEqual([]);
  });
});
