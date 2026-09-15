// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionState } from "../bindings/SessionState";
import type { ObsSelection } from "../bindings/ObsSelection";
import type { NdiStatusResult } from "../bindings/NdiStatusResult";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), listeners: new Map<string, (event: { payload: unknown }) => void>() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async (name, callback) => {
  mocks.listeners.set(name, callback); return () => { mocks.listeners.delete(name); };
}) }));
import { useNdiInput } from "./use-ndi-input";

const room: SessionState = { role: "peer", code: "room-a", peers: [], selfId: "m1", title: null, error: null, presenter: "m0", presenterEpoch: 0 };
const offStatus = { program: null, telemetry: { sourceId: "", phase: "off", error: null, inputWidth: 0, inputHeight: 0, outputFps: 0,
  receivedFrames: 0, ndiDroppedFrames: 0, encoderDroppedFrames: 0, inputFps:null,connectionCount:null,encoderDroppedAudioSamples:0,
  leftPeak: 0, rightPeak: 0, lastInputAgeMs: 0, encodedBitrateKbps: null }, encodedReady:false,roomGeneration:null };
const source = { kind: "loadSource", from: "m0", sourceKind: "ndi", url: "a".repeat(32), title: "Premiere" };
const emit = (name: string, payload: unknown) => act(() => { mocks.listeners.get(name)?.({ payload }); });
beforeEach(() => {
  localStorage.clear();
  mocks.invoke.mockReset(); mocks.listeners.clear();
  mocks.invoke.mockImplementation(async (command: string) => command === "session_state" ? room : command === "ndi_status" ? offStatus : null);
});
afterEach(cleanup);

