// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

/**
 * Removing a root while its scan is in flight.
 *
 * `removeRoot` drops the root's entry from `scans`, but the scan it started is
 * still awaiting Rust. Only a newer SWEEP superseded a scan, and removal is not
 * one, so the late result wrote the removed root straight back into `scans` -
 * a folder the user had just taken off the shelf reappearing in the state.
 */
const h = vi.hoisted(() => ({
  pending: new Map<string, (tree: unknown) => void>(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: { path?: string }) => {
    if (cmd === "scan_library_folder" && args?.path) {
      return new Promise((res) => { h.pending.set(args.path!, res); });
    }
    return Promise.resolve("");
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => null }));
vi.mock("../lib/mediabunny-helpers", () => ({
  extractPosterBlob: async () => null,
  extractFrameAsBlob: async () => null,
  probeVideoDuration: async () => null,
}));
vi.mock("../lib/asset-url", () => ({ assetUrl: (p: string) => `asset://${p}` }));
vi.mock("../lib/library", () => ({
  LIBRARY_SCAN_DEPTH: 3,
  chosenPosterFor: () => null,
  clearChosenPoster: () => {},
  loadLibraryRoots: () => ["/a", "/b"],
  saveLibraryRoots: () => {},
}));

const { useLibraryScan } = await import("./use-library-scan");
const tree = (path: string) => ({ path, name: path, items: [], folders: [] });

describe("removing a root mid-scan", () => {
  it("drops the removed root's late result and still lands the others", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { result } = renderHook(() => useLibraryScan(false));
    await act(async () => { await Promise.resolve(); });
    // Canary: both scans are genuinely in flight, or the test proves nothing.
    expect([...h.pending.keys()].sort()).toEqual(["/a", "/b"]);

    act(() => { result.current.removeRoot("/a"); });
    expect(result.current.scans["/a"]).toBeUndefined();

    await act(async () => {
      h.pending.get("/a")!(tree("/a"));
      h.pending.get("/b")!(tree("/b"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.scans["/a"], "the removed root was written back").toBeUndefined();
    // Removal must not strand the surviving root at "loading".
    expect(result.current.scans["/b"]?.status).toBe("ok");
  });
});
