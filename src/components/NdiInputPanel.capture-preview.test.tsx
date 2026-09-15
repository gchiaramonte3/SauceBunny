// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ObsSelection } from "../bindings/ObsSelection";
import { emptyNdiTelemetry, type NdiLocalProgram } from "../lib/ndi-program-coordinator";
import { NdiInputPanel, type NdiPreviewInput } from "./NdiInputPanel";

const selection: ObsSelection = { application: "com.generated.Editor", process: 101, window: 501,
  crop: { x: 0, y: 0, width: 1, height: 1 }, audio: false };
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => ({ bridgeCompiled: true, runtime: "ready", sources: [], error: null })) }));
vi.mock("./ObsCaptureControls", () => ({ ObsCaptureControls: (props: {
  onPreview: (selection: ObsSelection) => Promise<void>;
  onSelectionChange: (selection: ObsSelection) => void;
}) => <>
  <button onClick={() => void props.onPreview(selection)}>Generated preview</button>
  <button onClick={() => props.onSelectionChange({ ...selection, window: 502 })}>Choose another window</button>
</> }));

function program(decodedReady: boolean): NdiLocalProgram {
  return { id: "generated-capture", name: "Generated window", url: "/not-requested", reviewKey: "generated-review",
    source: { kind: "capture", selection }, capture: selection, telemetry: { ...emptyNdiTelemetry(), phase: "live", connectionCount: 1 },
    decodedReady, encodedReady: true, retired: false, roomGeneration: null };
}
function harness() {
  let resolve!: () => void;
  const startup = new Promise<void>(done => { resolve = done; });
  const input: NdiPreviewInput = { previewProgram: null, program: null, state: emptyNdiTelemetry(), previewState: emptyNdiTelemetry(),
    snapshot: { candidate: null, published: null, lease: null, roomSource: null, room: null, busy: null, error: null },
    canShare: false, start: vi.fn(async () => {}), startCapture: vi.fn(() => startup),
    cancelPreview: vi.fn(async () => {}), share: vi.fn(async () => {}), previewFrameDecoded: vi.fn(), previewPictureFailed: vi.fn() };
  const onClose = vi.fn(), onPreviewRequested = vi.fn();
  const view = render(<NdiInputPanel input={input} onClose={onClose} onPreviewRequested={onPreviewRequested}/>);
  fireEvent.click(screen.getByRole("tab", { name: "Window" }));
  return { input, onClose, onPreviewRequested,
    update(candidate: NdiLocalProgram | null, open = true) {
      input.snapshot = { ...input.snapshot, candidate };
      input.previewProgram = candidate ? { ...candidate, local: true, ownerId: "generated" } : null;
      view.rerender(<NdiInputPanel input={input} onClose={onClose} onPreviewRequested={onPreviewRequested} open={open}/>);
    },
    async finishStart() { await act(async () => { resolve(); await startup; }); },
  };
}
afterEach(cleanup);

describe("capture chooser reveals the existing monitor", () => {
  it("closes only after the explicitly requested picture is ready, without sharing or stopping it", async () => {
    const h = harness(); fireEvent.click(screen.getByRole("button", { name: "Generated preview" }));
    expect(h.input.startCapture).toHaveBeenCalledExactlyOnceWith(selection);
    expect(h.onPreviewRequested).toHaveBeenCalledOnce();
    h.update(program(false)); await h.finishStart(); expect(h.onClose).not.toHaveBeenCalled();
    h.update(program(true)); await waitFor(() => expect(h.onClose).toHaveBeenCalledOnce());
    expect(h.input.share).not.toHaveBeenCalled(); expect(h.input.cancelPreview).not.toHaveBeenCalled();
  });

  it.each(["Choose another window", "Done"])("%s cancels only the pending reveal, not the capture", async label => {
    const h = harness(); fireEvent.click(screen.getByRole("button", { name: "Generated preview" }));
    h.update(program(false)); fireEvent.click(screen.getByRole("button", { name: label }));
    const closes = h.onClose.mock.calls.length;
    h.update(program(false), false); h.update(program(true)); await h.finishStart();
    expect(h.onClose).toHaveBeenCalledTimes(closes);
    expect(h.input.share).not.toHaveBeenCalled(); expect(h.input.cancelPreview).not.toHaveBeenCalled();
  });
});
