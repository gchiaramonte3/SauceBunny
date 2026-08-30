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
    expect(JSON.parse(localStorage.getItem(KEY) ?? "null")).toEqual(DEFAULTS);
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
