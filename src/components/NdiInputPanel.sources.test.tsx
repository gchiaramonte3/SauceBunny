// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ObsSelection } from "../bindings/ObsSelection";
import type { ObsDisplaySelection } from "../bindings/ObsDisplaySelection";
import type { ObsDisplayChoice } from "../bindings/ObsDisplayChoice";
import { emptyNdiTelemetry, type NdiLocalProgram } from "../lib/ndi-program-coordinator";
import { NdiInputPanel, type NdiPreviewInput } from "./NdiInputPanel";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
const displays: ObsDisplayChoice[] = [
  { displayUuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", displayId: 10, label: "Generated left display",
    geometry: { x: -1000, y: 0, width: 1000, height: 800, pixelWidth: 2000, pixelHeight: 1600 } },
  { displayUuid: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", displayId: 20, label: "Generated right display",
    geometry: { x: 0, y: 0, width: 1200, height: 900, pixelWidth: 1200, pixelHeight: 900 } },
];
const windowSelection: ObsSelection = { application: "com.generated.Editor", process: 101, window: 501,
  crop: { x: 0, y: 0, width: 1, height: 1 }, audio: false };
const regionSelection: ObsDisplaySelection = { kind: "display", displayUuid: displays[1].displayUuid, displayId: 20,
  geometry: { ...displays[1].geometry }, crop: { x: .1, y: .2, width: .4, height: .5 }, audio: false };
function ordinary(command: string, args: Record<string, unknown>) {
  if (command === "ndi_discover") return Promise.resolve({ bridgeCompiled: true, runtime: "ready", sources: [{ name: "Generated NDI" }], error: null });
  if (command === "obs_preflight") return Promise.resolve({ available: true, error: null });
  if (command === "obs_displays") return Promise.resolve(displays);
  if (command === "obs_all_windows") return Promise.resolve([{ app: "com.generated.Editor", pid: 101, id: 501,
    applicationName: "Generated editor", title: "Composer", width: 1000, height: 800 }]);
  if (command === "capture_display_thumbnail") return Promise.resolve({ ...(args.selection as ObsDisplaySelection), thumb: "/9j/Z2VuZXJhdGVk" });
  if (command === "capture_window_thumbnail") return Promise.resolve({ ...args, thumb: "/9j/Z2VuZXJhdGVk" });
  throw new Error(`Unexpected command: ${command}`);
}
function input(): NdiPreviewInput {
  return { previewProgram: null, program: null, state: emptyNdiTelemetry(), previewState: emptyNdiTelemetry(),
    snapshot: { candidate: null, published: null, lease: null, roomSource: null, room: null, busy: null, error: null },
    canShare: false, start: vi.fn(async () => {}), startCapture: vi.fn(async () => {}),
    cancelPreview: vi.fn(async () => {}), share: vi.fn(async () => {}), previewFrameDecoded: vi.fn(), previewPictureFailed: vi.fn() };
}
function candidate(id: string, capture: ObsSelection, ready = false): NdiLocalProgram {
  return { id, name: "Generated capture", url: "/generated-not-loaded", reviewKey: "generated:" + id,
    capture, source: { kind: "capture", selection: capture }, telemetry: { ...emptyNdiTelemetry(), phase: "live", connectionCount: 1 },
    decodedReady: ready, encodedReady: ready, retired: false, roomGeneration: null };
}
const tab = (name: string) => screen.getByRole("tab", { name }) as HTMLButtonElement;
const preview = () => screen.getByRole("button", { name: /^(Preview source|Starting preview…)$/ }) as HTMLButtonElement;
const chooseDisplay = async (id: number) => fireEvent.click(await screen.findByRole("button", { name: new RegExp(`Display ${id}$`) }));
const changeField = (name: string, value: number) => fireEvent.change(screen.getByRole("spinbutton", { name }), { target: { value: String(value) } });
const fieldValue = (name: string) => (screen.getByRole("spinbutton", { name }) as HTMLInputElement).valueAsNumber;
beforeEach(() => { localStorage.clear(); mocks.invoke.mockReset(); mocks.invoke.mockImplementation(ordinary); });
afterEach(cleanup);

