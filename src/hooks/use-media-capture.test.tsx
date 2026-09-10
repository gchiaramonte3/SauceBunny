// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeviceChoice } from "../lib/media-devices";

const mocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("../lib/media-devices", async (original) => ({
  ...await original<typeof import("../lib/media-devices")>(),
  openCapture: (...args: unknown[]) => mocks.open(...args),
  queryAvPermission: async () => "granted",
  enumerateAv: async () => ({ cameras: [], mics: [], speakers: [] }),
}));
import { useMediaCapture } from "./use-media-capture";

const choice: DeviceChoice = { cameraId: null, micId: null, cameraOff: false,
  micMuted: false, echoCancel: true, speakerId: null };
function track(kind: "audio" | "video") {
  const t = Object.assign(new EventTarget(), {
    kind, label: "Test device", enabled: true, readyState: "live",
    stop: vi.fn(() => { t.readyState = "ended"; }),
  });
  return t;
}
function stream(...tracks: ReturnType<typeof track>[]) {
  return Object.assign(new EventTarget(), {
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter(t => t.kind === "audio"),
    getVideoTracks: () => tracks.filter(t => t.kind === "video"),
  }) as unknown as MediaStream;
}
afterEach(() => {
  const h = renderHook(() => useMediaCapture());
  act(() => h.result.current.release());
  cleanup(); mocks.open.mockReset(); localStorage.clear();
});

describe("actual session capture state", () => {
  it("never advertises saved-on preferences without live tracks or acquires on mount", () => {
    const h = renderHook(() => useMediaCapture());
    act(() => h.result.current.updateChoice(choice));
    expect(h.result.current.cameraOn).toBe(false);
    expect(h.result.current.micOn).toBe(false);
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it("updates every surface after capture, mute, device end, and release", async () => {
    const video = track("video"), audio = track("audio");
    mocks.open.mockResolvedValue(stream(video, audio));
    const first = renderHook(() => useMediaCapture()), second = renderHook(() => useMediaCapture());
    await act(async () => { await first.result.current.acquire(choice); });
    expect(second.result.current.cameraOn).toBe(true);
    expect(second.result.current.micOn).toBe(true);
    act(() => first.result.current.setEnabled("audio", false));
    expect(second.result.current.micOn).toBe(false);
    act(() => { video.readyState = "ended"; video.dispatchEvent(new Event("ended")); });
    expect(second.result.current.cameraOn).toBe(false);
    act(() => first.result.current.release());
    expect(second.result.current.cameraOn).toBe(false);
    expect(second.result.current.micOn).toBe(false);
  });
  it("turning on one device cannot revive the other saved-on device", async () => {
    const h = renderHook(() => useMediaCapture());
    act(() => h.result.current.updateChoice(choice));
    mocks.open.mockResolvedValue(stream(track("video")));
    await act(async () => { h.result.current.setEnabled("video", true); });
    expect(mocks.open).toHaveBeenCalledWith({ ...choice, micMuted: true });
    expect(h.result.current.cameraOn).toBe(true);
    expect(h.result.current.micOn).toBe(false);
  });
  it("an off click invalidates a pending on request without late rollback", async () => {
    const h = renderHook(() => useMediaCapture());
    act(() => h.result.current.updateChoice(choice));
    let finish!: (s: MediaStream) => void;
    mocks.open.mockImplementationOnce(() => new Promise<MediaStream>(resolve => { finish = resolve; }));
    act(() => h.result.current.setEnabled("video", true));
    act(() => h.result.current.setEnabled("video", false));
    const video = track("video");
    await act(async () => { finish(stream(video)); });
    expect(video.stop).toHaveBeenCalledOnce();
    expect(h.result.current.stream).toBeNull();
    expect(h.result.current.choice.cameraOff).toBe(true);
    expect(h.result.current.cameraOn).toBe(false);
  });
  it("reopens an ended track on an explicit on click", async () => {
    const h = renderHook(() => useMediaCapture()), video = track("video");
    mocks.open.mockResolvedValueOnce(stream(video)).mockResolvedValueOnce(stream(track("video")));
    await act(async () => { await h.result.current.acquire({ ...choice, micMuted: true }); });
    act(() => { video.readyState = "ended"; video.dispatchEvent(new Event("ended")); });
    await act(async () => { h.result.current.setEnabled("video", true); });
    expect(mocks.open).toHaveBeenCalledTimes(2);
    expect(h.result.current.cameraOn).toBe(true);
  });
});
