// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ObsSelection } from "../bindings/ObsSelection";
import type { ProgramCaptureSelection } from "../bindings/ProgramCaptureSelection";
import { emptyNdiTelemetry, type NdiLocalProgram } from "../lib/ndi-program-coordinator";
import { NdiInputPanel, type NdiPreviewInput } from "./NdiInputPanel";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
/** What macOS's picker hands back for each tab: Screen, Window and Region all choose through it. */
const picks = {
  screen: { choice: "0123456789abcdef0123456789abcdef", kind: "screen", label: "Generated screen", width: 1200, height: 900 },
  window: { choice: "11111111111111111111111111111111", kind: "window", label: "Generated editor · Composer", width: 1000, height: 800 },
  region: { choice: "22222222222222222222222222222222", kind: "region", label: "Generated screen", width: 1200, height: 900 },
} as const;
const windowSelection: ProgramCaptureSelection = { choice: picks.window.choice, kind: "window", label: picks.window.label, audio: true };
const regionSelection: ProgramCaptureSelection = { choice: picks.region.choice, kind: "region", label: picks.region.label, audio: false,
  region: { x: .1, y: .2, width: .4, height: .5 } };
function ordinary(command: string, args: Record<string, unknown>) {
  if (command === "ndi_discover") return Promise.resolve({ bridgeCompiled: true, runtime: "ready", sources: [{ name: "Generated NDI" }], error: null });
  if (command === "program_capture_preflight") return Promise.resolve({ available: true, error: null, kinds: ["screen", "window", "region"], systemAudio: true, applicationAudio: true });
  if (command === "program_capture_cancel_choose") return Promise.resolve();
  if (command === "program_capture_choose") return Promise.resolve({ outcome: "chosen", choice: picks[args.kind as keyof typeof picks] });
  if (command === "program_capture_snapshot") return Promise.resolve({ image: "data:image/jpeg;base64,/9j/Z2VuZXJhdGVk", width: 1200, height: 900 });
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
/** A Screen or Window pick starts its own preview: the picker's Share click is the go-ahead. */
const chooseScreen = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Choose screen…" }));
  await screen.findByRole("status", { name: "Selected screen" });
};
const chooseWindow = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Choose window…" }));
  await screen.findByRole("status", { name: "Selected window" });
};
/** A Region pick waits for its area, drawn on a still of the picked screen. */
const chooseRegion = async (width = 40, height = 50) => {
  fireEvent.click(await screen.findByRole("button", { name: "Choose screen…" }));
  await screen.findByRole("img", { name: picks.region.label });
  changeField("Width", width); changeField("Height", height);
};
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
    await chooseRegion(40, 50);
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
    if (mode === "Window") await chooseWindow();
    else if (mode === "Screen") await chooseScreen();
    else { await chooseRegion(); fireEvent.click(preview()); }
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
    await chooseWindow();
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

  it("retains independent NDI, screen, window audio, and region drafts across tabs and reopening", async () => {
    const source = input(), onClose = vi.fn();
    const view = render(<NdiInputPanel input={source} onClose={onClose}/>);
    await screen.findByRole("option", { name: "Generated NDI" });
    fireEvent.change(screen.getByRole("combobox", { name: "NDI source" }), { target: { value: "Generated NDI" } });
    fireEvent.click(tab("Window")); await chooseWindow();
    fireEvent.click(screen.getByRole("checkbox", { name: "Include application audio" }));
    fireEvent.click(tab("Region")); await chooseRegion(40, 60); changeField("Left", 20); changeField("Top", 10);
    fireEvent.click(tab("Screen")); await chooseScreen(); await waitFor(() => expect(preview().disabled).toBe(false));
    fireEvent.click(tab("Region")); await waitFor(() => expect(preview().disabled).toBe(false));
    expect(fieldValue("Left")).toBe(20); expect(fieldValue("Height")).toBe(60);
    expect(screen.getByRole("status", { name: "Selected screen" }).textContent).toContain("Generated screen");
    fireEvent.click(tab("Window")); await waitFor(() => expect(preview().disabled).toBe(false));
    expect(screen.getByRole("status", { name: "Selected window" }).textContent).toContain("Generated editor · Composer");
    expect((screen.getByRole("checkbox", { name: "Include application audio" }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(tab("Screen")); await waitFor(() => expect(preview().disabled).toBe(false));
    expect(screen.getByRole("status", { name: "Selected screen" }).textContent).toContain("Generated screen");
    expect(screen.queryByRole("spinbutton")).toBeNull();
    view.rerender(<NdiInputPanel input={source} onClose={onClose} open={false}/>);
    view.rerender(<NdiInputPanel input={source} onClose={onClose}/>);
    await waitFor(() => expect(preview().disabled).toBe(false));
    expect(tab("Screen").getAttribute("aria-selected")).toBe("true");
    fireEvent.click(tab("NDI")); await screen.findByRole("option", { name: "Generated NDI" });
    expect((screen.getByRole("combobox", { name: "NDI source" }) as HTMLSelectElement).value).toBe("Generated NDI");
    // Only the two picks started anything: the picker's Share click is the go-ahead for that one preview.
    expect(source.startCapture).toHaveBeenCalledTimes(2);
    expect(source.startCapture).toHaveBeenNthCalledWith(1, windowSelection);
    expect(source.startCapture).toHaveBeenNthCalledWith(2, expect.objectContaining({ choice: picks.screen.choice, kind: "screen" }));
    expect(source.start).not.toHaveBeenCalled();
    expect(source.cancelPreview).not.toHaveBeenCalled(); expect(source.share).not.toHaveBeenCalled();
  });

  it.each(["Window", "Screen", "Region"])("keeps the %s Preview and close actions outside the scrolling fields", async mode => {
    const source = input(); render(<NdiInputPanel input={source} onClose={vi.fn()}/>);
    fireEvent.click(tab(mode));
    if (mode === "Window") await chooseWindow();
    else if (mode === "Screen") await chooseScreen();
    else await chooseRegion();
    const panel = screen.getByRole("tabpanel", { name: mode });
    expect(panel.contains(preview())).toBe(false);
    expect(preview().closest(".cp-ndi-input-footer")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Done" }).closest(".cp-ndi-input-footer")).not.toBeNull();
    expect(screen.getAllByRole("button", { name: "Preview source" })).toHaveLength(1);
    const audio = screen.getByRole("checkbox", { name: mode === "Window" ? "Include application audio" : "Include system audio" });
    expect(audio.closest(".cp-ndi-input-footer")).not.toBeNull();
    if (mode === "Region") expect(panel.contains(screen.getByRole("spinbutton", { name: "Width" }))).toBe(true);
    // A Screen or Window pick starts its own preview; a region waits for its area.
    expect(source.startCapture).toHaveBeenCalledTimes(mode === "Region" ? 0 : 1);
  });

  it("allows tab navigation during startup without a late candidate changing the tab or closing settings", async () => {
    let complete!: () => void;
    const source = input(), onClose = vi.fn();
    source.startCapture = vi.fn(() => new Promise<void>(done => { complete = done; }));
    const view = render(<NdiInputPanel input={source} onClose={onClose}/>);
    fireEvent.click(tab("Window")); await chooseWindow();
    source.snapshot = { ...source.snapshot, busy: "starting" };
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
    await screen.findByRole("img", { name: regionSelection.label });
    await waitFor(() => expect(preview().disabled).toBe(false));
    changeField("Width", 30); fireEvent.click(preview());
    // App's explicit Preview handler exposes the old private stage before its
    // receiver has finished stopping; no source replacement has completed yet.
    source.snapshot = { ...source.snapshot, busy: "starting" };
    view.rerender(<NdiInputPanel input={source} onClose={onClose} previewVisible/>);
    expect(tab("Region").getAttribute("aria-selected")).toBe("true");
    fireEvent.click(tab("Screen"));
    const next = candidate("next-region", { ...regionSelection, region: { x: 0, y: 0, width: .3, height: .5 } }, true);
    source.snapshot = { ...source.snapshot, candidate: next, busy: null };
    source.previewProgram = { ...next, local: true, ownerId: "generated" };
    view.rerender(<NdiInputPanel input={source} onClose={onClose} previewVisible/>);
    await act(async () => complete());
    expect(tab("Screen").getAttribute("aria-selected")).toBe("true"); expect(onClose).not.toHaveBeenCalled();
    expect(source.share).not.toHaveBeenCalled(); expect(source.cancelPreview).not.toHaveBeenCalled();
  });

  it("opens on the tab of the running pick, with its region ready to preview again", async () => {
    const source = input(), onClose = vi.fn();
    const published = candidate("shared-region", regionSelection, true);
    source.snapshot.published = published; source.program = { ...published, local: true, ownerId: "generated" };
    render(<NdiInputPanel input={source} onClose={onClose}/>);
    expect(tab("Region").getAttribute("aria-selected")).toBe("true");
    await screen.findByRole("img", { name: regionSelection.label });
    await waitFor(() => expect(preview().disabled).toBe(false));
    expect(fieldValue("Left")).toBe(10); expect(fieldValue("Width")).toBe(40);
    expect(source.startCapture).not.toHaveBeenCalled(); expect(onClose).not.toHaveBeenCalled();
  });
});
