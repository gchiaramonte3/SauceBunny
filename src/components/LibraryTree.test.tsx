// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { LibraryTree } from "./LibraryTree";
import type { LibraryCrumb } from "../lib/library";
import type { LibraryFolder } from "../bindings/LibraryFolder";

/**
 * The disclosure system, audited after "minimizing and maximizing is not
 * working to perfection".
 *
 * Three faults, and none of them is the chevron itself:
 *
 *   1. Expansion was never persisted. Every launch collapsed the whole tree
 *      back to "roots open", which in a deep library means re-opening the
 *      same four folders every time. Every other list preference in this app
 *      is remembered - column widths, sort, the Settings sections.
 *
 *   2. Collapsing a folder you are INSIDE did not stick. The reveal effect
 *      re-added every ancestor of the selection and ran on [trees, selection],
 *      and `trees` gets a fresh identity on every rescan - so the next rescan
 *      sprang it back open. Roots were guarded against exactly this with a
 *      seededRoots ref; the ancestor path never was.
 *
 *   3. A folder the scan stopped short of looked like a leaf. LibraryFolder
 *      carries `deeper` for precisely this, LibraryView already prints a
 *      global note about it, and the tree ignored the flag - so a folder with
 *      contents was drawn identically to one without.
 */

const KEY = "saucebunny.libraryTreeExpanded";

function folder(
  name: string, folders: LibraryFolder[] = [], deeper = false, path = `/lib/${name}`,
): LibraryFolder {
  return { name, path, folders, items: [], deeper };
}

const TREES = [
  folder("Root", [
    folder("Inner", [folder("Leaf", [], false, "/lib/Leaf")], false, "/lib/Inner"),
    folder("Capped", [], true, "/lib/Capped"),
  ], false, "/lib/Root"),
];

const CHAIN: LibraryCrumb[] = [
  { name: "Root", path: "/lib/Root" },
  { name: "Inner", path: "/lib/Inner" },
];

function draw(over: Partial<Parameters<typeof LibraryTree>[0]> = {}) {
  return render(
    <LibraryTree
      trees={TREES}
      selection={CHAIN}
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
      {...over}
    />,
  );
}

const row = (name: string) => screen.getByRole("treeitem", { name: new RegExp(name) });
const twisty = (name: string) => row(name).querySelector(".cp-lib-tree-tw")!;

beforeEach(() => { localStorage.clear(); });
afterEach(() => { cleanup(); localStorage.clear(); });

describe("library tree disclosure", () => {
  it("opens roots and the ancestors of the current selection", () => {
    draw();
    expect(row("Root").getAttribute("aria-expanded")).toBe("true");
    expect(row("Inner").getAttribute("aria-expanded"), "the folder we are inside is not revealed").toBe("true");
  });

  it("remembers what was collapsed, across a remount", () => {
    const { unmount } = draw();
    fireEvent.click(twisty("Inner"));
    expect(row("Inner").getAttribute("aria-expanded")).toBe("false");
    expect(JSON.parse(localStorage.getItem(KEY) ?? "[]"), "nothing was written").not.toContain("/lib/Inner");

    unmount();
    draw();
    expect(row("Inner").getAttribute("aria-expanded"), "a collapsed folder re-opened on relaunch").toBe("false");
  });

  it("keeps a collapsed ancestor collapsed through a rescan", () => {
    // The bug: `trees` gets a new identity on every rescan, the reveal effect
    // ran on it, and it re-added every ancestor of the selection. So you
    // collapsed the folder you were inside and the next rescan re-opened it.
    const { rerender } = draw();
    fireEvent.click(twisty("Root"));
    expect(row("Root").getAttribute("aria-expanded")).toBe("false");

    // A rescan: same content, new identity, exactly as the scan produces.
    rerender(
      <LibraryTree
        trees={structuredClone(TREES)} selection={CHAIN} onSelect={() => {}}
        kind="all" onKind={() => {}} onCollapse={() => {}} addFolder={async () => {}}
        rescanAll={() => {}} scanning={false} removeRoot={() => {}} shelf={null}
        onSelectShelf={() => {}} dropOver={null}
      />,
    );
    expect(row("Root").getAttribute("aria-expanded"), "a rescan sprang the collapsed folder back open").toBe("false");
  });

  it("still reveals a NEW selection's ancestors", () => {
    // The fix must not kill the behaviour it is trimming: navigating to a
    // folder (from search, or a crumb) still has to open the way to it.
    const { rerender } = draw({ selection: null });
    fireEvent.click(twisty("Root"));
    expect(row("Root").getAttribute("aria-expanded")).toBe("false");

    rerender(
      <LibraryTree
        trees={TREES} selection={CHAIN} onSelect={() => {}}
        kind="all" onKind={() => {}} onCollapse={() => {}} addFolder={async () => {}}
        rescanAll={() => {}} scanning={false} removeRoot={() => {}} shelf={null}
        onSelectShelf={() => {}} dropOver={null}
      />,
    );
    expect(row("Root").getAttribute("aria-expanded"), "navigating into a folder did not reveal it").toBe("true");
  });

  it("marks a folder the scan stopped short of, instead of drawing a leaf", () => {
    draw();
    const capped = row("Capped");
    // Not expandable - there is nothing loaded to show - but not silent
    // either. LibraryView already prints a global note; this is the row that
    // note is about.
    expect(capped.hasAttribute("aria-expanded")).toBe(false);
    const tw = capped.querySelector(".cp-lib-tree-tw")!;
    expect(tw.className, "a capped folder is drawn exactly like a leaf").toContain("deeper");
    expect(capped.getAttribute("title") ?? "", "nothing says why it will not open").toMatch(/deeper/i);
  });

  it("a real leaf stays a leaf", () => {
    draw();
    expect(row("Leaf").hasAttribute("aria-expanded")).toBe(false);
    expect(row("Leaf").querySelector(".cp-lib-tree-tw")!.className).not.toContain("deeper");
  });
});
