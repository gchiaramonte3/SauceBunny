// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AafDocumentSummary } from "../bindings/AafDocumentSummary";

const state = vi.hoisted(() => ({ list: [] as AafDocumentSummary[], opened: [] as string[], changed: null as null | (() => void) }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown> = {}) => {
    if (cmd === "aaf_list") return state.list;
    if (cmd === "aaf_open") { state.opened.push(String(args.documentId)); return { id: args.documentId }; }
    throw new Error(`unexpected ${cmd}`);
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (event: string, handler: () => void) => { if (event === "saucebunny:multitrack-changed") state.changed = handler; return () => { state.changed = null; }; }),
}));

import { EditAddSource } from "./EditAddSource";

const sequence = (n: number, modified_ms = n * 1_000): AafDocumentSummary =>
  ({ id: `seq-${n}`, name: `Scene ${n}`, track_count: 3, transcribed_tracks: 1, source_path: `/fixtures/scene-${n}.aaf`, modified_ms });
const items = () => within(screen.getByRole("menu", { name: "Add a sequence" })).getAllByRole("menuitem").map((item) => item.querySelector(".lbl")?.textContent);
const openMenu = async () => {
  const trigger = screen.getByRole("button", { name: "Add sequence" });
  await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(trigger);
  return screen.getByRole("menu", { name: "Add a sequence" });
};

afterEach(cleanup);
beforeEach(() => { localStorage.clear(); state.list = []; state.opened = []; state.changed = null; });

it("lists the eight newest first, and the rest behind Show more", async () => {
  state.list = Array.from({ length: 11 }, (_, index) => sequence(index + 1));
  render(<EditAddSource exclude={["seq-11"]} onAdd={vi.fn()} onError={vi.fn()} />);
  await openMenu();
  // Already in the string out, so not offered; newest of the rest first.
  expect(items()).toEqual(["Scene 10", "Scene 9", "Scene 8", "Scene 7", "Scene 6", "Scene 5", "Scene 4", "Scene 3", "Show 2 more", "Clear list"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Show 2 more" }));
  expect(items().slice(-3)).toEqual(["Scene 2", "Scene 1", "Clear list"]);
  // The keyboard stays in the menu, on the first one that was just revealed.
  expect(document.activeElement?.textContent).toContain("Scene 2");
});

it("adds the sequence chosen, and names its file under it", async () => {
  state.list = [sequence(1), sequence(2)];
  const onAdd = vi.fn();
  render(<EditAddSource exclude={[]} onAdd={onAdd} onError={vi.fn()} />);
  await openMenu();
  const item = screen.getByRole("menuitem", { name: /Scene 1/ });
  expect(item.querySelector(".sub")?.textContent).toMatch(/^scene-1\.aaf · /);
  fireEvent.click(item);
  await waitFor(() => expect(onAdd).toHaveBeenCalledWith({ id: "seq-1" }));
  expect(screen.queryByRole("menu")).toBeNull();
});

it("removes one with × or Delete, keeps the keyboard on the next, and deletes nothing", async () => {
  state.list = [sequence(1), sequence(2), sequence(3)];
  render(<EditAddSource exclude={[]} onAdd={vi.fn()} onError={vi.fn()} />);
  await openMenu();
  fireEvent.click(screen.getByRole("button", { name: "Remove Scene 3 from this list" }));
  expect(items()).toEqual(["Scene 2", "Scene 1", "Clear list", "Show 1 hidden sequence"]);
  const second = screen.getByRole("menuitem", { name: /Scene 2/ });
  second.focus();
  fireEvent.keyDown(second, { key: "Backspace" });
  expect(items()).toEqual(["Scene 1", "Clear list", "Show 2 hidden sequences"]);
  expect(document.activeElement?.textContent).toContain("Scene 1");
  expect(state.opened).toEqual([]);
  expect(JSON.parse(localStorage.getItem("saucebunny.stringOuts.hiddenSequences")!)).toEqual({ "seq-3": 3_000, "seq-2": 2_000 });
});

it("clears the list, puts it back, and a cleared sequence returns when AAF Audio saves it again", async () => {
  state.list = [sequence(1), sequence(2)];
  render(<EditAddSource exclude={[]} onAdd={vi.fn()} onError={vi.fn()} />);
  await openMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "Clear list" }));
  expect(items()).toEqual(["Show 2 hidden sequences"]);
  expect(screen.getByText("Nothing else to add.")).toBeTruthy();
  fireEvent.click(screen.getByRole("menuitem", { name: "Show 2 hidden sequences" }));
  expect(items()).toEqual(["Scene 2", "Scene 1", "Clear list"]);
  fireEvent.click(screen.getByRole("menuitem", { name: "Clear list" }));
  // Scene 1 is saved again in AAF Audio: newer than when it was hidden.
  state.list = [sequence(1, 9_000), sequence(2)];
  await act(async () => { state.changed?.(); });
  await waitFor(() => expect(items()).toEqual(["Scene 1", "Clear list", "Show 1 hidden sequence"]));
});

it("can still open to bring sequences back when every one is hidden", async () => {
  state.list = [sequence(1)];
  localStorage.setItem("saucebunny.stringOuts.hiddenSequences", JSON.stringify({ "seq-1": 1_000 }));
  render(<EditAddSource exclude={[]} onAdd={vi.fn()} onError={vi.fn()} />);
  await openMenu();
  expect(items()).toEqual(["Show 1 hidden sequence"]);
  expect(screen.getByRole("button", { name: "Add sequence" }).getAttribute("title")).toBe("Every other sequence is hidden from this list");
});
