// @vitest-environment jsdom
import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyNdiState, type NdiProgram } from "../hooks/use-ndi-input";
import { ReviewProgramSurfaces, type ReviewProgramSurfacesHandle } from "./ReviewProgramSurfaces";

const source = (id: string): NdiProgram => ({ id, name: `Premiere ${id}`, url: `/program/${id}`, reviewKey: `ndi:${id}`, local: true, ownerId: "m0" });
const telemetry = (id: string) => ({ ...emptyNdiState(), sourceId: id, phase: "live" as const, connectionCount: 1 });
const created: EventTarget[] = [];
class MediaSourceMock extends EventTarget {
  static isTypeSupported = () => true;
  constructor() { super(); created.push(this); }
  addSourceBuffer() { return Object.assign(new EventTarget(), { mode: "", updating: false, buffered: { length: 0 }, appendBuffer: vi.fn() }); }
}
function decoded(video: HTMLVideoElement) {
  Object.defineProperties(video, { readyState: { value: 2, configurable: true }, videoWidth: { value: 1920, configurable: true } });
  fireEvent.loadedData(video);
}
const videos = (root: HTMLElement) => Array.from(root.querySelectorAll("video"));
async function primePlayback() {
  vi.spyOn(MediaSourceMock.prototype, "addSourceBuffer").mockImplementation(() => Object.assign(new EventTarget(), {
    mode: "", updating: false, buffered: { length: 1, start: () => 0, end: () => 1 }, appendBuffer: vi.fn(),
  }));
  vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => ({ ok: true,
    body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1, 0, 0, 0, 1, 0])); } }),
  })));
  await act(async () => { for (const mediaSource of created) mediaSource.dispatchEvent(new Event("sourceopen")); });
}
const pictureVisible = (video: HTMLVideoElement) => video.parentElement?.style.visibility === "visible"
  && (video.closest(".cp-review-program-surface") as HTMLElement).style.visibility === "visible";
