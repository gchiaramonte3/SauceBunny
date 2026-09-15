// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { openShareMediaBridge } from "./share-media-bridge";

function track(kind: "video" | "audio") {
  return { kind, contentHint: "", stop: vi.fn() } as unknown as MediaStreamTrack;
}
function stream(tracks: MediaStreamTrack[]) {
  return { getTracks: () => [...tracks], getVideoTracks: () => tracks.filter(t => t.kind === "video"),
    getAudioTracks: () => tracks.filter(t => t.kind === "audio"),
    addTrack: (t: MediaStreamTrack) => tracks.push(t), removeTrack: (t: MediaStreamTrack) => tracks.splice(tracks.indexOf(t), 1),
  } as unknown as MediaStream;
}
const oldCanvasCapture = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "captureStream");
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
  if (oldCanvasCapture) Object.defineProperty(HTMLCanvasElement.prototype, "captureStream", oldCanvasCapture);
  else Reflect.deleteProperty(HTMLCanvasElement.prototype, "captureStream");
});
function setup(native = false, audio = false) {
  const video = document.createElement("video"); video.muted = true;
  let readyState = 1;
  Object.defineProperties(video, { videoWidth: { value: 1280 }, videoHeight: { value: 720 }, readyState: { get: () => readyState } });
  video.play = vi.fn(async () => {});
  const callbacks = new Map<number, VideoFrameRequestCallback>();
  let next = 0;
  video.requestVideoFrameCallback = vi.fn(callback => { callbacks.set(++next, callback); return next; });
  video.cancelVideoFrameCallback = vi.fn(id => { callbacks.delete(id); });
  const v = track("video"), a = track("audio"), output = stream(audio ? [v, a] : [v]);
  const capture = vi.fn(() => output), draw = vi.fn();
  if (native) Object.defineProperty(video, "captureStream", { value: capture });
  else {
    Object.defineProperty(HTMLCanvasElement.prototype, "captureStream", { configurable: true, value: capture });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: draw } as unknown as CanvasRenderingContext2D);
  }
  const frame = () => {
    readyState = 2;
    video.currentTime += 1 / 30;
    const pending = [...callbacks]; callbacks.clear();
    for (const [, callback] of pending) callback(1, {} as VideoFrameCallbackMetadata);
  };
  const abort = new AbortController(), onDied = vi.fn();
  return { video, v, a, output, capture, draw, frame, callbacks, abort, onDied, decode: () => { readyState = 2; } };
}

