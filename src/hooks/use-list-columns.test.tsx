// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useListColumns } from "./use-list-columns";

/**
 * This was three near-verbatim copies (FrameListRows, WebListRows,
 * LibraryBrowserPane) and had no test at any of them. Extracting it is what
 * made one possible; these are the behaviours the copies encoded and nothing
 * checked.
 */
const KEY = "test.cols";
const DEFAULTS = { source: 120, size: 84, date: 96 };

type Seen = ReturnType<typeof useListColumns<keyof typeof DEFAULTS>>;
let seen: Seen | null = null;

function Probe({ defaults = DEFAULTS }: { defaults?: typeof DEFAULTS }) {
  seen = useListColumns(KEY, defaults);
  return <div />;
}

beforeEach(() => { localStorage.clear(); seen = null; });
afterEach(cleanup);

describe("persisted list columns", () => {
  it("starts at the defaults and writes them through", () => {
    render(<Probe />);
    expect(seen?.cols).toEqual(DEFAULTS);
    // The stored shape is {w, order, hidden} now. v1 wrote the bare width
    // map and is still READ, which the migration test below covers.
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toEqual({
      w: DEFAULTS, order: Object.keys(DEFAULTS), hidden: [],
    });
  });

  it("reads a v1 store, which is the bare width map", () => {
    // Every existing install has widths under the flat shape. Discarding them
    // to add ordering would trade a saved preference for a new feature.
    localStorage.setItem(KEY, JSON.stringify({ ...DEFAULTS, size: 150 }));
    render(<Probe />);
    expect(seen?.cols.size).toBe(150);
    expect(seen?.order).toEqual(Object.keys(DEFAULTS));
    expect(seen?.visible).toEqual(Object.keys(DEFAULTS));
  });

  it("appends a column the stored order never knew about", () => {
    // What happens when a build ADDS a column: an order saved before it
    // existed must not make the new one permanently invisible.
    localStorage.setItem(KEY, JSON.stringify({ w: DEFAULTS, order: ["date", "source"], hidden: [] }));
    render(<Probe />);
    expect(seen?.order).toEqual(["date", "source", "size"]);
  });

  it("hides and shows a column, and the template follows", () => {
    render(<Probe />);
    const before = seen?.template ?? "";
    act(() => seen?.toggleCol("size"));
    expect(seen?.visible).toEqual(["source", "date"]);
    expect(seen?.template, "a hidden column still reserves its track").not.toContain("84px");
    act(() => seen?.toggleCol("size"));
    expect(seen?.template).toBe(before);
  });

  it("refuses to hide the last visible column", () => {
    // The menu that turns one back on is opened FROM a header cell, so a list
    // with none is stranded.
    render(<Probe />);
    act(() => seen?.toggleCol("size"));
    act(() => seen?.toggleCol("date"));
    act(() => seen?.toggleCol("source"));
    expect(seen?.visible.length, "hid every column").toBe(1);
  });

  it("reorders, and the template reorders with it", () => {
    render(<Probe />);
    act(() => seen?.moveCol("date", 0));
    expect(seen?.order).toEqual(["date", "source", "size"]);
    expect(seen?.template).toBe("34px minmax(0, 1fr) 96px 120px 84px");
  });

  it("drops a stored hidden set that would leave nothing visible", () => {
    localStorage.setItem(KEY, JSON.stringify({ w: DEFAULTS, order: ["source", "size", "date"], hidden: ["source", "size", "date"] }));
    render(<Probe />);
    expect(seen?.visible.length).toBe(3);
  });

  it("restores a stored width", () => {
    localStorage.setItem(KEY, JSON.stringify({ ...DEFAULTS, size: 150 }));
    render(<Probe />);
    expect(seen?.cols.size).toBe(150);
  });

  it("takes the default for a width outside the bounds", () => {
    // Not clamped: 999 is a value this build would never have written, so
    // honouring it at 240 would be guessing at intent.
    localStorage.setItem(KEY, JSON.stringify({ source: 999, size: 2, date: 96 }));
    render(<Probe />);
    expect(seen?.cols.source).toBe(DEFAULTS.source);
    expect(seen?.cols.size).toBe(DEFAULTS.size);
    expect(seen?.cols.date, "a valid neighbour is still honoured").toBe(96);
  });

  it("survives a mangled value rather than throwing", () => {
    localStorage.setItem(KEY, "{not json");
    render(<Probe />);
    expect(seen?.cols).toEqual(DEFAULTS);
  });

  it("ignores a key the defaults do not declare", () => {
    // A width left behind by an older column set must not reappear as a
    // property of the current one.
    localStorage.setItem(KEY, JSON.stringify({ ...DEFAULTS, legacy: 200 }));
    render(<Probe />);
    expect(Object.keys(seen?.cols ?? {}).sort()).toEqual(["date", "size", "source"]);
  });

  it("nudges by keyboard, sharing the drag's clamp", () => {
    // The column was mouse-only: ColDivider had onMouseDown and no key
    // handler, so the width could not be changed by keyboard at all (2.1.1,
    // Level A). The clamp lives in the hook precisely so these two paths
    // cannot stop at different widths.
    render(<Probe />);
    act(() => { seen?.nudgeCol("size", 8); });
    expect(seen?.cols.size).toBe(92); // 84 + 8

    act(() => { seen?.nudgeCol("size", 9999); });
    expect(seen?.cols.size, "same maximum the drag clamps to").toBe(240);
    act(() => { seen?.nudgeCol("size", -9999); });
    expect(seen?.cols.size, "same minimum").toBe(48);
  });

  it("reports the bounds rather than making the divider retype them", () => {
    // aria-valuemin / aria-valuemax have to be the REAL bounds. A divider that
    // hardcodes 48 and 240 announces a lie the moment the hook changes.
    render(<Probe />);
    expect(seen?.bounds).toEqual({ min: 48, max: 240 });
  });

  it("drags a column, clamps it, and cleans up after itself", () => {
    render(<Probe />);
    act(() => {
      seen?.startColDrag("size")({
        preventDefault() {}, stopPropagation() {}, clientX: 100,
      } as unknown as React.MouseEvent);
    });
    expect(seen?.dragCol, "the divider needs to know it is active").toBe("size");
    // The body class is what gives the whole window a resize cursor; leaving
    // it behind is a stuck cursor over the entire app.
    expect(document.body.classList.contains("cp-resizing-ew")).toBe(true);

    act(() => { document.dispatchEvent(new MouseEvent("mousemove", { clientX: 140 })); });
    expect(seen?.cols.size).toBe(124); // 84 + 40

    act(() => { document.dispatchEvent(new MouseEvent("mousemove", { clientX: 9999 })); });
    expect(seen?.cols.size, "clamped at the maximum").toBe(240);
    act(() => { document.dispatchEvent(new MouseEvent("mousemove", { clientX: -9999 })); });
    expect(seen?.cols.size, "clamped at the minimum").toBe(48);

    act(() => { document.dispatchEvent(new MouseEvent("mouseup")); });
    expect(seen?.dragCol).toBeNull();
    expect(document.body.classList.contains("cp-resizing-ew")).toBe(false);

    // CANARY: the listeners are gone, not merely idle. A drag that keeps
    // listening resizes the column on every later mouse move in the app.
    const after = seen?.cols.size;
    act(() => { document.dispatchEvent(new MouseEvent("mousemove", { clientX: 500 })); });
    expect(seen?.cols.size).toBe(after);
  });
});
