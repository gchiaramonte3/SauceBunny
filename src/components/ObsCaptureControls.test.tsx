// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ObsSelection } from "../bindings/ObsSelection";
import type { ObsWindowChoice } from "../bindings/ObsWindowChoice";
import { emptyNdiState } from "../hooks/use-ndi-input";
import { ObsCaptureControls } from "./ObsCaptureControls";
import { NdiInputPanel, type NdiPreviewInput } from "./NdiInputPanel";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
const windows: ObsWindowChoice[] = [
  { app: "test.generated.alpha", applicationName: "Generated Alpha", pid: 101, id: 501, title: "Timeline", width: 640, height: 360 },
  { app: "test.generated.alpha", applicationName: "Generated Alpha", pid: 101, id: 502, title: "Timeline", width: 320, height: 180 },
  { app: "test.generated.beta", applicationName: "Generated Beta", pid: 202, id: 601, title: "Timeline", width: 800, height: 600 },
];
const selection: ObsSelection = { application: windows[1].app, process: 101, window: 502,
  crop: { x: 0, y: 0, width: 1, height: 1 }, audio: false };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function ordinary(command: string, args?: { application?: string; process?: number; window?: number }) {
  if (command === "obs_preflight") return Promise.resolve({ available: true, error: null });
  if (command === "obs_all_windows") return Promise.resolve(windows);
  if (command === "capture_window_thumbnail") return Promise.resolve({ ...args, thumb: "/9j/2Q==" });
  throw new Error("Unexpected native mutation in capture controls: " + command);
}
const selectedWindowId = () => screen.queryByRole("status", { name: "Selected window" })?.textContent?.match(/Window (\d+)/)?.[1] ?? "";
const previewButton = () => screen.getByRole("button", { name: /^(Preview source|Starting preview…)$/ }) as HTMLButtonElement;
const refreshButton = () => screen.getByRole("button", { name: "Refresh windows" }) as HTMLButtonElement;
const discoveryStatus = () => screen.getByRole("status", { name: "Window discovery" }).textContent;
async function chooseWindow(id = 502) {
  const card = await screen.findByRole("button", { name: new RegExp("Window " + id + "$") });
  fireEvent.click(card);
}
async function selected(onPreview = vi.fn(async (_value: ObsSelection) => {})) {
  const mounted = render(<ObsCaptureControls open disabled={false} onPreview={onPreview}/>);
  await chooseWindow();
  await waitFor(() => expect(previewButton().disabled).toBe(false));
  return { ...mounted, onPreview };
}
function onlyPassiveCommands() {
  expect(mocks.invoke.mock.calls.every(([command]) => ["obs_preflight", "obs_all_windows", "capture_window_thumbnail"].includes(command))).toBe(true);
}
beforeEach(() => { mocks.invoke.mockReset(); mocks.invoke.mockImplementation(ordinary); });
afterEach(cleanup);

