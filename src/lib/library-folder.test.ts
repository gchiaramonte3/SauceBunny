import { describe, expect, it } from "vitest";
import { diskFolderTargets, mergeFolderBranches, newFolderPath } from "./library-folder";
import type { LibraryFolder } from "../types";
import { pathKey } from "./repath";

describe("naming a new library folder", () => {
  it("joins onto the folder being browsed", () => {
    expect(newFolderPath("/Footage/Test", "Selects")).toEqual({ path: "/Footage/Test/Selects" });
  });

  it("does not double a trailing slash", () => {
    // The two callers get `dir` from different places and only one of them
    // trims. //Selects is a different path to /Selects on some filesystems.
    expect(newFolderPath("/Footage/Test/", "Selects")).toEqual({ path: "/Footage/Test/Selects" });
    expect(newFolderPath("/Footage/Test///", "Selects")).toEqual({ path: "/Footage/Test/Selects" });
  });

  it("refuses a separator, which would escape the folder", () => {
    // The Rust side joins blind, so this is the only thing standing between a
    // folder name and an arbitrary write location.
    expect(newFolderPath("/Footage", "../../etc")).toEqual({ error: "Use a plain folder name." });
    expect(newFolderPath("/Footage", "a/b")).toEqual({ error: "Use a plain folder name." });
  });

  it("refuses a leading dot, which would hide it from the scanner", () => {
    // You would make the folder, the rescan would skip it, and nothing would
    // appear. A refusal is better than a folder that exists and cannot be seen.
    expect(newFolderPath("/Footage", ".secret")).toEqual({ error: "Use a plain folder name." });
  });

  it("refuses an empty or whitespace name", () => {
    expect(newFolderPath("/Footage", "")).toEqual({ error: "Use a plain folder name." });
    expect(newFolderPath("/Footage", "   ")).toEqual({ error: "Use a plain folder name." });
  });

  it("trims, so a stray space does not become part of the folder name", () => {
    expect(newFolderPath("/Footage", "  Selects  ")).toEqual({ path: "/Footage/Selects" });
  });

  it("says so when there is no folder open to create inside", () => {
    expect(newFolderPath("", "Selects")).toEqual({ error: "Open a folder first." });
  });
});

it("merges lazy descendants without mutating Home's scan or losing deeper reads", () => {
  const node = (path: string, folders: LibraryFolder[] = [], deeper = false): LibraryFolder => ({ name: path.split("/").pop()!, path, folders, items: [], deeper });
  const base = node("/Media", [node("/Media/Deep", [], true)]);
  const branches = new Map([
    [pathKey("/Media/Deep"), node("/Media/Deep", [node("/Media/Deep/More", [], true)])],
    [pathKey("/Media/Deep/More"), node("/Media/Deep/More", [node("/Media/Deep/More/End")])],
  ]);
  const merged = mergeFolderBranches([base], branches);
  expect(diskFolderTargets(merged).map((f) => f.path)).toEqual(["/Media", "/Media/Deep", "/Media/Deep/More", "/Media/Deep/More/End"]);
  expect(base.folders[0]).toMatchObject({ folders: [], deeper: true });
});
