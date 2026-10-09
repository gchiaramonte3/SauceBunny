// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { multitrackFixture } from "../test/multitrack-fixture";
import { EditPage } from "./EditPage";

const mocks = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), invoke: vi.fn() }));
vi.mock("../lib/edit-store", () => ({ editStore: { list: mocks.list, create: mocks.create }, newEditId: () => "made" }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
// The workspace is the editor itself; here it only needs to say which edit it holds and let Ask open another.
vi.mock("./EditWorkspace", () => ({ EditWorkspace: ({ editId, onOpenEdit, onTitle }: { editId: string; onOpenEdit: (id: string) => void; onTitle?: (title: string) => void }) =>
  <div data-testid="workspace">{editId}<button onClick={() => onOpenEdit("rosa")}>Make Rosa</button><button onClick={() => onTitle?.("Scene, renamed")}>Rename</button></div> }));
vi.mock("./EditList", () => ({ EditList: ({ edits, onOpen }: { edits: { id: string; title: string }[]; onOpen: (id: string) => void }) =>
  <div>All string outs{edits.map((edit) => <button key={edit.id} onClick={() => onOpen(edit.id)}>Open {edit.id}</button>)}</div> }));
vi.mock("./EditNewPanel", () => ({ EditNewPanel: () => <div>New panel</div> }));

const edits = [{ id: "scene", title: "Scene", created_at: 1, updated_at: 1, head: 1, states: 1, sources: [], duration_frames: 0, bites: 0, bite_frames: [], edit_rate: null }, { id: "rosa", title: "Rosa", created_at: 2, updated_at: 2, head: 1, states: 1, sources: [], duration_frames: 0, bites: 0, bite_frames: [], edit_rate: null }];
afterEach(cleanup);
beforeEach(() => { localStorage.clear(); mocks.list.mockResolvedValue(edits); });

const tabs = () => screen.queryAllByRole("tab").map((tab) => [tab.textContent?.replace("×", ""), tab.getAttribute("aria-selected")]);
/** Open a saved string out the way a person does: from the list when it is showing, from the menu once one is open. */
const openSaved = async (id: string) => {
  await waitFor(() => expect(screen.queryByRole("combobox", { name: "Open saved string out" }) ?? screen.queryByRole("button", { name: `Open ${id}` })).toBeTruthy());
  const menu = screen.queryByRole("combobox", { name: "Open saved string out" });
  if (menu) fireEvent.change(menu, { target: { value: id } });
  else fireEvent.click(screen.getByRole("button", { name: `Open ${id}` }));
};

it("starts clear at launch: the list, no tabs, even if older builds remembered some", async () => {
  localStorage.setItem("saucebunny.editor.lastEdit", "scene");
  localStorage.setItem("saucebunny.stringOuts.tabs", JSON.stringify(["scene", "rosa"]));
  render(<EditPage active onOpenSettings={vi.fn()} />);
  expect(await screen.findByText("All string outs")).toBeTruthy();
  expect(tabs()).toEqual([]);
  expect(screen.queryByTestId("workspace")).toBeNull();
});

it("opens a string out Ask makes in a tab of its own, beside the one it came from, and remembers none for next launch", async () => {
  const view = render(<EditPage active onOpenSettings={vi.fn()} />);
  await openSaved("scene");
  await waitFor(() => expect(tabs()).toEqual([["Scene", "true"]]));
  fireEvent.click(screen.getByRole("button", { name: "Make Rosa" }));
  expect(tabs()).toEqual([["Scene", "false"], ["Rosa", "true"]]);
  expect(screen.getByTestId("workspace").textContent).toContain("rosa");
  // A string out is open in one tab at most, and choosing a tab opens it.
  fireEvent.click(screen.getByRole("button", { name: "Make Rosa" }));
  expect(screen.getAllByRole("tab")).toHaveLength(2);
  fireEvent.click(screen.getAllByRole("tab")[0]);
  expect(screen.getByTestId("workspace").textContent).toContain("scene");
  // A relaunch starts clear again.
  view.unmount();
  render(<EditPage active onOpenSettings={vi.fn()} />);
  expect(await screen.findByText("All string outs")).toBeTruthy();
  expect(tabs()).toEqual([]);
});

it("closing the chosen tab moves to its neighbour, never deletes, and the last one leaves the list", async () => {
  render(<EditPage active onOpenSettings={vi.fn()} />);
  await openSaved("scene");
  await openSaved("rosa");
  fireEvent.click(screen.getAllByRole("tab")[0]);
  await waitFor(() => expect(tabs()).toEqual([["Scene", "true"], ["Rosa", "false"]]));
  fireEvent.click(screen.getAllByRole("tab")[0].querySelector(".cp-tabstrip-close")!);
  expect(tabs()).toEqual([["Rosa", "true"]]);
  // Delete on the focused tab is the keyboard way to close it.
  await act(async () => { fireEvent.keyDown(screen.getByRole("tab"), { key: "Delete" }); });
  expect(screen.queryAllByRole("tab")).toHaveLength(0);
  expect(screen.getByText("All string outs")).toBeTruthy();
  expect(mocks.list).toHaveBeenCalled();
});

it("drops a tab whose string out is gone, and follows a rename", async () => {
  const view = render(<EditPage active onOpenSettings={vi.fn()} />);
  await openSaved("scene");
  await openSaved("rosa");
  await waitFor(() => expect(tabs()).toEqual([["Scene", "false"], ["Rosa", "true"]]));
  mocks.list.mockResolvedValue([edits[0]]);
  view.rerender(<EditPage active={false} onOpenSettings={vi.fn()} />);
  view.rerender(<EditPage active onOpenSettings={vi.fn()} />);
  await waitFor(() => expect(tabs()).toEqual([["Scene", "false"]]));
  fireEvent.click(screen.getAllByRole("tab")[0]);
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  expect(tabs()).toEqual([["Scene, renamed", "true"]]);
});

it("AAF Audio's Open in String Outs makes one string out per sequence, source loaded and record empty, then reuses it", async () => {
  const sequence = multitrackFixture();
  mocks.invoke.mockImplementation((command: string) => command === "aaf_open" ? Promise.resolve(sequence) : Promise.resolve(undefined));
  let listed = [...edits];
  mocks.list.mockImplementation(async () => listed);
  mocks.create.mockImplementation(async (id: string, document: { title: string }) => { listed = [...listed, { id, title: document.title, created_at: 3, updated_at: 3, head: 1, states: 1, sources: [], duration_frames: 0, bites: 0, bite_frames: [], edit_rate: null }]; });
  const view = render(<EditPage active onOpenSettings={vi.fn()} openRequest={{ documentId: sequence.id, tick: 1 }} />);
  await waitFor(() => expect(screen.getByTestId("workspace").textContent).toContain("made"));
  const [, document] = mocks.create.mock.calls[0];
  expect(document).toMatchObject({ title: sequence.manifest.name, segments: [], sources: [{ document_id: sequence.id }] });
  expect(tabs().at(-1)).toEqual([sequence.manifest.name, "true"]);
  // Asked again for the same sequence: the same string out, not another.
  fireEvent.click(screen.getAllByRole("tab")[0]);
  view.rerender(<EditPage active onOpenSettings={vi.fn()} openRequest={{ documentId: sequence.id, tick: 2 }} />);
  await waitFor(() => expect(screen.getByTestId("workspace").textContent).toContain("made"));
  expect(mocks.create).toHaveBeenCalledTimes(1);
});
