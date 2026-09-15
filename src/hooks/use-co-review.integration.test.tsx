// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMsg } from "../bindings/SessionMsg";
import type { SessionState } from "../bindings/SessionState";
import type { PlayerHandle, SeekResult } from "../components/player-handle";
import { createPlaybackSessionController } from "../lib/playback-session-controller";
import { buildComment, emptyDoc, type ReviewDoc } from "../lib/review";
import { pendingCount } from "../lib/review-outbox";
import { putReviewDoc } from "../lib/review-store";
import { setScrubbing } from "../lib/playhead-store";
import { associatePremiereInput, getPremiereLink, observePremiereLink, refreshPremiereLink,
  setPremiereRoom, setPremiereVisibleInput } from "../lib/premiere-link";
import { capturePremiereAnchor, type PremiereContext } from "../lib/premiere-notes";
import { createReviewEnvelope } from "../lib/review-delivery";
import type { PremiereMarkerRecord } from "../bindings/PremiereMarkerRecord";
import { selectRoomScreenStream } from "../lib/room-screen-stream";

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  invoke: vi.fn(), persist: vi.fn(), shareOpen: vi.fn(),
  savedListeners: new Set<(doc: ReviewDoc) => void>(),
  mesh: {
    remoteStreams: new Map(), remoteProgramStreams: new Map(), peerStates: new Map(), peerMutedForMe: new Set(),
    toggleMuteForMe: vi.fn(), handleSignal: vi.fn(), setVideoOverride: vi.fn(), setAudioOverride: vi.fn(), readProgramDiagnostics: vi.fn(),
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => mocks.invoke(...args) }));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async () => {}),
  listen: vi.fn(async (name: string, listener: (event: { payload: unknown }) => void) => {
    let listeners = mocks.listeners.get(name);
    if (!listeners) { listeners = new Set(); mocks.listeners.set(name, listeners); }
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }),
}));
vi.mock("./use-rtc-mesh", () => ({ useRtcMesh: () => mocks.mesh }));
vi.mock("../lib/share-stream", () => ({ openShareStream: (...args: unknown[]) => mocks.shareOpen(...args) }));
vi.mock("../lib/review-store", async (original) => ({
  ...await original<typeof import("../lib/review-store")>(),
  persistReviewDoc: async (doc: ReviewDoc) => {
    await mocks.persist(doc);
    for (const listener of mocks.savedListeners) listener(doc);
  },
  subscribePersistedReviews: (listener: (doc: ReviewDoc) => void) => {
    mocks.savedListeners.add(listener); return () => { mocks.savedListeners.delete(listener); };
  },
}));
import { useCoReview } from "./use-co-review";

const off: SessionState = { role: "off", code: null, peers: [], selfId: null, title: null,
  error: null, presenter: "m0", presenterEpoch: 0 };
const state = (role: "host" | "peer"): SessionState => ({ ...off, role, code: "test", selfId: role === "host" ? "m0" : "m1" });
const settled = (seconds: number): SeekResult => ({ requestedSeconds: seconds, presentedSeconds: seconds, status: "presented" });
async function emit(name: string, payload: unknown) {
  await act(async () => {
    for (const listener of mocks.listeners.get(name) ?? []) listener({ payload });
    await Promise.resolve();
  });
}
const programId = "a".repeat(32);
const binding = { bindingId: "bound", projectId: "project", sequenceId: "sequence", projectName: "Project",
  sequenceName: "Sequence", timebaseTicks: "10584000000", displayFormat: "102", zeroPointTicks: "0" };
