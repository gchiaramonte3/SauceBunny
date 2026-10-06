// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { LibraryOfflineRoot } from "./LibraryOfflineRoot";

afterEach(cleanup);

it("says a drive is not connected, where the folder was, and offers Locate and Remove but no Retry", () => {
  const onLocate = vi.fn(), onRetry = vi.fn(), onRemove = vi.fn();
  render(<LibraryOfflineRoot root="/Volumes/NEXIS/Show/Test" label="Test" state="driveOffline" volume="NEXIS"
    onLocate={onLocate} onRetry={onRetry} onRemove={onRemove}/>);
  expect(screen.getByRole("status", { name: "Test: NEXIS is not connected" })).toBeTruthy();
  expect(screen.getByText("/Volumes/NEXIS/Show/Test")).toBeTruthy();
  expect(screen.queryByRole("alert"), "an offline drive is drawn as an error").toBeNull();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Locate folder…" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove Test from library" }));
  expect(onLocate).toHaveBeenCalledOnce(); expect(onRemove).toHaveBeenCalledOnce(); expect(onRetry).not.toHaveBeenCalled();
});

it("offers Retry for a folder that moved", () => {
  const onRetry = vi.fn();
  render(<LibraryOfflineRoot root="/Users/editor/Desktop/Test" label="Test" state="missing" volume={null}
    onLocate={vi.fn()} onRetry={onRetry} onRemove={vi.fn()}/>);
  screen.getByText("This folder was moved or renamed");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(onRetry).toHaveBeenCalledOnce();
});
