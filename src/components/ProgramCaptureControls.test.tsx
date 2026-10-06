// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { ProgramCaptureControls } from "./ProgramCaptureControls";

const token = "0123456789abcdef0123456789abcdef";
let preflight = { available: true, error: null as string | null, kinds: ["screen", "window", "region"], systemAudio: true, applicationAudio: true };
let choose: () => Promise<unknown>;
let snapshot: () => Promise<unknown>;

beforeEach(() => {
  mocks.invoke.mockReset();
  preflight = { available: true, error: null, kinds: ["screen", "window", "region"], systemAudio: true, applicationAudio: true };
  choose = async () => ({ outcome: "chosen", choice: { choice: token, kind: "screen", label: "Studio Display", width: 1920, height: 1080 } });
  snapshot = async () => ({ image: "data:image/jpeg;base64,/9j/2Q==", width: 1920, height: 1080 });
  mocks.invoke.mockImplementation(async (command: string) => {
    if (command === "program_capture_preflight") return preflight;
    if (command === "program_capture_choose") return choose();
    if (command === "program_capture_snapshot") return snapshot();
    if (command === "program_capture_audio_apps") return [{ bundle: "com.p5sys.jump.mac.viewer", name: "Jump Desktop" }, { bundle: "com.apple.Safari", name: "Safari" }];
    return undefined;
  });
});
afterEach(cleanup);