async function mount(role: "host" | "peer", kind: "web" | "ndi" = "web") {
  let playing = false;
  const player: PlayerHandle = {
    play: vi.fn(async () => { playing = true; }), pause: vi.fn(() => { playing = false; }),
    seekTo: vi.fn(async (seconds) => settled(seconds)), beginScrub: vi.fn(), scrubTo: vi.fn(), endScrub: vi.fn(async (s) => settled(s)),
    getCurrentTime: () => 10, getDuration: () => 100, isReady: () => true, isPlaying: () => playing,
    setVolume: vi.fn(), getVolume: () => 1, setMuted: vi.fn(), isMuted: () => false, setShuttle: vi.fn(),
    setPlaybackRate: vi.fn(), supportsPlaybackRate: true,
  };
  const controller = createPlaybackSessionController(() => player);
  controller.setSource("file", 100); controller.reportPresented(10);
  const key = `${kind === "ndi" ? "ndi:" : "review-"}${crypto.randomUUID()}`;
  const url = kind === "ndi" ? programId : `https://example.com/${key}`;
  const args: Parameters<typeof useCoReview>[0] = {
    isPlaying: false, fps: 24, playbackRate: 1,
    sessionSource: { kind, url, reviewKey: key, fingerprint: null, title: "Cut", duration: 100 },
    activeSourceUrlRef: { current: url }, reviewSourceKey: key, playerRef: { current: player }, playbackController: controller,
    metadataRef: { current: null }, onChaseSeek: (frames) => controller.seekTo(frames / 24, { origin: "remote" }),
    setUrl: vi.fn(), handleFetch: vi.fn(async () => {}), loadLocalPath: vi.fn(async () => {}), loadPeerStream: vi.fn(async () => {}),
    clearStageForPeerSource: vi.fn(), pushNotification: vi.fn(), appendLog: vi.fn(), setQueueOpen: vi.fn(),
    setReviewMarkers: vi.fn(), setReviewAnnotations: vi.fn(), turn: { url: "", username: "", password: "" }, stunUrl: "",
  };
  const hook = renderHook(() => {
    const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
    return useCoReview({ ...args, isPlaying: snapshot.playing, playbackRate: snapshot.playbackRate });
  });
  await emit("session:state", state(role));
  if (role === "peer") {
    await emit("session:msg", { kind: "loadSource", sourceKind: kind, url, reviewKey: key, from: "m0" });
    const doc: ReviewDoc = { ...emptyDoc(key), versions: [{ id: "v", path: url, label: "V1", addedAt: 0 }], activeVersionId: "v",
      sync: { sessionId: "room", revision: 0, clock: 0, operations: {} } };
    await emit("session:msg", { kind: "reviewDoc", doc: JSON.stringify(doc) });
  }
  const transport = (overrides: Partial<Extract<SessionMsg, { kind: "transport" }>> = {}) => emit("session:msg", {
    kind: "transport", protocol: 2, command: 1, phase: "seek", target: 10, presented: 10,
    position: 10, playing: false, rate: 1, atMs: Date.now(), seq: 1, from: "m0", epoch: 0,
    sourceKey: key, sessionId: "room", ...overrides,
  });
  return { ...hook, player, controller, key, args, transport };
}

beforeEach(() => {
  setPremiereRoom("off", ""); setPremiereVisibleInput(null);
  vi.useFakeTimers(); localStorage.clear(); mocks.listeners.clear(); mocks.invoke.mockReset(); mocks.persist.mockReset();
  mocks.shareOpen.mockReset(); mocks.mesh.setVideoOverride.mockClear(); mocks.mesh.setAudioOverride.mockClear();
  mocks.invoke.mockImplementation(async (command) => command === "session_state" ? off : null);
  mocks.persist.mockImplementation(async (doc) => { putReviewDoc(doc); });
});
afterEach(async () => { cleanup(); setScrubbing(false); await Promise.resolve(); vi.useRealTimers(); });

