import { describe, expect, it } from "vitest";
import { newFolderPath } from "./library-folder";

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
