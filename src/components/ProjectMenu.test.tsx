// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { ProjectMenu, type ProjectMenuTarget } from "./ProjectMenu";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => "/lib/New") }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
beforeEach(() => { vi.mocked(invoke).mockClear(); });

const full: ProjectMenuTarget = {
  folder: "Marry Harry",
  title: "Marry Harry",
  items: [
    { path: "/lib/Marry Harry/ep1.srt", title: "ep1" },
    { path: "/lib/Marry Harry/ep2.srt", title: "ep2" },
  ],
  posterFrom: null,
  x: 10,
  y: 10,
};
const empty: ProjectMenuTarget = { ...full, items: [] };

function open(target = full, props: Partial<Parameters<typeof ProjectMenu>[0]> = {}) {
  const handlers = {
    onClose: vi.fn(),
    onRenamed: vi.fn(),
    onDeleted: vi.fn(),
    onPickPoster: vi.fn(),
  };
  render(<ProjectMenu target={target} libraryPath="/lib" {...handlers} {...props} />);
  return handlers;
}

describe("a project's actions", () => {
  it("renames the folder on disk, then carries the metadata", async () => {
    // The folder IS the identity, so the disk rename has to succeed before
    // anything moves the poster and colour onto the new key.
    const h = open();
    fireEvent.click(screen.getByRole("menuitem", { name: /Rename project/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Marry Harry S2" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await waitFor(() => expect(h.onRenamed).toHaveBeenCalledWith("Marry Harry", "Marry Harry S2"));
    expect(invoke).toHaveBeenCalledWith("rename_transcript_folder", {
      libraryPath: "/lib", folder: "Marry Harry", newName: "Marry Harry S2",
    });
  });

  it("does not carry anything when the disk rename failed", async () => {
    // Carrying first would leave the metadata pointing at a folder that does
    // not exist, and the next reconcile would drop the poster for good.
    vi.mocked(invoke).mockRejectedValueOnce(new Error("A folder named that already exists."));
    const h = open();
    fireEvent.click(screen.getByRole("menuitem", { name: /Rename project/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Taken" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await screen.findByText(/already exists/);
    expect(h.onRenamed).not.toHaveBeenCalled();
    expect(h.onClose).not.toHaveBeenCalled();
  });

  it("will not delete a project that still holds transcripts", () => {
    // The Rust command refuses this too. Disabling it here means the refusal
    // is read as an instruction before the click, not as an error after it.
    open(full);
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete project/ }));
    const del = screen.getByRole("button", { name: "Delete folder" }) as HTMLButtonElement;
    expect(del.disabled).toBe(true);
    expect(screen.getByText(/holds 2 transcripts/)).toBeTruthy();
  });

  it("deletes an empty project", async () => {
    const h = open(empty);
    fireEvent.click(screen.getByRole("menuitem", { name: /Delete project/ }));
    fireEvent.click(screen.getByRole("button", { name: "Delete folder" }));
    await waitFor(() => expect(h.onDeleted).toHaveBeenCalledWith("Marry Harry"));
    expect(invoke).toHaveBeenCalledWith("delete_transcript_folder", {
      libraryPath: "/lib", folder: "Marry Harry",
    });
  });

  it("picks a transcript as the project's picture", () => {
    const h = open();
    fireEvent.click(screen.getByRole("menuitem", { name: /Choose picture/ }));
    fireEvent.click(screen.getByRole("button", { name: "ep2" }));
    expect(h.onPickPoster).toHaveBeenCalledWith("Marry Harry", "/lib/Marry Harry/ep2.srt");
  });

  it("can go back to following the newest transcript", () => {
    const h = open({ ...full, posterFrom: "/lib/Marry Harry/ep1.srt" });
    fireEvent.click(screen.getByRole("menuitem", { name: /Choose picture/ }));
    fireEvent.click(screen.getByRole("button", { name: /Use the newest/ }));
    expect(h.onPickPoster).toHaveBeenCalledWith("Marry Harry", null);
  });

  it("offers no picture to choose when the project is empty", () => {
    open(empty);
    expect((screen.getByRole("menuitem", { name: /Choose picture/ }) as HTMLButtonElement).disabled)
      .toBe(true);
  });
});