describe("cross-application window chooser", () => {
  it("does nothing while closed, lists all app windows without a dropdown, and never captures on discovery or focus", async () => {
    const onPreview = vi.fn(async () => {});
    const view = render(<ObsCaptureControls open={false} disabled={false} onPreview={onPreview}/>);
    expect(mocks.invoke).not.toHaveBeenCalled();
    view.rerender(<ObsCaptureControls open disabled={false} onPreview={onPreview}/>);
    await screen.findByRole("button", { name: /Generated Beta.*Window 601/ });
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(selectedWindowId()).toBe("");
    expect(previewButton().disabled).toBe(true);
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "obs_all_windows")).toHaveLength(1);
    fireEvent.focus(window);
    await waitFor(() => expect(refreshButton().disabled).toBe(false));
    fireEvent.click(refreshButton());
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === "obs_all_windows")).toHaveLength(3));
    onlyPassiveCommands(); expect(onPreview).not.toHaveBeenCalled();
  });

  it("distinguishes same-title windows across applications and submits only the exact clicked identity", async () => {
    const onPreview = vi.fn(async (_value: ObsSelection) => {});
    render(<ObsCaptureControls open disabled={false} onPreview={onPreview}/>);
    await chooseWindow(601);
    for (const window of windows) {
      const card = screen.getByRole("button", { name: new RegExp("Window " + window.id + "$") });
      expect(card.textContent).toContain(window.title);
      expect(card.textContent).toContain(window.applicationName);
      expect(card.getAttribute("data-capture-source-id")).toBe(JSON.stringify([window.app, window.pid, window.id]));
    }
    expect(onPreview).not.toHaveBeenCalled();
    fireEvent.click(previewButton());
    await waitFor(() => expect(onPreview).toHaveBeenCalledExactlyOnceWith({
      ...selection, application: windows[2].app, process: 202, window: 601,
    }));
    onlyPassiveCommands();
  });

  it("restores an exact selection and crop without automatically previewing on reopen", async () => {
    const initialSelection = { ...selection, crop: { x: .1, y: .2, width: .5, height: .6 } };
    const onPreview = vi.fn(async () => {});
    const props = { disabled: false, initialSelection, onPreview };
    const view = render(<ObsCaptureControls {...props} open/>);
    await waitFor(() => expect(previewButton().disabled).toBe(false));
    fireEvent.click(screen.getByText("Crop", { selector: "summary" }));
    for (const [name, value] of [["Left", 10], ["Top", 20], ["Width", 50], ["Height", 60]] as const) {
      expect((screen.getByRole("spinbutton", { name }) as HTMLInputElement).valueAsNumber).toBe(value);
    }
    view.rerender(<ObsCaptureControls {...props} open={false}/>);
    view.rerender(<ObsCaptureControls {...props} open/>);
    await waitFor(() => expect(previewButton().disabled).toBe(false));
    expect(selectedWindowId()).toBe("502"); expect(onPreview).not.toHaveBeenCalled();
    fireEvent.click(previewButton());
    await waitFor(() => expect(onPreview).toHaveBeenCalledExactlyOnceWith(initialSelection));
  });

  it("hands off an independent selection and crop while preview is pending", async () => {
    const pending = deferred<void>();
    const initialSelection = { ...selection, crop: { x: .1, y: .2, width: .5, height: .6 } };
    const onPreview = vi.fn((_value: ObsSelection) => pending.promise);
    render(<ObsCaptureControls open disabled={false} initialSelection={initialSelection} onPreview={onPreview}/>);
    await waitFor(() => expect(previewButton().disabled).toBe(false));
    fireEvent.click(previewButton()); fireEvent.click(previewButton());
    expect(onPreview).toHaveBeenCalledTimes(1);
    const submitted = onPreview.mock.calls[0][0];
    if (!("window" in submitted)) throw new Error("Expected a window selection");
    expect(submitted).toEqual(initialSelection); expect(submitted).not.toBe(initialSelection);
    expect(submitted.crop).not.toBe(initialSelection.crop);
    initialSelection.crop.x = .2; submitted.crop.y = .3; submitted.window = 501;
    expect(submitted.crop.x).toBe(.1); expect(initialSelection.crop.y).toBe(.2);
    expect(initialSelection.window).toBe(502);
    await act(async () => pending.resolve()); onlyPassiveCommands();
  });

  it("normalizes crop percentages and blocks empty, too-small or out-of-bounds rectangles", async () => {
    const { onPreview } = await selected();
    fireEvent.click(screen.getByText("Crop", { selector: "summary" }));
    const change = (name: string, value: string) => fireEvent.change(screen.getByRole("spinbutton", { name }), { target: { value } });
    for (const [name, value] of [["Left", "90"], ["Width", "0"], ["Top", ""]] as const) {
      change(name, value); expect(previewButton().disabled).toBe(true); fireEvent.click(previewButton());
    }
    expect(onPreview).not.toHaveBeenCalled();
    change("Left", "25"); change("Width", "5"); change("Top", "10");
    expect(previewButton().disabled).toBe(true); // 16 source pixels is not a shareable region.
    change("Width", "50"); change("Height", "80");
    expect(previewButton().disabled).toBe(false); fireEvent.click(previewButton());
    await waitFor(() => expect(onPreview).toHaveBeenCalledExactlyOnceWith({ ...selection, crop: { x: .25, y: .1, width: .5, height: .8 } }));
  });

  it.each(["missing", "restarted", "other application"])("does not silently replace a %s selected window", async kind => {
    const { onPreview } = await selected();
    const replacement = kind === "missing" ? [windows[0]] : windows.map(item => item.id !== 502 ? item
      : kind === "restarted" ? { ...item, pid: 999 } : { ...item, app: "test.generated.other" });
    mocks.invoke.mockImplementation((command, args) => command === "obs_all_windows" ? Promise.resolve(replacement) : ordinary(command, args));
    fireEvent.click(refreshButton());
    await screen.findByText(/is no longer available/);
    expect(selectedWindowId()).toBe("502"); expect(previewButton().disabled).toBe(true);
    fireEvent.click(previewButton()); expect(onPreview).not.toHaveBeenCalled(); onlyPassiveCommands();
  });

  it("ignores superseded list results without overwriting a newer cross-application selection", async () => {
    const old = deferred<ObsWindowChoice[]>(); let scans = 0;
    mocks.invoke.mockImplementation((command, args) => command === "obs_all_windows"
      ? (++scans === 1 ? old.promise : Promise.resolve([windows[2]])) : ordinary(command, args));
    const onPreview = vi.fn(async (_value: ObsSelection) => {});
    const view = render(<ObsCaptureControls open disabled={false} onPreview={onPreview} refreshRequest={1}/>);
    await waitFor(() => expect(scans).toBe(1));
    view.rerender(<ObsCaptureControls open disabled={false} onPreview={onPreview} refreshRequest={2}/>);
    await chooseWindow(601);
    await act(async () => old.resolve(windows.slice(0, 2)));
    expect(screen.queryByRole("button", { name: /Window 502$/ })).toBeNull();
    fireEvent.click(previewButton());
    await waitFor(() => expect(onPreview).toHaveBeenCalledExactlyOnceWith({ ...selection, application: windows[2].app, process: 202, window: 601 }));
  });

  it("ignores obsolete errors after refresh and after closing a pending preview", async () => {
    const first = deferred<ObsWindowChoice[]>(); let scans = 0;
    mocks.invoke.mockImplementation((command, args) => command === "obs_all_windows"
      ? (++scans === 1 ? first.promise : Promise.resolve(windows)) : ordinary(command, args));
    const pending = deferred<void>();
    const onPreview = vi.fn((_value: ObsSelection) => pending.promise);
    const view = render(<ObsCaptureControls open disabled={false} onPreview={onPreview}/>);
    await waitFor(() => expect(scans).toBe(1)); fireEvent.focus(window);
    await chooseWindow(); await act(async () => first.reject(new Error("Obsolete list error")));
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(previewButton());
    view.rerender(<ObsCaptureControls open={false} disabled={false} onPreview={onPreview}/>);
    await act(async () => pending.reject(new Error("Obsolete preview error")));
    view.rerender(<ObsCaptureControls open disabled={false} onPreview={onPreview}/>);
    await waitFor(() => expect(previewButton().disabled).toBe(false));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("honors parent disablement and capture unavailability without starting or fetching thumbnails", async () => {
    const onPreview = vi.fn(async () => {});
    const view = render(<ObsCaptureControls open disabled initialSelection={selection} onPreview={onPreview}/>);
    expect(previewButton().disabled).toBe(true); fireEvent.click(previewButton()); expect(onPreview).not.toHaveBeenCalled();
    view.unmount(); mocks.invoke.mockClear();
    mocks.invoke.mockImplementation((command, args) => command === "obs_preflight"
      ? Promise.resolve({ available: false, error: "Generated runtime unavailable" }) : ordinary(command, args));
    render(<ObsCaptureControls open disabled={false} onPreview={onPreview}/>);
    expect((await screen.findByRole("alert")).textContent).toContain("Generated runtime unavailable");
    expect(screen.getByText("Application capture is unavailable in this build.")).toBeTruthy();
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(["obs_preflight"]);
    expect(previewButton().disabled).toBe(true);
  });

  it("bounds snapshots to the visible page and preserves the explicit choice off-page", async () => {
    const choices = Array.from({ length: 11 }, (_, index) => ({ ...windows[index % 3], id: 700 + index }));
    mocks.invoke.mockImplementation((command, args) => command === "obs_all_windows" ? Promise.resolve(choices) : ordinary(command, args));
    render(<ObsCaptureControls open disabled={false} onPreview={vi.fn(async () => {})}/>);
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === "capture_window_thumbnail")).toHaveLength(9));
    await chooseWindow(700); expect(previewButton().disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByRole("button", { name: /Window 710$/ });
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === "capture_window_thumbnail")).toHaveLength(11));
    expect(selectedWindowId()).toBe("700"); expect(previewButton().disabled).toBe(true);
    await chooseWindow(710); expect(previewButton().disabled).toBe(false);
  });
});