it("asks macOS's picker, then previews what was picked, with the job id held before the call", async () => {
  const onPreview = vi.fn(async () => {}), onSelectionChange = vi.fn();
  render(<ProgramCaptureControls mode="screen" open disabled={false} onPreview={onPreview} onSelectionChange={onSelectionChange}/>);
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
  render(<ProgramCaptureControls mode="screen" open disabled={false} onPreview={onPreview}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Choose screen…" }));
  await screen.findByRole("button", { name: "Choose screen…" });
  expect(onPreview).not.toHaveBeenCalled();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("asks for the screen again when the helper no longer holds the pick", async () => {
  const onPreview = vi.fn(async () => { throw new Error("Choose again. macOS does not let apps keep a screen choice after Sauce Bunny or its capture helper restarts."); });
  render(<ProgramCaptureControls mode="screen" open disabled={false} onPreview={onPreview}
    initialSelection={{ choice: token, kind: "screen", label: "Studio Display", audio: false }}/>);
  await screen.findByRole("status", { name: "Selected screen" });
  fireEvent.click(screen.getByRole("button", { name: "Preview source" }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("status", { name: "Selected screen" })).toBeNull();
  expect(screen.getByRole("button", { name: "Choose screen…" })).toBeTruthy();
});

it("offers system audio only where macOS can record it, and says why when it cannot", async () => {
  preflight = { ...preflight, systemAudio: false };
  render(<ProgramCaptureControls mode="screen" open disabled={false} onPreview={vi.fn(async () => {})}
    initialSelection={{ choice: token, kind: "screen", label: "Studio Display", audio: false }}/>);
  await screen.findByText("System audio needs macOS 14.2 or later.");
  expect((screen.getByRole("checkbox", { name: "Include system audio" }) as HTMLInputElement).disabled).toBe(true);
});

it("withdraws a pending pick when the dialog goes away, and says when this build has no helper", async () => {
  let release!: (value: unknown) => void;
  choose = () => new Promise(done => { release = done; });
  const view = render(<ProgramCaptureControls mode="screen" open disabled={false} onPreview={vi.fn(async () => {})}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Choose screen…" }));
  await screen.findByText("Waiting for your choice in the macOS picker…");
  const jobId = (mocks.invoke.mock.calls.find(([command]) => command === "program_capture_choose")?.[1] as { jobId: string }).jobId;
  view.unmount();
  expect(mocks.invoke).toHaveBeenCalledWith("program_capture_cancel_choose", { jobId });
  await act(async () => release({ outcome: "cancelled" }));
  cleanup();
  preflight = { ...preflight, available: false, error: "The screen capture helper is missing from this build" };
  render(<ProgramCaptureControls mode="screen" open disabled={false} onPreview={vi.fn(async () => {})}/>);
  expect((await screen.findByRole("alert")).textContent).toBe("The screen capture helper is missing from this build");
  expect(screen.queryByRole("button", { name: "Choose screen…" })).toBeNull();
});

it("chooses a window through the picker with its own application's audio on, and previews it at once", async () => {
  choose = async () => ({ outcome: "chosen", choice: { choice: token, kind: "window", label: "Safari · Dailies", width: 1600, height: 900 } });
  const onPreview = vi.fn(async () => {});
  render(<ProgramCaptureControls mode="window" open disabled={false} onPreview={onPreview}/>);
  expect(screen.queryByText(/OBS/)).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: "Choose window…" }));
  await screen.findByRole("status", { name: "Selected window" });
  expect(mocks.invoke.mock.calls.find(([command]) => command === "program_capture_choose")?.[1]).toEqual({ jobId: expect.any(String), kind: "window" });
  await waitFor(() => expect(onPreview).toHaveBeenCalledWith({ choice: token, kind: "window", label: "Safari · Dailies", audio: true }));
  expect((screen.getByRole("checkbox", { name: "Include application audio" }) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByRole("button", { name: "Choose another window…" })).toBeTruthy();
});

it("says why application audio is off where macOS cannot name a picked window's app", async () => {
  preflight = { ...preflight, applicationAudio: false };
  choose = async () => ({ outcome: "chosen", choice: { choice: token, kind: "window", label: "Window 1600 × 900", width: 1600, height: 900 } });
  const onPreview = vi.fn(async () => {});
  render(<ProgramCaptureControls mode="window" open disabled={false} onPreview={onPreview}/>);
  await screen.findByText("Application audio needs macOS 15.2 or later.");
  fireEvent.click(await screen.findByRole("button", { name: "Choose window…" }));
  await waitFor(() => expect(onPreview).toHaveBeenCalledWith(expect.objectContaining({ kind: "window", audio: false })));
});

it("draws a region on a still of the picked screen and previews only once the area is drawn", async () => {
  choose = async () => ({ outcome: "chosen", choice: { choice: token, kind: "region", label: "Studio Display", width: 1920, height: 1080 } });
  const onPreview = vi.fn(async () => {}), onSelectionChange = vi.fn();
  render(<ProgramCaptureControls mode="region" open disabled={false} onPreview={onPreview} onSelectionChange={onSelectionChange}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Choose screen…" }));
  await screen.findByRole("img", { name: "Studio Display" });
  expect(mocks.invoke).toHaveBeenCalledWith("program_capture_snapshot", { choice: token });
  expect(onPreview).not.toHaveBeenCalled();
  const previewButton = screen.getByRole("button", { name: "Preview source" }) as HTMLButtonElement;
  expect(previewButton.disabled).toBe(true);
  for (const [name, value] of [["Left", "25"], ["Top", "25"], ["Width", "50"], ["Height", "50"]] as const) {
    fireEvent.change(screen.getByRole("spinbutton", { name }), { target: { value } });
  }
  await screen.findByText("Captures 960 × 540 of Studio Display.");
  expect(previewButton.disabled).toBe(false);
  fireEvent.click(previewButton);
  await waitFor(() => expect(onPreview).toHaveBeenCalledWith({ choice: token, kind: "region", label: "Studio Display", audio: false,
    region: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } }));
  expect(onSelectionChange).toHaveBeenLastCalledWith(expect.objectContaining({ region: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 } }));
});

it("asks for the screen again when a region's still is of a pick the helper no longer holds", async () => {
  snapshot = async () => { throw new Error("Choose again. macOS does not let apps keep a screen choice after Sauce Bunny or its capture helper restarts."); };
  render(<ProgramCaptureControls mode="region" open disabled={false} onPreview={vi.fn(async () => {})}
    initialSelection={{ choice: token, kind: "region", label: "Studio Display", audio: false, region: { x: 0, y: 0, width: 0.5, height: 0.5 } }}/>);
  await screen.findByRole("button", { name: "Choose screen…" });
  expect(screen.queryByRole("status", { name: "Selected screen" })).toBeNull();
});

it("hears only the apps the person ticks, and will not preview a choice of none", async () => {
  const onPreview = vi.fn(async () => {});
  render(<ProgramCaptureControls mode="screen" open disabled={false} onPreview={onPreview}
    initialSelection={{ choice: token, kind: "screen", label: "Studio Display", audio: true }}/>);
  expect((await screen.findByRole("combobox", { name: "Audio from" }) as HTMLSelectElement).value).toBe("default");
  await screen.findByText(/Leaves out Sauce Bunny, so nobody in a session hears themselves/);
  fireEvent.change(screen.getByRole("combobox", { name: "Audio from" }), { target: { value: "apps" } });
  const jump = await screen.findByRole("checkbox", { name: "Jump Desktop" });
  expect((screen.getByRole("button", { name: "Preview source" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(jump);
  fireEvent.click(screen.getByRole("button", { name: "Preview source" }));
  await waitFor(() => expect(onPreview).toHaveBeenCalledWith({ choice: token, kind: "screen", label: "Studio Display", audio: true,
    audioApps: ["com.p5sys.jump.mac.viewer"] }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Include system audio" }));
  expect(screen.queryByRole("combobox", { name: "Audio from" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Preview source" }));
  await waitFor(() => expect(onPreview).toHaveBeenLastCalledWith({ choice: token, kind: "screen", label: "Studio Display", audio: false }));
});
