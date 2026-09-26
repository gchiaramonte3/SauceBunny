// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AafDiagnosticEvent } from "../bindings/AafDiagnosticEvent";
import type { AafDiagnostics } from "../bindings/AafDiagnostics";
import { MultitrackPipeline } from "./MultitrackPipeline";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: mocks.save }));
const snapshot: AafDiagnostics = { events: [], active_jobs: [], persistence_error: null, context: '{"app_version":"0.5.1","document":null}' };
const event: AafDiagnosticEvent = { id: "native-1", timestamp_ms: 1234567890, job_id: "job-1", level: "err", stage: "candidate", message: "/Volumes/Offline/large.mxf · Permission denied (os error 13)", active: false };
let receive: (event: { payload: AafDiagnosticEvent }) => void;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.listen.mockImplementation((_name, handler) => { receive = handler; return Promise.resolve(vi.fn()); });
  mocks.invoke.mockResolvedValue(snapshot); mocks.save.mockResolvedValue(null);
});
afterEach(cleanup);
it("keeps a failed import exportable with no document and only reports success after writing", async () => {
  mocks.save.mockResolvedValue("/chosen/diagnostics.txt");
  let finish!: () => void;
  mocks.invoke.mockImplementation(command => command === "write_text_to_path" ? new Promise<void>(resolve => { finish = resolve; }) : Promise.resolve(snapshot));
  render(<MultitrackPipeline error="AAF could not open" />);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("aaf_diagnostics", { documentId: null }));
  act(() => receive({ payload: event }));
  expect(screen.getByText(/Permission denied/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Export diagnostics" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("write_text_to_path", expect.objectContaining({ path: "/chosen/diagnostics.txt", atomic: true, text: expect.stringContaining("Permission denied") })));
  expect(screen.queryByText(/Diagnostics saved:/)).toBeNull();
  await act(async () => finish());
  expect(screen.getByText(/Diagnostics saved:/)).toBeTruthy();
});
it("Save As cancellation does not write or report success", async () => {
  render(<MultitrackPipeline />);
  fireEvent.click(screen.getByRole("button", { name: "Export diagnostics" }));
  await waitFor(() => expect(mocks.save).toHaveBeenCalled());
  expect(mocks.invoke.mock.calls.some(([command]) => command === "write_text_to_path")).toBe(false);
  expect(screen.queryByText(/Diagnostics saved:/)).toBeNull();
});
it("merges an event arriving during initial hydration once and clears the running status", async () => {
  let hydrate!: (value: AafDiagnostics) => void;
  mocks.invoke.mockReturnValue(new Promise<AafDiagnostics>(resolve => { hydrate = resolve; }));
  render(<MultitrackPipeline />);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalled());
  act(() => receive({ payload: { ...event, id: "start", active: true } }));
  act(() => receive({ payload: event }));
  await act(async () => hydrate({ ...snapshot, events: [event] }));
  expect(screen.queryByText("WORKING")).toBeNull();
  expect(screen.getAllByText(/Permission denied/)).toHaveLength(2);
});
it("shows native-log and export failures and still offers a fallback report", async () => {
  mocks.invoke.mockRejectedValue(new Error("Native unavailable")); mocks.save.mockResolvedValue("/chosen/diagnostics.txt");
  render(<MultitrackPipeline />);
  await waitFor(() => expect(screen.getByText(/Cannot load native diagnostics/)).toBeTruthy());
  fireEvent.click(screen.getByRole("button", { name: "Export diagnostics" }));
  await waitFor(() => expect(screen.getByText(/Diagnostics export failed/)).toBeTruthy());
  expect(mocks.invoke).toHaveBeenCalledWith("write_text_to_path", expect.objectContaining({ text: expect.stringContaining("Native context unavailable") }));
});
it("applies a burst of ordinary rows in one batch rather than one render per event", async () => {
  render(<MultitrackPipeline />);
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("aaf_diagnostics", { documentId: null }));
  fireEvent.click(screen.getByLabelText("Pipeline log"));
  act(() => { for (let index = 0; index < 50; index++) receive({ payload: { ...event, id: `row-${index}`, level: "info", message: `checked mic ${index}`, active: null } }); });
  expect(screen.queryByText(/checked mic 49/)).toBeNull();
  await waitFor(() => expect(screen.getByText(/checked mic 49/)).toBeTruthy());
  expect(screen.getAllByText(/checked mic/)).toHaveLength(50);
});