describe("one private source chooser", () => {
  it("applies each explicit source-category request once without starting capture or discarding drafts", async () => {
    const source = input(), onClose = vi.fn();
    const view = render(<NdiInputPanel input={source} onClose={onClose} open={false}
      sourceRequest={{ kind: "region", serial: 1 }}/>);
    expect(screen.queryByRole("dialog")).toBeNull();
    view.rerender(<NdiInputPanel input={source} onClose={onClose} sourceRequest={{ kind: "region", serial: 1 }}/>);
    expect(tab("Region").getAttribute("aria-selected")).toBe("true");
    await chooseDisplay(20); changeField("Width", 40); changeField("Height", 50);
    fireEvent.click(tab("Window"));
    view.rerender(<NdiInputPanel input={source} onClose={onClose} sourceRequest={{ kind: "region", serial: 1 }}/>);
    expect(tab("Window").getAttribute("aria-selected")).toBe("true");
    view.rerender(<NdiInputPanel input={source} onClose={onClose} sourceRequest={{ kind: "region", serial: 2 }}/>);
    expect(tab("Region").getAttribute("aria-selected")).toBe("true");
    await waitFor(() => expect(preview().disabled).toBe(false));
    expect(fieldValue("Width")).toBe(40); expect(fieldValue("Height")).toBe(50);
    for (const [serial, kind] of [[3, "screen"], [4, "window"], [5, "ndi"]] as const) {
      view.rerender(<NdiInputPanel input={source} onClose={onClose} sourceRequest={{ kind, serial }}/>);
      expect(tab(kind === "ndi" ? "NDI" : kind === "screen" ? "Screen" : "Window").getAttribute("aria-selected")).toBe("true");
    }
    await screen.findByRole("option", { name: "Generated NDI" });
    expect(source.startCapture).not.toHaveBeenCalled(); expect(source.start).not.toHaveBeenCalled();
    expect(source.share).not.toHaveBeenCalled(); expect(source.cancelPreview).not.toHaveBeenCalled();
  });

  it.each(["Window", "Screen", "Region"])("shows a %s startup failure once when the coordinator reports the same error", async mode => {
    const source = input(), onClose = vi.fn(), message = "The captured source changed. Choose the source again.";
    source.startCapture = vi.fn(async () => { throw new Error(message); });
    const view = render(<NdiInputPanel input={source} onClose={onClose}/>);
    fireEvent.click(tab(mode));
    if (mode === "Window") fireEvent.click(await screen.findByRole("button", { name: /Window 501$/ }));
    else { await chooseDisplay(20); if (mode === "Region") { changeField("Width", 40); changeField("Height", 50); } }
    fireEvent.click(preview());
    await screen.findByText(message);
    source.snapshot = { ...source.snapshot, error: message };
    view.rerender(<NdiInputPanel input={source} onClose={onClose}/>);
    expect(screen.getAllByText(message)).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toBe(message);
    // A distinct failure of the existing picture must not hide the startup failure.
    source.snapshot = { ...source.snapshot, error: "The previous picture disconnected." };
    view.rerender(<NdiInputPanel input={source} onClose={onClose}/>);
    expect(screen.getAllByRole("alert")).toHaveLength(2);
    expect(screen.getByText(message)).toBeTruthy();
    expect(source.share).not.toHaveBeenCalled(); expect(source.cancelPreview).not.toHaveBeenCalled();
  });

  it("does not let an earlier capture startup replace a newly requested source category", async () => {
    const source = input(), onClose = vi.fn();
    let complete!: () => void;
    source.startCapture = vi.fn(() => new Promise<void>(done => { complete = done; }));
    const view = render(<NdiInputPanel input={source} onClose={onClose} sourceRequest={{ kind: "window", serial: 1 }}/>);
    fireEvent.click(await screen.findByRole("button", { name: /Window 501$/ }));
    fireEvent.click(preview());
    view.rerender(<NdiInputPanel input={source} onClose={onClose} sourceRequest={{ kind: "region", serial: 2 }}/>);
    const window = candidate("earlier-window", windowSelection, true);
    source.snapshot = { ...source.snapshot, candidate: window };
    source.previewProgram = { ...window, local: true, ownerId: "generated" };
    view.rerender(<NdiInputPanel input={source} onClose={onClose} sourceRequest={{ kind: "region", serial: 2 }}/>);
    await act(async () => complete());
    expect(tab("Region").getAttribute("aria-selected")).toBe("true");
    expect(onClose).not.toHaveBeenCalled(); expect(source.share).not.toHaveBeenCalled();
  });

  it("exposes four top tabs with roving keyboard focus and the matching labelled panel", async () => {
    const source = input(); render(<NdiInputPanel input={source} onClose={vi.fn()}/>);
    expect(screen.getAllByRole("tab").map(item => item.textContent)).toEqual(["NDI", "Screen", "Window", "Region"]);
    expect(screen.getByRole("dialog", { name: "Source settings" })).toBeTruthy();
    expect(tab("NDI").tabIndex).toBe(0); expect(tab("Window").tabIndex).toBe(-1);
    tab("NDI").focus(); fireEvent.keyDown(tab("NDI"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(tab("Screen")); expect(tab("Screen").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel", { name: "Screen" }).id).toBe(tab("Screen").getAttribute("aria-controls"));
    fireEvent.keyDown(tab("Screen"), { key: "End" }); expect(document.activeElement).toBe(tab("Region"));
    fireEvent.keyDown(tab("Region"), { key: "ArrowLeft" }); expect(document.activeElement).toBe(tab("Window"));
    expect(screen.queryByRole("combobox", { name: /application/i })).toBeNull();
    fireEvent.keyDown(tab("Window"), { key: "Home" }); expect(document.activeElement).toBe(tab("NDI"));
    await screen.findByRole("option", { name: "Generated NDI" });
    expect(source.startCapture).not.toHaveBeenCalled(); expect(source.start).not.toHaveBeenCalled(); expect(source.share).not.toHaveBeenCalled();
  });

  it("retains independent NDI, screen, window crop/audio, and region drafts across tabs and reopening", async () => {
    const source = input(), onClose = vi.fn();
    const view = render(<NdiInputPanel input={source} onClose={onClose}/>);
    await screen.findByRole("option", { name: "Generated NDI" });
    fireEvent.change(screen.getByRole("combobox", { name: "NDI source" }), { target: { value: "Generated NDI" } });
    fireEvent.click(tab("Window")); fireEvent.click(await screen.findByRole("button", { name: /Window 501$/ }));
    fireEvent.click(screen.getByText("Crop", { selector: "summary" })); changeField("Left", 10); changeField("Width", 50);
    fireEvent.click(screen.getByRole("checkbox", { name: "Include application audio" }));
    fireEvent.click(tab("Region")); await chooseDisplay(20);
    changeField("Left", 20); changeField("Top", 10); changeField("Width", 40); changeField("Height", 60);
    fireEvent.click(tab("Screen")); await chooseDisplay(10); expect(preview().disabled).toBe(false);
    fireEvent.click(tab("Region")); await waitFor(() => expect(preview().disabled).toBe(false));
    expect(fieldValue("Left")).toBe(20); expect(fieldValue("Height")).toBe(60);
    expect(screen.getByRole("status", { name: "Selected display" }).textContent).toContain("Display 20");
    fireEvent.click(tab("Window")); await waitFor(() => expect(preview().disabled).toBe(false));
    fireEvent.click(screen.getByText("Crop", { selector: "summary" }));
    expect(fieldValue("Left")).toBe(10); expect(fieldValue("Width")).toBe(50);
    expect((screen.getByRole("checkbox", { name: "Include application audio" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(tab("Screen")); await waitFor(() => expect(preview().disabled).toBe(false));
    expect(screen.getByRole("status", { name: "Selected display" }).textContent).toContain("Display 10");
    expect(screen.queryByRole("spinbutton")).toBeNull();
    view.rerender(<NdiInputPanel input={source} onClose={onClose} open={false}/>);
    view.rerender(<NdiInputPanel input={source} onClose={onClose}/>);
    await waitFor(() => expect(preview().disabled).toBe(false));
    expect(tab("Screen").getAttribute("aria-selected")).toBe("true");
    fireEvent.click(tab("NDI")); await screen.findByRole("option", { name: "Generated NDI" });
    expect((screen.getByRole("combobox", { name: "NDI source" }) as HTMLSelectElement).value).toBe("Generated NDI");
    expect(source.startCapture).not.toHaveBeenCalled(); expect(source.start).not.toHaveBeenCalled();
    expect(source.cancelPreview).not.toHaveBeenCalled(); expect(source.share).not.toHaveBeenCalled();
  });

  it.each(["Window", "Screen", "Region"])("keeps the %s Preview and close actions outside the scrolling fields", async mode => {
    const source = input(); render(<NdiInputPanel input={source} onClose={vi.fn()}/>);
    fireEvent.click(tab(mode));
    if (mode === "Window") fireEvent.click(await screen.findByRole("button", { name: /Window 501$/ }));
    else await chooseDisplay(10);
    const panel = screen.getByRole("tabpanel", { name: mode });
    expect(panel.contains(preview())).toBe(false);
    expect(preview().closest(".cp-ndi-input-footer")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Done" }).closest(".cp-ndi-input-footer")).not.toBeNull();
    expect(screen.getAllByRole("button", { name: "Preview source" })).toHaveLength(1);
    const audio = screen.getByRole("checkbox", { name: mode === "Window" ? "Include application audio" : "Include system audio" });
    expect(audio.closest(".cp-ndi-input-footer")).not.toBeNull();
    if (mode === "Region") expect(panel.contains(screen.getByRole("spinbutton", { name: "Width" }))).toBe(true);
    expect(source.startCapture).not.toHaveBeenCalled();
  });

  it("allows tab navigation during startup without a late candidate changing the tab or closing settings", async () => {
    let complete!: () => void;
    const source = input(), onClose = vi.fn();
    source.startCapture = vi.fn(() => new Promise<void>(done => { complete = done; }));
    const view = render(<NdiInputPanel input={source} onClose={onClose}/>);
    fireEvent.click(tab("Window")); fireEvent.click(await screen.findByRole("button", { name: /Window 501$/ }));
    fireEvent.click(preview()); source.snapshot = { ...source.snapshot, busy: "starting" };
    view.rerender(<NdiInputPanel input={source} onClose={onClose}/>);
    expect(tab("Region").disabled).toBe(false); fireEvent.click(tab("Region"));
    const pending = candidate("new-window", windowSelection);
    source.snapshot = { ...source.snapshot, candidate: pending };
    source.previewProgram = { ...pending, local: true, ownerId: "generated" };
    view.rerender(<NdiInputPanel input={source} onClose={onClose}/>);
    expect(tab("Region").getAttribute("aria-selected")).toBe("true"); expect(preview().disabled).toBe(true);
    await act(async () => complete());
    source.snapshot = { ...source.snapshot, candidate: candidate("new-window", windowSelection, true), busy: null };
    view.rerender(<NdiInputPanel input={source} onClose={onClose}/>);
    expect(tab("Region").getAttribute("aria-selected")).toBe("true"); expect(onClose).not.toHaveBeenCalled();
    expect(source.startCapture).toHaveBeenCalledExactlyOnceWith(windowSelection);
    expect(source.cancelPreview).not.toHaveBeenCalled(); expect(source.share).not.toHaveBeenCalled();
  });

  it.each(["publishing", "stopping"] as const)("preserves source-tab exclusivity while %s", async busy => {
    const source = input(); source.snapshot.busy = busy;
    render(<NdiInputPanel input={source} onClose={vi.fn()}/>);
    for (const item of screen.getAllByRole("tab")) expect((item as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(tab("Screen")); expect(tab("NDI").getAttribute("aria-selected")).toBe("true");
    await screen.findByRole("option", { name: "Generated NDI" }); expect(source.startCapture).not.toHaveBeenCalled();
  });

  it("does not restore the old private window when explicit Preview reveals it during the next Region startup", async () => {
    const source = input(), onClose = vi.fn();
    const oldWindow = candidate("old-window", windowSelection, true);
    const shared = candidate("shared-region", regionSelection, true);
    source.snapshot = { ...source.snapshot, candidate: oldWindow, published: shared };
    source.program = { ...shared, local: true, ownerId: "generated" };
    source.previewProgram = { ...oldWindow, local: true, ownerId: "generated" };
    let complete!: () => void;
    source.startCapture = vi.fn(() => new Promise<void>(done => { complete = done; }));
    const view = render(<NdiInputPanel input={source} onClose={onClose} previewVisible={false}/>);
    await waitFor(() => expect(preview().disabled).toBe(false));
    changeField("Width", 30); fireEvent.click(preview());
    // App's explicit Preview handler exposes the old private stage before its
    // receiver has finished stopping; no source replacement has completed yet.
    source.snapshot = { ...source.snapshot, busy: "starting" };
    view.rerender(<NdiInputPanel input={source} onClose={onClose} previewVisible/>);
    expect(tab("Region").getAttribute("aria-selected")).toBe("true");
    fireEvent.click(tab("Screen"));
    const next = candidate("next-region", { ...regionSelection, crop: { ...regionSelection.crop, width: .3 } }, true);
    source.snapshot = { ...source.snapshot, candidate: next, busy: null };
    source.previewProgram = { ...next, local: true, ownerId: "generated" };
    view.rerender(<NdiInputPanel input={source} onClose={onClose} previewVisible/>);
    await act(async () => complete());
    expect(tab("Screen").getAttribute("aria-selected")).toBe("true"); expect(onClose).not.toHaveBeenCalled();
    expect(source.share).not.toHaveBeenCalled(); expect(source.cancelPreview).not.toHaveBeenCalled();
  });

  it.each(["candidate", "published"] as const)("desktop Edit restores the exact %s Region, even with another source visible", async slot => {
    const source = input(), onClose = vi.fn();
    const display = candidate("edit-region", regionSelection, true);
    source.snapshot[slot] = display;
    source.previewProgram = { ...candidate("visible-window", windowSelection, true), local: true, ownerId: "generated" };
    const view = render(<NdiInputPanel input={source} onClose={onClose}/>);
    await screen.findByRole("button", { name: /Window 501$/ });
    view.rerender(<NdiInputPanel input={source} onClose={onClose} editRequest={{ sourceId: display.id, serial: 1 }}/>);
    await waitFor(() => expect(preview().disabled).toBe(false));
    expect(tab("Region").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("status", { name: "Selected display" }).textContent).toContain("Display 20");
    expect(fieldValue("Left")).toBe(10); expect(fieldValue("Top")).toBe(20); expect(fieldValue("Width")).toBe(40);
    changeField("Width", 30);
    view.rerender(<NdiInputPanel input={source} onClose={onClose} editRequest={{ sourceId: display.id, serial: 1 }}/>);
    expect(fieldValue("Width")).toBe(30); // same event cannot erase subsequent edits
    expect(source.startCapture).not.toHaveBeenCalled(); expect(source.share).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
  });

  it.each(["absent", "retired", "window"])("ignores an Edit event for an %s source", async condition => {
    const source = input();
    const target = candidate("edit-target", condition === "window" ? windowSelection : regionSelection, true);
    if (condition === "retired") target.retired = true;
    if (condition !== "absent") source.snapshot.candidate = target;
    const view = render(<NdiInputPanel input={source} onClose={vi.fn()} editRequest={{ sourceId: target.id, serial: 1 }}/>);
    await screen.findByRole("option", { name: "Generated NDI" });
    expect(tab("NDI").getAttribute("aria-selected")).toBe("true");
    source.snapshot.candidate = candidate("edit-target", regionSelection, true);
    view.rerender(<NdiInputPanel input={source} onClose={vi.fn()} editRequest={{ sourceId: target.id, serial: 1 }}/>);
    expect(tab("NDI").getAttribute("aria-selected")).toBe("true"); expect(source.startCapture).not.toHaveBeenCalled();
  });

  it("opens a full Screen's Edit as a full-sized Region draft without changing capture or sharing", async () => {
    const source = input(), onClose = vi.fn();
    const fullSelection = { ...regionSelection, crop: { x: 0, y: 0, width: 1, height: 1 } };
    const full = candidate("full-screen", fullSelection, true);
    source.snapshot.published = full; source.program = { ...full, local: true, ownerId: "generated" };
    const view = render(<NdiInputPanel input={source} onClose={onClose}/>);
    await waitFor(() => expect(preview().disabled).toBe(false));
    expect(tab("Screen").getAttribute("aria-selected")).toBe("true");
    view.rerender(<NdiInputPanel input={source} onClose={onClose} editRequest={{ sourceId: full.id, serial: 1 }}/>);
    expect(tab("Region").getAttribute("aria-selected")).toBe("true");
    await screen.findByRole("spinbutton", { name: "Left" });
    expect(fieldValue("Left")).toBe(0); expect(fieldValue("Top")).toBe(0);
    expect(fieldValue("Width")).toBe(100); expect(fieldValue("Height")).toBe(100);
    changeField("Width", 50);
    expect(full.capture?.crop.width).toBe(1);
    expect(source.startCapture).not.toHaveBeenCalled(); expect(source.share).not.toHaveBeenCalled();
    expect(source.cancelPreview).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
  });

  it("preserves an explicit desktop Edit draft when an unrelated already-authorized startup finishes", async () => {
    const source = input(), onClose = vi.fn();
    const shared = candidate("shared-region", regionSelection, true);
    const previous = candidate("previous-window", windowSelection, true);
    source.snapshot = { ...source.snapshot, candidate: previous, published: shared, busy: "starting" };
    source.program = { ...shared, local: true, ownerId: "generated" };
    source.previewProgram = { ...previous, local: true, ownerId: "generated" };
    const editRequest = { sourceId: shared.id, serial: 1 };
    const view = render(<NdiInputPanel input={source} onClose={onClose} editRequest={editRequest}/>);
    await screen.findByRole("spinbutton", { name: "Width" });
    expect(fieldValue("Width")).toBe(40); expect(preview().disabled).toBe(true);
    const unrelated = candidate("already-starting-region", { ...regionSelection,
      displayUuid: displays[0].displayUuid, displayId: 10, geometry: displays[0].geometry,
      crop: { x: .3, y: .3, width: .6, height: .6 } }, true);
    source.snapshot = { ...source.snapshot, candidate: unrelated, busy: null };
    source.previewProgram = { ...unrelated, local: true, ownerId: "generated" };
    view.rerender(<NdiInputPanel input={source} onClose={onClose} editRequest={editRequest}/>);
    await waitFor(() => expect(preview().disabled).toBe(false));
    expect(tab("Region").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("status", { name: "Selected display" }).textContent).toContain("Display 20");
    expect(fieldValue("Left")).toBe(10); expect(fieldValue("Width")).toBe(40);
    expect(source.startCapture).not.toHaveBeenCalled(); expect(source.share).not.toHaveBeenCalled();
    expect(source.cancelPreview).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
  });

  it.each(["close", "tab", "Preview"])("releases desktop Edit protection on explicit %s", async action => {
    const source = input(), onClose = vi.fn();
    const shared = candidate("shared-region", regionSelection, true);
    source.snapshot.published = shared; source.program = { ...shared, local: true, ownerId: "generated" };
    const editRequest = { sourceId: shared.id, serial: 1 };
    const view = render(<NdiInputPanel input={source} onClose={onClose} editRequest={editRequest}/>);
    await waitFor(() => expect(preview().disabled).toBe(false));
    if (action === "close") {
      fireEvent.click(screen.getByRole("button", { name: "Done" }));
      view.rerender(<NdiInputPanel input={source} onClose={onClose} editRequest={editRequest} open={false}/>);
      view.rerender(<NdiInputPanel input={source} onClose={onClose} editRequest={editRequest}/>);
    } else if (action === "tab") fireEvent.click(tab("Screen"));
    else {
      fireEvent.click(preview());
      await waitFor(() => expect(source.startCapture).toHaveBeenCalledOnce());
      const requested = candidate("requested-region", regionSelection);
      source.snapshot.candidate = requested; source.previewProgram = { ...requested, local: true, ownerId: "generated" };
      view.rerender(<NdiInputPanel input={source} onClose={onClose} editRequest={editRequest}/>);
    }
    const next = candidate("later-window", windowSelection, true);
    source.snapshot.candidate = next; source.previewProgram = { ...next, local: true, ownerId: "generated" };
    view.rerender(<NdiInputPanel input={source} onClose={onClose} editRequest={editRequest}/>);
    await screen.findByRole("button", { name: /Window 501$/ });
    expect(tab("Window").getAttribute("aria-selected")).toBe("true");
    expect(source.share).not.toHaveBeenCalled(); expect(source.cancelPreview).not.toHaveBeenCalled();
  });

  it("reveals an unchanged published Region only after its explicit Preview reuses that ready source", async () => {
    const source = input(), onClose = vi.fn();
    const published = candidate("shared-region", regionSelection, true);
    const other = candidate("private-window", windowSelection, true);
    source.snapshot.published = published; source.snapshot.candidate = other;
    source.program = { ...published, local: true, ownerId: "generated" };
    source.previewProgram = { ...other, local: true, ownerId: "generated" };
    let complete!: () => void;
    source.startCapture = vi.fn(() => new Promise<void>(done => { complete = done; }));
    const editRequest = { sourceId: published.id, serial: 1 };
    const view = render(<NdiInputPanel input={source} onClose={onClose} editRequest={editRequest}/>);
    await waitFor(() => expect(preview().disabled).toBe(false));
    expect(onClose).not.toHaveBeenCalled(); expect(source.startCapture).not.toHaveBeenCalled();
    fireEvent.click(preview());
    // The coordinator reuses an identical published source instead of starting
    // a duplicate receiver, and removes the unrelated private candidate.
    source.snapshot = { ...source.snapshot, candidate: null }; source.previewProgram = null;
    view.rerender(<NdiInputPanel input={source} onClose={onClose} editRequest={editRequest}/>);
    await act(async () => complete());
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(source.startCapture).toHaveBeenCalledExactlyOnceWith(regionSelection);
    expect(source.share).not.toHaveBeenCalled(); expect(source.cancelPreview).not.toHaveBeenCalled();
  });
});
