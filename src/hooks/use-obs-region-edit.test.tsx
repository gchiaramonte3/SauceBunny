// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ObsEditSource } from "../bindings/ObsEditSource";
import type { ObsDisplaySelection } from "../bindings/ObsDisplaySelection";
import { emptyNdiTelemetry, type NdiLocalProgram, type NdiProgramSnapshot } from "../lib/ndi-program-coordinator";
import { useObsRegionEdit } from "./use-obs-region-edit";

const mocks = vi.hoisted(() => ({ listen: vi.fn(), remove: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
let event: (value: { payload: ObsEditSource }) => void;
const display: ObsDisplaySelection = { kind: "display", displayUuid: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE", displayId: 7,
  geometry: { x: -1920, y: 0, width: 1920, height: 1080, pixelWidth: 3840, pixelHeight: 2160 },
  crop: { x: .25, y: .25, width: .5, height: .5 }, audio: false };
function owner(id = "a"): NdiLocalProgram {
  return { id, name: "Generated region", url: "/fixture", reviewKey: "ndi:fixture", source: { kind: "capture", selection: display },
    capture: display, telemetry: { ...emptyNdiTelemetry(), phase: "live", connectionCount: 1 },
    retired: false, decodedReady: true, encodedReady: true, roomGeneration: null };
}
function state(overrides: Partial<NdiProgramSnapshot> = {}): NdiProgramSnapshot {
  return { candidate: owner(), published: null, lease: null, roomSource: null, room: null, busy: null, error: null, ...overrides };
}
const edit = (sourceId = "a") => act(() => event({ payload: { sourceId } }));
beforeEach(() => {
  mocks.listen.mockReset(); mocks.remove.mockReset();
  mocks.listen.mockImplementation(async (_name, callback) => { event = callback; return mocks.remove; });
});
afterEach(cleanup);

it("opens only an exact live region draft and never starts or publishes", () => {
  const onEdit = vi.fn(); renderHook(() => useObsRegionEdit(state(), onEdit));
  expect(onEdit).not.toHaveBeenCalled(); edit(); edit();
  expect(onEdit.mock.calls).toEqual([[{ sourceId: "a", serial: 1 }], [{ sourceId: "a", serial: 2 }]]);
  expect(mocks.listen).toHaveBeenCalledExactlyOnceWith("obs:edit-source", expect.any(Function));
});
it("can edit a published region while a different private candidate exists", () => {
  const onEdit = vi.fn(); renderHook(() => useObsRegionEdit(state({ published: owner("shared") }), onEdit));
  edit("shared"); expect(onEdit).toHaveBeenCalledWith({ sourceId: "shared", serial: 1 });
});
it("rejects a superseded owner using the latest snapshot without resubscribing", () => {
  const first = vi.fn(), next = vi.fn();
  const view = renderHook(({ snapshot, callback }) => useObsRegionEdit(snapshot, callback),
    { initialProps: { snapshot: state(), callback: first } });
  view.rerender({ snapshot: state({ candidate: owner("b") }), callback: next });
  edit(); expect(first).not.toHaveBeenCalled(); expect(next).not.toHaveBeenCalled();
  edit("b"); expect(next).toHaveBeenCalledWith({ sourceId: "b", serial: 1 });
  expect(mocks.listen).toHaveBeenCalledTimes(1);
});
it.each(["off", "error"] as const)("ignores %s source events", phase => {
  const onEdit = vi.fn(), source = owner(); source.telemetry.phase = phase;
  renderHook(() => useObsRegionEdit(state({ candidate: source }), onEdit)); edit(); expect(onEdit).not.toHaveBeenCalled();
});
it.each(["publishing", "stopping"] as const)("does not interrupt %s", busy => {
  const onEdit = vi.fn(); renderHook(() => useObsRegionEdit(state({ busy }), onEdit)); edit(); expect(onEdit).not.toHaveBeenCalled();
});
it.each(["candidate", "published"] as const)("accepts Edit from an exact live full-screen %s without capture mutations", slot => {
  const onEdit = vi.fn(), full = owner("full-screen");
  const selection = { ...display, crop: { x: 0, y: 0, width: 1, height: 1 } };
  full.capture = selection; full.source = { kind: "capture", selection };
  renderHook(() => useObsRegionEdit(state({ [slot]: full }), onEdit));
  expect(onEdit).not.toHaveBeenCalled(); edit("full-screen");
  expect(onEdit).toHaveBeenCalledExactlyOnceWith({ sourceId: "full-screen", serial: 1 });
  expect(full.capture).toEqual(selection);
  expect(mocks.listen).toHaveBeenCalledExactlyOnceWith("obs:edit-source", expect.any(Function));
});
it("ignores missing, retired, disconnected and window captures", () => {
  const onEdit = vi.fn(); const view = renderHook((snapshot: NdiProgramSnapshot) => useObsRegionEdit(snapshot, onEdit), { initialProps: state() });
  const retired = { ...owner(), retired: true };
  const disconnected = owner(); disconnected.telemetry.connectionCount = 0;
  const window = owner(); window.capture = { application: "com.generated.app", process: 1, window: 2, crop: display.crop };
  const ndi = owner(); ndi.capture = undefined;
  for (const candidate of [null, retired, disconnected, window, ndi]) {
    view.rerender(state({ candidate })); edit();
  }
  expect(onEdit).not.toHaveBeenCalled();
});
it("ignores callbacks immediately on unmount, including late listener registration", async () => {
  let resolve!: (remove: () => void) => void;
  mocks.listen.mockImplementation((_name, callback) => { event = callback; return new Promise(yes => { resolve = yes; }); });
  const onEdit = vi.fn(), view = renderHook(() => useObsRegionEdit(state(), onEdit));
  view.unmount(); edit(); expect(onEdit).not.toHaveBeenCalled();
  await act(async () => resolve(mocks.remove)); expect(mocks.remove).toHaveBeenCalledTimes(1);
});
it("contains event-registration failure without any capture retry", async () => {
  mocks.listen.mockRejectedValueOnce(new Error("Generated event service unavailable"));
  const onEdit = vi.fn(), view = renderHook(() => useObsRegionEdit(state(), onEdit));
  await act(async () => {}); view.unmount(); await act(async () => {});
  expect(mocks.listen).toHaveBeenCalledTimes(1); expect(onEdit).not.toHaveBeenCalled();
});