describe("mounted room screen-share delivery", () => {
  const selected = { kind: "display", id: 5, crop: "10,20,640,360", audio: true };
  function stage(current: ReturnType<typeof useCoReview>) {
    return selectRoomScreenStream({ session: current.coSession, shareState: current.shareState, shareStream: current.shareStream,
      sharingMembers: current.sharingMembers, programStreams: current.meshProgramStreams });
  }
  function native() {
    mocks.invoke.mockImplementation(async command => command === "session_state" ? off
      : command === "start_screen_share" ? "http://127.0.0.1/test/share/v1" : null);
    const video = { kind: "video" } as MediaStreamTrack, audio = { kind: "audio" } as MediaStreamTrack;
    const stream = { getVideoTracks: () => [video], getAudioTracks: () => [audio] } as unknown as MediaStream;
    const handle = { stream, track: video, audioTrack: audio, close: vi.fn() };
    return handle;
  }
  it("puts the exact selected share on the host stage and existing program senders, then retracts it on Stop", async () => {
    const handle = native(); mocks.shareOpen.mockResolvedValue(handle);
    const h = await mount("host"); mocks.invoke.mockClear();
    await act(async () => { h.result.current.startShare(selected); });
    expect(mocks.invoke).toHaveBeenCalledWith("start_screen_share", { source: selected });
    expect(mocks.shareOpen.mock.calls[0][2]).toMatchObject({ audio: true });
    expect(h.result.current.shareState).toBe("sharing");
    expect(stage(h.result.current)).toMatchObject({ stream: handle.stream, ownerId: "m0", isSelf: true });
    expect(mocks.mesh.setVideoOverride).toHaveBeenLastCalledWith(handle.track);
    expect(mocks.mesh.setAudioOverride).toHaveBeenLastCalledWith(handle.audioTrack);
    expect(mocks.invoke).toHaveBeenCalledWith("session_broadcast", { msg: { kind: "sharing", from: "m0", on: true } });
    expect(mocks.invoke.mock.calls.some(([cmd]) => String(cmd).includes("ndi"))).toBe(false);
    await act(async () => { h.result.current.stopShare(); });
    expect(stage(h.result.current)).toBeNull(); expect(handle.close).toHaveBeenCalledTimes(1);
    expect(mocks.mesh.setVideoOverride).toHaveBeenLastCalledWith(null);
    expect(mocks.mesh.setAudioOverride).toHaveBeenLastCalledWith(null);
  });
  it("does not announce pending decode and cannot publish a late frame after session end", async () => {
    const handle = native(); let finish!: (value: typeof handle) => void;
    mocks.shareOpen.mockImplementation(() => new Promise<typeof handle>(resolve => { finish = resolve; }));
    const h = await mount("host"); mocks.invoke.mockClear();
    await act(async () => { h.result.current.startShare(selected); });
    expect(h.result.current.shareState).toBe("starting"); expect(stage(h.result.current)).toBeNull();
    expect(mocks.mesh.setVideoOverride).not.toHaveBeenCalled();
    await emit("session:state", off);
    expect(mocks.shareOpen.mock.calls[0][2].signal.aborted).toBe(true);
    await act(async () => { finish(handle); });
    expect(stage(h.result.current)).toBeNull(); expect(handle.close).toHaveBeenCalledTimes(1);
    expect(mocks.invoke.mock.calls.some(([, args]) => args?.msg?.kind === "sharing" && args.msg.on)).toBe(false);
    expect(mocks.mesh.setVideoOverride.mock.calls.every(([track]) => track === null)).toBe(true);
  });
  it("unmount aborts a decoder owned by the room and never publishes its late result", async () => {
    const handle = native(); let finish!: (value: typeof handle) => void;
    mocks.shareOpen.mockImplementation(() => new Promise<typeof handle>(resolve => { finish = resolve; }));
    const h = await mount("host"); mocks.invoke.mockClear();
    await act(async () => { h.result.current.startShare(selected); });
    h.unmount();
    expect(mocks.shareOpen.mock.calls[0][2].signal.aborted).toBe(true);
    await act(async () => { finish(handle); });
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(mocks.invoke.mock.calls.some(([, args]) => args?.msg?.kind === "sharing" && args.msg.on)).toBe(false);
  });
});

it("shows native invitation-policy failures to the host without ending the room", async () => {
  const h = await mount("host");
  const message = "Review invitation settings are damaged. Restore the backup.";
  await emit("session:admission-error", message);
  expect(h.args.pushNotification).toHaveBeenCalledWith("error", "New review joins are blocked", message);
  expect(h.result.current.coSession.role).toBe("host");
  h.unmount();
  await emit("session:admission-error", message);
  expect(h.args.pushNotification).toHaveBeenCalledTimes(1);
});