describe("NDI source lifecycle", () => {
  it("pulls native desktop Stop truth for the host while retaining the room review and unrelated candidate", async () => {
    const id = "a".repeat(32), privateId = "b".repeat(32), host = { ...room, role: "host", selfId: "m0" };
    const program = { id, name: "Shared region", url: "/generated-shared" };
    const preview = { id: privateId, name: "Private window", url: "/generated-private" };
    const status = (p: typeof program): NdiStatusResult => ({ ...offStatus, program: p, encodedReady: true, roomGeneration: 1,
      telemetry: { ...offStatus.telemetry, sourceId: p.id, phase: "live", connectionCount: 1 } });
    let stopped = false;
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "session_state") return host;
      if (command === "ndi_sessions") return { programs: [...(stopped ? [] : [status(program)]), status(preview)],
        room: { generation: 1, presenterEpoch: 0, presenting: true, publishedId: stopped ? null : id,
          publicationRevision: stopped ? null : 1, source: { id, name: program.name, reviewKey: "ndi:shared-review", state: stopped ? "stopped" : "live" } } };
      return null;
    });
    const h = renderHook(useNdiInput); await act(async () => {});
    expect(h.result.current.program?.id).toBe(id); expect(h.result.current.previewProgram?.id).toBe(privateId);
    stopped = true;
    emit("session:msg", { kind: "loadSource", from: "m0", sourceKind: "ndi", url: id, title: program.name,
      fingerprint: null, duration: null, reviewKey: "ndi:shared-review", liveState: "stopped" });
    await act(async () => {});
    expect(h.result.current.program).toMatchObject({ id, stopped: true, reviewKey: "ndi:shared-review" });
    expect(h.result.current.previewProgram?.id).toBe(privateId);
    expect(mocks.invoke.mock.calls.some(([name]) => ["ndi_stop", "ndi_start", "obs_start", "ndi_publish"].includes(name))).toBe(false);
  });
  it("cancels a pending start by its exact id without stopping a newer receiver", async () => {
    let finish!: (value: unknown) => void;
    mocks.invoke.mockImplementation(async (command: string, args?: { name?: string }) => {
      if (command === "ndi_start") return args?.name === "old" ? new Promise(resolve => { finish = resolve; }) : { id: "b".repeat(32), name: "new", url: "/new" };
      return command === "session_state" ? room : command === "ndi_status" ? offStatus : null;
    });
    const h = renderHook(useNdiInput); let old!: Promise<void>;
    await act(async () => { old = h.result.current.start("old"); await Promise.resolve(); });
    await act(async () => {
      const stopping=h.result.current.stop();
      finish({ id: "a".repeat(32), name: "old", url: "/old" });
      await old; await stopping; await h.result.current.start("new");
    });
    expect(h.result.current.previewProgram?.name).toBe("new");
    expect(h.result.current.program).toBeNull();
    expect(mocks.invoke).toHaveBeenCalledWith("ndi_stop", { id: "a".repeat(32) });
    expect(mocks.invoke).not.toHaveBeenCalledWith("ndi_stop", { id: "b".repeat(32) });
  });
  it("recovers an early native error from the post-start status snapshot", async () => {
    const id="c".repeat(32);let started=false;
    mocks.invoke.mockImplementation(async (command:string)=>{
      if(command==="session_state")return room;
      if(command==="ndi_start"){started=true;return {id,name:"Premiere",url:"/program"};}
      if(command==="ndi_status" && started)return {program:{id,name:"Premiere",url:"/program"},telemetry:{
        ...offStatus.telemetry,sourceId:id,phase:"error",error:"Hardware H.264 encoder unavailable",
      }};
      if(command==="ndi_status")return offStatus;
      return null;
    });
    const h=renderHook(useNdiInput);await act(async()=>{});
    await act(async()=>{await h.result.current.start("Premiere");await Promise.resolve();});
    expect(h.result.current.previewState.phase).toBe("error");
    expect(h.result.current.previewState.error).toContain("Hardware H.264 encoder unavailable");
    expect(h.result.current.state.phase).toBe("off");
    expect(h.result.current.reviewBlocked).toBe(false);
  });
  it("does not paint an old guest program after a file source change", async () => {
    let finish!: (value: string) => void;
    mocks.invoke.mockImplementation(async (command: string) => command === "ndi_remote_source" ? new Promise<string>(resolve => { finish = resolve; }) : command === "session_state" ? room : command === "ndi_status" ? offStatus : null);
    const h = renderHook(useNdiInput); await act(async () => {});
    emit("session:msg", source);
    emit("session:msg", { ...source, sourceKind: "file", url: "file" });
    await act(async () => { finish("/old-program"); });
    expect(h.result.current.program).toBeNull();
    expect(h.result.current.state.phase).toBe("off");
  });
  it("clears a remote program on presenter handoff and ignores a former host's source", async () => {
    mocks.invoke.mockImplementation(async (command: string) => command === "ndi_remote_source" ? "/program" : command === "session_state" ? room : command === "ndi_status" ? offStatus : null);
    const h = renderHook(useNdiInput); await act(async () => {});
    await act(async () => { mocks.listeners.get("session:msg")?.({ payload: source }); });
    expect(h.result.current.program).toMatchObject({ local: false, ownerId: "m0" });
    emit("session:state", { ...room, presenter: "m2", presenterEpoch: 1 });
    expect(h.result.current.program).toBeNull();
    await act(async () => { mocks.listeners.get("session:msg")?.({ payload: source }); });
    expect(h.result.current.program).toBeNull();
  });
  it("rejects arbitrary remote source identifiers", async () => {
    const h = renderHook(useNdiInput); await act(async () => {});
    emit("session:msg", { ...source, url: "../../etc/passwd" });
    expect(h.result.current.program).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalledWith("ndi_remote_source", expect.anything());
  });
  it("keeps a stopped remote picture without opening a private/native receiver", async () => {
    const h=renderHook(useNdiInput);await act(async()=>{});
    emit("session:msg",{...source,reviewKey:"ndi:pass",liveState:"stopped"});
    expect(h.result.current.program).toMatchObject({id:source.url,stopped:true,url:""});
    expect(h.result.current.roomSource).toMatchObject({reviewKey:"ndi:pass",state:"stopped"});
    expect(mocks.invoke.mock.calls.some(([command])=>["ndi_start","ndi_discover","ndi_preflight","ndi_remote_source"].includes(command))).toBe(false);
  });
  it("waits for the actual remote picture before allowing room notes", async () => {
    mocks.invoke.mockImplementation(async(command:string)=>command==="ndi_remote_source"?"/program":command==="session_state"?room:command==="ndi_sessions"?{programs:[],room:null}:offStatus);
    const h=renderHook(useNdiInput);await act(async()=>{});
    await act(async()=>{mocks.listeners.get("session:msg")?.({payload:{...source,reviewKey:"ndi:pass"}});});
    expect(h.result.current.reviewBlocked).toBe(true);
    act(()=>h.result.current.frameDecoded("obsolete"));
    expect(h.result.current.reviewBlocked).toBe(true);
    act(()=>h.result.current.frameDecoded(source.url));
    expect(h.result.current.reviewBlocked).toBe(false);
    expect(mocks.invoke).not.toHaveBeenCalledWith("ndi_status",{id:source.url});
  });
  it("revokes remote picture readiness after a decoder failure", async () => {
    mocks.invoke.mockImplementation(async(command:string)=>command==="ndi_remote_source"?"/program":command==="session_state"?room:command==="ndi_sessions"?{programs:[],room:null}:offStatus);
    const h=renderHook(useNdiInput);await act(async()=>{});
    await act(async()=>{mocks.listeners.get("session:msg")?.({payload:source});});
    act(()=>h.result.current.frameDecoded(source.url));
    expect(h.result.current.reviewBlocked).toBe(false);
    act(()=>h.result.current.pictureFailed(source.url));
    expect(h.result.current.reviewBlocked).toBe(true);
    act(()=>h.result.current.frameDecoded("obsolete"));
    expect(h.result.current.reviewBlocked).toBe(true);
  });
});

