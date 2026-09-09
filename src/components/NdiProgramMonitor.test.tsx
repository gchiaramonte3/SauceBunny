// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NdiProgramMonitor } from "./NdiProgramMonitor";
import { emptyNdiState, type NdiProgram } from "../hooks/use-ndi-input";

const source = (id = "a", stopped = false): NdiProgram => ({
  id, name: `Premiere ${id}`, url: `/media/${id}`, reviewKey: `ndi:review-${id}`, local: true, ownerId: "m0", stopped,
});
const state = { ...emptyNdiState(), sourceId: "a", phase: "live" as const, connectionCount: 1 };
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
async function primePlayback(end=1) {
  const buffer=Object.assign(new EventTarget(),{mode:"",updating:false,
    buffered:{length:1,start:()=>0,end:()=>end},appendBuffer:vi.fn()});
  vi.spyOn(MediaSourceMock.prototype,"addSourceBuffer").mockReturnValue(buffer);
  const body=new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new Uint8Array([1,0,0,0,1,0]));}});
  vi.stubGlobal("fetch",vi.fn().mockResolvedValue({ok:true,body}));
  await act(async()=>{created[0].dispatchEvent(new Event("sourceopen"));});
  return buffer;
}
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

describe("NDI decoded-picture handoff", () => {
  it("waits for the startup audio reserve before playing even when PTS starts at zero",async()=>{
    const h=render(<NdiProgramMonitor program={source()} state={state} audio={{muted:false,volume:1}}/>);
    const video=videos(h.container)[0];
    const buffer=await primePlayback(0.1);
    decoded(video);await act(async()=>{});
    expect(video.autoplay).toBe(false);
    expect(video.play).not.toHaveBeenCalled();
    buffer.buffered.end=()=>0.6;
    await act(async()=>{buffer.dispatchEvent(new Event("updateend"));});
    expect(video.currentTime).toBeCloseTo(0.1);
    expect(video.play).toHaveBeenCalledOnce();
  });
  it("drains a coalesced media burst before making a latency seek", async () => {
    const append=vi.fn();
    const buffer=Object.assign(new EventTarget(),{mode:"",updating:false,
      buffered:{length:1,start:()=>10,end:()=>11},appendBuffer:append,remove:vi.fn()});
    append.mockImplementation(()=>{buffer.updating=true;});
    vi.stubGlobal("MediaSource",class extends EventTarget {
      static isTypeSupported=()=>true;
      constructor(){super();created.push(this);}
      addSourceBuffer(){return buffer;}
    });
    let input!:ReadableStreamDefaultController<Uint8Array>;
    const body=new ReadableStream<Uint8Array>({start(controller){input=controller;}});
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue({ok:true,body}));
    const h=render(<NdiProgramMonitor program={source()} state={state}/>);
    const video=videos(h.container)[0];let current=5;
    const seek=vi.fn((value:number)=>{current=value;});
    Object.defineProperty(video,"currentTime",{configurable:true,get:()=>current,set:seek});
    await act(async()=>{created[0].dispatchEvent(new Event("sourceopen"));});
    // Init plus six independent fragments arrive during a native append.
    const bytes=new Uint8Array(7*6),view=new DataView(bytes.buffer);
    for(let i=0;i<7;i++){bytes[i*6]=i===0?1:2;view.setUint32(i*6+1,1);bytes[i*6+5]=i;}
    await act(async()=>{input.enqueue(bytes);});
    expect(append).toHaveBeenCalledTimes(1);
    expect(seek).not.toHaveBeenCalled();
    for(let i=0;i<6;i++)await act(async()=>{buffer.updating=false;buffer.dispatchEvent(new Event("updateend"));});
    expect(append.mock.calls.map(([data])=>(data as Uint8Array)[0])).toEqual([0,1,2,3,4,5,6]);
    expect(seek).not.toHaveBeenCalled();
    await act(async()=>{buffer.updating=false;buffer.dispatchEvent(new Event("updateend"));});
    expect(seek).toHaveBeenCalledExactlyOnceWith(10.5);
    expect(videos(h.container)).toEqual([video]);
    h.unmount();await act(async()=>{input.close();});
  });
  it("explains Premiere's tiny startup placeholder without claiming the preview is ready", () => {
    const ready=vi.fn();
    render(<NdiProgramMonitor program={source()} state={{...state,phase:"connecting",inputWidth:8,inputHeight:8}} onFrameDecoded={ready}/>);
    expect(screen.getByRole("status").textContent).toContain("Park inside the sequence");
    expect(ready).not.toHaveBeenCalled();
  });
  it("reports ready only after a real decoded frame, not a requested URL or empty timeupdate", async () => {
    const ready = vi.fn(); const h = render(<NdiProgramMonitor program={source()} state={state} onFrameDecoded={ready}/>);
    const video = videos(h.container)[0]; fireEvent.timeUpdate(video);
    expect(ready).not.toHaveBeenCalled();
    decoded(video); await act(async () => {});
    expect(ready).toHaveBeenCalledExactlyOnceWith("a");
    fireEvent.timeUpdate(video); expect(ready).toHaveBeenCalledTimes(1);
  });
  it("confirms picture after a live-edge seek supersedes the first loadeddata event", () => {
    const ready=vi.fn();const h=render(<NdiProgramMonitor program={source()} state={state} onFrameDecoded={ready}/>);
    const video=videos(h.container)[0];
    Object.defineProperties(video,{readyState:{value:1,configurable:true},videoWidth:{value:1920,configurable:true}});
    fireEvent.loadedData(video);expect(ready).not.toHaveBeenCalled();
    Object.defineProperty(video,"readyState",{value:2,configurable:true});
    fireEvent.seeked(video);
    expect(ready).toHaveBeenCalledExactlyOnceWith("a");
  });
  it("retains the old video until the new source decodes, without canvas readback", async () => {
    const h = render(<NdiProgramMonitor program={source()} state={state}/>);
    const old = videos(h.container)[0]; decoded(old);
    h.rerender(<NdiProgramMonitor program={source("b")} state={state}/>);
    expect(videos(h.container)).toHaveLength(2);
    expect(old.isConnected).toBe(true);
    expect(old.getAttribute("src")).toBe("blob:program-1");
    expect(old.parentElement?.style.visibility).toBe("visible");
    const next = videos(h.container)[1]; expect(next.parentElement?.style.visibility).toBe("hidden");
    decoded(next); await act(async () => {});
    expect(videos(h.container)).toEqual([next]);
    expect(old.isConnected).toBe(false);
    expect(next.parentElement?.style.visibility).toBe("visible");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:program-1");
  });
  it("ignores a cancelled replacement's late frame and keeps at most two decoder attempts", async () => {
    const ready = vi.fn(); const h = render(<NdiProgramMonitor program={source()} state={state} onFrameDecoded={ready}/>);
    const old = videos(h.container)[0]; decoded(old);
    h.rerender(<NdiProgramMonitor program={source("b")} state={state} onFrameDecoded={ready}/>);
    const cancelled = videos(h.container)[1];
    h.rerender(<NdiProgramMonitor program={source("c")} state={state} onFrameDecoded={ready}/>);
    expect(videos(h.container)).toHaveLength(2); expect(cancelled.isConnected).toBe(false);
    decoded(cancelled); await act(async () => {});
    expect(old.isConnected).toBe(true); expect(ready).not.toHaveBeenCalledWith("b");
    decoded(videos(h.container)[1]); expect(ready).toHaveBeenCalledWith("c");
  });
  it("does not unload the last picture when sharing stops", () => {
    const h = render(<NdiProgramMonitor program={source()} state={state}/>);
    const old = videos(h.container)[0]; decoded(old);
    h.rerender(<NdiProgramMonitor program={source("a", true)} state={state}/>);
    expect(videos(h.container)).toEqual([old]); expect(old.getAttribute("src")).toBe("blob:program-1");
    expect(screen.getByRole("status").textContent).toContain("Sharing stopped");
    expect(old.muted).toBe(true);
    expect(old.pause).toHaveBeenCalled();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });
  it("uses the room transport's audio without adding a permanent control strip", () => {
    const h=render(<NdiProgramMonitor program={source()} state={state} chrome={false} audio={{muted:true,volume:0.4}}/>);
    const video=videos(h.container)[0];decoded(video);
    expect(h.container.querySelector(".cp-ndi-audio-bar")).toBeNull();
    expect(video.muted).toBe(true);expect(video.volume).toBe(0.4);
    h.rerender(<NdiProgramMonitor program={source()} state={state} chrome={false} audio={{muted:false,volume:0.7}}/>);
    expect(video.muted).toBe(false);expect(video.volume).toBe(0.7);
    h.rerender(<NdiProgramMonitor program={source()} state={state} chrome={false} active={false} audio={{muted:false,volume:0.7}}/>);
    expect(video.muted).toBe(true);expect(videos(h.container)).toEqual([video]);
    h.rerender(<NdiProgramMonitor program={source()} state={state} chrome={false} active audio={{muted:false,volume:0.7}}/>);
    expect(video.muted).toBe(false);expect(videos(h.container)).toEqual([video]);
  });
  it("late joining a stopped source does not open a media connection", () => {
    render(<NdiProgramMonitor program={{ ...source("a", true), url: "" }} state={state}/>);
    expect(created).toHaveLength(0); expect(screen.getByRole("status").textContent).toContain("Sharing stopped");
  });
  it("offers explicit audio recovery when audible autoplay is blocked, without replacing the decoder", async () => {
    vi.mocked(HTMLMediaElement.prototype.play).mockRejectedValue(new DOMException("User gesture required", "NotAllowedError"));
    const recovery=vi.fn();
    const h=render(<NdiProgramMonitor program={source()} state={state} chrome={false} audio={{muted:false,volume:0.7}} onRecoveryChange={recovery}/>);
    await primePlayback();
    const video=videos(h.container)[0];
    decoded(video);await act(async()=>{});
    expect(video.muted).toBe(false);
    expect(h.container.querySelector("button,.cp-peerstage-badge")).toBeNull();
    const current=recovery.mock.lastCall![0];
    expect(current.label).toBe("Enable program audio");expect(current.error).toBeNull();
    vi.mocked(HTMLMediaElement.prototype.play).mockResolvedValue();
    await act(async()=>{current.resume();});
    expect(recovery).toHaveBeenLastCalledWith(null);
    expect(screen.queryByRole("button",{name:"Enable program audio"})).toBeNull();
    expect(videos(h.container)).toEqual([video]);
    expect(video.volume).toBe(0.7);
    expect(created).toHaveLength(1);
    expect(h.container.querySelector(".cp-ndi-audio-bar")).toBeNull();
  });
  it("makes an unexpected pause visible and recovers through the existing speaker state", async () => {
    const recovery=vi.fn();
    const h=render(<NdiProgramMonitor program={source()} state={state} chrome={false} audio={{muted:true,volume:0.4}} onRecoveryChange={recovery}/>);
    await primePlayback();
    const video=videos(h.container)[0];decoded(video);await act(async()=>{});
    fireEvent.pause(video);
    expect(recovery.mock.lastCall![0].label).toBe("Resume program monitor");
    expect(h.container.querySelector("button,.cp-peerstage-badge")).toBeNull();
    await act(async()=>{h.rerender(<NdiProgramMonitor program={source()} state={state} chrome={false} audio={{muted:false,volume:0.4}} onRecoveryChange={recovery}/>);});
    expect(recovery).toHaveBeenLastCalledWith(null);
    expect(screen.queryByRole("button",{name:/Resume program monitor|Enable program audio/})).toBeNull();
    expect(video.muted).toBe(false);expect(video.volume).toBe(0.4);
    expect(videos(h.container)).toEqual([video]);expect(created).toHaveLength(1);
  });
  it("keeps a failed replacement from turning the previous picture black", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503 })));
    const failed = vi.fn(); const h = render(<NdiProgramMonitor program={source()} state={state} onPictureFailed={failed}/>);
    const old = videos(h.container)[0]; decoded(old);
    h.rerender(<NdiProgramMonitor program={source("b")} state={state} onPictureFailed={failed}/>);
    await act(async () => { created[1].dispatchEvent(new Event("sourceopen")); });
    expect(failed).toHaveBeenCalledWith("b"); expect(old.isConnected).toBe(true);
    expect(old.parentElement?.style.visibility).toBe("visible");
    fireEvent.click(screen.getByRole("button", { name: "Reconnect picture" }));
    expect(videos(h.container)).toHaveLength(2); expect(old.isConnected).toBe(true);
  });
  it("reports a media-element decoder failure and retains the last picture for retry", async () => {
    const failed = vi.fn(), ready = vi.fn();
    const h = render(<NdiProgramMonitor program={source()} state={state} onPictureFailed={failed} onFrameDecoded={ready}/>);
    const old = videos(h.container)[0]; decoded(old);
    Object.defineProperty(old, "error", { value: { code: 3, message: "Decoder stopped" }, configurable: true });
    fireEvent.error(old);
    expect(failed).toHaveBeenCalledExactlyOnceWith("a");
    expect(screen.getByRole("alert").textContent).toContain("decode");
    expect(old.isConnected).toBe(true); expect(old.parentElement?.style.visibility).toBe("visible");
    expect(old.getAttribute("src")).toBe("blob:program-1");
    fireEvent.timeUpdate(old); expect(ready).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Reconnect picture" }));
    expect(videos(h.container)).toHaveLength(2); expect(old.isConnected).toBe(true);
    decoded(videos(h.container)[1]); await act(async () => {});
    expect(ready).toHaveBeenCalledTimes(2); expect(old.isConnected).toBe(false);
  });
  it("does not announce a first frame that arrives after its decoder already failed", () => {
    const failed=vi.fn(),ready=vi.fn();
    const h=render(<NdiProgramMonitor program={source()} state={state} onPictureFailed={failed} onFrameDecoded={ready}/>);
    const video=videos(h.container)[0];
    fireEvent.error(video);decoded(video);
    expect(failed).toHaveBeenCalledExactlyOnceWith("a");
    expect(ready).not.toHaveBeenCalled();
  });
  it("starts monitoring muted and never mixes held-source audio into a private candidate", () => {
    const h = render(<NdiProgramMonitor program={source()} state={state}/>);
    const old = videos(h.container)[0]; decoded(old); expect(old.muted).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Monitor program audio" })); expect(old.muted).toBe(false);
    h.rerender(<NdiProgramMonitor program={source("b")} state={state}/>);
    expect(old.muted).toBe(true); expect(videos(h.container)[1].muted).toBe(true);
    decoded(videos(h.container)[1]); expect(videos(h.container)[0].muted).toBe(true);
  });
  it("uses connection evidence to distinguish parking from input loss", () => {
    const h = render(<NdiProgramMonitor program={source()} state={{ ...state, phase: "stale", lastInputAgeMs: 5000 }}/>);
    decoded(videos(h.container)[0]); expect(screen.getByRole("status").textContent).toContain("picture parked");
    h.rerender(<NdiProgramMonitor program={source()} state={{ ...state, phase: "stale", connectionCount: 0 }}/>);
    expect(screen.getByRole("status").textContent).toContain("Input disconnected");
  });
});
