// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ObsApplication } from "../bindings/ObsApplication";
import type { ObsSelection } from "../bindings/ObsSelection";
import type { ObsWindow } from "../bindings/ObsWindow";
import { emptyNdiState } from "../hooks/use-ndi-input";
import { ObsCaptureControls } from "./ObsCaptureControls";
import { NdiInputPanel, type NdiPreviewInput } from "./NdiInputPanel";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
const applications: ObsApplication[] = [
  { app: "test.generated.alpha", pid: 101, name: "Generated Alpha" },
  { app: "test.generated.beta", pid: 202, name: "Generated Beta" },
];
const windows: ObsWindow[] = [
  { app: applications[0].app, pid: 101, id: 501, title: "Timeline", width: 640, height: 360 },
  { app: applications[0].app, pid: 101, id: 502, title: "Timeline", width: 320, height: 180 },
];
const betaWindow: ObsWindow = { app: applications[1].app, pid: 202, id: 601, title: "Generated Beta picture", width: 800, height: 600 };
const selection: ObsSelection = { application: applications[0].app, process: 101, window: 502,
  crop: { x: 0, y: 0, width: 1, height: 1 } };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function ordinary(command: string, args?: { application?: string }) {
  if (command === "obs_preflight") return Promise.resolve({ available: true, error: null });
  if (command === "obs_applications") return Promise.resolve(applications);
  if (command === "obs_windows") return Promise.resolve(args?.application === applications[1].app ? [betaWindow] : windows);
  throw new Error(`Unexpected native mutation in capture controls: ${command}`);
}
const applicationSelect = () => screen.getByRole("combobox", { name: "Application" }) as HTMLSelectElement;
const windowSelect = () => screen.getByRole("combobox", { name: "Window" }) as HTMLSelectElement;
const previewButton = () => screen.getByRole("button", { name: /^(Preview source|Starting preview…)$/ }) as HTMLButtonElement;
async function chooseApplication(name = "Generated Alpha") {
  const option = await screen.findByRole("option", { name: new RegExp(name) }) as HTMLOptionElement;
  fireEvent.change(applicationSelect(), { target: { value: option.value } });
}
async function chooseWindow(id = 502) {
  await waitFor(() => expect(Array.from(windowSelect().options).some(option => option.value === String(id))).toBe(true));
  const option = Array.from(windowSelect().options).find(option => option.value === String(id))!;
  fireEvent.change(windowSelect(), { target: { value: option.value } });
}
async function selected(onPreview = vi.fn(async (_value: ObsSelection) => {})) {
  const mounted = render(<ObsCaptureControls open disabled={false} onPreview={onPreview}/>);
  await chooseApplication(); await chooseWindow();
  await waitFor(() => expect(previewButton().disabled).toBe(false));
  return { ...mounted, onPreview };
}
function onlyPassiveCommands() {
  expect(mocks.invoke.mock.calls.every(([command]) => ["obs_preflight", "obs_applications", "obs_windows"].includes(command))).toBe(true);
}
beforeEach(() => { mocks.invoke.mockReset(); mocks.invoke.mockImplementation(ordinary); });
afterEach(cleanup);

