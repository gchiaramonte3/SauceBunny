import { describe, expect, it } from "vitest";
import { activate, closeTab, columnOf, defaultDock, moveTab, neighbour, openTab, sourceTab } from "./transcript-editor-dock";

describe("transcript editor dock", () => {
  it("moves a tab to another column and shows it there, leaving a neighbour showing where it was", () => {
    const dock = moveTab(defaultDock(), "inspector", "left");
    expect(dock.left).toEqual({ tabs: ["library", "inspector"], active: "inspector" });
    expect(dock.right).toEqual({ tabs: ["ask"], active: "ask" });
  });

  it("drops a tab at a position, and reordering within a column counts the gap it leaves", () => {
    let dock = moveTab(defaultDock(), "ask", "left", 0);
    expect(dock.left.tabs).toEqual(["ask", "library"]);
    dock = moveTab(dock, "ask", "left", 2);
    expect(dock.left.tabs).toEqual(["library", "ask"]);
  });

  it("keeps the edit in the column that fills the window", () => {
    const dock = defaultDock();
    expect(moveTab(dock, "edit", "left")).toBe(dock);
    expect(moveTab(moveTab(dock, "ask", "record"), "edit", "record", 2).record.tabs).toEqual(["ask", "edit"]);
  });

  it("opens sources as tabs beside the ones already open, wherever those have been moved", () => {
    let dock = openTab(defaultDock(), sourceTab("mg1"), "source");
    expect(dock.source).toEqual({ tabs: [sourceTab("mg3"), sourceTab("mg1")], active: sourceTab("mg1") });
    dock = moveTab(moveTab(dock, sourceTab("mg3"), "right"), sourceTab("mg1"), "right");
    dock = openTab(dock, sourceTab("itm"), "source");
    expect(columnOf(dock, sourceTab("itm"))).toBe("right");
    expect(openTab(dock, sourceTab("itm"), "source")).toEqual(dock);
  });

  it("closes only what can be opened again, and an emptied column shows nothing", () => {
    const dock = closeTab(defaultDock(), sourceTab("mg3"));
    expect(dock.source).toEqual({ tabs: [], active: null });
    expect(closeTab(dock, "inspector")).toBe(dock);
    expect(activate(dock, "ask").right.active).toBe("ask");
  });

  it("finds the column beside another for keyboard moves", () => {
    expect(neighbour("left", -1)).toBeNull();
    expect(neighbour("source", 1)).toBe("record");
  });
});
