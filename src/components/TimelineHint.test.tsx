// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TimelineHint } from "./TimelineHint";
import { announceCutMarkers, CUT_MARKERS_CHANGED_EVENT } from "../lib/cut-markers";

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });
const announce = (addedCount: number, sourceKey = "source") => act(() => announceCutMarkers({ sourceKey, addedCount }));

it("temporarily borrows the existing hint and restores its latest text after three seconds", () => {
  const { rerender } = render(<TimelineHint sourceKey="source">No marks set.</TimelineHint>);
  expect(screen.getByRole("status").textContent).toBe("");
  announce(12);
  expect(screen.getByRole("status").textContent).toBe("Added 12 cut markers");
  expect(screen.getByText("No marks set.").getAttribute("aria-hidden")).toBe("true");
  rerender(<TimelineHint sourceKey="source">Mark out (O) to set the end.</TimelineHint>);
  act(() => vi.advanceTimersByTime(2999));
  expect(screen.getByRole("status").textContent).toContain("Added 12");
  act(() => vi.advanceTimersByTime(1));
  expect(screen.getByRole("status").textContent).toBe("");
  expect(screen.getByText("Mark out (O) to set the end.").getAttribute("aria-hidden")).toBe("false");
});

it("repeated clicks restart one confirmation lifetime without an old timer clearing the new message", () => {
  render(<TimelineHint sourceKey="source">Hint</TimelineHint>);
  announce(1);
  act(() => vi.advanceTimersByTime(2500));
  announce(0);
  expect(screen.getByRole("status").textContent).toBe("Cut markers already added");
  expect(vi.getTimerCount()).toBe(1);
  act(() => vi.advanceTimersByTime(500));
  expect(screen.getByRole("status").textContent).toBe("Cut markers already added");
  act(() => vi.advanceTimersByTime(2500));
  expect(screen.getByRole("status").textContent).toBe("");
});

it("never replays a confirmation across source changes, reloads or unmounts", () => {
  const { rerender, unmount } = render(<TimelineHint sourceKey="source">Hint</TimelineHint>);
  announce(1);
  rerender(<TimelineHint sourceKey="other">Other</TimelineHint>);
  expect(vi.getTimerCount()).toBe(0);
  expect(screen.getByRole("status").textContent).toBe("");
  announce(1);
  expect(screen.getByRole("status").textContent).toBe("");
  rerender(<TimelineHint sourceKey="source">Hint</TimelineHint>);
  expect(screen.getByRole("status").textContent).toBe("");
  announce(1);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
  announce(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("ignores passive storage reloads and invalid or unscoped detached notifications", () => {
  render(<TimelineHint sourceKey="source">Hint</TimelineHint>);
  for (const detail of [null, {}, { sourceKey: "source" }, { sourceKey: "other", addedCount: 1 },
    ...[-1, .5, NaN, Infinity, "2"].map(addedCount => ({ sourceKey: "source", addedCount }))]) {
    act(() => window.dispatchEvent(new CustomEvent(CUT_MARKERS_CHANGED_EVENT, { detail })));
  }
  expect(screen.getByRole("status").textContent).toBe("");
  expect(vi.getTimerCount()).toBe(0);
});
