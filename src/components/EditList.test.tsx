// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { EditSummary } from "../bindings/EditSummary";
import { EditList, editedGroup, editedLabel } from "./EditList";
import { EditStrip, stripBars } from "./EditStrip";

afterEach(cleanup);

const edit = (id: string, title: string, updated: number, patch: Partial<EditSummary> = {}): EditSummary => ({
  id, title, created_at: 1, updated_at: updated, head: 1, states: 4, sources: ["OPPONENT SELECTION"], duration_frames: 24 * 252, bites: 24, bite_frames: [],
  edit_rate: { numerator: 24, denominator: 1 }, ...patch,
});

it("lists newest first with what each is cut from, how long it plays and its bites, and opens one", () => {
  const onOpen = vi.fn();
  render(<EditList edits={[edit("old", "First pass", 1_000), edit("new", "Record test", 2_000, { sources: ["HEAT 1", "HEAT 2"], bites: 1 })]} onOpen={onOpen} />);
  const rows = screen.getAllByRole("button", { name: /edited/ });
  expect(rows.map((row) => row.getAttribute("aria-label")?.split(",")[0])).toEqual(["Record test", "First pass"]);
  expect(rows[0].getAttribute("aria-label")).toMatch(/^Record test, cut from 2 sequences, plays 4:12, 1 bite, edited /);
  expect(rows[1].textContent).toContain("OPPONENT SELECTION");
  expect(rows[1].textContent).toContain("4:12");
  fireEvent.click(rows[1]);
  expect(onOpen).toHaveBeenCalledWith("old");
});

it("finds by name or by sequence, and says when nothing matches", () => {
  render(<EditList edits={[edit("a", "Twins", 2, { sources: ["PLANK HEAT 1"] }), edit("b", "Captains", 1)]} onOpen={() => undefined} />);
  const search = screen.getByRole("searchbox", { name: "Find a string out" });
  fireEvent.change(search, { target: { value: "plank" } });
  expect(screen.getAllByRole("button", { name: /edited/ }).map((row) => row.getAttribute("aria-label")?.split(",")[0])).toEqual(["Twins"]);
  fireEvent.change(search, { target: { value: "nobody" } });
  expect(screen.getByRole("status").textContent).toBe("No string out matches “nobody”.");
  fireEvent.keyDown(search, { key: "Escape" });
  expect(screen.getAllByRole("button", { name: /edited/ })).toHaveLength(2);
});

it("dates by the calendar day, and gives the year only when it is not this one", () => {
  const now = new Date(2026, 9, 7, 9, 0);
  expect(editedLabel(new Date(2026, 9, 7, 1, 0).getTime(), now)).toMatch(/^Today, /);
  expect(editedLabel(new Date(2026, 9, 6, 23, 50).getTime(), now)).toMatch(/^Yesterday, /);
  expect(editedLabel(new Date(2026, 9, 5, 13, 31).getTime(), now)).toMatch(/^Oct 5, /);
  expect(editedLabel(new Date(2025, 8, 28, 8, 16).getTime(), now)).toBe("Sep 28, 2025");
});

it("files rows under the day they were last edited, and arrows walk across the groups", () => {
  const now = Date.now(), day = 86_400_000;
  render(<EditList edits={[edit("a", "Fresh", now), edit("b", "Older", now - 40 * day), edit("c", "Also fresh", now - 1)]} onOpen={() => undefined} />);
  expect(screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent)).toEqual(["Today", editedGroup(now - 40 * day)]);
  const rows = screen.getAllByRole("button", { name: /edited/ });
  rows[0].focus();
  fireEvent.keyDown(rows[0], { key: "ArrowDown" });
  fireEvent.keyDown(rows[1], { key: "ArrowDown" });
  expect(document.activeElement).toBe(rows[2]);
  fireEvent.keyDown(rows[2], { key: "Home" });
  expect(document.activeElement).toBe(rows[0]);
});

it("names the group by recency, then by month, with the year only when it is not this one", () => {
  const now = new Date(2026, 9, 7, 9, 0);
  expect(editedGroup(new Date(2026, 9, 7, 0, 5).getTime(), now)).toBe("Today");
  expect(editedGroup(new Date(2026, 9, 6, 23, 0).getTime(), now)).toBe("Yesterday");
  expect(editedGroup(new Date(2026, 9, 1, 12, 0).getTime(), now)).toBe("Previous 7 days");
  expect(editedGroup(new Date(2026, 8, 28, 12, 0).getTime(), now)).toMatch(/^September$/);
  expect(editedGroup(new Date(2025, 8, 28, 12, 0).getTime(), now)).toMatch(/^September 2025$/);
});

it("draws a cut to scale, folding a long one into runs that keep its total", () => {
  expect(stripBars([48, 0, 96])).toEqual([48, 1, 96]);
  const long = Array.from({ length: 64 }, (_, index) => index + 1);
  const runs = stripBars(long);
  expect(runs.length).toBeLessThanOrEqual(28);
  expect(runs.reduce((sum, length) => sum + length, 0)).toBe(long.reduce((sum, length) => sum + length, 0));
  const { container, rerender } = render(<EditStrip frames={[24, 48]} bites={2} />);
  const strip = container.querySelector(".cp-te-shelf-cut");
  expect(strip?.children).toHaveLength(2);
  expect((strip?.children[1] as HTMLElement).style.getPropertyValue("--te-bite")).toBe("48");
  rerender(<EditStrip frames={[]} bites={0} />);
  expect(container.querySelector(".cp-te-shelf-cut")?.classList.contains("is-empty")).toBe(true);
});
