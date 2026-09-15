// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ObsWindow } from "../bindings/ObsWindow";
import { captureWindowKey, useCaptureWindowThumbnails } from "./use-capture-window-thumbnails";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
const windows: ObsWindow[] = Array.from({ length: 5 }, (_, index) => ({
  app: "com.generated.editor", pid: 100, id: 20 + index, title: `Generated ${index}`, width: 640, height: 360,
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const response = (window: ObsWindow) => ({ application: window.app, process: window.pid, window: window.id, thumb: "/9j/2Q==" });
beforeEach(() => { mocks.invoke.mockReset(); });
afterEach(cleanup);

describe("bounded window chooser snapshots", () => {
  it("never reads pixels while closed and runs at most two requests at once", async () => {
    const pending = windows.map(() => deferred<ReturnType<typeof response>>());
    mocks.invoke.mockImplementation((_command, args) => pending[args.window - 20].promise);
    const view = renderHook(({ enabled }) => useCaptureWindowThumbnails(windows, enabled, 0), { initialProps: { enabled: false } });
    expect(mocks.invoke).not.toHaveBeenCalled();
    view.rerender({ enabled: true });
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "capture_window_thumbnail", { application: windows[0].app, process: 100, window: 20 });
    await act(async () => pending[0].resolve(response(windows[0])));
    expect(mocks.invoke).toHaveBeenCalledTimes(3);
    view.rerender({ enabled: false });
    await act(async () => { pending[1].resolve(response(windows[1])); pending[2].resolve(response(windows[2])); });
    expect(mocks.invoke).toHaveBeenCalledTimes(3);
    expect(view.result.current).toEqual({});
  });

  it("rejects identity mismatches and stale results from another application", async () => {
    const old = deferred<ReturnType<typeof response>>();
    const changed = [{ ...windows[0], app: "com.generated.other", pid: 200 }];
    mocks.invoke.mockImplementation((_command, args) => args.process === 100 ? old.promise
      : Promise.resolve(response(windows[0])));
    const view = renderHook(({ sources }) => useCaptureWindowThumbnails(sources, true, 0), { initialProps: { sources: windows.slice(0, 1) } });
    view.rerender({ sources: changed });
    await waitFor(() => expect(view.result.current[captureWindowKey(changed[0])]?.phase).toBe("error"));
    await act(async () => old.resolve(response(windows[0])));
    expect(view.result.current[captureWindowKey(windows[0])]).toBeUndefined();
    expect(view.result.current[captureWindowKey(changed[0])].image).toBeNull();
  });

  it("refreshes an unavailable snapshot explicitly without starting capture", async () => {
    mocks.invoke.mockRejectedValueOnce(new Error("Generated snapshot permission failure"))
      .mockResolvedValueOnce(response(windows[0]));
    const one = windows.slice(0, 1);
    const view = renderHook(({ refresh }) => useCaptureWindowThumbnails(one, true, refresh), { initialProps: { refresh: 0 } });
    await waitFor(() => expect(view.result.current[captureWindowKey(one[0])]?.error).toContain("permission failure"));
    view.rerender({ refresh: 1 });
    await waitFor(() => expect(view.result.current[captureWindowKey(one[0])]?.image).toBe("data:image/jpeg;base64,/9j/2Q=="));
    expect(mocks.invoke.mock.calls.every(([command]) => command === "capture_window_thumbnail")).toBe(true);
  });
});