describe("explicit application preview controls", () => {
  it("does nothing while closed and never starts capture during discovery or focus", async () => {
    const onPreview = vi.fn(async () => {});
    const view = render(<ObsCaptureControls open={false} disabled={false} onPreview={onPreview}/>);
    expect(mocks.invoke).not.toHaveBeenCalled();
    view.rerender(<ObsCaptureControls open disabled={false} onPreview={onPreview}/>);
    await screen.findByRole("option", { name: /Generated Alpha/ });
    expect(applicationSelect().value).toBe("");
    expect(windowSelect().value).toBe("");
    expect(previewButton().disabled).toBe(true);
    fireEvent.focus(window);
    fireEvent.click(screen.getByRole("button", { name: "Refresh applications" }));
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === "obs_applications").length).toBeGreaterThan(1));
    onlyPassiveCommands(); expect(onPreview).not.toHaveBeenCalled();
  });

  it("distinguishes same-title windows and previews only the exact explicit process/window tuple", async () => {
    const onPreview = vi.fn(async () => {});
    render(<ObsCaptureControls open disabled={false} onPreview={onPreview}/>);
    await chooseApplication();
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("obs_windows", { application: applications[0].app }));
    expect(windowSelect().value).toBe("");
    expect(previewButton().disabled).toBe(true);
    await chooseWindow(502);
    const options = within(windowSelect()).getAllByRole("option");
    for (const window of windows) {
      const option = options.find(value => value.textContent?.includes(String(window.id)))!;
      expect(option.textContent).toContain(window.title);
      expect(option.textContent).toContain(String(window.width));
      expect(option.textContent).toContain(String(window.height));
    }
    expect(onPreview).not.toHaveBeenCalled();
    fireEvent.click(previewButton());
    await waitFor(() => expect(onPreview).toHaveBeenCalledExactlyOnceWith(selection));
    onlyPassiveCommands();
  });

  it("restores an exact selection and crop without automatically previewing on reopen", async () => {
    const initialSelection = { ...selection, crop: { x: .1, y: .2, width: .5, height: .6 } };
    const onPreview = vi.fn(async () => {});
    const props = { disabled: false, initialSelection, onPreview };
    const view = render(<ObsCaptureControls {...props} open/>);
    await waitFor(() => expect(previewButton().disabled).toBe(false));
    const app = applicationSelect().value, window = windowSelect().value;
    fireEvent.click(screen.getByText("Crop", { selector: "summary" }));
    for (const [name, value] of [["Left", 10], ["Top", 20], ["Width", 50], ["Height", 60]] as const) {
      expect((screen.getByRole("spinbutton", { name: new RegExp(`^${name}`) }) as HTMLInputElement).valueAsNumber).toBe(value);
    }
    view.rerender(<ObsCaptureControls {...props} open={false}/>);
    view.rerender(<ObsCaptureControls {...props} open/>);
    await waitFor(() => expect(previewButton().disabled).toBe(false));
    expect(applicationSelect().value).toBe(app); expect(windowSelect().value).toBe(window);
    expect(onPreview).not.toHaveBeenCalled();
    fireEvent.click(previewButton());
    await waitFor(() => expect(onPreview).toHaveBeenCalledExactlyOnceWith(initialSelection));
    onlyPassiveCommands();
  });

  it("hands off an independent selection and crop snapshot while preview is pending", async () => {
    const pending = deferred<void>();
    const initialSelection = { ...selection, crop: { x: .1, y: .2, width: .5, height: .6 } };
    const onPreview = vi.fn((_value: ObsSelection) => pending.promise);
    render(<ObsCaptureControls open disabled={false} initialSelection={initialSelection} onPreview={onPreview}/>);
    await waitFor(() => expect(previewButton().disabled).toBe(false));
    fireEvent.click(previewButton());
    const submitted = onPreview.mock.calls[0][0];
    expect(submitted).toEqual(initialSelection);
    expect(submitted).not.toBe(initialSelection);
    expect(submitted.crop).not.toBe(initialSelection.crop);
    initialSelection.crop.x = .2;
    submitted.crop.y = .3;
    submitted.window = 501;
    expect(submitted.crop.x).toBe(.1);
    expect(initialSelection.crop.y).toBe(.2);
    expect(initialSelection.window).toBe(502);
    await act(async () => pending.resolve());
    onlyPassiveCommands();
  });

  it("normalizes crop percentages and blocks empty or out-of-bounds rectangles", async () => {
    const { onPreview } = await selected();
    fireEvent.click(screen.getByText("Crop", { selector: "summary" }));
    const change = (name: string, value: string) => fireEvent.change(screen.getByRole("spinbutton", { name: new RegExp(`^${name}`) }), { target: { value } });
    change("Left", "90"); change("Width", "50");
    expect(previewButton().disabled).toBe(true); fireEvent.click(previewButton());
    change("Left", "25"); change("Width", "0");
    expect(previewButton().disabled).toBe(true); fireEvent.click(previewButton());
    change("Width", "50"); change("Top", "");
    expect(previewButton().disabled).toBe(true); fireEvent.click(previewButton());
    expect(onPreview).not.toHaveBeenCalled();
    change("Top", "10"); change("Height", "80");
    expect(previewButton().disabled).toBe(false); fireEvent.click(previewButton());
    await waitFor(() => expect(onPreview).toHaveBeenCalledExactlyOnceWith({ ...selection, crop: { x: .25, y: .1, width: .5, height: .8 } }));
  });

  it("keeps a disappeared window unavailable instead of switching to the other same-title window", async () => {
    const { onPreview } = await selected();
    const exact = windowSelect().value;
    mocks.invoke.mockImplementation((command, args) => command === "obs_windows" ? Promise.resolve([windows[0]]) : ordinary(command, args));
    fireEvent.click(screen.getByRole("button", { name: "Refresh windows" }));
    await waitFor(() => expect(previewButton().disabled).toBe(true));
    await waitFor(() => expect((screen.getByRole("button", { name: "Refresh windows" }) as HTMLButtonElement).disabled).toBe(false));
    expect(windowSelect().value).toBe(exact);
    fireEvent.click(previewButton());
    expect(onPreview).not.toHaveBeenCalled(); onlyPassiveCommands();
  });

  it("never restores an old window into a restarted process with the same app identifier", async () => {
    const onPreview = vi.fn(async () => {});
    mocks.invoke.mockImplementation((command, args) => {
      if (command === "obs_applications") return Promise.resolve([{ ...applications[0], pid: 999 }]);
      if (command === "obs_windows") return Promise.resolve(windows.map(window => ({ ...window, pid: 999 })));
      return ordinary(command, args);
    });
    render(<ObsCaptureControls open disabled={false} initialSelection={selection} onPreview={onPreview}/>);
    await screen.findByRole("option", { name: /Generated Alpha/ });
    expect(previewButton().disabled).toBe(true);
    fireEvent.click(previewButton());
    expect(onPreview).not.toHaveBeenCalled(); onlyPassiveCommands();
  });

  it("ignores late windows from the previously selected application", async () => {
    const alpha = deferred<ObsWindow[]>();
    mocks.invoke.mockImplementation((command, args) => command === "obs_windows" && args?.application === applications[0].app
      ? alpha.promise : ordinary(command, args));
    const onPreview = vi.fn(async () => {});
    render(<ObsCaptureControls open disabled={false} onPreview={onPreview}/>);
    await chooseApplication(); await chooseApplication("Generated Beta"); await chooseWindow(601);
    await act(async () => alpha.resolve(windows));
    expect(within(windowSelect()).queryByRole("option", { name: /Timeline/ })).toBeNull();
    fireEvent.click(previewButton());
    await waitFor(() => expect(onPreview).toHaveBeenCalledExactlyOnceWith({ application: applications[1].app,
      process: 202, window: 601, crop: selection.crop }));
  });

  it("ignores obsolete application discovery after an explicit refresh request", async () => {
    const first = deferred<ObsApplication[]>(); let discoveries = 0;
    mocks.invoke.mockImplementation((command, args) => command === "obs_applications"
      ? (++discoveries === 1 ? first.promise : Promise.resolve([applications[1]])) : ordinary(command, args));
    const onPreview = vi.fn(async () => {});
    const view = render(<ObsCaptureControls open disabled={false} onPreview={onPreview} refreshRequest={1}/>);
    await waitFor(() => expect(discoveries).toBe(1));
    view.rerender(<ObsCaptureControls open disabled={false} onPreview={onPreview} refreshRequest={2}/>);
    await screen.findByRole("option", { name: /Generated Beta/ });
    await act(async () => first.resolve([applications[0]]));
    expect(screen.queryByRole("option", { name: /Generated Alpha/ })).toBeNull();
    expect(applicationSelect().value).toBe(""); expect(onPreview).not.toHaveBeenCalled();
  });

  it("does not submit a second preview while the explicit request is pending and surfaces failure", async () => {
    const pending = deferred<void>();
    const onPreview = vi.fn((_value: ObsSelection) => pending.promise);
    await selected(onPreview);
    fireEvent.click(previewButton()); fireEvent.click(previewButton());
    expect(onPreview).toHaveBeenCalledExactlyOnceWith(selection);
    expect(previewButton().disabled).toBe(true);
    await act(async () => pending.reject(new Error("Selected window closed")));
    expect((await screen.findByRole("alert")).textContent).toContain("Selected window closed");
    expect(windowSelect().value).not.toBe(""); onlyPassiveCommands();
  });

  it("honors parent disablement and unavailable native preflight without starting a source", async () => {
    const onPreview = vi.fn(async () => {});
    const view = render(<ObsCaptureControls open disabled initialSelection={selection} onPreview={onPreview}/>);
    expect(previewButton().disabled).toBe(true); fireEvent.click(previewButton());
    expect(onPreview).not.toHaveBeenCalled();
    view.unmount();
    mocks.invoke.mockImplementation((command, args) => command === "obs_preflight"
      ? Promise.resolve({ available: false, error: "Generated runtime unavailable" }) : ordinary(command, args));
    render(<ObsCaptureControls open disabled={false} onPreview={onPreview}/>);
    expect((await screen.findByRole("alert")).textContent).toContain("Generated runtime unavailable");
    expect(previewButton().disabled).toBe(true); expect(onPreview).not.toHaveBeenCalled(); onlyPassiveCommands();
  });

  it("the real panel restores replacement B rather than A and retains B's unsent crop across closing", async () => {
    mocks.invoke.mockImplementation((command, args) => {
      if (command === "ndi_discover") return Promise.resolve({ bridgeCompiled: true, runtime: "ready", runtimeVersion: "Generated fixture", sources: [], error: null });
      if (command === "obs_broadcast_status") return Promise.resolve({ sourceId: args.id, attempt: 0, phase: "off", error: null });
      return ordinary(command, args);
    });
    const preview = vi.fn(async (_selection: ObsSelection) => {});
    const source = (id: string, capture: ObsSelection): NdiPreviewInput => ({
      program: null, state: emptyNdiState(),
      previewProgram: { id, name: "Generated window", url: "/generated-not-loaded", reviewKey: `ndi:${id}`, local: true, ownerId: "m0", capture },
      previewState: emptyNdiState(), snapshot: { candidate: null, published: null, lease: null, roomSource: null, room: null, busy: null, error: null },
      canShare: false, start: vi.fn(async () => {}), startCapture: preview,
      cancelPreview: vi.fn(async () => {}), share: vi.fn(async () => {}), previewFrameDecoded: vi.fn(), previewPictureFailed: vi.fn(),
    });
    const a = source("a".repeat(32), selection);
    const bSelection: ObsSelection = { application: applications[1].app, process: 202, window: 601, crop: { x: .2, y: .1, width: .6, height: .4 } };
    const b = source("b".repeat(32), bSelection);
    const onClose = vi.fn();
    const view = render(<NdiInputPanel input={a} onClose={onClose}/>);
    await waitFor(() => expect(previewButton().disabled).toBe(false));
    view.rerender(<NdiInputPanel input={b} onClose={onClose}/>);
    await waitFor(() => expect(previewButton().disabled).toBe(false));
    expect(windowSelect().value).toBe("601");
    expect(applicationSelect().value).toContain(applications[1].app);
    fireEvent.click(screen.getByText("Crop", { selector: "summary" }));
    for (const [name, value] of [["Left", 20], ["Top", 10], ["Width", 60], ["Height", 40]] as const) {
      expect((screen.getByRole("spinbutton", { name }) as HTMLInputElement).valueAsNumber).toBe(value);
    }
    fireEvent.change(screen.getByRole("spinbutton", { name: "Left" }), { target: { value: "30" } });
    view.rerender(<NdiInputPanel input={b} onClose={onClose} open={false}/>);
    view.rerender(<NdiInputPanel input={b} onClose={onClose} open/>);
    await waitFor(() => expect(previewButton().disabled).toBe(false));
    fireEvent.click(screen.getByText("Crop", { selector: "summary" }));
    expect((screen.getByRole("spinbutton", { name: "Left" }) as HTMLInputElement).valueAsNumber).toBe(30);
    expect(preview).not.toHaveBeenCalled();
    fireEvent.click(previewButton());
    await waitFor(() => expect(preview).toHaveBeenCalledExactlyOnceWith({ ...bSelection, crop: { ...bSelection.crop, x: .3 } }));
    expect(a.cancelPreview).not.toHaveBeenCalled(); expect(b.cancelPreview).not.toHaveBeenCalled();
    expect(a.share).not.toHaveBeenCalled(); expect(b.share).not.toHaveBeenCalled();
  });
});
