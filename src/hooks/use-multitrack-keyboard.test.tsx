// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createFrameStore } from "../lib/frame-store";
import { useMultitrackKeyboard } from "./use-multitrack-keyboard";

const press = (key: string, init: KeyboardEventInit = {}) => window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));

function setup() {
  const controls = { frames: createFrameStore(500), pause: vi.fn(), toggle: vi.fn(), shuttle: vi.fn(), seek: vi.fn(async () => {}) };
  const marks = { markIn: vi.fn(), markOut: vi.fn(), clear: vi.fn(), clearIn: vi.fn(), clearOut: vi.fn(), gotoIn: vi.fn(), gotoOut: vi.fn() };
  const view = { zoom: vi.fn(), duration: 24000 };
  const hook = renderHook(() => useMultitrackKeyboard(true, controls, undefined, marks, view));
  return { controls, marks, view, hook };
}
afterEach(() => vi.restoreAllMocks());

it("zooms with ⌘= and ⌘−, fits with ⇧Z, and goes to either end with Home and End, as String Outs does", () => {
  const { controls, view, hook } = setup();
  press("=", { metaKey: true }); press("-", { metaKey: true }); press("Z", { shiftKey: true });
  expect(view.zoom.mock.calls).toEqual([[1], [-1], [0]]);
  press("Home"); press("End");
  expect(controls.seek.mock.calls).toEqual([[0, undefined, false], [23999, undefined, false]]);
  // Any other ⌘ chord is left to the app.
  press("s", { metaKey: true });
  expect(controls.seek).toHaveBeenCalledTimes(2);
  hook.unmount();
});

it("reads the mark keys as plain letters only: ⇧I is not a mark", () => {
  const { marks, hook } = setup();
  press("I", { shiftKey: true }); press("O", { shiftKey: true });
  expect(marks.markIn).not.toHaveBeenCalled();
  press("i"); press("o");
  expect([marks.markIn, marks.markOut].map((mark) => mark.mock.calls.length)).toEqual([1, 1]);
  hook.unmount();
});