describe("truthful and independent capture feedback", () => {
  const permissionError = "Screen recording permission is required to list application windows";
  it.each([permissionError, "Window discovery timed out"])("does not report a failed window lookup as empty: %s", async failure => {
    const first = deferred<ObsWindowChoice[]>();
    mocks.invoke.mockImplementation((command, args) => command === "obs_all_windows" ? first.promise : ordinary(command, args));
    render(<ObsCaptureControls open disabled={false} initialSelection={selection} onPreview={vi.fn(async () => {})}/>);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("obs_all_windows", {}));
    expect(screen.getByText("Finding sources…")).toBeTruthy();
    await act(async () => first.reject(new Error(failure)));
    expect(screen.getByText("Windows could not be loaded. Refresh windows to try again.")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe(failure);
    expect(screen.queryByText("No windows to choose from.")).toBeNull();
    expect(screen.queryByText(/is no longer available/)).toBeNull(); expect(previewButton().disabled).toBe(true);
    const retry = deferred<ObsWindowChoice[]>();
    mocks.invoke.mockImplementation((command, args) => command === "obs_all_windows" ? retry.promise : ordinary(command, args));
    fireEvent.click(refreshButton());
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === "obs_all_windows")).toHaveLength(2));
    expect(screen.getByText(failure)).toBeTruthy();
    await act(async () => retry.resolve([]));
    expect(screen.getByText("No windows to choose from.")).toBeTruthy();
    expect(discoveryStatus()).toContain("No visible windows found"); expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each(["manual", "focus"])("clears only current discovery failure after a successful %s refresh", async method => {
    await selected();
    mocks.invoke.mockImplementation((command, args) => command === "obs_all_windows" ? Promise.reject(new Error(permissionError)) : ordinary(command, args));
    fireEvent.click(refreshButton()); await screen.findByText(permissionError);
    expect(discoveryStatus()).toBe("Window discovery needs attention."); expect(previewButton().disabled).toBe(true);
    mocks.invoke.mockImplementation(ordinary);
    if (method === "focus") fireEvent.focus(window); else fireEvent.click(refreshButton());
    await waitFor(() => expect(previewButton().disabled).toBe(false));
    expect(screen.queryByText(permissionError)).toBeNull(); expect(selectedWindowId()).toBe("502");
  });

  it.each(["failed", "unavailable"])("does not deadlock if newer runtime check is %s while obsolete windows are pending", async state => {
    const old = deferred<ObsWindowChoice[]>();
    mocks.invoke.mockImplementation((command, args) => command === "obs_all_windows" ? old.promise : ordinary(command, args));
    render(<ObsCaptureControls open disabled={false} onPreview={vi.fn(async () => {})}/>);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("obs_all_windows", {}));
    mocks.invoke.mockImplementation((command, args) => command === "obs_preflight"
      ? state === "failed" ? Promise.reject(new Error("Runtime check failed")) : Promise.resolve({ available: false, error: "Runtime unavailable" })
      : ordinary(command, args));
    fireEvent.focus(window);
    await screen.findByRole("alert");
    expect(refreshButton().disabled).toBe(false); expect(previewButton().disabled).toBe(true);
    expect(screen.queryByText("Finding sources…")).toBeNull();
    expect(discoveryStatus()).not.toContain("No visible windows");
    await act(async () => old.resolve(windows));
    expect(screen.queryByRole("button", { name: /Window 502$/ })).toBeNull();
    mocks.invoke.mockImplementation(ordinary); fireEvent.click(refreshButton()); await chooseWindow();
    expect(previewButton().disabled).toBe(false);
  });

  it("keeps discovery and preview errors through unrelated crop edits and failed runtime checks", async () => {
    const onPreview = vi.fn(async (_value: ObsSelection): Promise<void> => { throw new Error("Selected capture could not start"); });
    await selected(onPreview); fireEvent.click(previewButton()); await screen.findByText("Selected capture could not start");
    mocks.invoke.mockImplementation((command, args) => command === "obs_all_windows" ? Promise.reject(new Error(permissionError)) : ordinary(command, args));
    fireEvent.click(refreshButton()); await screen.findByText(permissionError);
    fireEvent.click(screen.getByText("Crop", { selector: "summary" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Height" }), { target: { value: "90" } });
    expect(screen.getByText(permissionError)).toBeTruthy(); expect(screen.getByText("Selected capture could not start")).toBeTruthy();
    mocks.invoke.mockImplementation((command, args) => command === "obs_preflight" ? Promise.reject(new Error("Runtime check failed")) : ordinary(command, args));
    fireEvent.click(refreshButton()); await screen.findByText("Runtime check failed");
    expect(screen.getByText(permissionError)).toBeTruthy();
    mocks.invoke.mockImplementation(ordinary); fireEvent.click(refreshButton());
    await waitFor(() => expect(previewButton().disabled).toBe(false));
    expect(screen.queryByText(permissionError)).toBeNull(); expect(screen.queryByText("Runtime check failed")).toBeNull();
    expect(screen.getByText("Selected capture could not start")).toBeTruthy();
    await chooseWindow(501); expect(screen.getByText("Selected capture could not start")).toBeTruthy();
    const retry = deferred<void>(); onPreview.mockImplementationOnce(() => retry.promise);
    fireEvent.click(previewButton()); expect(screen.queryByText("Selected capture could not start")).toBeNull();
    await act(async () => retry.resolve()); onlyPassiveCommands();
  });
});

it("real source panel restores replacement B and retains its unsent crop across closing", async () => {
  mocks.invoke.mockImplementation((command, args) => {
    if (command === "ndi_discover") return Promise.resolve({ bridgeCompiled: true, runtime: "ready", runtimeVersion: "Generated fixture", sources: [], error: null });
    if (command === "obs_broadcast_status") return Promise.resolve({ sourceId: args.id, attempt: 0, phase: "off", error: null });
    return ordinary(command, args);
  });
  const preview = vi.fn(async (_selection: ObsSelection) => {});
  const source = (id: string, capture: ObsSelection): NdiPreviewInput => ({
    program: null, state: emptyNdiState(),
    previewProgram: { id, name: "Generated window", url: "/generated-not-loaded", reviewKey: "ndi:" + id, local: true, ownerId: "m0", capture },
    previewState: emptyNdiState(), snapshot: { candidate: null, published: null, lease: null, roomSource: null, room: null, busy: null, error: null },
    canShare: false, start: vi.fn(async () => {}), startCapture: preview,
    cancelPreview: vi.fn(async () => {}), share: vi.fn(async () => {}), previewFrameDecoded: vi.fn(), previewPictureFailed: vi.fn(),
  });
  const a = source("a".repeat(32), selection);
  const bSelection: ObsSelection = { application: windows[2].app, process: 202, window: 601, crop: { x: .2, y: .1, width: .6, height: .4 } };
  const b = source("b".repeat(32), bSelection);
  const onClose = vi.fn();
  const view = render(<NdiInputPanel input={a} onClose={onClose}/>);
  await waitFor(() => expect(previewButton().disabled).toBe(false));
  view.rerender(<NdiInputPanel input={b} onClose={onClose}/>);
  await waitFor(() => expect(previewButton().disabled).toBe(false));
  expect(selectedWindowId()).toBe("601");
  fireEvent.click(screen.getByText("Crop", { selector: "summary" }));
  fireEvent.change(screen.getByRole("spinbutton", { name: "Left" }), { target: { value: "30" } });
  view.rerender(<NdiInputPanel input={b} onClose={onClose} open={false}/>);
  view.rerender(<NdiInputPanel input={b} onClose={onClose} open/>);
  await waitFor(() => expect(previewButton().disabled).toBe(false));
  fireEvent.click(screen.getByText("Crop", { selector: "summary" }));
  expect((screen.getByRole("spinbutton", { name: "Left" }) as HTMLInputElement).valueAsNumber).toBe(30);
  expect(preview).not.toHaveBeenCalled(); fireEvent.click(previewButton());
  await waitFor(() => expect(preview).toHaveBeenCalledExactlyOnceWith({ ...bSelection, crop: { ...bSelection.crop, x: .3 } }));
  expect(a.cancelPreview).not.toHaveBeenCalled(); expect(b.cancelPreview).not.toHaveBeenCalled();
  expect(a.share).not.toHaveBeenCalled(); expect(b.share).not.toHaveBeenCalled();
});
