// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadProjectCatalog, libraryAsset, projectTranscriptEntry } from "./library-project-catalog";
import { assetKey, matchesSmartFolder } from "./library-organization";
import { clearHidden, hidePaths } from "./library-hidden";
import type { LibraryFolder } from "../types";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), history: vi.fn(() => []), review: vi.fn(() => null) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("./transcript-history", () => ({ getHistory: mocks.history }));
vi.mock("./review-store", () => ({ reviewStatusForKey: mocks.review }));
beforeEach(() => {
  clearHidden(); mocks.history.mockReset().mockReturnValue([]); mocks.review.mockReset().mockReturnValue(null);
  mocks.invoke.mockReset().mockImplementation(async (cmd, args) => {
    if (cmd === "library_reference_status") return args.paths.map((path: string) => ({ path, exists: true }));
    return [];
  });
});
describe("project catalog", () => {
  it("keeps stable reference identities and bounds availability reads to 500 paths", async () => {
    const references = Array.from({ length: 1001 }, (_, i) => libraryAsset("file", `/media/${i}.mov`));
    const original = { ...references[0], id: "original-id", title: "My title" };
    const catalog = await loadProjectCatalog([], [original, ...references], "");
    expect(catalog.assets).toHaveLength(1001); expect(catalog.assets[0]).toEqual(original);
    expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "library_reference_status").map(([, args]) => args.paths.length)).toEqual([500, 500, 1]);
    expect(mocks.invoke.mock.calls.every(([cmd]) => ["list_cached_web", "aaf_list", "library_reference_status", "read_finder_tags"].includes(cmd))).toBe(true);
  });
  it("does not confuse unavailable metadata with an offline item, and recomputes changes", async () => {
    const file = libraryAsset("file", "/media/a.mov"), sequence = libraryAsset("multitrack", "aaf-id");
    mocks.invoke.mockRejectedValue(new Error("Permission denied"));
    const unknown = await loadProjectCatalog([], [file, sequence], "");
    expect(unknown.errors.length).toBeGreaterThan(0);
    expect(unknown.facts.get(assetKey(file))?.offline).toBeNull();
    expect(unknown.facts.get(assetKey(sequence))?.offline).toBeNull();
    const rule = { query: "", kind: "all", tag: "", status: "offline" } as const;
    expect(matchesSmartFolder(file, unknown.facts.get(assetKey(file))!, rule)).toBe(false);
    mocks.invoke.mockImplementation(async (cmd) => cmd === "library_reference_status" ? [{ path: file.locator, exists: false }] : []);
    const missing = await loadProjectCatalog([], [file, sequence], "");
    expect(matchesSmartFolder(file, missing.facts.get(assetKey(file))!, rule)).toBe(true);
    mocks.invoke.mockImplementation(async (cmd) => cmd === "library_reference_status" ? [{ path: file.locator, exists: true }] : []);
    const online = await loadProjectCatalog([], [file], "");
    expect(matchesSmartFolder(file, online.facts.get(assetKey(file))!, rule)).toBe(false);
  });
  it("abandons obsolete metadata batches rather than continuing a stale catalog scan", async () => {
    const controller = new AbortController();
    mocks.invoke.mockImplementation(async (cmd) => { if (cmd === "library_reference_status") controller.abort(); return []; });
    const refs = Array.from({ length: 1100 }, (_, i) => libraryAsset("file", `/media/${i}.mov`));
    await expect(loadProjectCatalog([], refs, "", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(mocks.invoke.mock.calls.filter(([cmd]) => cmd === "library_reference_status")).toHaveLength(1);
  });
  it("keeps explicit missing/hidden references, but does not rediscover removed media", async () => {
    const tree: LibraryFolder = { path: "/media", name: "Media", deeper: false, folders: [], items: ["a.mov", "b.mov"].map((name) => ({ path: `/media/${name}`, name, kind: "video", size_bytes: 1, modified_ms: 0 })) };
    hidePaths(["/media/a.mov", "/media/b.mov"]);
    const reference = libraryAsset("file", "/media/a.mov");
    const catalog = await loadProjectCatalog([tree], [reference], "");
    expect(catalog.assets).toEqual([reference]);
  });
  it("opens an explicitly filed transcript even without a history entry", async () => {
    const transcript = libraryAsset("transcript", "/words.srt", "Words");
    const catalog = await loadProjectCatalog([], [transcript], "");
    expect(projectTranscriptEntry(transcript, catalog)).toMatchObject({ srtPath: "/words.srt", title: "Words" });
  });
});
