// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ObsWindow } from "../bindings/ObsWindow";
import type { ObsDisplayChoice } from "../bindings/ObsDisplayChoice";
import { useCaptureWindowThumbnails } from "./use-capture-window-thumbnails";
import { captureDisplayKey, useCaptureDisplayThumbnails } from "./use-capture-display-thumbnails";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
const windows: ObsWindow[] = Array.from({ length: 9 }, (_, index) => ({
  app: "com.generated.editor", pid: 100, id: 20 + index, title: "Generated", width: 640, height: 360,
}));
const displays: ObsDisplayChoice[] = [{ displayUuid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", displayId: 5,
  label: "Generated display", geometry: { x: 0, y: 0, width: 1920, height: 1080, pixelWidth: 3840, pixelHeight: 2160 } }];
const image = "data:image/jpeg;base64,/9j/2Q==";
const displayResponse = () => ({ ...displays[0], thumb: "/9j/2Q==" });
const windowResponse = (index: number) => ({ application: windows[index].app, process: windows[index].pid,
  window: windows[index].id, thumb: "/9j/2Q==" });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
beforeEach(() => { mocks.invoke.mockReset(); });
afterEach(cleanup);

describe("Window to Region thumbnail handoff", () => {
  it("waits for stale Window workers instead of permanently failing the current display as busy", async () => {
    const old = [deferred<ReturnType<typeof windowResponse>>(), deferred<ReturnType<typeof windowResponse>>()];
    let active = 0, maximum = 0;
    mocks.invoke.mockImplementation((command, args) => {
      active++; maximum = Math.max(maximum, active);
      const work = command === "capture_window_thumbnail" ? old[args.window - 20].promise : Promise.resolve(displayResponse());
      return work.finally(() => { active--; });
    });
    const view = renderHook(({ mode }) => ({
      windows: useCaptureWindowThumbnails(windows, mode === "window", 0),
      displays: useCaptureDisplayThumbnails(displays, mode === "region", 0),
    }), { initialProps: { mode: "window" } });
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    view.rerender({ mode: "region" });
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(view.result.current.displays[captureDisplayKey(displays[0])].phase).toBe("loading");
    await act(async () => old[0].resolve(windowResponse(0)));
    await waitFor(() => expect(view.result.current.displays[captureDisplayKey(displays[0])].image).toBe(image));
    await act(async () => old[1].resolve(windowResponse(1)));
    expect(mocks.invoke).toHaveBeenCalledTimes(3); expect(maximum).toBe(2);
    expect(view.result.current.windows).toEqual({});
  });

  it("drops an obsolete Region request queued behind Window work before any pixels are read", async () => {
    const old = [deferred<ReturnType<typeof windowResponse>>(), deferred<ReturnType<typeof windowResponse>>()];
    mocks.invoke.mockImplementation((_command, args) => old[args.window - 20].promise);
    const view = renderHook(({ mode }) => {
      useCaptureWindowThumbnails(windows, mode === "window", 0);
      return useCaptureDisplayThumbnails(displays, mode === "region", 0);
    }, { initialProps: { mode: "window" } });
    view.rerender({ mode: "region" }); view.rerender({ mode: "closed" });
    await act(async () => { old[0].resolve(windowResponse(0)); old[1].resolve(windowResponse(1)); });
    expect(mocks.invoke).toHaveBeenCalledTimes(2); expect(view.result.current).toEqual({});
  });

  it("keeps a same-identity snapshot visible during refresh, but never lends it to changed geometry", async () => {
    const refresh = deferred<ReturnType<typeof displayResponse>>();
    mocks.invoke.mockResolvedValueOnce(displayResponse()).mockImplementationOnce(() => refresh.promise)
      .mockResolvedValue({ ...displayResponse(), geometry: { ...displays[0].geometry, x: 100 } });
    const view = renderHook(({ sources, revision }) => useCaptureDisplayThumbnails(sources, true, revision),
      { initialProps: { sources: displays, revision: 0 } });
    await waitFor(() => expect(view.result.current[captureDisplayKey(displays[0])].image).toBe(image));
    view.rerender({ sources: displays, revision: 1 });
    expect(view.result.current[captureDisplayKey(displays[0])]).toEqual({ phase: "loading", image, error: null });
    const changed = [{ ...displays[0], geometry: { ...displays[0].geometry, x: 100 } }];
    view.rerender({ sources: changed, revision: 1 });
    expect(view.result.current[captureDisplayKey(displays[0])]).toBeUndefined();
    await waitFor(() => expect(view.result.current[captureDisplayKey(changed[0])].image).toBe(image));
    await act(async () => refresh.resolve(displayResponse()));
    expect(view.result.current[captureDisplayKey(displays[0])]).toBeUndefined();
  });
});
