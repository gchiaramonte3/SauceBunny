// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useFinderTags } from "./use-finder-tags";

/**
 * Finder owns these colours and changes them behind the app's back.
 *
 * LibraryTree knew that and re-read on window focus; LibraryBrowser called the
 * same hook and did not. So tagging a folder in Finder repainted the sidebar
 * and left the grid next to it wearing the old colour — one set of tags, two
 * panes, disagreeing. From the outside that reads as "the app cannot see my
 * tag", which is the report that found it.
 *
 * The re-read now lives in the hook, so a consumer gets it by construction.
 * These pin that: it happens at all, it happens for ANY consumer, and it does
 * not re-read when there is nothing listed.
 */

const h = vi.hoisted(() => ({ calls: [] as string[][], rows: [] as unknown[],
  read: null as null | (() => Promise<unknown[]>),
  write: null as null | ((args: Record<string, unknown>) => Promise<unknown>),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "read_finder_tags") {
      h.calls.push(args.paths as string[]);
      return h.read ? h.read() : h.rows;
    }
    if (cmd === "set_finder_tags" && h.write) return h.write(args);
    return null;
  },
}));

beforeEach(() => { h.calls = []; h.rows = []; h.read = null; h.write = null; });
afterEach(cleanup);

describe("useFinderTags", () => {
  it("does not cancel a pending read on equivalent rerenders or duplicate paths", async () => {
    let finish!: (rows: unknown[]) => void;
    h.read = () => new Promise((resolve) => { finish = resolve; });
    const { result, rerender } = renderHook(({ paths }) => useFinderTags(paths), { initialProps: { paths: ["/b", "/a", "/a"] } });
    rerender({ paths: ["/a", "/b"] });
    await act(async () => finish([{ path: "/a", tags: [{ name: "Blue", color: 4 }] }]));
    expect(result.current.tags.get("/a")?.[0].name).toBe("Blue");
    expect(h.calls).toEqual([["/a", "/b"]]);
  });

  it("discards an obsolete read after a source-path change", async () => {
    const pending: ((rows: unknown[]) => void)[] = [];
    h.read = () => new Promise((resolve) => pending.push(resolve));
    const { result, rerender } = renderHook(({ path }) => useFinderTags([path]), { initialProps: { path: "/old" } });
    rerender({ path: "/new" });
    await act(async () => pending[1]([{ path: "/new", tags: [{ name: "Green", color: 2 }] }]));
    await act(async () => pending[0]([{ path: "/old", tags: [{ name: "Red", color: 6 }] }]));
    expect(result.current.tags.has("/old")).toBe(false);
    expect(result.current.tags.has("/new")).toBe(true);
  });

  it("rolls a failed native write back without refreshing other views", async () => {
    h.rows = [{ path: "/a", tags: [{ name: "Archive", color: 0 }] }];
    h.write = async () => { throw new Error("Permission denied"); };
    const { result } = renderHook(() => useFinderTags(["/a"]));
    await waitFor(() => expect(result.current.tags.has("/a")).toBe(true));
    await act(async () => result.current.toggle("/a", 6));
    expect(result.current.tags.get("/a")).toEqual([{ name: "Archive", color: 0 }]);
    expect(h.calls).toHaveLength(1);
  });

  it("updates another mounted representation after a successful native write", async () => {
    h.rows = [{ path: "/a", tags: [] }];
    h.write = async ({ path, tags }) => { h.rows = [{ path, tags }]; };
    const editor = renderHook(() => useFinderTags(["/a"]));
    const home = renderHook(() => useFinderTags(["/a"]));
    const unrelated = renderHook(() => useFinderTags(["/elsewhere"]));
    await waitFor(() => expect(editor.result.current.tags.has("/a")).toBe(true));
    await act(async () => editor.result.current.toggle("/a", 5));
    await waitFor(() => expect(home.result.current.tags.get("/a")?.[0].name).toBe("Yellow"));
    expect(h.calls.filter((paths) => paths.includes("/elsewhere"))).toHaveLength(1);
    unrelated.unmount();
  });
  it("reads the listed paths once, in one call", async () => {
    h.rows = [{ path: "/a", tags: [{ name: "Purple", color: 5 }] }];
    const { result } = renderHook(() => useFinderTags(["/a", "/b"]));
    await waitFor(() => expect(h.calls.length).toBe(1));
    expect(h.calls[0], "should be one bulk read, not one per row").toEqual(["/a", "/b"]);
    await waitFor(() => expect(result.current.tags.get("/a")).toBeTruthy());
  });

  it("re-reads when the window regains focus", async () => {
    // The actual bug: a colour set in Finder while the app was in the
    // background never appeared until the folder list itself changed.
    renderHook(() => useFinderTags(["/a"]));
    await waitFor(() => expect(h.calls.length).toBe(1));
    act(() => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(h.calls.length, "no re-read on focus").toBe(2));
  });

  it("gives EVERY consumer the re-read, not just the one that remembered", async () => {
    // Two independent mounts, as the tree and the grid are. Before the move
    // into the hook, only whichever component had the effect would refresh.
    renderHook(() => useFinderTags(["/tree"]));
    renderHook(() => useFinderTags(["/grid"]));
    await waitFor(() => expect(h.calls.length).toBe(2));
    act(() => { window.dispatchEvent(new Event("focus")); });
    await waitFor(() => expect(h.calls.length).toBe(4));
    const refreshed = h.calls.slice(2).flat();
    expect(refreshed, "the grid did not re-read").toContain("/grid");
    expect(refreshed, "the tree did not re-read").toContain("/tree");
  });

  it("does not hit the disk when nothing is listed", async () => {
    renderHook(() => useFinderTags([]));
    act(() => { window.dispatchEvent(new Event("focus")); });
    await new Promise((r) => setTimeout(r, 20));
    expect(h.calls, "read an empty path set").toEqual([]);
  });
});
