// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LibraryVideoSearch } from "./LibraryVideoSearch";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), find: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("../lib/transcript-history", () => ({ findForSource: mocks.find }));
const source = { key: "a".repeat(64), path: "/chosen.mp4", duration: 20, model: "pinned", complete: 1, available: true, segments: 3 };
const hit = { id: 1, source_key: source.key, path: source.path, start: 6, end: 14, frames: [6, 7], score: 0.7 };
const response = { models: [], sources: [source], hits: [hit], answers: [] };
const props = { paths: [source.path], scopeLabel: "1 selected video", onOpenMoment: vi.fn(), onSettings: vi.fn() };
const operations = () => mocks.invoke.mock.calls.filter((call) => call[0] === "video_intelligence_run").map((call) => call[1].request);
beforeEach(() => { vi.resetAllMocks(); mocks.listen.mockResolvedValue(() => {}); mocks.invoke.mockResolvedValue(response); });
afterEach(cleanup);
async function search() {
  await screen.findByText("1 selected video · 1 indexed");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "blue screen" } });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  await screen.findByRole("button", { name: "Describe" });
}
it("reads metadata only on mount, searches explicit scope and opens decoded source time", async () => {
  render(<StrictMode><LibraryVideoSearch {...props} /></StrictMode>);
  await screen.findByText("1 selected video · 1 indexed");
  expect(operations()).toEqual([{ operation: "sources" }]);
  await search();
  expect(operations()).toContainEqual({ operation: "search", query: "blue screen", scope: [source.key], rerank: false });
  fireEvent.click(screen.getByRole("button", { name: /chosen.mp4/ }));
  expect(props.onOpenMoment).toHaveBeenCalledWith(source.path, 6);
});
it.each(["selection", "Stop", "unmount"])("%s invalidates transcript preflight without launching stale inference", async (action) => {
  let release!: (text: string) => void;
  const pending = new Promise<string>((resolve) => { release = resolve; });
  mocks.find.mockReturnValue({ srtPath: "/transcript.srt" });
  mocks.invoke.mockImplementation((command) => command === "read_text_file_capped" ? pending : Promise.resolve(response));
  const view = render(<LibraryVideoSearch {...props} />);
  await search();
  fireEvent.click(screen.getByRole("button", { name: "Describe" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("read_text_file_capped", expect.anything()));
  if (action === "selection") view.rerender(<LibraryVideoSearch {...props} paths={["/different.mp4"]} />);
  else if (action === "Stop") fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  else view.unmount();
  await act(async () => { release("1\n00:00:06,000 --> 00:00:07,000\nEvidence.\n"); });
  expect(operations().some((op) => op.operation === "reason")).toBe(false);
});
it("includes only overlapping existing transcript cues and ignores double Describe clicks", async () => {
  mocks.find.mockReturnValue({ srtPath: "/transcript.srt" });
  mocks.invoke.mockImplementation((command) => Promise.resolve(command === "read_text_file_capped"
    ? "1\n00:00:01,000 --> 00:00:02,000\nOutside.\n\n2\n00:00:06,000 --> 00:00:07,000\nInside.\n" : response));
  render(<LibraryVideoSearch {...props} />); await search();
  const button = screen.getByRole("button", { name: "Describe" });
  fireEvent.click(button); fireEvent.click(button);
  await waitFor(() => expect(operations().filter((op) => op.operation === "reason")).toHaveLength(1));
  const request = operations().find((op) => op.operation === "reason");
  expect(request.transcripts["1"]).toContain("Inside.");
  expect(request.transcripts["1"]).not.toContain("Outside.");
});
it("removing derived data requires a second click and never deletes original media", async () => {
  render(<LibraryVideoSearch {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "Remove index" }));
  expect(operations()).toEqual([{ operation: "sources" }]);
  fireEvent.click(screen.getByRole("button", { name: "Remove index?" }));
  await waitFor(() => expect(operations()).toContainEqual({ operation: "forget", source_key: source.key }));
  expect(mocks.invoke.mock.calls.every(([command]) => command === "video_intelligence_run")).toBe(true);
});
