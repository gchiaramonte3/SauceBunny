// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { LibraryBrowserPane } from "./LibraryBrowserPane";
import type { LibraryItem } from "../types";

vi.mock("../hooks/use-lazy-thumbnails", () => ({ useLazyThumbnails: () => [] }));

afterEach(cleanup);

/**
 * The modifier keys have to survive the trip from the DOM event to the
 * selection rule. Reported twice as "shift click is missing" and invisible to
 * every existing test, because the RULE is unit-tested in isolation and the
 * plumbing that feeds it never was.
 */

const items: LibraryItem[] = ["a", "b", "c"].map((n) => ({
  name: `${n}.mp4`, path: `/m/${n}.mp4`, size_bytes: 1, modified_ms: 0, kind: "video",
} as LibraryItem));

/** The pane's required props, minus what a case is varying. Extracted so the
 *  folder-tile cases below can spread it instead of restating fifteen props. */
const baseProps = {
  view: "grid" as const,
  selectedPath: null,
  posterVersions: {},
  requestThumb: async () => null,
  onOpen: vi.fn(),
  onSelectItem: vi.fn(),
  onChoosePoster: vi.fn(),
  onResetPoster: vi.fn(),
  onClearSelection: vi.fn(),
  emptyText: "",
  sort: "name" as const,
  dir: "asc" as const,
  onSort: vi.fn(),
};

function mount(view: "grid" | "list") {
  const onSelectItem = vi.fn();
  render(
    <LibraryBrowserPane
      items={items}
      view={view}
      selectedPath={null}
      posterVersions={{}}
      requestThumb={async () => null}
      onOpen={vi.fn()}
      onSelectItem={onSelectItem}
      onChoosePoster={vi.fn()}
      onResetPoster={vi.fn()}
      onClearSelection={vi.fn()}
      emptyText=""
      sort="name"
      dir="asc"
      onSort={vi.fn()}
    />,
  );
  return onSelectItem;
}

const rowsIn = (view: "grid" | "list") =>
  [...document.querySelectorAll(view === "grid" ? ".cp-lib-card" : ".cp-lib-lrow")] as HTMLElement[];

for (const view of ["grid", "list"] as const) {
  describe(`${view} view carries modifiers to the selection rule`, () => {
    it("passes shiftKey through on a shift-click", () => {
      const onSelectItem = mount(view);
      fireEvent.click(rowsIn(view)[1], { shiftKey: true });
      expect(onSelectItem).toHaveBeenCalledTimes(1);
      const [item, e] = onSelectItem.mock.calls[0];
      expect(item.path).toBe("/m/b.mp4");
      expect(e.shiftKey).toBe(true);
    });

    it("passes metaKey through on a command-click", () => {
      const onSelectItem = mount(view);
      fireEvent.click(rowsIn(view)[2], { metaKey: true });
      expect(onSelectItem.mock.calls[0][1].metaKey).toBe(true);
    });

    it("reports no modifiers on a plain click", () => {
      const onSelectItem = mount(view);
      fireEvent.click(rowsIn(view)[0], {});
      const e = onSelectItem.mock.calls[0][1];
      expect(e.shiftKey).toBe(false);
      expect(e.metaKey).toBe(false);
    });

    it("renders one selectable element per item", () => {
      mount(view);
      expect(rowsIn(view)).toHaveLength(3);
    });

    it("gives every item a data-path, which the marquee hit-tests on", () => {
      mount(view);
      expect(rowsIn(view).map((el) => el.getAttribute("data-path")))
        .toEqual(["/m/a.mp4", "/m/b.mp4", "/m/c.mp4"]);
    });
  });
}

describe("folders as containers in the browse pane", () => {
  const folder = (name: string, items: unknown[] = []) => ({
    name, path: `/lib/${name}`, folders: [], items,
  });
  const file = (name: string) => ({
    name, path: `/lib/${name}`, kind: "video", size_bytes: 1, modified_ms: 1,
  });

  it("renders subfolders as tiles ABOVE the files", async () => {
    render(
      <LibraryBrowserPane
        {...baseProps}
        folders={[folder("Selects"), folder("Rejects")] as never}
        items={[file("a.mov")] as never}
      />,
    );
    const cards = [...document.querySelectorAll(".cp-lib-card")];
    expect(cards.length).toBe(3);
    // Containers first: the roving grid's `names` list assumes this order.
    expect(cards[0].className).toContain("cp-lib-foldercard");
    expect(cards[1].className).toContain("cp-lib-foldercard");
    expect(cards[2].className).not.toContain("cp-lib-foldercard");
  });

  it("the roving grid's names line up with the rendered cards", async () => {
    // THE silent bug this guards: useRovingGrid takes `names` from props but
    // reads elements from querySelectorAll(".cp-lib-card"), and folder cards
    // share that class. A mismatch does not throw - type-ahead just jumps to
    // the wrong tile. So assert the two lists agree, by index.
    render(
      <LibraryBrowserPane
        {...baseProps}
        folders={[folder("Selects")] as never}
        items={[file("alpha.mov"), file("beta.mov")] as never}
      />,
    );
    const rendered = [...document.querySelectorAll(".cp-lib-card")]
      .map((el) => el.getAttribute("title") ?? el.textContent ?? "");
    expect(rendered[0]).toContain("Selects");
    expect(rendered[1]).toContain("alpha.mov");
    expect(rendered[2]).toContain("beta.mov");
  });

  it("opening a folder tile calls back with that folder", async () => {
    const opened: string[] = [];
    render(
      <LibraryBrowserPane
        {...baseProps}
        folders={[folder("Selects")] as never}
        items={[] as never}
        onOpenFolder={(f: { name: string }) => opened.push(f.name)}
      />,
    );
    (document.querySelector(".cp-lib-foldercard") as HTMLButtonElement).click();
    expect(opened).toEqual(["Selects"]);
  });
});