describe("mounted live-session Premiere receiving", () => {
  let stop: (() => void) | undefined;
  afterEach(() => { stop?.(); stop = undefined; });
  async function editor() {
    const records: PremiereMarkerRecord[] = [];
    mocks.invoke.mockImplementation(async (command, args) => {
      if (command === "session_state") return off;
      if (command === "premiere_bridge_status") return { phase: "connected", binding: { ...binding,
        projectPath: "/private/editor.prproj", pairingSecret: "private-code" }, syncEnabled: true,
        automaticPlacement: false, pendingCount: records.length, otherBindingPendingCount: 0, ledgerRevision: records.length, error: null };
      if (command === "premiere_marker_notes") return records;
      if (command === "premiere_enqueue_note") {
        const record: PremiereMarkerRecord = { id: crypto.randomUUID(), request: args.request, status: "needs_confirmation",
          sequenceTicks: null, markerGuid: null, error: "/private/native-error-path" };
        records.push(record); return record;
      }
      return null;
    });
    const h = await mount("host", "ndi");
    await act(async () => {
      setPremiereVisibleInput({ sourceId: h.key, streamId: programId, name: "Premiere" });
      stop = observePremiereLink(); await refreshPremiereLink(); associatePremiereInput();
    });
    const contexts = mocks.invoke.mock.calls.flatMap(([, args]) => {
      if (args?.msg?.kind !== "reviewOp") return [];
      const parsed = JSON.parse(args.msg.op);
      return parsed.t === "premiere-context" && parsed.binding ? [parsed as PremiereContext] : [];
    });
    const context = contexts.at(-1)!;
    expect(context?.binding).toEqual(binding);
    return { ...h, records, context };
  }
  function submission(h: Awaited<ReturnType<typeof editor>>) {
    const comment = buildComment({ versionId: h.result.current.sessionDoc!.activeVersionId!, timeStart: 0,
      body: "A participant's timeline note", author: "Forged author" });
    comment.timing = { kind: "general", sourceId: h.key, pass: "Pass 1" };
    comment.premiere = { ...capturePremiereAnchor(binding, h.key, {
      streamId: programId, frameId: "frame:1", mediaSeconds: 7, displayedAt: 1,
    }), verification: "verified", sequenceTicks: "12345" };
    return { ...createReviewEnvelope(h.result.current.sessionDoc!, { t: "add", comment }, h.key, h.context.sessionId),
      premiereContext: { programId, presenterEpoch: h.context.presenterEpoch, revision: h.context.revision } };
  }
  const submit = (envelope: unknown) => emit("session:msg", { kind: "reviewOp", from: "m1", op: JSON.stringify(envelope) });
  it("deduplicates unchanged Premiere publication and stops after unmount", async () => {
    const h = await editor(); mocks.invoke.mockClear();
    await act(async () => { await refreshPremiereLink(); await refreshPremiereLink(); vi.advanceTimersByTime(6000); });
    const publications = () => mocks.invoke.mock.calls.filter(([cmd, args]) => cmd === "session_broadcast"
      && args?.msg?.kind === "reviewOp" && JSON.parse(args.msg.op).t.startsWith("premiere-"));
    expect(publications()).toHaveLength(0);
    h.unmount();
    await act(async () => { vi.advanceTimersByTime(6000); await refreshPremiereLink(); });
    expect(publications()).toHaveLength(0);
  });
  it("does not publish stale receipt batches after a source changes during an awaited broadcast", async () => {
    const h = await editor();
    await submit(submission(h));
    let finish!: () => void;
    const original = mocks.invoke.getMockImplementation()!;
    mocks.invoke.mockImplementation((command, args) => {
      if (command === "session_broadcast" && args?.msg?.kind === "reviewOp"
        && JSON.parse(args.msg.op).t === "premiere-context") {
        return new Promise<void>(resolve => { finish = resolve; });
      }
      return original(command, args);
    });
    mocks.invoke.mockClear();
    // A document change creates a fresh publication with context before receipts.
    const note = buildComment({ versionId: h.result.current.sessionDoc!.activeVersionId!, timeStart: 0, body: "General", author: "Host" });
    await act(async () => { h.result.current.postSessionOp({ t: "add", comment: note }); });
    expect(finish).toBeTypeOf("function");
    h.args.sessionSource = { ...h.args.sessionSource, liveState: "stopped" };
    await act(async () => { h.rerender(); });
    mocks.invoke.mockClear();
    await act(async () => { finish(); });
    expect(mocks.invoke.mock.calls.some(([cmd, args]) => cmd === "session_broadcast"
      && args?.msg?.kind === "reviewOp" && JSON.parse(args.msg.op).t === "premiere-receipts")).toBe(false);
  });
  it("receives a guest note only after durable host acceptance, once, and returns sanitized receipts", async () => {
    const h = await editor();
    const envelope = submission(h);
    let finish!: () => void;
    mocks.persist.mockImplementationOnce((doc) => new Promise<void>(resolve => {
      finish = () => { putReviewDoc(doc); resolve(); };
    }));
    await submit(envelope);
    expect(h.records).toHaveLength(0);
    await act(async () => { finish(); });
    expect(h.records).toHaveLength(1);
    expect(h.records[0].request.anchor).toMatchObject({ verification: "unverified", binding });
    expect(h.records[0].request.anchor.sequenceTicks).toBeUndefined();
    expect(h.records[0].request.author).not.toBe("Forged author");
    await submit(envelope);
    expect(h.records).toHaveLength(1);
    const wire = mocks.invoke.mock.calls.filter(([cmd]) => ["session_broadcast", "session_send_to"].includes(cmd));
    expect(JSON.stringify(wire)).not.toMatch(/private-code|private\/editor|private\/native-error/);
    const receipts = wire.flatMap(([, a]) => a?.msg?.kind === "reviewOp" ? [JSON.parse(a.msg.op)] : [])
      .filter(m => m.t === "premiere-receipts");
    expect(receipts.at(-1)?.items).toEqual([{ commentId: h.records[0].request.commentId,
      versionId: h.records[0].request.versionId, bindingId: binding.bindingId, status: "needs_confirmation" }]);
  });
  it("does not queue or acknowledge a failed save; retry delivers exactly once", async () => {
    const h = await editor(); const envelope = submission(h);
    mocks.persist.mockRejectedValueOnce(Error("Disk full"));
    await submit(envelope); expect(h.records).toHaveLength(0);
    await submit(envelope); expect(h.records).toHaveLength(1);
    await submit(envelope); expect(h.records).toHaveLength(1);
  });
  it("rejects forged bindings and rechecks the source when a queued commit actually runs", async () => {
    const h = await editor(); const stale = submission(h);
    const forged = structuredClone(stale);
    if (forged.op.t !== "add") throw Error("fixture");
    forged.op.comment.premiere!.binding.sequenceId = "unrelated";
    await submit(forged); expect(h.records).toHaveLength(0);
    let finish!: () => void;
    mocks.persist.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const ordinary = buildComment({ versionId: h.result.current.sessionDoc!.activeVersionId!, timeStart: 0, body: "General", author: "Guest" });
    await submit(createReviewEnvelope(h.result.current.sessionDoc!, { t: "add", comment: ordinary }, h.key, h.context.sessionId));
    await submit(stale);
    await act(async () => {
      h.args.sessionSource = { ...h.args.sessionSource, url: "b".repeat(32) }; h.rerender();
    });
    await act(async () => { finish(); });
    expect(h.records).toHaveLength(0);
    expect(h.args.appendLog).toHaveBeenCalledWith("warn", "session", expect.stringContaining("selected sequence changed"));
  });
  it("welcomes late joins with approved context, and revokes when publishing stops", async () => {
    const h = await editor(); mocks.invoke.mockClear();
    await emit("session:state", { ...state("host"), peers: [{ id: "m2", name: "New guest", epoch: 1 }] });
    const welcome = mocks.invoke.mock.calls.filter(([cmd]) => cmd === "session_send_to").map(([, a]) => a.msg);
    expect(welcome.find(m => m.kind === "reviewDoc")).toBeTruthy();
    expect(welcome.some(m => m.kind === "reviewOp" && JSON.parse(m.op).t === "premiere-context")).toBe(true);
    h.args.sessionSource = { ...h.args.sessionSource, liveState: "stopped" };
    await act(async () => { h.rerender(); });
    await submit(submission(h));
    expect(h.records).toHaveLength(0);
  });
  it("accepts context and receipts only from the current host/source and ignores stale receipt revisions", async () => {
    const h = await mount("peer", "ndi");
    await act(async () => { setPremiereVisibleInput({ sourceId: h.key, streamId: programId, name: "Premiere" }); });
    const context = { t: "premiere-context", protocol: 1, sessionId: "room", reviewKey: h.key, sourceId: h.key,
      programId, presenterEpoch: 0, revision: 1, binding };
    await emit("session:msg", { kind: "reviewOp", from: "m2", op: JSON.stringify(context) });
    expect(getPremiereLink().remote).toBeNull();
    await emit("session:msg", { kind: "reviewOp", from: "m0", op: JSON.stringify(context) });
    expect(getPremiereLink().remote?.binding).toEqual(binding);
    const comment = buildComment({ versionId: "v", timeStart: 0, body: "Marker", author: "Guest" });
    comment.timing = { kind: "general", sourceId: h.key, pass: "Pass 1" };
    comment.premiere = capturePremiereAnchor(binding, h.key, null);
    await act(async () => { h.result.current.postSessionOp({ t: "add", comment }); });
    const receipt = { ...context, t: "premiere-receipts", ledgerRevision: 3,
      items: [{ commentId: comment.id, versionId: "v", bindingId: binding.bindingId, status: "added" }] };
    await emit("session:msg", { kind: "reviewOp", from: "m2", op: JSON.stringify(receipt) });
    expect(getPremiereLink().receipts).toHaveLength(0);
    await emit("session:msg", { kind: "reviewOp", from: "m0", op: JSON.stringify(receipt) });
    expect(getPremiereLink().receipts[0]?.status).toBe("added");
    await emit("session:msg", { kind: "reviewOp", from: "m0", op: JSON.stringify({ ...receipt, ledgerRevision: 2,
      items: [{ ...receipt.items[0], status: "dispatching" }] }) });
    expect(getPremiereLink().receipts[0]?.status).toBe("added");
    await emit("session:msg", { kind: "reviewOp", from: "m0", op: JSON.stringify({ ...context, revision: 2, binding: null }) });
    await emit("session:msg", { kind: "reviewOp", from: "m0", op: JSON.stringify(context) });
    expect(getPremiereLink().remote?.binding).toBeNull();
    expect(getPremiereLink().receipts).toHaveLength(0);
    expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "premiere_enqueue_note")).toBe(false);
  });
});

