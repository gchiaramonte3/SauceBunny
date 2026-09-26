// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CUT_MARKERS_CHANGED_EVENT, loadCutMarkers, saveCutMarkers } from "./cut-markers";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

it("rejects corrupt entries, normalizes microseconds, sorts and deduplicates", () => {
  localStorage.setItem("saucebunny.cutMarkers.source", JSON.stringify([
    null, "bad", { time: "1" }, { time: -1 }, { time: 0 }, { time: 1e-9 },
    { time: 2 }, { time: 1.5000021 }, { time: 1.500002 }, { time: Number.MAX_VALUE },
  ]));
  expect(loadCutMarkers("source")).toEqual([{ time: 1.500002 }, { time: 2 }]);
});

it("uses source-scoped normalized keys and notifies only after a verified save", () => {
  const changed = vi.fn();
  window.addEventListener(CUT_MARKERS_CHANGED_EVENT, changed);
  try {
    expect(saveCutMarkers("caf\u00e9", [{ time: 1.500002 }])).toBe(true);
    expect(loadCutMarkers("cafe\u0301")).toEqual([{ time: 1.500002 }]);
    expect(loadCutMarkers("other")).toEqual([]);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed.mock.calls[0][0].detail).toEqual({ sourceKey: "caf\u00e9" });
    vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("quota"); });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(saveCutMarkers("caf\u00e9", [{ time: 2 }])).toBe(false);
    expect(loadCutMarkers("caf\u00e9")).toEqual([{ time: 1.500002 }]);
    expect(changed).toHaveBeenCalledTimes(1);
  } finally { window.removeEventListener(CUT_MARKERS_CHANGED_EVENT, changed); }
});
