// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ObsDisplayChoice } from "../bindings/ObsDisplayChoice";
import type { ObsDisplaySelection } from "../bindings/ObsDisplaySelection";
import type { ObsSelection } from "../bindings/ObsSelection";
import { ObsCaptureControls } from "./ObsCaptureControls";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
const displays: ObsDisplayChoice[] = [
  { displayUuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", displayId: 10, label: "Generated left display",
    geometry: { x: -1000, y: 0, width: 1000, height: 800, pixelWidth: 2000, pixelHeight: 1600 } },
  { displayUuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", displayId: 20, label: "Generated right display",
    geometry: { x: 0, y: 0, width: 1200, height: 900, pixelWidth: 1200, pixelHeight: 900 } },
];
const selection: ObsDisplaySelection = { kind: "display", displayUuid: displays[0].displayUuid,
  displayId: 10, geometry: { ...displays[0].geometry }, crop: { x: 0, y: 0, width: 1, height: 1 }, audio: false };
const image = "/9j/Z2VuZXJhdGVk";
const previewButton = () => screen.getByRole("button", { name: /^(Preview source|Starting preview…)$/ }) as HTMLButtonElement;
const refreshButton = () => screen.getByRole("button", { name: "Refresh displays" }) as HTMLButtonElement;
const deferred = <T,>() => {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
function ordinary(command: string, args: Record<string, unknown>) {
  if (command === "obs_preflight") return Promise.resolve({ available: true, error: null });
  if (command === "obs_displays") return Promise.resolve(displays);
  if (command === "capture_display_thumbnail") {
    const target = args.selection as ObsDisplaySelection;
    return Promise.resolve({ displayUuid: target.displayUuid, displayId: target.displayId, geometry: target.geometry, thumb: image });
  }
  throw new Error(`Unexpected command: ${command}`);
}
async function choose(id = 10) { fireEvent.click(await screen.findByRole("button", { name: new RegExp(`Display ${id}$`) })); }
const onlyPassive = () => expect(mocks.invoke.mock.calls.every(([command]) =>
  ["obs_preflight", "obs_displays", "capture_display_thumbnail"].includes(command))).toBe(true);
beforeEach(() => { mocks.invoke.mockReset(); mocks.invoke.mockImplementation(ordinary); });
afterEach(cleanup);

describe("private display chooser", () => {
  it.each(["screen", "region"] as const)("keeps %s discovery inert while closed and never chooses a main display", async mode => {
    const onPreview = vi.fn(async () => {});
    const view = render(<ObsCaptureControls mode={mode} open={false} disabled={false} onPreview={onPreview}/>);
    expect(mocks.invoke).not.toHaveBeenCalled();
    view.rerender(<ObsCaptureControls mode={mode} open disabled={false} onPreview={onPreview}/>);
    await screen.findByRole("button", { name: /Display 10$/ });
    expect(document.querySelector('[data-capture-source-id][aria-pressed="true"]')).toBeNull();
    expect(previewButton().disabled).toBe(true); fireEvent.click(previewButton());
    expect(onPreview).not.toHaveBeenCalled();
    const audio = screen.getByRole("checkbox", { name: "Include system audio" }) as HTMLInputElement;
    expect(audio.checked).toBe(false); expect(audio.disabled).toBe(true);
    expect(screen.getByText(/Hides Sauce Bunny's windows and excludes its playback audio/)).toBeTruthy();
    onlyPassive();
  });

  it("submits one independent exact display/geometry selection, with no window IDs or audio", async () => {
    const pending = deferred<void>(), onPreview = vi.fn((_selection: ObsSelection) => pending.promise);
    render(<ObsCaptureControls mode="screen" open disabled={false} onPreview={onPreview}/>);
    await choose(); expect(previewButton().disabled).toBe(false);
    fireEvent.click(previewButton()); fireEvent.click(previewButton());
    expect(onPreview).toHaveBeenCalledExactlyOnceWith(selection);
    const submitted = onPreview.mock.calls[0][0];
    if (!("geometry" in submitted)) throw new Error("Expected display selection");
    expect(submitted.geometry).not.toBe(displays[0].geometry);
    expect(submitted).not.toHaveProperty("window"); expect(submitted).not.toHaveProperty("application");
    submitted.geometry.x = 5; submitted.crop.width = .5;
    expect(displays[0].geometry.x).toBe(-1000);
    await act(async () => pending.resolve()); onlyPassive();
  });

  it.each(["screen", "region"] as const)("keeps %s audio opt-in and local until explicit Preview", async mode => {
    const pending = deferred<void>(), onPreview = vi.fn((_selection: ObsSelection) => pending.promise);
    render(<ObsCaptureControls mode={mode} open disabled={false} onPreview={onPreview}/>);
    await choose();
    const audio = screen.getByRole("checkbox", { name: "Include system audio" }) as HTMLInputElement;
    expect(audio.checked).toBe(false); expect(audio.disabled).toBe(false);
    fireEvent.click(audio);
    expect(audio.checked).toBe(true); expect(onPreview).not.toHaveBeenCalled(); onlyPassive();
    if (mode === "region") {
      fireEvent.change(screen.getByRole("spinbutton", { name: "Width" }), { target: { value: "50" } });
      fireEvent.change(screen.getByRole("spinbutton", { name: "Height" }), { target: { value: "50" } });
      expect(audio.checked).toBe(true);
    }
    await choose(); // Re-clicking the current card must not discard the draft.
    expect(audio.checked).toBe(true);
    expect(previewButton().disabled).toBe(false);
    if (mode === "region") {
      expect((screen.getByRole("spinbutton", { name: "Width" }) as HTMLInputElement).value).toBe("50");
      expect((screen.getByRole("spinbutton", { name: "Height" }) as HTMLInputElement).value).toBe("50");
    }
    expect(onPreview).not.toHaveBeenCalled(); onlyPassive();
    fireEvent.click(previewButton());
    expect(onPreview).toHaveBeenCalledExactlyOnceWith({ ...selection, audio: true,
      crop: mode === "region" ? { x: 0, y: 0, width: .5, height: .5 } : selection.crop });
    expect(audio.disabled).toBe(true);
    fireEvent.click(audio); expect(audio.checked).toBe(true);
    await act(async () => pending.resolve());
    await choose(20); expect(audio.checked).toBe(false); // A new display needs a new audio choice.
    if (mode === "region") expect(previewButton().disabled).toBe(true);
    for (const [, args] of mocks.invoke.mock.calls.filter(([command]) => command === "capture_display_thumbnail")) {
      expect(args.selection.audio).toBe(false); // Snapshots never acquire audio.
    }
  });

  it("retains opted-in audio in an existing Region draft after reopening", async () => {
    const initialSelection = { ...selection, audio: true, crop: { x: .1, y: .2, width: .3, height: .4 } };
    const onPreview = vi.fn(async () => {});
    const view = render(<ObsCaptureControls mode="region" open disabled={false} initialSelection={initialSelection} onPreview={onPreview}/>);
    await waitFor(() => expect(previewButton().disabled).toBe(false));
    view.rerender(<ObsCaptureControls mode="region" open={false} disabled={false} initialSelection={initialSelection} onPreview={onPreview}/>);
    view.rerender(<ObsCaptureControls mode="region" open disabled={false} initialSelection={initialSelection} onPreview={onPreview}/>);
    await waitFor(() => expect(previewButton().disabled).toBe(false));
    expect((screen.getByRole("checkbox", { name: "Include system audio" }) as HTMLInputElement).checked).toBe(true);
    expect(onPreview).not.toHaveBeenCalled(); onlyPassive();
  });

  it("requires an explicit valid Region and clearing it never becomes full-screen capture", async () => {
    const onPreview = vi.fn(async (_selection: ObsSelection) => {});
    render(<ObsCaptureControls mode="region" open disabled={false} onPreview={onPreview}/>);
    await choose(); expect(previewButton().disabled).toBe(true);
    const change = (name: string, value: string) => fireEvent.change(screen.getByRole("spinbutton", { name }), { target: { value } });
    change("Width", "1.6"); change("Height", "50");
    expect(previewButton().disabled).toBe(true); // 16 logical points remains too small on Retina.
    change("Left", "10"); change("Top", "20"); change("Width", "50");
    expect(previewButton().disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(previewButton().disabled).toBe(true); expect(onPreview).not.toHaveBeenCalled();
    change("Left", "10"); change("Top", "20"); change("Width", "50"); change("Height", "50");
    fireEvent.click(previewButton());
    await waitFor(() => expect(onPreview).toHaveBeenCalledExactlyOnceWith({ ...selection, crop: { x: .1, y: .2, width: .5, height: .5 } }));
    const snapshotCalls = mocks.invoke.mock.calls.filter(([command]) => command === "capture_display_thumbnail");
    expect(snapshotCalls).toHaveLength(2);
    for (const [, args] of snapshotCalls) expect(args.selection).toMatchObject({ crop: { x: 0, y: 0, width: 1, height: 1 }, audio: false });
  });

  it.each(["displayUuid", "displayId", "x", "y", "width", "height", "pixelWidth", "pixelHeight", "missing"])("rejects stale display %s without choosing its replacement", async field => {
    const onPreview = vi.fn(async () => {});
    render(<ObsCaptureControls mode="screen" open disabled={false} initialSelection={selection} onPreview={onPreview}/>);
    await waitFor(() => expect(previewButton().disabled).toBe(false));
    const old = displays[0];
    const changed = field === "displayUuid" ? { ...old, displayUuid: displays[1].displayUuid }
      : field === "displayId" ? { ...old, displayId: 100 }
        : { ...old, geometry: { ...old.geometry, [field]: 999 } };
    mocks.invoke.mockImplementation((command, args) => command === "obs_displays" ? Promise.resolve(field === "missing" ? [] : [changed]) : ordinary(command, args));
    fireEvent.click(refreshButton()); await screen.findByText(/arrangement changed/);
    expect(previewButton().disabled).toBe(true); fireEvent.click(previewButton());
    expect(onPreview).not.toHaveBeenCalled(); expect(document.querySelector('[data-capture-source-id][aria-pressed="true"]')).toBeNull();
    onlyPassive();
  });

  it.each(["Permission denied", "Display discovery timed out"])("preserves %s as an error, then permits an explicit refresh", async message => {
    const pending = deferred<ObsDisplayChoice[]>();
    mocks.invoke.mockImplementation((command, args) => command === "obs_displays" ? pending.promise : ordinary(command, args));
    render(<ObsCaptureControls mode="screen" open disabled={false} onPreview={vi.fn(async () => {})}/>);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("obs_displays", {}));
    expect(screen.getByText("Finding sources…")).toBeTruthy();
    await act(async () => pending.reject(new Error(message)));
    expect(screen.getByRole("alert").textContent).toBe(message);
    expect(screen.getByText("Displays could not be loaded. Refresh displays to try again.")).toBeTruthy();
    expect(screen.queryByText("No displays to choose from.")).toBeNull(); expect(previewButton().disabled).toBe(true);
    mocks.invoke.mockImplementation((command, args) => command === "obs_displays" ? Promise.resolve([]) : ordinary(command, args));
    fireEvent.click(refreshButton()); await screen.findByText("No displays to choose from.");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the Region and exact display across reopening, but respects parent busy", async () => {
    const initialSelection = { ...selection, crop: { x: .1, y: .2, width: .3, height: .4 } };
    const onPreview = vi.fn(async () => {});
    const view = render(<ObsCaptureControls mode="region" open disabled={false} initialSelection={initialSelection} onPreview={onPreview}/>);
    await waitFor(() => expect(previewButton().disabled).toBe(false));
    view.rerender(<ObsCaptureControls mode="region" open={false} disabled={false} initialSelection={initialSelection} onPreview={onPreview}/>);
    view.rerender(<ObsCaptureControls mode="region" open disabled initialSelection={initialSelection} onPreview={onPreview}/>);
    expect((screen.getByRole("spinbutton", { name: "Left" }) as HTMLInputElement).value).toBe("10");
    expect(previewButton().disabled).toBe(true); fireEvent.click(previewButton()); expect(onPreview).not.toHaveBeenCalled();
  });

  it("rejects a snapshot for the right ID with a different geometry while leaving metadata selectable", async () => {
    mocks.invoke.mockImplementation((command, args) => command === "capture_display_thumbnail"
      ? Promise.resolve({ ...displays[0], geometry: { ...displays[0].geometry, x: 9 }, thumb: image }) : ordinary(command, args));
    render(<ObsCaptureControls mode="screen" open disabled={false} onPreview={vi.fn(async () => {})}/>);
    await choose(); await screen.findByText(/Snapshot unavailable: The display changed/);
    expect(document.querySelector("img")).toBeNull(); expect(previewButton().disabled).toBe(false);
  });

  it("ignores old discovery and thumbnail results after closing and reopening", async () => {
    const first = deferred<ObsDisplayChoice[]>(); let scans = 0;
    mocks.invoke.mockImplementation((command, args) => command === "obs_displays"
      ? ++scans === 1 ? first.promise : Promise.resolve([displays[1]]) : ordinary(command, args));
    const onPreview = vi.fn(async () => {});
    const view = render(<ObsCaptureControls mode="screen" open disabled={false} onPreview={onPreview}/>);
    await waitFor(() => expect(scans).toBe(1));
    view.rerender(<ObsCaptureControls mode="screen" open={false} disabled={false} onPreview={onPreview}/>);
    view.rerender(<ObsCaptureControls mode="screen" open disabled={false} onPreview={onPreview}/>);
    await choose(20); await act(async () => first.resolve(displays));
    expect(screen.queryByRole("button", { name: /Display 10$/ })).toBeNull();
    expect(previewButton().disabled).toBe(false);
  });

  it("stops a queued snapshot page on close and rejects late preview feedback", async () => {
    const snapshot = deferred<unknown>(), pending = deferred<void>();
    const many = Array.from({ length: 10 }, (_, index) => ({ ...displays[0], displayId: 100 + index }));
    mocks.invoke.mockImplementation((command, args) => command === "obs_displays" ? Promise.resolve(many)
      : command === "capture_display_thumbnail" ? snapshot.promise : ordinary(command, args));
    const onPreview = vi.fn(() => pending.promise);
    const view = render(<ObsCaptureControls mode="screen" open disabled={false} onPreview={onPreview}/>);
    await choose(100); fireEvent.click(previewButton());
    await waitFor(() => expect(mocks.invoke.mock.calls.filter(([command]) => command === "capture_display_thumbnail")).toHaveLength(2));
    view.rerender(<ObsCaptureControls mode="screen" open={false} disabled={false} onPreview={onPreview}/>);
    await act(async () => { snapshot.resolve({ ...many[0], thumb: image }); pending.reject(new Error("Old request failed")); });
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "capture_display_thumbnail")).toHaveLength(2);
    mocks.invoke.mockImplementation(ordinary);
    view.rerender(<ObsCaptureControls mode="screen" open disabled={false} onPreview={onPreview}/>);
    await screen.findByRole("button", { name: /Display 10$/ });
    expect(screen.queryByText("Old request failed")).toBeNull(); onlyPassive();
  });
});