describe("private preview is not the room presentation", () => {
  const published = { id:"a".repeat(32), name:"On air", url:"/on-air" };
  const candidate = { id:"b".repeat(32), name:"Private test", url:"/private" };
  function host(withPublished: boolean) {
    const status = (program: typeof published) => ({ program, encodedReady:true, roomGeneration:7,
      telemetry:{...offStatus.telemetry,sourceId:program.id,phase:"live",connectionCount:1,inputWidth:1920,inputHeight:1080} });
    mocks.invoke.mockImplementation(async(command:string,args?:{id?:string})=>{
      if(command==="session_state")return {...room,role:"host",selfId:"m0"};
      if(command==="ndi_sessions")return {programs:withPublished?[status(published)]:[],room:{generation:7,presenterEpoch:0,presenting:true,
        publishedId:withPublished?published.id:null,publicationRevision:withPublished?1:null,
        source:withPublished?{id:published.id,name:published.name,reviewKey:"ndi:on-air",state:"live"}:null}};
      if(command==="ndi_start")return candidate;
      if(command==="ndi_status")return status(args?.id===published.id?published:candidate);
      if(command==="ndi_publish")return 2;
      return null;
    });
  }
  it("keeps a file room usable while a candidate connects and decodes", async () => {
    host(false); const h=renderHook(useNdiInput); await act(async()=>{});
    await act(async()=>{await h.result.current.start(candidate.name);});
    expect(h.result.current.previewProgram?.id).toBe(candidate.id);
    expect(h.result.current.program).toBeNull();
    expect(h.result.current.roomSource).toBeNull();
    expect(h.result.current.reviewBlocked).toBe(false);
    act(()=>h.result.current.frameDecoded(candidate.id));
    expect(h.result.current.canShare).toBe(false);
    act(()=>h.result.current.previewFrameDecoded(candidate.id));
    expect(h.result.current.canShare).toBe(true);
    expect(h.result.current.reviewBlocked).toBe(false);
  });
  it("never replaces a published picture or its telemetry with the private candidate", async () => {
    host(true); const h=renderHook(useNdiInput); await act(async()=>{});
    act(()=>h.result.current.frameDecoded(published.id));
    await act(async()=>{await h.result.current.start(candidate.name);});
    expect(h.result.current.program?.id).toBe(published.id);
    expect(h.result.current.state.sourceId).toBe(published.id);
    expect(h.result.current.previewState.sourceId).toBe(candidate.id);
    act(()=>h.result.current.previewPictureFailed(candidate.id));
    expect(h.result.current.reviewBlocked).toBe(false);
    await act(async()=>{await h.result.current.cancelPreview();});
    expect(h.result.current.program?.id).toBe(published.id);
    expect(h.result.current.previewProgram).toBeNull();
    expect(mocks.invoke).toHaveBeenCalledWith("ndi_stop",{id:candidate.id});
    expect(mocks.invoke).not.toHaveBeenCalledWith("ndi_stop",{id:published.id});
  });
  it("requires the room surface to decode after explicit publication", async () => {
    host(true); const h=renderHook(useNdiInput); await act(async()=>{});
    act(()=>h.result.current.frameDecoded(published.id));
    await act(async()=>{await h.result.current.start(candidate.name);});
    act(()=>h.result.current.previewFrameDecoded(candidate.id));
    await act(async()=>{await h.result.current.share();});
    expect(h.result.current.program?.id).toBe(candidate.id);
    expect(h.result.current.reviewBlocked).toBe(true);
    act(()=>h.result.current.frameDecoded(published.id));
    expect(h.result.current.reviewBlocked).toBe(true);
    act(()=>h.result.current.frameDecoded(candidate.id));
    expect(h.result.current.reviewBlocked).toBe(false);
  });
  it("retains the stopped room source even if its private connection is cancelled", async () => {
    host(true); const h=renderHook(useNdiInput); await act(async()=>{});
    act(()=>h.result.current.frameDecoded(published.id));
    await act(async()=>{await h.result.current.stopSharing();});
    expect(h.result.current.program).toMatchObject({id:published.id,url:published.url,stopped:true});
    await act(async()=>{await h.result.current.cancelPreview();});
    expect(h.result.current.program).toMatchObject({id:published.id,url:published.url,stopped:true});
    expect(h.result.current.roomSource?.state).toBe("stopped");
  });
});

