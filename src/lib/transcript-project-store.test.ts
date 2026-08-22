import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  writes: [] as { path: string; text: string }[],
  fileText: null as string | null,
  libDir: "/Docs/Sauce Bunny/Transcripts",
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "default_transcript_library_path") return h.libDir;
    if (cmd === "ensure_dir_exists") return null;
    if (cmd === "write_text_to_path") {
      h.writes.push({ path: args.path as string, text: args.text as string });
      return null;
    }
    if (cmd === "read_text_file_capped") {
      if (h.fileText === null) throw new Error("ENOENT");
      return h.fileText;
    }
    return null;
  },
}));

const store = () => import("./transcript-project-store");

beforeEach(async () => {
  h.writes = [];
  h.fileText = null;
  (await store()).__resetProjectStore();
  vi.useFakeTimers();
});
// restoreAllMocks matters here: the mid-hydration test installs a spy whose
// promise is released by hand, so if that test ever FAILS early the spy would
// survive and every later test would hang on a gate nobody opens. That is
// exactly what happened while break-testing this file.
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.resetModules(); });

/** Let the debounce fire and the async flush settle. */
async function settle() {
  await vi.advanceTimersByTimeAsync(500);
  await vi.advanceTimersByTimeAsync(0);
}

describe("the project store", () => {
  it("REFUSES to write before hydration, which is the unrecoverable bug", async () => {
    // An empty list at boot means "not loaded", not "no projects". Writing it
    // would erase the file with a subset of itself.
    const s = await store();
    s.editProject("Show", { title: "nope" });
    await settle();
    expect(h.writes, "wrote before reading the disk copy").toEqual([]);
  });

  it("refuses a write that lands DURING hydration, not just before it", async () => {
    // This is the case that isolates the `hydrated` flag. Before hydration
    // starts, `dir` is null and that alone blocks the write — so the test
    // above passes even with the hydration check deleted, which made it a
    // false pass. `hydrateProjects` sets `dir` and THEN awaits the read, so an
    // edit arriving in that window is stopped by `hydrated` and nothing else.
    const s = await store();
    let release!: () => void;
    h.fileText = JSON.stringify({ version: 1, projects: [{ folder: "Show", title: "on disk" }] });
    const gate = new Promise<void>((r) => { release = r; });
    const slowRead = vi.fn(async () => { await gate; return h.fileText!; });
    const core = await import("@tauri-apps/api/core");
    const real = core.invoke as unknown as (c: string, a: Record<string, unknown>) => Promise<unknown>;
    vi.spyOn(core, "invoke").mockImplementation((async (c: string, a?: Record<string, unknown>) => {
      if (c === "read_text_file_capped") return slowRead();
      return real(c, a ?? {});
    }) as typeof core.invoke);

    const hydration = s.hydrateProjects(["Show"]);
    await vi.advanceTimersByTimeAsync(0);      // dir is set; the read is pending
    s.editProject("Show", { title: "mid-flight" });
    await settle();
    expect(h.writes, "wrote while the disk copy was still being read").toEqual([]);

    release();
    await hydration;
    await settle();
    // And the edit is still owed, not dropped.
    expect(h.writes.length).toBeGreaterThan(0);
  });

  it("performs the owed write once hydration lands", async () => {
    // The edit above is not dropped — it is owed, and hydration pays it.
    const s = await store();
    s.editProject("Show", { title: "nope" });
    await settle();
    await s.hydrateProjects(["Show"]);
    await settle();
    expect(h.writes.length).toBeGreaterThan(0);
  });

  it("adopts folders on disk when there is no file yet", async () => {
    const s = await store();
    await s.hydrateProjects(["Marry Harry", "2026-08"]);
    // The month bucket is the app's own filing, not a project.
    expect(s.getProjects().map((p) => p.folder)).toEqual(["Marry Harry"]);
  });

  it("keeps stored metadata for folders that still exist", async () => {
    h.fileText = JSON.stringify({
      version: 1,
      projects: [{ folder: "Show", title: "The Show", color: "#0f0" }],
    });
    const s = await store();
    await s.hydrateProjects(["Show"]);
    expect(s.getProjects()[0].title).toBe("The Show");
    expect(s.getProjects()[0].color).toBe("#0f0");
  });

  it("drops a project whose folder was deleted outside the app", async () => {
    h.fileText = JSON.stringify({ version: 1, projects: [{ folder: "Gone" }] });
    const s = await store();
    await s.hydrateProjects([]);
    expect(s.getProjects()).toEqual([]);
  });

  it("survives a corrupt file by rebuilding from the folders", async () => {
    // It sits in the user's Documents and is hand-editable.
    h.fileText = "{ not json";
    const s = await store();
    await s.hydrateProjects(["Show"]);
    expect(s.getProjects().map((p) => p.folder)).toEqual(["Show"]);
  });

  it("writes atomically, beside the transcripts it describes", async () => {
    const s = await store();
    await s.hydrateProjects(["Show"]);
    s.editProject("Show", { title: "Renamed" });
    await settle();
    const w = h.writes.at(-1)!;
    expect(w.path).toBe(`${h.libDir}/projects.json`);
    expect(JSON.parse(w.text).projects[0].title).toBe("Renamed");
  });

  it("debounces a burst into one write", async () => {
    const s = await store();
    await s.hydrateProjects(["Show"]);
    h.writes = [];
    s.editProject("Show", { title: "a" });
    s.editProject("Show", { title: "b" });
    s.editProject("Show", { title: "c" });
    await settle();
    expect(h.writes).toHaveLength(1);
    expect(JSON.parse(h.writes[0].text).projects[0].title).toBe("c");
  });

  it("notices a folder made in Finder after boot", async () => {
    const s = await store();
    await s.hydrateProjects(["Show"]);
    s.syncProjectFolders(["Show", "New Show"]);
    expect(s.getProjects().map((p) => p.folder)).toEqual(["Show", "New Show"]);
  });

  it("does not write when a re-scan changed nothing", async () => {
    const s = await store();
    await s.hydrateProjects(["Show"]);
    await settle();
    h.writes = [];
    s.syncProjectFolders(["Show"]);
    await settle();
    expect(h.writes, "a no-op scan rewrote the file").toEqual([]);
  });

  it("tells subscribers when the shelf changes", async () => {
    const s = await store();
    let hits = 0;
    s.subscribeProjects(() => { hits += 1; });
    await s.hydrateProjects(["Show"]);
    s.editProject("Show", { color: "#f00" });
    expect(hits).toBeGreaterThanOrEqual(2);
  });
});
