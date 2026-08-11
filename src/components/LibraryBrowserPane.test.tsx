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
