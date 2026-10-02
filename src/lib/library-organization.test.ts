import { describe, expect, it } from "vitest";
import { addFolderAssets, emptyOrganization, folderChain, matchesSmartFolder, parseOrganization, putFolder, relinkAsset, removeFolder, type ProjectFolder } from "./library-organization";

const folder = (id: string, parentId: string | null = null): ProjectFolder => ({ id, parentId, name: id, assetIds: [], rule: null });

describe("reference-only project folders", () => {
  it("keeps a mixed asset in several nested folders without copying its source", () => {
    let data = putFolder(putFolder(emptyOrganization(), folder("Show")), folder("Interview", "Show"));
    const assets = [
      { id: "f", kind: "file" as const, locator: "/Media/interview.mov", title: "Interview" },
      { id: "w", kind: "web" as const, locator: "https://example.com/film", title: "Reference" },
      { id: "t", kind: "transcript" as const, locator: "/Transcripts/interview.srt", title: "Words" },
      { id: "m", kind: "multitrack" as const, locator: "sequence-id", title: "Mics" },
    ];
    data = addFolderAssets(addFolderAssets(data, "Show", assets), "Interview", assets);
    expect(data.assets).toHaveLength(4);
    expect(data.folders.map((f) => f.assetIds)).toEqual([["f", "w", "t", "m"], ["f", "w", "t", "m"]]);
    expect(folderChain(data.folders, "Interview").map((f) => f.name)).toEqual(["Show", "Interview"]);
    expect(parseOrganization(JSON.stringify(data))).toEqual(data);
    const removed = removeFolder(data, "Show");
    expect(removed.folders).toEqual([]);
    expect(removed.assets).toEqual(assets);
  });
  it("rejects cycles, missing parents, duplicate sibling names and invalid names", () => {
    const data = putFolder(putFolder(emptyOrganization(), folder("a")), folder("b", "a"));
    expect(() => putFolder(data, { ...folder("a"), parentId: "b" })).toThrow("itself");
    expect(() => putFolder(data, folder("c", "missing"))).toThrow("parent");
    expect(() => putFolder(data, { ...folder("c"), name: " A " })).toThrow("already exists");
    expect(() => putFolder(data, { ...folder("c"), name: "a/b" })).toThrow("slashes");
  });
  it("deduplicates composed/decomposed file paths and retains stable identity on relink", () => {
    let data = putFolder(emptyOrganization(), folder("a"));
    data = addFolderAssets(data, "a", [
      { id: "1", kind: "file", locator: "/café.mov", title: "café" },
      { id: "2", kind: "file", locator: "/cafe\u0301.mov", title: "café" },
    ]);
    expect(data.assets).toHaveLength(1);
    const moved = relinkAsset(data, "1", "/Disk/new.mov");
    expect(moved.folders[0].assetIds).toEqual(["1"]);
    expect(moved.assets[0].locator).toBe("/Disk/new.mov");
  });
  it("refuses malformed/future documents rather than quietly saving a subset", () => {
    expect(() => parseOrganization("{" )).toThrow();
    expect(() => parseOrganization('{"version":2}')).toThrow("newer");
    expect(() => parseOrganization(JSON.stringify({ ...emptyOrganization(), folders: [folder("a", "a")] }))).toThrow("itself");
    expect(() => parseOrganization(JSON.stringify({ ...emptyOrganization(), folders: [{ ...folder("a"), assetIds: ["missing"] }] }))).toThrow("unknown");
  });
  it("smart folders use observed facts and never treat unknown status as false", () => {
    const asset = { id: "a", kind: "file" as const, locator: "/a.mov", title: "Interview" };
    const rule = { query: "inter", kind: "file" as const, tag: "interview", status: "not-transcribed" as const };
    const facts = { tags: ["Interview"], transcribed: false, needsReview: null, offline: null };
    expect(matchesSmartFolder(asset, facts, rule)).toBe(true);
    expect(matchesSmartFolder(asset, { ...facts, transcribed: null }, rule)).toBe(false);
    expect(matchesSmartFolder(asset, { ...facts, transcribed: true }, rule)).toBe(false);
  });
});
