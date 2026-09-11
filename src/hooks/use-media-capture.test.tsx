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
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function requestedStream(c: DeviceChoice) {
  const audio = track("audio"); audio.enabled = !c.micMuted;
  return stream(...(c.cameraOff ? [] : [track("video")]), audio);
}
afterEach(() => {
  const h = renderHook(() => useMediaCapture());
  act(() => h.result.current.release());
  cleanup(); mocks.open.mockReset(); localStorage.clear();
});

describe("actual session capture state", () => {
  it("reuses a matching pending on request", async () => {
    const h = renderHook(() => useMediaCapture());
    act(() => h.result.current.updateChoice({ ...choice, cameraOff: true, micMuted: true }));
    const request = deferred<MediaStream>();
    mocks.open.mockReturnValueOnce(request.promise);
    act(() => h.result.current.setEnabled("video", true));
    act(() => h.result.current.setEnabled("video", true));
    expect(mocks.open).toHaveBeenCalledOnce();
    await act(async () => { request.resolve(requestedStream(mocks.open.mock.calls[0][0])); });
    expect(h.result.current.cameraOn).toBe(true);
  });

  it("pagehide cancels a pending capture and stops its late hardware result", async () => {
    const h = renderHook(() => useMediaCapture());
    const request = deferred<MediaStream>();
    mocks.open.mockReturnValueOnce(request.promise);
    act(() => h.result.current.setEnabled("video", true));
    act(() => window.dispatchEvent(new Event("pagehide")));
    const late = requestedStream(mocks.open.mock.calls[0][0]);
    await act(async () => { request.resolve(late); });
    expect(h.result.current.stream).toBeNull();
    expect(late.getTracks().every(t => t.readyState === "ended")).toBe(true);
  });

  it("preserves a live microphone when opening the camera fails", async () => {
    const h = renderHook(() => useMediaCapture());
    const live = requestedStream({ ...choice, cameraOff: true });
    mocks.open.mockResolvedValueOnce(live).mockRejectedValueOnce(new Error("Camera busy"));
    await act(async () => { await h.result.current.acquire({ ...choice, cameraOff: true }); });
    await act(async () => { h.result.current.setEnabled("video", true); });
    expect(h.result.current.stream).toBe(live);
    expect(h.result.current.micOn).toBe(true);
    expect(h.result.current.cameraOn).toBe(false);
    expect(h.result.current.error).toContain("Camera busy");
  });
  it.each(["audio", "video"] as const)("preserves both explicit on actions while %s permission is pending", async firstKind => {
    const first = renderHook(() => useMediaCapture()), second = renderHook(() => useMediaCapture());
    act(() => first.result.current.updateChoice({ ...choice, cameraOff: true, micMuted: true }));
    const one = deferred<MediaStream>(), two = deferred<MediaStream>();
    mocks.open.mockReturnValueOnce(one.promise).mockReturnValueOnce(two.promise);
    act(() => first.result.current.setEnabled(firstKind, true));
    act(() => second.result.current.setEnabled(firstKind === "video" ? "audio" : "video", true));
    const discarded = requestedStream(mocks.open.mock.calls[0][0]);
    const combined = requestedStream(mocks.open.mock.calls[1][0]);
    await act(async () => { two.resolve(combined); one.resolve(discarded); });
    expect(first.result.current.cameraOn).toBe(true);
    expect(second.result.current.micOn).toBe(true);
    expect(first.result.current.choice.cameraOff).toBe(false);
    expect(second.result.current.choice.micMuted).toBe(false);
    expect(discarded.getTracks().every(t => t.readyState === "ended")).toBe(true);
    expect(first.result.current.stream).toBe(combined);
  });

  it.each(["audio", "video"] as const)("turning %s off preserves the other pending on request", async offKind => {
    const h = renderHook(() => useMediaCapture());
    act(() => h.result.current.updateChoice({ ...choice, cameraOff: true, micMuted: true }));
    const requests = [deferred<MediaStream>(), deferred<MediaStream>(), deferred<MediaStream>()];
    requests.forEach(r => mocks.open.mockReturnValueOnce(r.promise));
    act(() => h.result.current.setEnabled("video", true));
    act(() => h.result.current.setEnabled("audio", true));
    act(() => h.result.current.setEnabled(offKind, false));
    expect(mocks.open).toHaveBeenCalledTimes(3);
    await act(async () => {
      requests.forEach((r, i) => r.resolve(requestedStream(mocks.open.mock.calls[i][0])));
    });
    expect(h.result.current.cameraOn).toBe(offKind !== "video");
    expect(h.result.current.micOn).toBe(offKind !== "audio");
  });

  it("release cancels all pending device intent, even when the newest request finishes first", async () => {
    const h = renderHook(() => useMediaCapture());
    act(() => h.result.current.updateChoice(choice));
    const one = deferred<MediaStream>(), two = deferred<MediaStream>();
    mocks.open.mockReturnValueOnce(one.promise).mockReturnValueOnce(two.promise);
    act(() => h.result.current.setEnabled("video", true));
    act(() => h.result.current.setEnabled("audio", true));
    act(() => h.result.current.release());
    const a = requestedStream(mocks.open.mock.calls[0][0]), b = requestedStream(mocks.open.mock.calls[1][0]);
    await act(async () => { two.resolve(b); one.resolve(a); });
    expect(h.result.current.stream).toBeNull();
    expect([...a.getTracks(), ...b.getTracks()].every(t => t.readyState === "ended")).toBe(true);
    mocks.open.mockImplementationOnce(async c => requestedStream(c));
    await act(async () => { h.result.current.setEnabled("audio", true); });
    expect(h.result.current.micOn).toBe(true);
    expect(h.result.current.cameraOn).toBe(false);
  });

  it("a denied combined request clears pending intent and cannot revive a device on retry", async () => {
    const h = renderHook(() => useMediaCapture());
    act(() => h.result.current.updateChoice({ ...choice, cameraOff: true, micMuted: true }));
    const one = deferred<MediaStream>(), two = deferred<MediaStream>();
    mocks.open.mockReturnValueOnce(one.promise).mockReturnValueOnce(two.promise);
    act(() => h.result.current.setEnabled("video", true));
    act(() => h.result.current.setEnabled("audio", true));
    await act(async () => {
      two.reject(new DOMException("Denied", "NotAllowedError"));
      one.resolve(requestedStream(mocks.open.mock.calls[0][0]));
    });
    expect(h.result.current.error).toContain("blocked");
    expect(h.result.current.cameraOn).toBe(false);
    expect(h.result.current.micOn).toBe(false);
    expect(h.result.current.choice.cameraOff).toBe(true);
    mocks.open.mockImplementationOnce(async c => requestedStream(c));
    await act(async () => { h.result.current.setEnabled("audio", true); });
    expect(h.result.current.micOn).toBe(true);
    expect(h.result.current.cameraOn).toBe(false);
  });
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
