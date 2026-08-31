import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every surface that draws a folder offers its colours, and reads them.
 *
 * Reported as a regression: right-clicking a folder in the library gave no
 * colour picker, and folders showed none of the colours they already wear in
 * Finder. Both were true, and neither was a removal - the browse area never
 * had them. FolderTagMenu's own header names the three places folders appear
 * ("the tree, the Home shelves, the browser's folder cards") and the third was
 * never wired, so the sidebar tree coloured a folder correctly while the same
 * folder two panes over was drawn plain. One library, two answers.
 *
 * The read half is the easier one to lose again, because it is invisible: the
 * paths handed to useFinderTags were the FILES on screen, so a folder's tags
 * were never fetched and its tint was empty rather than wrong.
 */

const ROOT = join(__dirname, "../..");

function code(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Everything that renders a folder the user can right-click. */
const FOLDER_SURFACES = [
  "src/components/LibraryTree.tsx",        // the sidebar
  "src/components/LibraryFolderCard.tsx",  // grid / thumbnail view
  "src/components/LibraryFolderRow.tsx",   // list view
];

describe("folder colours", () => {
  it("the surfaces under test exist and render folders", () => {
    // The canary. Rename a file and every check below passes over nothing.
    expect(FOLDER_SURFACES.length).toBe(3);
    for (const rel of FOLDER_SURFACES) {
      expect(code(rel).length, `${rel} did not load`).toBeGreaterThan(200);
    }
  });

  it("every one opens FolderTagMenu", () => {
    for (const rel of FOLDER_SURFACES) {
      expect(code(rel), `${rel} draws a folder with no way to colour it`).toContain("FolderTagMenu");
    }
  });

  it("every one has a right-click and a keyboard route to it", () => {
    for (const rel of FOLDER_SURFACES) {
      const src = code(rel);
      expect(src, `${rel} has no onContextMenu`).toMatch(/onContextMenu/);
      // Mouse-only would put the colours out of reach of the keyboard
      // entirely, which is 2.1.1 Level A.
      // Tight on purpose. A loose /ContextMenu|F10/ is satisfied by the
      // mouse handler's own name and by a leftover guard line, so removing
      // the whole keyboard branch still passed it.
      expect(
        src,
        `${rel} reaches its menu by pointer only`,
      ).toMatch(/(?:case|===)\s*"ContextMenu"/);
    }
  });

  it("every one tints the folder rather than adding a second dot", () => {
    // The glyph IS a filled folder shape, so colouring it is the Finder
    // treatment. A separate swatch would compete for row space.
    for (const rel of ["src/components/LibraryFolderCard.tsx", "src/components/LibraryFolderRow.tsx"]) {
      expect(code(rel), `${rel} does not use the tag colour`).toContain("primarySwatch");
    }
  });

  it("the browse pane asks for folder tags, not only file tags", () => {
    // The invisible half. useFinderTags used to be handed itemPaths alone, so
    // a folder's tags were never READ and the tint was empty rather than wrong.
    const src = code("src/components/LibraryBrowser.tsx");
    expect(src, "useFinderTags is gone").toContain("useFinderTags(");
    expect(
      src,
      "useFinderTags is handed the file paths only; folder tags are never read",
    ).not.toMatch(/useFinderTags\(itemPaths\)/);
    expect(src).toMatch(/folders\.map\(\(f\) => f\.path\)/);
  });
});
