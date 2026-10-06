// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AafDiagnosticEvent } from "../bindings/AafDiagnosticEvent";
import type { AafDiagnostics } from "../bindings/AafDiagnostics";
import { useState } from "react";
import { setPipelineContext } from "../lib/pipeline";
import { PipelinePanel, type PipelinePage } from "./PipelinePanel";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: mocks.save }));
const snapshot: AafDiagnostics = { events: [], active_jobs: [], persistence_error: null, context: '{"app_version":"0.5.1","document":null}' };
const event: AafDiagnosticEvent = { id: "native-1", timestamp_ms: 1234567890, job_id: "job-1", level: "err", stage: "candidate", message: "/Volumes/Offline/large.mxf · Permission denied (os error 13)", active: false };
let receive: (event: { payload: AafDiagnosticEvent }) => void;
// The open state lives in App (⌘\ toggles it for every page); here, a stand-in for it.
function MultitrackPipeline(props: { error?: string; page?: PipelinePage; documentId?: string }) {
  const [open, setOpen] = useState(false);
  return <PipelinePanel page={props.page ?? "AAF Audio"} active={false} open={open} onOpenChange={setOpen} error={props.error} documentId={props.documentId} />;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.listen.mockImplementation((_name, handler) => { receive = handler; return Promise.resolve(vi.fn()); });
  mocks.invoke.mockResolvedValue(snapshot); mocks.save.mockResolvedValue(null);
});
afterEach(() => { cleanup(); setPipelineContext("String Outs", null); });
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
it("exports String Outs with what the string out is doing and every AAF Audio document it reads", async () => {
  mocks.save.mockResolvedValue("/chosen/string-outs.txt");
  setPipelineContext("String Outs", () => ({ text: "String out 1a2b3c4d · 2 sources", documentIds: ["doc-a", "doc-b"] }));
  mocks.invoke.mockImplementation((command: string) => command === "pipeline_health"
    ? Promise.resolve({ resident_bytes: 900_000_000, uptime_seconds: 60, running_jobs: [], main_thread_wait_ms: 0, volumes: [], latest_hang: null, co_review: "off" })
    : Promise.resolve(snapshot));
  render(<MultitrackPipeline page="String Outs" />);
  fireEvent.click(screen.getByRole("button", { name: "Export diagnostics" }));
  await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("write_text_to_path", expect.anything()));
  expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ title: "Save String Outs diagnostics", defaultPath: expect.stringContaining("string-outs-diagnostics") }));
  expect(mocks.invoke).toHaveBeenCalledWith("aaf_diagnostics", { documentId: "doc-a" });
  expect(mocks.invoke).toHaveBeenCalledWith("aaf_diagnostics", { documentId: "doc-b" });
  const text = mocks.invoke.mock.calls.find(([command]) => command === "write_text_to_path")?.[1].text as string;
  expect(text).toContain("PAGE · String Outs\nString out 1a2b3c4d · 2 sources");
  expect(text).toContain("Main thread: answering");
  expect(text).toContain("CONTEXT 2 of 2");
});
