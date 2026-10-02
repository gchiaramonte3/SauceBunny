// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { LibraryProjectFolderDialog } from "./LibraryProjectFolderDialog";
import { emptyOrganization, type LibraryOrganization } from "../lib/library-organization";
const store = vi.hoisted(() => ({ edit: vi.fn(), getSnapshot: vi.fn() }));
vi.mock("../lib/library-organization-store", () => ({ libraryOrganization: store }));
let current: LibraryOrganization, error: string | null;
beforeEach(() => {
  current = { ...emptyOrganization(), folders: [{ id: "folder", name: "Folder", parentId: null, assetIds: [], rule: null }] }; error = null;
  store.getSnapshot.mockImplementation(() => ({ error }));
  store.edit.mockImplementation(async (_label, update) => {
    try { current = update(current); return true; } catch (cause) { error = (cause as Error).message; return false; }
  });
});
afterEach(cleanup);
it("a metadata dialog cannot restore obsolete folder membership", async () => {
  render(<LibraryProjectFolderDialog folder={current.folders[0]} data={current} onClose={vi.fn()} onSaved={vi.fn()} />);
  current = { ...current, folders: [{ ...current.folders[0], assetIds: ["added-while-open"] }] };
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Renamed" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(current.folders[0].name).toBe("Renamed"));
  expect(current.folders[0].assetIds).toEqual(["added-while-open"]);
});
it("does not resurrect a folder deleted while its metadata dialog was open", async () => {
  const folder = current.folders[0];
  const view = render(<LibraryProjectFolderDialog folder={folder} data={current} onClose={vi.fn()} onSaved={vi.fn()} />);
  current = emptyOrganization();
  view.rerender(<LibraryProjectFolderDialog folder={folder} data={current} onClose={vi.fn()} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("removed"));
  expect(current.folders).toEqual([]);
});