describe("application capture uses the existing preview controller", () => {
  const capture = (): Exclude<ObsSelection, { kind: "display" }> => ({ application: "com.adobe.PremierePro", process: 123, window: 45,
    crop: { x: 0, y: 0, width: 1, height: 1 } });
  function native() {
    let next = 0;
    const programs = new Map<string, NdiStatusResult>();
    const nativeRoom = { generation: 7, presenterEpoch: 0, presenting: true, publishedId: null,
      publicationRevision: null, source: null };
    mocks.invoke.mockImplementation(async (command: string, args?: { name?: string; selection?: ObsSelection; id?: string }) => {
      if (command === "session_state") return { ...room, role: "host", selfId: "m0" };
      if (command === "ndi_sessions") return { programs: [...programs.values()], room: nativeRoom };
      if (command === "ndi_start" || command === "obs_start") {
        const program = { id: String(++next).padStart(32, "0"), name: "Premiere", url: `/program/${next}` };
        const selection = command === "obs_start" ? args?.selection : undefined;
        programs.set(program.id, { program, encodedReady: true, roomGeneration: 7,
          telemetry: { ...offStatus.telemetry, sourceId: program.id, phase: "live", connectionCount: 1 },
          ...(selection ? { capture: selection } : {}) });
        return command === "obs_start" ? { program, selection } : program;
      }
      if (command === "ndi_status") return programs.get(args?.id ?? "") ?? offStatus;
      if (command === "ndi_stop") { programs.delete(args?.id ?? ""); return null; }
      if (command === "ndi_publish") return 2;
      return null;
    });
    return { programs, nativeRoom };
  }
  it("starts exact capture privately and retains metadata through explicit publication", async () => {
    native(); const h = renderHook(useNdiInput); await act(async () => {});
    const selection = capture();
    await act(async () => { await h.result.current.startCapture(selection); });
    const preview = h.result.current.previewProgram!;
    expect(mocks.invoke).toHaveBeenCalledWith("obs_start", { selection });
    expect(mocks.invoke.mock.calls.some(([name]) => name === "ndi_start" || name === "ndi_publish")).toBe(false);
    expect(preview.capture).toEqual(selection);
    expect(h.result.current.program).toBeNull();
    expect(h.result.current.canShare).toBe(false);
    act(() => h.result.current.previewFrameDecoded(preview.id));
    expect(h.result.current.canShare).toBe(true);
    await act(async () => { await h.result.current.share(); });
    expect(h.result.current.program?.capture).toEqual(selection);
    expect(h.result.current.published?.capture).toEqual(selection);
    expect(mocks.invoke).toHaveBeenCalledWith("ndi_publish", { id: preview.id, reviewKey: preview.reviewKey, generation: 7, epoch: 0 });
    const publishArguments = mocks.invoke.mock.calls.find(([name]) => name === "ndi_publish")?.[1];
    expect(JSON.stringify(publishArguments)).not.toContain(selection.application);
    expect(JSON.stringify(h.result.current.roomSource)).not.toContain("crop");
    expect(preview.reviewKey).toMatch(/^ndi:[a-f0-9-]+$/i);
    expect(h.result.current.reviewBlocked).toBe(true);
  });
  it("keeps existing NDI review passes unchanged and separates same-title windows and crops", async () => {
    native(); localStorage.setItem("saucebunny.ndiReviewPasses", JSON.stringify({ Premiere: "ndi:existing-pass" }));
    const h = renderHook(useNdiInput); await act(async () => {});
    await act(async () => { await h.result.current.start("Premiere"); });
    expect(h.result.current.previewProgram?.reviewKey).toBe("ndi:existing-pass");
    expect(h.result.current.previewProgram?.capture).toBeUndefined();
    await act(async () => { await h.result.current.startCapture(capture()); });
    const first = h.result.current.previewProgram!;
    expect(first.reviewKey).not.toBe("ndi:existing-pass");
    const window = capture(); window.window += 1;
    await act(async () => { await h.result.current.startCapture(window); });
    const second = h.result.current.previewProgram!;
    expect(second.name).toBe(first.name);
    expect(second.reviewKey).not.toBe(first.reviewKey);
    const cropped = { ...window, crop: { ...window.crop, width: 0.5 } };
    await act(async () => { await h.result.current.startCapture(cropped); });
    expect(h.result.current.previewProgram?.reviewKey).not.toBe(second.reviewKey);
    await act(async () => { await h.result.current.start("Premiere"); });
    expect(h.result.current.previewProgram?.reviewKey).toBe("ndi:existing-pass");
    expect(JSON.parse(localStorage.getItem("saucebunny.ndiReviewPasses")!)).toEqual({ Premiere: "ndi:existing-pass" });
  });
  it("restores the same selection and opaque capture pass from native session metadata", async () => {
    const service = native(); const h = renderHook(useNdiInput); await act(async () => {});
    await act(async () => { await h.result.current.startCapture(capture()); });
    const previous = h.result.current.previewProgram!;
    const status = service.programs.get(previous.id)!;
    h.unmount(); await act(async () => { await Promise.resolve(); });
    // Model a still-open native session discovered by a new controller instance.
    service.programs.set(previous.id, status);
    mocks.invoke.mockClear();
    const restored = renderHook(useNdiInput); await act(async () => {});
    expect(restored.result.current.previewProgram).toMatchObject({ id: previous.id, reviewKey: previous.reviewKey, capture: capture() });
    expect(restored.result.current.canShare).toBe(false);
    await act(async () => { await restored.result.current.startCapture(capture()); });
    expect(mocks.invoke.mock.calls.some(([name]) => name === "obs_start" || name === "ndi_start")).toBe(false);
  });
  it("rejects stale capture decode and telemetry after replacing the selected window", async () => {
    native(); const h = renderHook(useNdiInput); await act(async () => {});
    await act(async () => { await h.result.current.startCapture(capture()); });
    const old = h.result.current.previewProgram!;
    const next = capture(); next.window += 1;
    await act(async () => { await h.result.current.startCapture(next); });
    const current = h.result.current.previewProgram!;
    act(() => h.result.current.previewFrameDecoded(old.id));
    emit("ndi:state", { ...offStatus.telemetry, sourceId: old.id, phase: "error", error: "Stale capture error" });
    expect(h.result.current.previewProgram?.id).toBe(current.id);
    expect(h.result.current.previewState.error).toBeNull();
    expect(h.result.current.canShare).toBe(false);
    act(() => h.result.current.previewFrameDecoded(current.id));
    expect(h.result.current.canShare).toBe(true);
    expect(mocks.invoke).toHaveBeenCalledWith("ndi_stop", { id: old.id });
    expect(mocks.invoke).not.toHaveBeenCalledWith("ndi_stop", { id: current.id });
  });
});
