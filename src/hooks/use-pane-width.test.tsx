// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { usePaneWidth } from "./use-pane-width";

const KEY = "saucebunny.test.paneWidth";
const key = (k: string, shiftKey = false) => ({ key: k, shiftKey, preventDefault: () => undefined }) as unknown as React.KeyboardEvent;
const press = (x: number, y = 0) => ({ clientX: x, clientY: y, preventDefault: () => undefined }) as unknown as React.MouseEvent;
const move = (x: number, y = 0) => document.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y }));
const release = () => document.dispatchEvent(new MouseEvent("mouseup"));

beforeEach(() => localStorage.clear());
afterEach(() => document.body.classList.remove("cp-resizing-ew", "cp-resizing-ns"));

it("a left pane grows to the right, clamps, and stores only a size the user chose", () => {
  const { result } = renderHook(() => usePaneWidth({ key: KEY, min: 200, max: 400, fallback: 300 }));
  expect(result.current.width).toBe(300);
  // The default is not written down, so a later default is not frozen out.
  expect(localStorage.getItem(KEY)).toBeNull();
  act(() => result.current.onMouseDown(press(100)));
  expect(document.body.classList.contains("cp-resizing-ew")).toBe(true);
  act(() => move(150));
  expect(result.current.width).toBe(350);
  act(() => move(900));
  expect(result.current.width).toBe(400);
  act(() => release());
  expect(document.body.classList.contains("cp-resizing-ew")).toBe(false);
  expect(localStorage.getItem(KEY)).toBe("400");
});

it("a right pane grows to the left, and Home puts the default back by storing nothing", () => {
  localStorage.setItem(KEY, "320");
  const { result } = renderHook(() => usePaneWidth({ key: KEY, min: 200, max: 400, fallback: 300, side: "right" }));
  expect(result.current.width).toBe(320);
  act(() => result.current.onKeyDown(key("ArrowLeft")));
  expect(result.current.width).toBe(328);
  act(() => result.current.onKeyDown(key("ArrowRight", true)));
  expect(result.current.width).toBe(296);
  act(() => result.current.onKeyDown(key("Home")));
  expect(result.current.width).toBe(300);
  expect(result.current.chosen).toBe(false);
  expect(localStorage.getItem(KEY)).toBeNull();
});

it("a bottom pane is sized by height: dragging up or Up grows it, with the vertical cursor", () => {
  const { result } = renderHook(() => usePaneWidth({ key: KEY, min: 160, max: 900, fallback: 280, side: "bottom" }));
  act(() => result.current.onMouseDown(press(500, 600)));
  expect(document.body.classList.contains("cp-resizing-ns")).toBe(true);
  act(() => move(900, 540));
  expect(result.current.width).toBe(340);
  act(() => release());
  act(() => result.current.onKeyDown(key("ArrowUp")));
  expect(result.current.width).toBe(348);
  act(() => result.current.onKeyDown(key("ArrowDown")));
  expect(result.current.width).toBe(340);
  // Left and Right do not move a horizontal divider.
  act(() => result.current.onKeyDown(key("ArrowRight")));
  expect(result.current.width).toBe(340);
});

it("starts a drag or a nudge from the size as drawn when CSS holds the pane below the stored one", () => {
  localStorage.setItem(KEY, "600");
  const { result } = renderHook(() => usePaneWidth({ key: KEY, min: 280, max: 640, fallback: 340, measure: () => 420 }));
  act(() => result.current.onKeyDown(key("ArrowRight")));
  expect(result.current.width).toBe(428);
  act(() => result.current.onMouseDown(press(100)));
  act(() => move(110));
  expect(result.current.width).toBe(430);
  act(() => release());
});

it("ignores a stored size outside the bounds", () => {
  localStorage.setItem(KEY, "9999");
  const { result } = renderHook(() => usePaneWidth({ key: KEY, min: 200, max: 400, fallback: 300 }));
  expect(result.current.width).toBe(300);
  expect(result.current.chosen).toBe(false);
});
