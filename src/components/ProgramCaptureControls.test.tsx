// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { ProgramCaptureControls } from "./ProgramCaptureControls";

const token = "0123456789abcdef0123456789abcdef";
let preflight = { available: true, error: null as string | null, kinds: ["screen"], systemAudio: true };
let choose: () => Promise<unknown>;

beforeEach(() => {
  mocks.invoke.mockReset();
  preflight = { available: true, error: null, kinds: ["screen"], systemAudio: true };
  choose = async () => ({ outcome: "chosen", choice: { choice: token, kind: "screen", label: "Studio Display", width: 1920, height: 1080 } });
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "program_capture_preflight") return preflight;
    if (command === "program_capture_choose") return choose();
    return undefined;
  });
});
afterEach(cleanup);

it("asks macOS's picker, then previews what was picked, with the job id held before the call", async () => {
  const onPreview = vi.fn(async () => {}), onSelectionChange = vi.fn();
  render(<ProgramCaptureControls open disabled={false} onPreview={onPreview} onSelectionChange={onSelectionChange}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Choose screen…" }));
  await screen.findByRole("status", { name: "Selected screen" });
  expect(screen.getByRole("status", { name: "Selected screen" }).textContent).toBe("Selected: Studio Display");
  const chooseCall = mocks.invoke.mock.calls.find(([command]) => command === "program_capture_choose");
  expect(chooseCall?.[1]).toEqual({ jobId: expect.stringMatching(/\S/), kind: "screen" });
  await waitFor(() => expect(onPreview).toHaveBeenCalledWith({ choice: token, kind: "screen", label: "Studio Display", audio: false }));
  expect(onSelectionChange).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Choose another screen…" })).toBeTruthy();
});

it("starts nothing and shows no error when the person cancels the picker", async () => {
  choose = async () => ({ outcome: "cancelled" });
  const onPreview = vi.fn(async () => {});
  render(<ProgramCaptureControls open disabled={false} onPreview={onPreview}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Choose screen…" }));
  await screen.findByRole("button", { name: "Choose screen…" });
  expect(onPreview).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("asks for the screen again when the helper no longer holds the pick", async () => {
  const onPreview = vi.fn(async () => { throw new Error("Choose again. macOS does not let apps keep a screen choice after Sauce Bunny or its capture helper restarts."); });
  render(<ProgramCaptureControls open disabled={false} onPreview={onPreview}
    initialSelection={{ choice: token, kind: "screen", label: "Studio Display", audio: false }}/>);
  await screen.findByRole("status", { name: "Selected screen" });
  fireEvent.click(screen.getByRole("button", { name: "Preview source" }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("status", { name: "Selected screen" })).toBeNull();
  expect(screen.getByRole("button", { name: "Choose screen…" })).toBeTruthy();
});

it("offers system audio only where macOS can record it, and says why when it cannot", async () => {
  preflight = { ...preflight, systemAudio: false };
  render(<ProgramCaptureControls open disabled={false} onPreview={vi.fn(async () => {})}
    initialSelection={{ choice: token, kind: "screen", label: "Studio Display", audio: false }}/>);
  await screen.findByText("System audio needs macOS 14.2 or later.");
  expect((screen.getByRole("checkbox", { name: "Include system audio" }) as HTMLInputElement).disabled).toBe(true);
});

it("withdraws a pending pick when the dialog goes away, and says when this build has no helper", async () => {
  let release!: (value: unknown) => void;
  choose = () => new Promise(done => { release = done; });
  const view = render(<ProgramCaptureControls open disabled={false} onPreview={vi.fn(async () => {})}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Choose screen…" }));
  await screen.findByText("Waiting for your choice in the macOS picker…");
  const jobId = (mocks.invoke.mock.calls.find(([command]) => command === "program_capture_choose")?.[1] as { jobId: string }).jobId;
  view.unmount();
  expect(mocks.invoke).toHaveBeenCalledWith("program_capture_cancel_choose", { jobId });
  await act(async () => release({ outcome: "cancelled" }));
  cleanup();
  preflight = { ...preflight, available: false, error: "The screen capture helper is missing from this build" };
  render(<ProgramCaptureControls open disabled={false} onPreview={vi.fn(async () => {})}/>);
  expect((await screen.findByRole("alert")).textContent).toBe("The screen capture helper is missing from this build");
  expect(screen.queryByRole("button", { name: "Choose screen…" })).toBeNull();
});
