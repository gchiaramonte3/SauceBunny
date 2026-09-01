// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { canCapture, captureElement } from "./viewer-capture";

/** A stream stub: jsdom has no real MediaStream, and this only needs shape. */
function streamWith(video: number, audio: number): MediaStream {
  const v = Array.from({ length: video }, (_, i) => ({ id: `v${i}`, kind: "video" }));
  const a = Array.from({ length: audio }, (_, i) => ({ id: `a${i}`, kind: "audio" }));
  return {
    getVideoTracks: () => v,
    getAudioTracks: () => a,
  } as unknown as MediaStream;
}

function videoEl(opts: {
  capture?: () => MediaStream;
  readyState?: number;
}): HTMLVideoElement {
  const el = document.createElement("video");
  Object.defineProperty(el, "readyState", { value: opts.readyState ?? 4, configurable: true });
  if (opts.capture) {
    (el as HTMLVideoElement & { captureStream: () => MediaStream }).captureStream = opts.capture;
  }
  return el;
}

describe("capturing what the monitor is painting", () => {
  it("returns the tracks a video element hands over", () => {
    const el = videoEl({ capture: () => streamWith(1, 1) });
    const cap = captureElement(el);
    expect(cap?.video?.kind).toBe("video");
    expect(cap?.audio?.kind).toBe("audio");
  });

  it("treats an EMPTY stream as no capture", () => {
    // A <video> that has not started answers captureStream with a stream
    // carrying no tracks. Passing that to the mesh shows the guest a black
    // tile that never resolves, which reads as the feature being broken
    // rather than as "not ready yet".
    const el = videoEl({ capture: () => streamWith(0, 0) });
    expect(captureElement(el)).toBe(null);
  });

  it("is null rather than throwing when the engine refuses", () => {
    const el = videoEl({ capture: () => { throw new Error("tainted"); } });
    expect(captureElement(el)).toBe(null);
  });

  it("is null when the engine has no captureStream at all", () => {
    expect(captureElement(videoEl({}))).toBe(null);
  });

  it("is null for no element", () => {
    expect(captureElement(null)).toBe(null);
  });

  it("captures a canvas, which carries no audio", () => {
    const el = document.createElement("canvas");
    el.width = 640; el.height = 360;
    (el as HTMLCanvasElement & { captureStream: (fps?: number) => MediaStream }).captureStream =
      () => streamWith(1, 0);
    const cap = captureElement(el);
    expect(cap?.video?.kind).toBe("video");
    expect(cap?.audio).toBe(null);
  });

  it("asks a canvas for a frame rate, since it has no rate of its own", () => {
    const el = document.createElement("canvas");
    el.width = 640; el.height = 360;
    let asked: number | undefined = -1;
    (el as HTMLCanvasElement & { captureStream: (fps?: number) => MediaStream }).captureStream =
      (fps) => { asked = fps; return streamWith(1, 0); };
    captureElement(el);
    expect(asked).toBeGreaterThan(0);
  });
});

describe("knowing whether a capture is worth offering", () => {
  it("says no before the element has a frame", () => {
    // readyState 1 is HAVE_METADATA: duration is known, no picture yet.
    expect(canCapture(videoEl({ capture: () => streamWith(1, 0), readyState: 1 }))).toBe(false);
  });

  it("says yes once it has current data", () => {
    expect(canCapture(videoEl({ capture: () => streamWith(1, 0), readyState: 2 }))).toBe(true);
  });

  it("says no for a canvas that has never been sized", () => {
    const el = document.createElement("canvas");
    el.width = 0; el.height = 0;
    (el as HTMLCanvasElement & { captureStream: () => MediaStream }).captureStream = () => streamWith(1, 0);
    expect(canCapture(el)).toBe(false);
  });

  it("says no when the engine cannot capture at all", () => {
    expect(canCapture(videoEl({ readyState: 4 }))).toBe(false);
    expect(canCapture(null)).toBe(false);
  });
});