describe("mounted co-review reliability", () => {
  it("keeps incoming notes while blocking local operations during private preview", async () => {
    const h = await mount("peer");
    h.args.privatePreview = true; h.rerender();
    const comment = buildComment({ versionId: "v", timeStart: 5, body: "Do not post against private picture", author: "Guest" });
    expect(() => h.result.current.postSessionOp({ t: "add", comment })).toThrow(/Return to the room picture/);
    expect(pendingCount()).toBe(0);
    const incoming = { ...h.result.current.sessionDoc!, comments: [{ ...comment, body: "Room note received" }] };
    await emit("session:msg", { kind: "reviewDoc", doc: JSON.stringify(incoming) });
    expect(h.result.current.sessionDoc?.comments.some(c => c.body === "Room note received")).toBe(true);
    h.args.privatePreview = false; h.rerender();
    await act(async () => { h.result.current.postSessionOp({ t: "add", comment }); });
    expect(pendingCount()).toBe(1);
  });
  it("keeps note delivery pending across successful IPC until the host commit arrives", async () => {
    const h = await mount("peer");
    const comment = buildComment({ versionId: "v", timeStart: 5, body: "Keep me", author: "Guest" });
    await act(async () => { h.result.current.postSessionOp({ t: "add", comment }); });
    expect(pendingCount()).toBe(1);
    const sent = mocks.invoke.mock.calls.filter(([cmd, a]) => cmd === "session_send" && a?.msg?.kind === "reviewOp");
    const envelope = JSON.parse(sent.at(-1)![1].msg.op);
    await emit("session:msg", { kind: "reviewOp", from: "m0", op: JSON.stringify({ ...envelope,
      t: "review-commit", revision: 1, clock: Date.now(), op: { t: "add", comment: { ...comment, updatedAt: Date.now() } },
    }) });
    expect(pendingCount()).toBe(0);
    expect(h.result.current.sessionDoc?.comments).toHaveLength(1);
  });

  it("does not restart a long landing on duplicate heartbeats; a new command supersedes it", async () => {
    const h = await mount("peer");
    const completions: Array<(r: SeekResult) => void> = [];
    vi.mocked(h.player.seekTo).mockImplementation(() => new Promise((resolve) => { completions.push(resolve); }));
    await h.transport({ target: 30 });
    await h.transport({ seq: 2, target: 30 });
    await act(async () => { vi.advanceTimersByTime(5000); });
    await h.transport({ seq: 3, target: 30 });
    expect(h.player.seekTo).toHaveBeenCalledTimes(1);
    await h.transport({ seq: 4, command: 2, target: 40 });
    expect(h.player.seekTo).toHaveBeenCalledTimes(2);
    await act(async () => { completions[0](settled(30)); completions[1](settled(40)); });
    expect(h.controller.getSnapshot().presentedSeconds).toBe(40);
  });

  it("restores the exact engine rate after a small playing correction converges", async () => {
    const h = await mount("peer");
    await h.transport({ playing: true, phase: "play" });
    await act(async () => { h.controller.reportPresented(10); });
    await h.transport({ seq: 2, playing: true, phase: "play", position: 10.2, presented: 10.2 });
    expect(h.player.setPlaybackRate).toHaveBeenLastCalledWith(1.016);
    await act(async () => { h.controller.reportPresented(10.2); });
    await h.transport({ seq: 3, playing: true, phase: "play", position: 10.2, presented: 10.2 });
    expect(h.player.setPlaybackRate).toHaveBeenLastCalledWith(1);
  });

  it("welcomes a new connection without withdrawing the room's existing file offer", async () => {
    const h = await mount("host");
    await emit("session:msg", { kind: "offerFile", from: "m0", name: "review.mp4", size: 100, blake3: "hash", vcodec: "h264", acodec: "aac" });
    mocks.invoke.mockClear();
    await emit("session:state", { ...state("host"), peers: [{ id: "m1", name: "Guest", epoch: 1 }] });
    expect(mocks.invoke.mock.calls.some(([cmd]) => cmd === "session_clear_offer")).toBe(false);
    expect(h.result.current.offeredFile?.blake3).toBe("hash");
    expect(mocks.invoke.mock.calls.some(([cmd, a]) => cmd === "session_send_to" && a.msg.kind === "offerFile" && a.msg.blake3 === "hash")).toBe(true);
    expect(mocks.invoke.mock.calls.some(([cmd, a]) => cmd === "session_broadcast" && a.msg.kind === "loadSource")).toBe(false);
  });

  it("emits paused comment jumps immediately and heartbeats preserve the command target", async () => {
    const h = await mount("host");
    mocks.invoke.mockClear();
    await act(async () => { await h.controller.seekTo(22); });
    const commands = () => mocks.invoke.mock.calls.filter(([, a]) => a?.msg?.kind === "transport").map(([, a]) => a.msg);
    expect(commands()).toHaveLength(1);
    const first = commands()[0];
    expect(first).toMatchObject({ target: 22, phase: "seek", playing: false });
    await act(async () => { h.controller.reportPresented(21.99); vi.advanceTimersByTime(500); });
    expect(commands().at(-1)).toMatchObject({ command: first.command, target: 22, presented: 21.99 });
  });

  it("holds a paused guest's inspected frame until the next presenter command", async () => {
    const h = await mount("peer");
    await h.transport();
    vi.mocked(h.player.seekTo).mockClear();
    await act(async () => { setScrubbing(true); h.controller.beginScrub(); h.controller.scrubTo(30); });
    await h.transport({ seq: 2 });
    await act(async () => { await h.controller.endScrub(30); setScrubbing(false); });
    await h.transport({ seq: 3 });
    expect(h.player.seekTo).not.toHaveBeenCalled();
    await h.transport({ seq: 4, command: 2, phase: "frame-step", target: 10 + 1 / 24 });
    expect(h.player.seekTo).toHaveBeenLastCalledWith(10 + 1 / 24);
  });

  it("rejects a stale room/source transport and resets watermarks between sessions", async () => {
    const h = await mount("peer");
    await h.transport({ seq: 200, command: 100, target: 20 });
    vi.mocked(h.player.seekTo).mockClear();
    await h.transport({ seq: 201, command: 101, target: 30, sourceKey: "another-review" });
    await h.transport({ seq: 202, command: 102, target: 30, sessionId: "another-room" });
    expect(h.player.seekTo).not.toHaveBeenCalled();
    await emit("session:state", off);
    await emit("session:state", { ...state("peer"), code: "new-room" });
    await emit("session:msg", { kind: "loadSource", sourceKind: "web", url: h.args.sessionSource.url, reviewKey: h.key, from: "m0" });
    await h.transport({ seq: 1, command: 1, target: 40, sessionId: "" });
    expect(h.player.seekTo).toHaveBeenCalledWith(40);
  });

  it("keeps a host's note queued when durable storage fails and retries without duplication", async () => {
    const h = await mount("host");
    mocks.persist.mockRejectedValueOnce(Error("Disk unavailable"));
    mocks.invoke.mockClear();
    const comment = buildComment({ versionId: h.result.current.sessionDoc!.activeVersionId!, timeStart: 5, body: "Do not lose", author: "Host" });
    await act(async () => { h.result.current.postSessionOp({ t: "add", comment }); });
    expect(pendingCount()).toBe(1);
    expect(mocks.invoke.mock.calls.some(([, a]) => a?.msg?.op?.includes('"review-commit"'))).toBe(false);
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(pendingCount()).toBe(0);
    expect(h.result.current.sessionDoc?.comments).toHaveLength(1);
    expect(h.result.current.sessionDoc?.sync?.revision).toBe(1);
  });

  it("does not turn a slow playing drift correction into an endless seek loop", async () => {
    const h = await mount("peer");
    await h.transport({ playing: true, phase: "play" });
    vi.mocked(h.player.seekTo).mockClear();
    await h.transport({ seq: 2, playing: true, phase: "play", presented: 20, position: 20 });
    expect(h.player.seekTo).toHaveBeenCalledTimes(1);
    // The presenter advanced while the first hard correction was landing.
    await h.transport({ seq: 3, playing: true, phase: "play", presented: 23, position: 23 });
    await h.transport({ seq: 4, playing: true, phase: "play", presented: 24, position: 24 });
    expect(h.player.seekTo).toHaveBeenCalledTimes(1);
    expect(h.player.setPlaybackRate).toHaveBeenLastCalledWith(1.05);
    await act(async () => { h.controller.reportPresented(24); });
    await h.transport({ seq: 5, playing: true, phase: "play", presented: 24, position: 24 });
    expect(h.player.setPlaybackRate).toHaveBeenLastCalledWith(1);
  });

  it("resets transport even when switching directly from one peer session to another", async () => {
    const h = await mount("peer");
    await h.transport({ seq: 500, command: 99, target: 20 });
    vi.mocked(h.player.seekTo).mockClear();
    await emit("session:state", { ...state("peer"), code: "different-session" });
    await emit("session:msg", { kind: "loadSource", sourceKind: "web", url: h.args.sessionSource.url, reviewKey: h.key, from: "m0" });
    await h.transport({ seq: 1, command: 1, target: 40, sessionId: "" });
    expect(h.player.seekTo).toHaveBeenCalledWith(40);
  });
});
