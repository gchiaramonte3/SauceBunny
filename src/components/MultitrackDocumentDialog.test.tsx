// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MultitrackDocumentDialog } from "./MultitrackDocumentDialog";
import type { MultitrackLibraryEntry } from "../lib/transcript-library";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), fileDocuments: vi.fn(), notify: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../lib/transcript-project-store", () => ({ fileDocuments: mocks.fileDocuments }));
vi.mock("../lib/transcript-history", () => ({ notifyTranscriptsChanged: mocks.notify }));

const id = "a".repeat(64);
const entry: MultitrackLibraryEntry = { kind: "multitrack", id, title: "Interview",
  summary: { id, name: "Interview", track_count: 3, transcribed_tracks: 1, source_path: "/fixtures/Interview.aaf" } };
const projects = [{ folder: "Show", title: "The Show" }, { folder: "Other", title: "Other" }];

beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

it("files the transcript in a project, or back in none, and says nothing moves on disk", () => {
  const onClose = vi.fn();
  render(<MultitrackDocumentDialog mode="move" entry={entry} projects={projects} filedIn="Show" libraryPath="/lib" onClose={onClose} />);
  expect(screen.getByRole("dialog", { name: /Move “Interview” to a project/ })).toBeTruthy();
  expect(screen.getByText(/Nothing moves on disk/)).toBeTruthy();
  // Where it is now is not offered as a destination.
  expect((screen.getByRole("button", { name: "The Show" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Other" }));
  expect(mocks.fileDocuments).toHaveBeenCalledWith([id], "Other");
  expect(onClose).toHaveBeenCalled();
});

it("takes it out of its project", () => {
  render(<MultitrackDocumentDialog mode="move" entry={entry} projects={projects} filedIn="Show" libraryPath="/lib" onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: /No project/ }));
  expect(mocks.fileDocuments).toHaveBeenCalledWith([id], null);
});

it("makes a project and files it there, then has the page look again", async () => {
  mocks.invoke.mockResolvedValue("/lib/Season Two");
  render(<MultitrackDocumentDialog mode="move" entry={entry} projects={projects} filedIn={null} libraryPath="/lib" onClose={vi.fn()} />);
  fireEvent.change(screen.getByRole("textbox", { name: "New project name" }), { target: { value: "Season Two" } });
  fireEvent.click(screen.getByRole("button", { name: "Create & move" }));
  await waitFor(() => expect(mocks.fileDocuments).toHaveBeenCalledWith([id], "Season Two"));
  expect(mocks.invoke).toHaveBeenCalledWith("create_transcript_folder", { libraryPath: "/lib", name: "Season Two" });
  expect(mocks.notify).toHaveBeenCalled();
});

it("an empty name goes back to the sequence's", async () => {
  mocks.invoke.mockResolvedValue({});
  const onClose = vi.fn();
  render(<MultitrackDocumentDialog mode="rename" entry={entry} projects={projects} filedIn={null} libraryPath="/lib" onClose={onClose} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "   " } });
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("aaf_rename", { documentId: id, title: null }));
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
});

it("a refused name is said, and the dialog stays", async () => {
  mocks.invoke.mockRejectedValue({ kind: "Invalid", data: "Use a name of up to 200 characters, on one line" });
  const onClose = vi.fn();
  render(<MultitrackDocumentDialog mode="rename" entry={entry} projects={projects} filedIn={null} libraryPath="/lib" onClose={onClose} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "A name that is refused" } });
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/up to 200 characters/);
  expect(onClose).not.toHaveBeenCalled();
});
