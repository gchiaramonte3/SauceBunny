// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ShotCutAction } from "./ShotCutAction";
import { loadChapters, saveChapters } from "../lib/chapters";
import { loadCutMarkers, saveCutMarkers } from "../lib/cut-markers";
import type { SceneEvidence } from "../lib/scene-analysis/evidence";

// Presentation fixture only; evidence validation and time mapping have their
// own real adapter tests. No worker/model job runs in this component test.
const evidence = { shots: [{ start_us: 0 }, { start_us: 1_500_002 }] } as unknown as SceneEvidence;
beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it("requires a click, preserves creator chapters, and adds exact source-time markers once", () => {
  const changed = vi.fn();
  saveChapters("source", [{ time: 0, title: "Creator opening", origin: "creator" }]);
  render(<ShotCutAction evidence={evidence} sourceKey="source" onCutMarkersChanged={changed} />);
  expect(loadChapters("source")).toHaveLength(1);
  expect(loadCutMarkers("source")).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Add cut markers" }));
  expect(loadChapters("source")).toEqual([
    { time: 0, title: "Creator opening", origin: "creator" },
  ]);
  expect(loadCutMarkers("source")).toEqual([{ time: 1.500002 }]);
  expect(changed).toHaveBeenCalledTimes(1);
  expect(changed).toHaveBeenLastCalledWith({ sourceKey: "source", addedCount: 1 });
  expect(screen.queryByRole("status")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add cut markers" }));
  expect(loadCutMarkers("source")).toHaveLength(1);
  expect(changed).toHaveBeenCalledTimes(2);
  expect(changed).toHaveBeenLastCalledWith({ sourceKey: "source", addedCount: 0 });
  expect(screen.queryByRole("status")).toBeNull();
});

it("reads edits made after render instead of replacing them with a stale snapshot", () => {
  render(<ShotCutAction evidence={evidence} sourceKey="source" />);
  saveChapters("source", [{ time: .5, title: "New user chapter" }]);
  saveCutMarkers("source", [{ time: .75 }]);
  fireEvent.click(screen.getByRole("button", { name: "Add cut markers" }));
  expect(loadChapters("source").map(chapter => chapter.title)).toEqual(["New user chapter"]);
  expect(loadCutMarkers("source")).toEqual([{ time: .75 }, { time: 1.500002 }]);
  expect(loadCutMarkers("unrelated")).toEqual([]);
});

it("does not claim success or notify the detached panel when persistence fails", () => {
  const changed = vi.fn();
  vi.spyOn(localStorage, "setItem").mockImplementation(() => { throw new Error("quota"); });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  render(<ShotCutAction evidence={evidence} sourceKey="source" onCutMarkersChanged={changed} />);
  fireEvent.click(screen.getByRole("button", { name: "Add cut markers" }));
  expect(screen.getByRole("alert").textContent).toContain("Couldn't save");
  expect(changed).not.toHaveBeenCalled();
});

it("does not offer to mark the opening shot as a cut", () => {
  render(<ShotCutAction evidence={{ ...evidence, shots: evidence.shots.slice(0, 1) }} sourceKey="source" />);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Add cut markers" }).disabled).toBe(true);
  expect(loadCutMarkers("source")).toEqual([]);
});
