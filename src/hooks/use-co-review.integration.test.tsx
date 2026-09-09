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

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  invoke: vi.fn(), persist: vi.fn(),
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
vi.mock("../lib/review-store", async (original) => ({
  ...await original<typeof import("../lib/review-store")>(),
  persistReviewDoc: (doc: ReviewDoc) => mocks.persist(doc),
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
async function mount(role: "host" | "peer") {
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
  const key = `review-${crypto.randomUUID()}`;
  const url = `https://example.com/${key}`;
  const args: Parameters<typeof useCoReview>[0] = {
    isPlaying: false, fps: 24, playbackRate: 1,
    sessionSource: { kind: "web", url, reviewKey: key, fingerprint: null, title: "Cut", duration: 100 },
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
    await emit("session:msg", { kind: "loadSource", sourceKind: "web", url, reviewKey: key, from: "m0" });
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
  vi.useFakeTimers(); localStorage.clear(); mocks.listeners.clear(); mocks.invoke.mockReset(); mocks.persist.mockReset();
  mocks.invoke.mockImplementation(async (command) => command === "session_state" ? off : null);
  mocks.persist.mockImplementation(async (doc) => { putReviewDoc(doc); });
});
afterEach(async () => { cleanup(); setScrubbing(false); await Promise.resolve(); vi.useRealTimers(); });

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
