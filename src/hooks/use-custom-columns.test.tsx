// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useCustomColumns } from "./use-custom-columns";
import { COLUMNS_KEY, VALUES_KEY } from "../lib/custom-columns";

type Seen = ReturnType<typeof useCustomColumns>;
let seen: Seen | null = null;

function Probe() {
  seen = useCustomColumns();
  return <div />;
}

beforeEach(() => { localStorage.clear(); seen = null; cleanup(); });

describe("custom columns, wired up", () => {
  it("writes a new column through to storage", () => {
    render(<Probe />);
    act(() => seen?.add("Scene"));
    expect(seen?.columns.map((c) => c.label)).toEqual(["Scene"]);
    expect(JSON.parse(localStorage.getItem(COLUMNS_KEY) ?? "[]")).toHaveLength(1);
  });

  it("keeps a value against the clip that carries it", () => {
    render(<Probe />);
    act(() => seen?.add("Scene"));
    const id = seen!.columns[0].id;
    act(() => seen?.setValue("/a.mov", id, "12A"));
    expect(seen?.valueFor("/a.mov", id)).toBe("12A");
    expect(seen?.valueFor("/b.mov", id)).toBe("");
    expect(JSON.parse(localStorage.getItem(VALUES_KEY) ?? "{}")).toEqual({ "/a.mov": { [id]: "12A" } });
  });

  it("a rename keeps what was typed", () => {
    render(<Probe />);
    act(() => seen?.add("Scene"));
    const id = seen!.columns[0].id;
    act(() => seen?.setValue("/a.mov", id, "12A"));
    act(() => seen?.rename(id, "Sc."));
    expect(seen?.columns[0].label).toBe("Sc.");
    expect(seen?.valueFor("/a.mov", id)).toBe("12A");
  });

  it("deleting a column takes its values with it, and only its own", () => {
    render(<Probe />);
    act(() => seen?.add("Scene"));
    act(() => seen?.add("Take"));
    const [scene, take] = seen!.columns;
    act(() => seen?.setValue("/a.mov", scene.id, "12A"));
    act(() => seen?.setValue("/a.mov", take.id, "3"));
    act(() => seen?.remove(scene.id));
    expect(seen?.columns.map((c) => c.label)).toEqual(["Take"]);
    expect(seen?.valueFor("/a.mov", scene.id)).toBe("");
    // The one that survives has to actually survive. A prune that took
    // everything would satisfy the assertion above and be silently wrong.
    expect(seen?.valueFor("/a.mov", take.id)).toBe("3");
  });

  it("a renamed file keeps its metadata", () => {
    render(<Probe />);
    act(() => seen?.add("Scene"));
    const id = seen!.columns[0].id;
    act(() => seen?.setValue("/x/old.mov", id, "12A"));
    act(() => seen?.repath("/x/old.mov", "/x/new.mov"));
    expect(seen?.valueFor("/x/new.mov", id)).toBe("12A");
    expect(seen?.valueFor("/x/old.mov", id)).toBe("");
  });

  it("reloads what a previous session wrote", () => {
    render(<Probe />);
    act(() => seen?.add("Scene"));
    const id = seen!.columns[0].id;
    act(() => seen?.setValue("/a.mov", id, "12A"));
    cleanup();
    render(<Probe />);
    expect(seen?.columns[0].id).toBe(id);
    expect(seen?.valueFor("/a.mov", id)).toBe("12A");
  });
});
