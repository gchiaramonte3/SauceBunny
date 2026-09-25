// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { multitrackLinkedFixture } from "../test/multitrack-fixture";
import { MultitrackMediaStatus } from "./MultitrackMediaStatus";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("stays out of the way when everything is linked", () => {
  render(<MultitrackMediaStatus document={multitrackLinkedFixture(true)} />);
  expect(screen.queryByRole("group", { name: "Linked media" })).toBeNull();
});

it("counts what is missing and relinks from the workspace", async () => {
  const doc = multitrackLinkedFixture(true);
  doc.manifest.graph!.sources[1].status = "offline"; doc.manifest.graph!.sources[1].resolved = null;
  mocks.invoke.mockResolvedValue(doc); mocks.open.mockResolvedValue("/Volumes/NEXIS/Show/Avid MediaFiles/MXF/1");
  const details = vi.fn();
  render(<MultitrackMediaStatus document={doc} onDetails={details} />);
  const total = doc.manifest.graph!.sources.length;
  expect(screen.getByRole("status").textContent).toBe(`${total - 1} of ${total} media files linked · 1 offline`);
  fireEvent.click(screen.getByRole("button", { name: "Relink folder…" }));
  await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("aaf_resolve_media", expect.objectContaining({ documentId: doc.id, sourceId: null, path: "/Volumes/NEXIS/Show/Avid MediaFiles/MXF/1" })));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await vi.waitFor(() => expect(mocks.invoke).toHaveBeenLastCalledWith("aaf_resolve_media", expect.objectContaining({ path: null })));
  fireEvent.click(screen.getByRole("button", { name: "Details" }));
  expect(details).toHaveBeenCalled();
});
