// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

/**
 * Offline library roots (docs/RECONNECT-MEDIA-SPEC-2026-10-05.md, phase 1).
 *
 * A root that cannot be reached is asked about first, without touching an
 * unmounted drive, and is shown as offline with the reason rather than
 * scanned into "Not found"; a drive mounting brings it back without a click;
 * and Locate folder… puts the new place where the old one was and moves
 * everything stored under it.
 */
const h = vi.hoisted(() => ({
  availability: new Map<string, string>(),
  scanned: [] as string[],
  roots: ["/Volumes/NEXIS/Show", "/Users/editor/Desktop/Test", "/Users/editor/Movies"],
  saved: [] as string[][],
  picked: null as string | null,
  dialog: [] as Record<string, unknown>[],
  volumesChanged: null as null | ((event: { payload: null }) => void),
  moved: [] as [string, string][],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: { path?: string; paths?: string[] }) => {
    if (cmd === "media_availability") return args!.paths!.map((path) => ({ path, state: h.availability.get(path) ?? "online",
      volume: path.startsWith("/Volumes/") ? path.split("/")[2] : null, folder: true }));
    if (cmd === "scan_library_folder") { h.scanned.push(args!.path!); return { path: args!.path!, name: args!.path!.split("/").pop(), items: [], folders: [], deeper: false }; }
    return "";
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, handler: (event: { payload: null }) => void) => { if (event === "media:volumes-changed") h.volumesChanged = handler; return () => {}; },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async (options: Record<string, unknown>) => { h.dialog.push(options); return h.picked; } }));
vi.mock("../lib/mediabunny-helpers", () => ({ extractPosterBlob: async () => null, extractFrameAsBlob: async () => null, probeVideoDuration: async () => null }));
vi.mock("../lib/asset-url", () => ({ assetUrl: (p: string) => `asset://${p}` }));
vi.mock("../lib/library", () => ({
  LIBRARY_SCAN_DEPTH: 3, chosenPosterFor: () => null, clearChosenPoster: () => {},
  loadLibraryRoots: () => h.roots, saveLibraryRoots: (roots: string[]) => { h.saved.push([...roots]); },
}));
vi.mock("../lib/relink", () => ({ moveStoredPaths: (from: string, to: string) => { h.moved.push([from, to]); } }));

const { useLibraryScan } = await import("./use-library-scan");
afterEach(() => { h.availability.clear(); h.scanned = []; h.saved = []; h.moved = []; h.dialog = []; h.picked = null; });

describe("offline library roots", () => {
  it("says why a root is offline instead of scanning it, and scans the rest", async () => {
    h.availability.set("/Volumes/NEXIS/Show", "driveOffline");
    h.availability.set("/Users/editor/Desktop/Test", "missing");
    const { result } = renderHook(() => useLibraryScan(false));
    await waitFor(() => expect(result.current.scans["/Users/editor/Movies"]?.status).toBe("ok"));
    expect(result.current.scans["/Volumes/NEXIS/Show"]).toEqual({ status: "offline", state: "driveOffline", volume: "NEXIS" });
    expect(result.current.scans["/Users/editor/Desktop/Test"]).toEqual({ status: "offline", state: "missing", volume: null });
    expect(h.scanned, "an offline root was scanned").toEqual(["/Users/editor/Movies"]);
    expect(result.current.roots).toEqual(h.roots);
  });

  it("brings a root back when its drive mounts, without a click, and leaves online roots alone", async () => {
    h.availability.set("/Volumes/NEXIS/Show", "driveOffline");
    const { result } = renderHook(() => useLibraryScan(false));
    await waitFor(() => expect(result.current.scans["/Volumes/NEXIS/Show"]?.status).toBe("offline"));
    expect(h.volumesChanged, "nothing listens for drives mounting").not.toBeNull();
    h.availability.delete("/Volumes/NEXIS/Show"); h.scanned = [];
    await act(async () => { h.volumesChanged!({ payload: null }); });
    await waitFor(() => expect(result.current.scans["/Volumes/NEXIS/Show"]?.status).toBe("ok"));
    expect(h.scanned).toEqual(["/Volumes/NEXIS/Show"]);
  });

  it("Locate folder… puts the new place where the old one was and moves what is stored under it", async () => {
    h.availability.set("/Users/editor/Desktop/Test", "missing");
    const { result } = renderHook(() => useLibraryScan(false));
    await waitFor(() => expect(result.current.scans["/Users/editor/Desktop/Test"]?.status).toBe("offline"));
    h.picked = "/Users/editor/Projects/Test";
    await act(async () => { await result.current.locateRoot("/Users/editor/Desktop/Test"); });
    expect(h.dialog[0]).toMatchObject({ directory: true, defaultPath: "/Users/editor/Desktop", title: "Locate Test" });
    expect(result.current.roots).toEqual(["/Volumes/NEXIS/Show", "/Users/editor/Projects/Test", "/Users/editor/Movies"]);
    expect(h.saved.at(-1)).toEqual(result.current.roots);
    expect(h.moved).toEqual([["/Users/editor/Desktop/Test", "/Users/editor/Projects/Test"]]);
    await waitFor(() => expect(result.current.scans["/Users/editor/Projects/Test"]?.status).toBe("ok"));
    expect(result.current.scans["/Users/editor/Desktop/Test"]).toBeUndefined();
  });

  it("starts a drive's Locate at /Volumes, and a cancelled or unchanged pick moves nothing", async () => {
    h.availability.set("/Volumes/NEXIS/Show", "driveOffline");
    const { result } = renderHook(() => useLibraryScan(false));
    await waitFor(() => expect(result.current.scans["/Volumes/NEXIS/Show"]?.status).toBe("offline"));
    await act(async () => { await result.current.locateRoot("/Volumes/NEXIS/Show"); });
    expect(h.dialog[0]).toMatchObject({ defaultPath: "/Volumes" });
    h.picked = "/Volumes/NEXIS/Show";
    await act(async () => { await result.current.locateRoot("/Volumes/NEXIS/Show"); });
    expect(h.moved).toEqual([]); expect(h.saved).toEqual([]);
  });

  it("merges a root located onto a folder the library already has, rather than listing it twice", async () => {
    h.availability.set("/Users/editor/Desktop/Test", "missing");
    const { result } = renderHook(() => useLibraryScan(false));
    await waitFor(() => expect(result.current.scans["/Users/editor/Desktop/Test"]?.status).toBe("offline"));
    h.picked = "/Users/editor/Movies";
    await act(async () => { await result.current.locateRoot("/Users/editor/Desktop/Test"); });
    expect(result.current.roots).toEqual(["/Volumes/NEXIS/Show", "/Users/editor/Movies"]);
  });
});
