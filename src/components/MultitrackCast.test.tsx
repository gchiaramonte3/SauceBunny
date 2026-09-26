// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MultitrackCast } from "./MultitrackCast";
import { multitrackFixture } from "../test/multitrack-fixture";
import { castFromSpeakers, type Cast } from "../lib/cast";
const store = vi.hoisted(() => ({ casts: [] as Cast[], save: vi.fn(), flush: vi.fn(), error: null as string | null }));
vi.mock("../lib/cast-store", () => ({ subscribeCasts: () => () => {}, getCasts: () => store.casts, getCastError: () => store.error, castsAreReadOnly: () => false, hydrateCastStore: async () => {}, saveCast: store.save, flushCasts: store.flush }));
beforeEach(() => { vi.clearAllMocks(); store.casts = []; store.error = null; store.flush.mockResolvedValue(undefined); });
afterEach(cleanup);
it("applying an older cast does not inherit a previous person's gender", () => {
  const cast = castFromSpeakers("Legacy cast", [{ tag: "one", name: "Alex", color: "#123456" }]);
  store.casts = [cast];
  const document = multitrackFixture(), rename = vi.fn();
  document.labels[0].gender = "man"; document.labels[0].marker_color = "blue";
  render(<MultitrackCast document={document} onRename={rename} />);
  fireEvent.click(screen.getByText("Save Mic Owners as Cast"));
  fireEvent.change(screen.getByLabelText("Apply a saved cast"), { target: { value: cast.id } });
  fireEvent.click(screen.getByRole("button", { name: "Apply mic labels" }));
  expect(rename).toHaveBeenCalledWith("track-1", "Alex", cast.members[0].id, "#123456", { gender: "unspecified", marker_color: undefined });
});
it("typing a cast name enables saving without any review checkbox", async () => {
  render(<MultitrackCast document={multitrackFixture()} onRename={vi.fn()} />);
  fireEvent.click(screen.getByText("Save Mic Owners as Cast"));
  const button = screen.getByRole("button", { name: "Save cast" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("New cast name"), { target: { value: "Interview cast" } });
  expect(button.disabled).toBe(false); fireEvent.click(button);
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Cast saved locally"));
  expect(store.save).toHaveBeenCalledWith(expect.objectContaining({ name: "Interview cast", members: expect.arrayContaining([expect.objectContaining({ name: "Alex" })]) }));
});
it("retains the entered name when disk saving fails", async () => {
  store.flush.mockRejectedValue(new Error("Disk unavailable"));
  render(<MultitrackCast document={multitrackFixture()} onRename={vi.fn()} />);
  fireEvent.click(screen.getByText("Save Mic Owners as Cast"));
  fireEvent.change(screen.getByLabelText("New cast name"), { target: { value: "Retry me" } });
  fireEvent.click(screen.getByRole("button", { name: "Save cast" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Disk unavailable"));
  expect((screen.getByLabelText("New cast name") as HTMLInputElement).value).toBe("Retry me");
});
