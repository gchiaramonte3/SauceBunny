// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { LibraryTree } from "./LibraryTree";
import type { LibraryFolder } from "../types";

/**
 * The sidebar must ask about REAL paths, and must paint what comes back.
 *
 * This is a render-level test on purpose. row-key-path-contract already
 * forbids the source shape that caused the bug, but the bug itself was never
 * a bad-looking line - it was that the tree asked the filesystem about
 * "0:/Users/..." and drew the empty answer without complaint. A source rule
 * cannot see that; only the arguments actually handed to read_finder_tags,
 * and the colour actually reaching the DOM, can.
 *
 * It has been reported as a regression twice.
 */

const h = vi.hoisted(() => ({
  tagCalls: [] as string[][],
  tags: [] as { path: string; tags: { name: string; color: number }[] }[],
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === "read_finder_tags") {
      h.tagCalls.push((args?.paths as string[]) ?? []);
      return Promise.resolve(h.tags);
    }
    return Promise.resolve(undefined);
  },
}));

const ROOT = "/lib/Root";
const CHILD = "/lib/Root/Inner";

const folder = (name: string, path: string, folders: LibraryFolder[] = []): LibraryFolder =>
  ({ name, path, folders, items: [], deeper: false }) as unknown as LibraryFolder;

const TREES = [folder("Root", ROOT, [folder("Inner", CHILD)])];

function draw() {
  return render(
    <LibraryTree
      trees={TREES}
      selection={null}
      onSelect={() => {}}
      kind="all"
      onKind={() => {}}
      onCollapse={() => {}}
      addFolder={async () => {}}
      rescanAll={() => {}}
      scanning={false}
      removeRoot={() => {}}
      shelf={null}
      onSelectShelf={() => {}}
      dropOver={null}
    />,
  );
}

describe("LibraryTree Finder colours", () => {
  beforeEach(() => {
    h.tagCalls.length = 0;
    h.tags.length = 0;
    localStorage.clear();
  });

  it("asks about real filesystem paths, never the row key", async () => {
    draw();
    await waitFor(() => expect(h.tagCalls.length).toBeGreaterThan(0));
    const asked = h.tagCalls.flat();
    // The canary: a run that asked about nothing would satisfy every
    // "no bad path" assertion below by vacuum.
    expect(asked.length).toBeGreaterThan(0);
    expect(asked).toContain(ROOT);
    // The regression itself. A row's key is `<rootIndex>:<path>`, so the bug
    // asked about "0:/lib/Root" - which cannot exist, so every folder drew
    // plain and nothing reported an error.
    for (const p of asked) {
      expect(p.startsWith("/"), `asked about a non-path: ${p}`).toBe(true);
      expect(/^\d+:/.test(p), `asked about a row key, not a path: ${p}`).toBe(false);
    }
  });

  it("paints a tagged folder with its Finder colour", async () => {
    // Name "Purple", index 1. That is what macOS actually writes: Finder
    // resolves a named tag's colour from its own list, so real folders on
    // disk read back as "Purple\n1" where 1 is Grey. The name has to win.
    h.tags.push({ path: ROOT, tags: [{ name: "Purple", color: 1 }] });
    const { container } = draw();
    await waitFor(() => {
      const glyphs = [...container.querySelectorAll<HTMLElement>(".cp-lib-tree-folder")];
      expect(glyphs.length).toBeGreaterThan(0);
      const tinted = glyphs.filter((g) => g.style.color !== "");
      expect(tinted.length, "no folder glyph was tinted").toBeGreaterThan(0);
      // #CB6BD9, which jsdom normalises to rgb().
      expect(tinted[0].style.color).toBe("rgb(203, 107, 217)");
    });
  });

  it("leaves an untagged folder alone", async () => {
    const { container } = draw();
    await waitFor(() => expect(h.tagCalls.length).toBeGreaterThan(0));
    const glyphs = [...container.querySelectorAll<HTMLElement>(".cp-lib-tree-folder")];
    expect(glyphs.length).toBeGreaterThan(0);
    expect(glyphs.every((g) => g.style.color === "")).toBe(true);
  });
});