const props = () => ({
  program: null as NdiProgram | null, state: telemetry("a"), previewProgram: source("b") as NdiProgram | null,
  previewState: telemetry("b"), previewVisible: true, active: true,
  roomAudio: { muted: false, volume: 0.3 }, previewAudio: { muted: true, volume: 0.7 },
  onFrameDecoded: vi.fn(), onPictureFailed: vi.fn(), onPreviewFrameDecoded: vi.fn(), onPreviewPictureFailed: vi.fn(),
});
beforeEach(() => {
  created.length = 0;
  vi.stubGlobal("MediaSource", MediaSourceMock);
  let sequence = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:program-${++sequence}`);
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("the Review monitor's private and published program surfaces", () => {
  it("routes settings recovery only to the selected decoder and clears it when hidden or stopped", async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValue(new DOMException("Gesture required", "NotAllowedError"));
    const p={...props(),program:source("a")}, recovery=vi.fn();
    const h=render(<ReviewProgramSurfaces {...p} onRecoveryChange={recovery}/>);
    const [room,candidate]=videos(h.container);decoded(room);decoded(candidate);
    await primePlayback();
    expect(recovery.mock.lastCall![0].label).toBe("Resume program monitor");
    h.rerender(<ReviewProgramSurfaces {...p} previewVisible={false} onRecoveryChange={recovery}/>);
    await act(async()=>{});
    expect(recovery.mock.lastCall![0].label).toBe("Enable program audio");
    vi.mocked(HTMLMediaElement.prototype.play).mockClear().mockResolvedValue();
    await act(async()=>{recovery.mock.lastCall![0].resume();});
    expect(vi.mocked(HTMLMediaElement.prototype.play).mock.contexts).toEqual([room]);
    expect(recovery).toHaveBeenLastCalledWith(null);
    fireEvent.pause(room);expect(recovery.mock.lastCall![0]).not.toBeNull();
    h.rerender(<ReviewProgramSurfaces {...p} previewVisible={false} program={{...p.program,stopped:true}} onRecoveryChange={recovery}/>);
    expect(recovery).toHaveBeenLastCalledWith(null);
    h.rerender(<ReviewProgramSurfaces {...p} program={{...p.program,stopped:true}} active={false} onRecoveryChange={recovery}/>);
    expect(recovery).toHaveBeenLastCalledWith(null);
    expect(videos(h.container)).toEqual([room,candidate]);expect(created).toHaveLength(2);
    expect(h.container.querySelector("button,.cp-peerstage-badge")).toBeNull();
  });
  it("decodes privately without announcing room readiness, and uses Transport audio", () => {
    const p = props(); const h = render(<ReviewProgramSurfaces {...p}/>);
    const video = videos(h.container)[0]; decoded(video);
    expect(p.onPreviewFrameDecoded).toHaveBeenCalledExactlyOnceWith("b");
    expect(p.onFrameDecoded).not.toHaveBeenCalled();
    expect(pictureVisible(video)).toBe(true); expect(video.muted).toBe(true); expect(video.volume).toBe(0.7);
    expect(h.container.querySelector(".cp-ndi-audio-bar")).toBeNull();
    h.rerender(<ReviewProgramSurfaces {...p} previewAudio={{ muted: false, volume: 0.5 }}/>);
    expect(video.muted).toBe(false); expect(video.volume).toBe(0.5);
  });
  it("promotes the exact decoded candidate without reopening its decoder", () => {
    const p = props(); const h = render(<ReviewProgramSurfaces {...p}/>);
    const video = videos(h.container)[0]; decoded(video);
    h.rerender(<ReviewProgramSurfaces {...p} program={p.previewProgram} state={p.previewState} previewProgram={null} previewVisible={false}/>);
    expect(videos(h.container)).toEqual([video]); expect(created).toHaveLength(1);
    expect(pictureVisible(video)).toBe(true); expect(video.muted).toBe(false); expect(video.volume).toBe(0.3);
    expect(p.onFrameDecoded).toHaveBeenCalledExactlyOnceWith("b");
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });
  it("announces a hidden published decoder only after its actual visible promotion", () => {
    const p = { ...props(), program: source("a") };
    const h = render(<ReviewProgramSurfaces {...p}/>);
    const [room, candidate] = videos(h.container); decoded(room); decoded(candidate);
    expect(p.onFrameDecoded).not.toHaveBeenCalled(); expect(room.muted).toBe(true);
    h.rerender(<ReviewProgramSurfaces {...p} previewVisible={false}/>);
    expect(p.onFrameDecoded).toHaveBeenCalledExactlyOnceWith("a");
    expect(videos(h.container)).toEqual([room, candidate]); expect(pictureVisible(room)).toBe(true);
    expect(room.muted).toBe(false); expect(candidate.muted).toBe(true);
    h.rerender(<ReviewProgramSurfaces {...p}/>);
    h.rerender(<ReviewProgramSurfaces {...p} previewVisible={false}/>);
    expect(p.onFrameDecoded).toHaveBeenCalledTimes(1);
  });
  it("waits for Review to become visible before announcing a background publication", () => {
    const p = props(); const h = render(<ReviewProgramSurfaces {...p}/>);
    const video = videos(h.container)[0]; decoded(video);
    const published = { ...p, program: p.previewProgram, state: p.previewState, previewProgram: null, previewVisible: false };
    h.rerender(<ReviewProgramSurfaces {...published} active={false}/>);
    expect(p.onFrameDecoded).not.toHaveBeenCalled(); expect(pictureVisible(video)).toBe(false);
    h.rerender(<ReviewProgramSurfaces {...published}/>);
    expect(p.onFrameDecoded).toHaveBeenCalledExactlyOnceWith("b"); expect(pictureVisible(video)).toBe(true);
    expect(videos(h.container)).toEqual([video]); expect(created).toHaveLength(1);
  });
  it("keeps the playing room decoder and the last candidate until its replacement paints", () => {
    const p = { ...props(), program: source("a"), previewVisible: false };
    const h = render(<ReviewProgramSurfaces {...p}/>);
    const [room, candidate] = videos(h.container); decoded(room); decoded(candidate);
    h.rerender(<ReviewProgramSurfaces {...p} previewVisible/>);
    expect(pictureVisible(candidate)).toBe(true); expect(room.muted).toBe(true);
    const next = source("c");
    h.rerender(<ReviewProgramSurfaces {...p} previewVisible previewProgram={next} previewState={telemetry("c")}/>);
    expect(videos(h.container)).toHaveLength(3); expect(room.isConnected).toBe(true);
    expect(pictureVisible(candidate)).toBe(true); expect(candidate.muted).toBe(true);
    const replacement = videos(h.container).find(video => video !== room && video !== candidate)!;
    expect(pictureVisible(replacement)).toBe(false);
    decoded(replacement);
    expect(videos(h.container)).toEqual([room, replacement]); expect(pictureVisible(replacement)).toBe(true);
    expect(candidate.isConnected).toBe(false);
  });
  it("bounds rapid replacements and ignores frames from cancelled candidates", () => {
    const p = { ...props(), program: source("a") }; const h = render(<ReviewProgramSurfaces {...p}/>);
    const [room, candidate] = videos(h.container); decoded(room); decoded(candidate);
    h.rerender(<ReviewProgramSurfaces {...p} previewProgram={source("c")} previewState={telemetry("c")}/>);
    const cancelled = videos(h.container).find(video => video !== room && video !== candidate)!;
    h.rerender(<ReviewProgramSurfaces {...p} previewProgram={source("d")} previewState={telemetry("d")}/>);
    expect(videos(h.container)).toHaveLength(3); expect(cancelled.isConnected).toBe(false);
    decoded(cancelled);
    expect(p.onPreviewFrameDecoded).not.toHaveBeenCalledWith("c"); expect(pictureVisible(candidate)).toBe(true);
  });
  it("keeps the prepared decoder mounted and muted when Review or private preview closes", () => {
    const p = props(); const h = render(<ReviewProgramSurfaces {...p}/>);
    const video = videos(h.container)[0]; decoded(video);
    h.rerender(<ReviewProgramSurfaces {...p} active={false}/>);
    expect(videos(h.container)).toEqual([video]); expect(pictureVisible(video)).toBe(false); expect(video.muted).toBe(true);
    h.rerender(<ReviewProgramSurfaces {...p} previewVisible={false}/>);
    expect(videos(h.container)).toEqual([video]); expect(pictureVisible(video)).toBe(false);
    h.rerender(<ReviewProgramSurfaces {...p}/>);
    expect(pictureVisible(video)).toBe(true); expect(created).toHaveLength(1);
  });
  it("retains a stopped published picture and can dispose the cancelled private candidate", () => {
    const p = { ...props(), program: source("a"), previewVisible: false };
    const h = render(<ReviewProgramSurfaces {...p}/>); const [room, candidate] = videos(h.container); decoded(room); decoded(candidate);
    h.rerender(<ReviewProgramSurfaces {...p} program={{ ...p.program, stopped: true }} previewProgram={null}/>);
    expect(videos(h.container)).toEqual([room]); expect(pictureVisible(room)).toBe(true); expect(room.muted).toBe(true);
    expect(room.getAttribute("src")).toBe("blob:program-1");
  });
  it("preserves the exact stopped room picture while a same-ID private feed continues", () => {
    const live = source("a"), p = { ...props(), program: live, previewProgram: null, previewVisible: false };
    const h = render(<ReviewProgramSurfaces {...p}/>); const room = videos(h.container)[0]; decoded(room);
    room.currentTime = 17;
    const stopped = { ...live, stopped: true };
    h.rerender(<ReviewProgramSurfaces {...p} program={stopped} previewProgram={live} previewState={telemetry("a")}/>);
    const candidate = videos(h.container).find(video => video !== room)!; decoded(candidate); candidate.currentTime = 99;
    expect(videos(h.container)).toHaveLength(2); expect(pictureVisible(room)).toBe(true);
    expect(p.onPreviewFrameDecoded).toHaveBeenCalledWith("a");
    h.rerender(<ReviewProgramSurfaces {...p} program={stopped} previewProgram={live} previewState={telemetry("a")} previewVisible/>);
    expect(pictureVisible(candidate)).toBe(true); expect(pictureVisible(room)).toBe(false);
    h.rerender(<ReviewProgramSurfaces {...p} program={stopped} previewProgram={live} previewState={telemetry("a")}/>);
    expect(pictureVisible(room)).toBe(true); expect(room.currentTime).toBe(17); expect(candidate.currentTime).toBe(99);
    expect(room.muted).toBe(true); expect(candidate.muted).toBe(true); expect(created).toHaveLength(2);
  });
  it("re-publishes the same-ID private decoder instead of resuming the stopped room decoder", () => {
    const live = source("a"), p = { ...props(), program: live, previewProgram: null, previewVisible: false };
    const h = render(<ReviewProgramSurfaces {...p}/>); const stoppedVideo = videos(h.container)[0]; decoded(stoppedVideo);
    h.rerender(<ReviewProgramSurfaces {...p} program={{ ...live, stopped: true }} previewProgram={live} previewState={telemetry("a")} previewVisible/>);
    const privateVideo = videos(h.container).find(video => video !== stoppedVideo)!;
    expect(pictureVisible(stoppedVideo)).toBe(true); decoded(privateVideo);
    expect(pictureVisible(privateVideo)).toBe(true);
    h.rerender(<ReviewProgramSurfaces {...p}/>);
    expect(videos(h.container)).toEqual([privateVideo]); expect(created).toHaveLength(2);
    expect(pictureVisible(privateVideo)).toBe(true); expect(stoppedVideo.isConnected).toBe(false);
    expect(p.onFrameDecoded).toHaveBeenCalledTimes(2); expect(p.onFrameDecoded).toHaveBeenLastCalledWith("a");
  });
  it("does not revoke stopped-room readiness when its same-ID private decoder fails", () => {
    const live = source("a"), p = { ...props(), program: live, previewProgram: null, previewVisible: false };
    const h = render(<ReviewProgramSurfaces {...p}/>); const room = videos(h.container)[0]; decoded(room);
    h.rerender(<ReviewProgramSurfaces {...p} program={{ ...live, stopped: true }} previewProgram={live} previewState={telemetry("a")} previewVisible/>);
    const candidate = videos(h.container).find(video => video !== room)!; fireEvent.error(candidate);
    expect(p.onPreviewPictureFailed).toHaveBeenCalledExactlyOnceWith("a"); expect(p.onPictureFailed).not.toHaveBeenCalled();
    expect(pictureVisible(room)).toBe(true);
    h.rerender(<ReviewProgramSurfaces {...p} program={{ ...live, stopped: true }}/>);
    expect(videos(h.container)).toEqual([room]); expect(pictureVisible(room)).toBe(true);
    expect(created).toHaveLength(2);
  });
  it("retries the selected failed replacement, not the retained old picture", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 })));
    const p = props(), ref = createRef<ReviewProgramSurfacesHandle>(), recovery=vi.fn();
    const h = render(<ReviewProgramSurfaces {...p} ref={ref} onRecoveryChange={recovery}/>); const old = videos(h.container)[0]; decoded(old);
    h.rerender(<ReviewProgramSurfaces {...p} ref={ref} previewProgram={source("c")} previewState={telemetry("c")} onRecoveryChange={recovery}/>);
    await act(async () => { created[1].dispatchEvent(new Event("sourceopen")); });
    expect(p.onPreviewPictureFailed).toHaveBeenCalledWith("c"); expect(p.onPictureFailed).not.toHaveBeenCalled();
    expect(recovery.mock.lastCall![0].error).toContain("503");
    expect(h.container.querySelector("button,.cp-peerstage-badge")).toBeNull();
    expect(pictureVisible(old)).toBe(true);
    act(() => ref.current!.retryVisible());
    expect(created).toHaveLength(3); expect(old.isConnected).toBe(true);
    const replacement = videos(h.container).find(video => video !== old)!; decoded(replacement);
    expect(videos(h.container)).toEqual([replacement]); expect(p.onPreviewFrameDecoded).toHaveBeenCalledWith("c");
  });
  it("offers an explicit autoplay retry without adding permanent player chrome", async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValueOnce(new Error("Autoplay denied"));
    const p = props(), recovery=vi.fn(); const h = render(<ReviewProgramSurfaces {...p} onRecoveryChange={recovery}/>);
    expect(recovery).toHaveBeenLastCalledWith(null);
    await primePlayback();
    expect(recovery.mock.lastCall![0].label).toBe("Resume program monitor");
    await act(async () => { recovery.mock.lastCall![0].resume(); });
    expect(recovery).toHaveBeenLastCalledWith(null);
    expect(screen.queryByRole("button", { name: "Resume program monitor" })).toBeNull();
    expect(h.container.querySelector(".cp-ndi-audio-bar")).toBeNull();
  });
});
