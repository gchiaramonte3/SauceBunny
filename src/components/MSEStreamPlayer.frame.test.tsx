// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MSEStreamPlayer } from "./MSEStreamPlayer";
import type { PlayerHandle, SeekResult } from "./player-handle";

// jsdom supplies no decoder/compositor. Model only buffer delivery and a
// decoded-but-covered video; drive the real component's seek lifecycle.
class BufferDouble extends EventTarget {
  updating = false;
  mode = "segments";
  timestampOffset = 0;
  buffered = { length: 0, start: () => 0, end: () => 100 };
  appendBuffer() {
    this.buffered.length = 1;
    queueMicrotask(() => this.dispatchEvent(new Event("updateend")));
  }
  abort() {}
}
class MediaSourceDouble extends EventTarget {
  static instances: MediaSourceDouble[] = [];
  static isTypeSupported() { return true; }
  readyState = "open";
  duration = 149;
  constructor() {
    super();
    MediaSourceDouble.instances.push(this);
    queueMicrotask(() => this.dispatchEvent(new Event("sourceopen")));
  }
  addSourceBuffer() { return new BufferDouble(); }
  removeSourceBuffer() {}
  endOfStream() { this.readyState = "ended"; }
}

beforeEach(() => {
  vi.useFakeTimers();
  MediaSourceDouble.instances = [];
  vi.stubGlobal("MediaSource", MediaSourceDouble);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array([1]), {
    headers: { "x-timeline": "absolute", "x-stream-epoch": "0" },
  })));
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

async function mount() {
  const player = createRef<PlayerHandle>();
  const view = render(<MSEStreamPlayer ref={player} path="http://127.0.0.1/v1/media"
    hasVideo initialVolume={1} knownDuration={149} videoCodec="avc1.640028"
    audioCodec="mp4a.40.2" disableScrubPreview />);
  const video = view.container.querySelector("video")!;
  Object.defineProperties(video, {
    readyState: { configurable: true, value: 2 },
    videoWidth: { configurable: true, value: 1920 },
    requestVideoFrameCallback: { configurable: true, value: vi.fn(() => 7) },
    cancelVideoFrameCallback: { configurable: true, value: vi.fn() },
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(player.current!.isReady()).toBe(true);
  return { player, video };
}

it("confirms an already-decoded zero-distance seek without another seeked/rVFC event", async () => {
  const { player } = await mount();
  let landing!: Promise<SeekResult>;
  act(() => { landing = player.current!.seekTo(0); });
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(await landing).toEqual({ requestedSeconds: 0, presentedSeconds: 0, status: "presented" });
});

it("only the newest command can settle after the compositor stays quiet", async () => {
  const { player } = await mount();
  const first = player.current!.seekTo(42);
  const second = player.current!.seekTo(68);
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect((await first).status).toBe("superseded");
  expect(await second).toEqual({ requestedSeconds: 68, presentedSeconds: 68, status: "presented" });
});

it("a media clock with no decoded frame never passes the seek gate", async () => {
  const { player, video } = await mount();
  Object.defineProperty(video, "readyState", { value: 1 });
  const landing = player.current!.seekTo(68);
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect((await landing).status).toBe("unavailable");
});

it("aborts a pending response before replacing its pipeline", async () => {
  const requests: AbortSignal[] = [];
  vi.stubGlobal("fetch", vi.fn((_url: string, init?: RequestInit) => {
    requests.push(init?.signal as AbortSignal);
    return new Promise<Response>(() => {});
  }));
  const { player } = await mount();
  const landing = player.current!.seekTo(120);
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  expect(requests).toHaveLength(2);
  expect(requests[0]?.aborted).toBe(true);
  expect(requests[1]?.aborted).toBe(false);
  cleanup();
  expect(requests[1]?.aborted).toBe(true);
  expect((await landing).status).toBe("unavailable");
});

it("a cancelled reader's late EOF cannot end the replacement stream", async () => {
  let oldRead!: (value: ReadableStreamReadResult<Uint8Array>) => void;
  const cancel = vi.fn(async () => {});
  let requests = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    if (++requests > 1) return new Promise<Response>(() => {});
    return { ok: true, headers: new Headers(), body: { getReader: () => ({
      read: () => new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => { oldRead = resolve; }),
      cancel,
    }) } };
  }));
  const { player } = await mount();
  const landing = player.current!.seekTo(120);
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  expect(cancel).toHaveBeenCalled();
  expect(MediaSourceDouble.instances).toHaveLength(2);
  await act(async () => { oldRead({ done: true, value: undefined }); });
  expect(MediaSourceDouble.instances[1].readyState).toBe("open");
  cleanup();
  await landing;
});

it("keeps reading until a rebuilt absolute stream reaches its landing frame", async () => {
  let requests = 0;
  let appends = 0;
  vi.spyOn(BufferDouble.prototype, "appendBuffer").mockImplementation(function (this: BufferDouble) {
    const end = [2, 67, 74][appends++];
    this.buffered = { length: 1, start: () => 0, end: () => end };
    queueMicrotask(() => this.dispatchEvent(new Event("updateend")));
  });
  vi.stubGlobal("fetch", vi.fn(async () => {
    const chunks = ++requests === 1 ? 1 : 2;
    return new Response(new ReadableStream({ start(controller) {
      for (let i = 0; i < chunks; i++) controller.enqueue(new Uint8Array([1]));
      controller.close();
    } }), { headers: { "x-timeline": "absolute", "x-stream-epoch": "0" } });
  }));
  const { player, video } = await mount();
  const landing = player.current!.seekTo(68.3);
  await act(async () => { await vi.advanceTimersByTimeAsync(10); });
  // The first post-seek fragment ends at 67s. Comparing buffer-ahead to
  // currentTime=0 would stop reads there, so the 68.3s frame never arrives.
  expect(appends).toBe(3);
  expect(video.currentTime).toBeCloseTo(68.3);
  await act(async () => { video.dispatchEvent(new Event("seeked")); });
  expect((await landing).status).toBe("presented");
});