describe("decoded native program → RTC bridge", () => {
  it("never treats play or metadata as a decoded picture, even with native captureStream", async () => {
    const h = setup(true);
    const opening = openShareMediaBridge(h.video, { audio: false, signal: h.abort.signal, onDied: h.onDied });
    await Promise.resolve();
    expect(h.capture).not.toHaveBeenCalled();
    h.frame(); const result = await opening;
    expect(result.track).toBe(h.v); expect(result.track.contentHint).toBe("detail");
    expect(h.video.muted).toBe(true);
    result.close(); result.close(); expect(h.v.stop).toHaveBeenCalledTimes(1);
  });
  it("sends a painted canvas when HTMLVideoElement.captureStream is absent", async () => {
    const h = setup();
    const opening = openShareMediaBridge(h.video, { audio: false, signal: h.abort.signal, onDied: h.onDied });
    expect(h.capture).not.toHaveBeenCalled();
    h.frame(); const result = await opening;
    expect(h.draw).toHaveBeenCalledWith(h.video, 0, 0, 1280, 720);
    expect(h.capture).toHaveBeenCalledExactlyOnceWith(30);
    expect(result.stream).toBe(h.output); expect(result.audioTrack).toBeNull();
    h.frame(); expect(h.draw).toHaveBeenCalledTimes(2);
    result.close(); expect(h.callbacks.size).toBe(0); expect(h.v.stop).toHaveBeenCalledTimes(1);
  });
  it("uses decoded hidden-video pixels even when WebKit never delivers a compositor callback", async () => {
    vi.useFakeTimers(); const h = setup();
    const opening = openShareMediaBridge(h.video, { audio: false, signal: h.abort.signal, onDied: h.onDied });
    await vi.advanceTimersByTimeAsync(100);
    expect(h.capture).not.toHaveBeenCalled();
    h.decode(); await vi.advanceTimersByTimeAsync(34);
    const result = await opening;
    expect(h.draw).toHaveBeenCalledTimes(1); expect(h.capture).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100); expect(h.draw).toHaveBeenCalledTimes(1);
    h.video.currentTime += 1 / 30; await vi.advanceTimersByTimeAsync(34);
    expect(h.draw).toHaveBeenCalledTimes(2);
    result.close(); expect(vi.getTimerCount()).toBe(0);
  });
  it("fails truthfully and cleans up when canvas stream capture is also unavailable", async () => {
    const h = setup(); Reflect.deleteProperty(HTMLCanvasElement.prototype, "captureStream");
    await expect(openShareMediaBridge(h.video, { audio: false, signal: h.abort.signal, onDied: h.onDied }))
      .rejects.toThrow(/Canvas stream capture is unavailable/);
    expect(h.video.play).not.toHaveBeenCalled(); expect(h.video.muted).toBe(true);
  });
  it("routes opted-in system audio only to RTC, never to speakers or microphone", async () => {
    const h = setup(), audio = track("audio"), destinationStream = stream([audio]);
    const connect = vi.fn(), disconnect = vi.fn(), close = vi.fn(async () => {});
    const destination = { stream: destinationStream }, speakers = {};
    const source = { connect, disconnect };
    const createSource = vi.fn(() => source), resume = vi.fn(async () => {});
    vi.stubGlobal("AudioContext", class {
      state = "running"; destination = speakers; close = close; resume = resume;
      createMediaStreamDestination = () => destination;
      createMediaElementSource = createSource;
    });
    const opening = openShareMediaBridge(h.video, { audio: true, signal: h.abort.signal, onDied: h.onDied });
    expect(createSource).toHaveBeenCalledWith(h.video);
    expect(connect).toHaveBeenCalledExactlyOnceWith(destination);
    expect(connect).not.toHaveBeenCalledWith(speakers);
    expect(h.video.muted).toBe(false); expect(h.video.volume).toBe(1);
    h.frame(); const result = await opening;
    expect(result.audioTrack).toBe(audio); expect(result.stream.getTracks()).toEqual([h.v, audio]);
    result.close(); result.close();
    expect(h.video.muted).toBe(true); expect(disconnect).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1); expect(audio.stop).toHaveBeenCalledTimes(1);
  });
  it("removes audio when consent was off even if a native stream unexpectedly has it", async () => {
    const h = setup(true, true);
    const opening = openShareMediaBridge(h.video, { audio: false, signal: h.abort.signal, onDied: h.onDied });
    h.frame(); const result = await opening;
    expect(result.audioTrack).toBeNull(); expect(h.a.stop).toHaveBeenCalledTimes(1);
    result.close();
  });
  it("Stop aborts before a first frame without announcing a capture death", async () => {
    const h = setup();
    const opening = openShareMediaBridge(h.video, { audio: false, signal: h.abort.signal, onDied: h.onDied });
    h.abort.abort();
    await expect(opening).rejects.toMatchObject({ name: "AbortError" });
    expect(h.callbacks.size).toBe(0); expect(h.capture).not.toHaveBeenCalled(); expect(h.onDied).not.toHaveBeenCalled();
  });
  it("Stop also aborts a blocked play after a frame has arrived", async () => {
    const h = setup(); h.video.play = vi.fn(() => new Promise<void>(() => {}));
    const opening = openShareMediaBridge(h.video, { audio: false, signal: h.abort.signal, onDied: h.onDied });
    h.frame(); h.abort.abort();
    await expect(opening).rejects.toMatchObject({ name: "AbortError" });
    expect(h.v.stop).toHaveBeenCalledTimes(1); expect(h.callbacks.size).toBe(0);
  });
});
