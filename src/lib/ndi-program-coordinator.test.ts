import { describe, expect, it, vi } from "vitest";
import type { NdiRoomState } from "../bindings/NdiRoomState";
import type { NdiStarted } from "../bindings/NdiStarted";
import type { NdiStatusResult } from "../bindings/NdiStatusResult";
import { canPublishNdi, emptyNdiTelemetry, NdiProgramCoordinator, type NdiProgramPorts } from "./ndi-program-coordinator";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const room = (generation = 1, presenterEpoch = 0): NdiRoomState => ({
  generation, presenterEpoch, presenting: true, publishedId: null, publicationRevision: null, source: null,
});
const ready = (p: NdiStarted, roomGeneration: number | null = 1): NdiStatusResult => ({
  program: p, roomGeneration, encodedReady: true,
  telemetry: { ...emptyNdiTelemetry(), sourceId: p.id, phase: "live", connectionCount: 1,
    receivedFrames: 30, inputWidth: 1920, inputHeight: 1080, outputFps: 30 },
});
function harness(inRoom = true) {
  let next = 0, revision = 10;
  const native = new Map<string, NdiStatusResult>();
  const ports: NdiProgramPorts = {
    start: vi.fn(async name => {
      const p = { id: String(++next).padStart(32, "0"), name, url: `/program/${next}` };
      native.set(p.id, ready(p, inRoom ? 1 : null)); return p;
    }),
    status: vi.fn(async id => native.get(id)!),
    stop: vi.fn(async () => {}),
    publish: vi.fn(async () => ++revision),
    unpublish: vi.fn(async () => {}),
    reviewKey: vi.fn(name => `review:${name}`),
  };
  const ctl = new NdiProgramCoordinator(ports);
  if (inRoom) ctl.setRoom(room());
  async function preview(name = "Premiere A") {
    await ctl.preview(name);
    const p = ctl.getSnapshot().candidate!;
    ctl.frameDecoded(p.id); return p;
  }
  async function publish(name = "Premiere A") { const p = await preview(name); await ctl.publish(); return p; }
  return { ctl, ports, native, preview, publish };
}

describe("independent Premiere preview and publication", () => {
  it("never publishes implicitly, including when a standalone preview enters a room", async () => {
    const h = harness(false); const p = await h.preview();
    expect(h.ctl.getSnapshot().candidate?.id).toBe(p.id);
    expect(canPublishNdi(h.ctl.getSnapshot())).toBe(false);
    h.ctl.setRoom(room());
    expect(h.ctl.getSnapshot().candidate?.id).toBe(p.id);
    expect(h.ctl.getSnapshot().roomSource).toBeNull();
    expect(h.ports.publish).not.toHaveBeenCalled();
    expect(canPublishNdi(h.ctl.getSnapshot())).toBe(true);
  });
  it("requires independent encoded media AND a decoded picture before sharing", async () => {
    const h = harness(); await h.ctl.preview("Premiere");
    const p = h.ctl.getSnapshot().candidate!;
    expect(p.encodedReady).toBe(true);
    await expect(h.ctl.publish()).rejects.toThrow(/decoded preview/);
    h.ctl.frameDecoded("cancelled-old-id");
    expect(canPublishNdi(h.ctl.getSnapshot())).toBe(false);
    h.native.set(p.id, { ...ready(p), encodedReady: false });
    await h.ctl.refreshStatus(p.id); h.ctl.frameDecoded(p.id);
    expect(canPublishNdi(h.ctl.getSnapshot())).toBe(false);
    h.native.set(p.id, ready(p)); await h.ctl.refreshStatus(p.id);
    expect(canPublishNdi(h.ctl.getSnapshot())).toBe(true);
    await h.ctl.publish();
    expect(h.ports.publish).toHaveBeenCalledTimes(1);
  });
  it("keeps source A shared while previewing B, then cancels only B", async () => {
    const h = harness(); const a = await h.publish();
    const lease = h.ctl.getSnapshot().lease;
    const b = await h.preview("Premiere B");
    expect(h.ctl.getSnapshot().published?.id).toBe(a.id);
    expect(h.ctl.getSnapshot().roomSource?.id).toBe(a.id);
    expect(h.ports.unpublish).not.toHaveBeenCalled();
    expect(h.ports.stop).not.toHaveBeenCalled();
    await h.ctl.cancelPreview();
    expect(h.ports.stop).toHaveBeenCalledExactlyOnceWith(b.id);
    expect(h.ctl.getSnapshot().lease).toEqual(lease);
    expect(h.ctl.getSnapshot().candidate).toBeNull();
  });
  it("reuses the already published source without a second receiver or a private claim", async () => {
    const h = harness(); const a = await h.publish();
    await h.ctl.preview(a.name);
    expect(h.ports.start).toHaveBeenCalledTimes(1);
    expect(h.ctl.getSnapshot().candidate).toBeNull();
    expect(h.ctl.getSnapshot().published?.id).toBe(a.id);
  });
  it("leaves the old publication untouched on hardware capacity failure", async () => {
    const h = harness(); const a = await h.publish();
    vi.mocked(h.ports.start).mockRejectedValueOnce(new Error("Hardware encoder capacity exceeded"));
    await expect(h.ctl.preview("Premiere B")).rejects.toThrow(/capacity/);
    expect(h.ctl.getSnapshot().published?.id).toBe(a.id);
    expect(h.ports.unpublish).not.toHaveBeenCalled();
    expect(h.ports.stop).not.toHaveBeenCalled();
    expect(h.ctl.getSnapshot().busy).toBeNull();
  });
  it("keeps the last private preview mounted across replacement startup and failure", async () => {
    const h = harness(); const a = await h.preview(); const pending = deferred<NdiStarted>();
    vi.mocked(h.ports.start).mockReturnValueOnce(pending.promise);
    const replacement = h.ctl.preview("B"); await Promise.resolve(); await Promise.resolve();
    expect(h.ctl.getSnapshot().candidate?.id).toBe(a.id);
    expect(h.ctl.getSnapshot().candidate?.retired).toBe(true);
    expect(canPublishNdi(h.ctl.getSnapshot())).toBe(false);
    const rejected = expect(replacement).rejects.toThrow(/Hardware/);
    pending.reject(new Error("Hardware capacity unavailable")); await rejected;
    expect(h.ctl.getSnapshot().candidate?.id).toBe(a.id);
    expect(canPublishNdi(h.ctl.getSnapshot())).toBe(false);
    await h.ctl.preview(a.name);
    expect(h.ports.start).toHaveBeenCalledTimes(3);
    expect(h.ctl.getSnapshot().candidate?.id).not.toBe(a.id);
  });
  it("commits once before releasing the old receiver and preserves logical review identity", async () => {
    const h = harness(); const a = await h.publish();
    const b = await h.preview("Premiere B");
    const order: string[] = [];
    vi.mocked(h.ports.publish).mockImplementationOnce(async () => { order.push("publish"); return 22; });
    vi.mocked(h.ports.stop).mockImplementationOnce(async id => { order.push(`stop:${id}`); });
    await h.ctl.publish();
    expect(order).toEqual(["publish", `stop:${a.id}`]);
    expect(h.ctl.getSnapshot().published?.id).toBe(b.id);
    expect(h.ctl.getSnapshot().roomSource).toEqual({ id: b.id, name: b.name, reviewKey: "review:Premiere B", state: "live" });
    expect(h.ctl.getSnapshot().lease).toEqual({ id: b.id, generation: 1, epoch: 0, revision: 22 });
  });
  it("retains local preview and stopped review identity after unpublishing", async () => {
    const h = harness(); const a = await h.publish(); const lease = h.ctl.getSnapshot().lease;
    await h.ctl.stopSharing();
    expect(h.ports.unpublish).toHaveBeenCalledExactlyOnceWith(lease);
    expect(h.ports.stop).not.toHaveBeenCalled();
    expect(h.ctl.getSnapshot().candidate?.id).toBe(a.id);
    expect(h.ctl.getSnapshot().roomSource).toMatchObject({ id: a.id, state: "stopped" });
    expect(h.ctl.getSnapshot().published).toBeNull();
    await h.ctl.cancelPreview();
    expect(h.ctl.getSnapshot().roomSource?.state).toBe("stopped");
    expect(h.ctl.getSnapshot().roomSource?.reviewKey).toBe(a.reviewKey);
  });
  it("stop sharing during a different private preview keeps that preview", async () => {
    const h = harness(); const a = await h.publish(); const b = await h.preview("B");
    await h.ctl.stopSharing();
    expect(h.ctl.getSnapshot().candidate?.id).toBe(b.id);
    expect(h.ctl.getSnapshot().roomSource).toMatchObject({ id: a.id, state: "stopped" });
    expect(h.ports.stop).toHaveBeenCalledExactlyOnceWith(a.id);
  });
  it("never changes visible publication on a failed publish or unpublish", async () => {
    const h = harness(); const a = await h.publish(); const b = await h.preview("B");
    vi.mocked(h.ports.publish).mockRejectedValueOnce(new Error("Presentation changed"));
    await expect(h.ctl.publish()).rejects.toThrow(/Presentation/);
    expect(h.ctl.getSnapshot().published?.id).toBe(a.id);
    expect(h.ctl.getSnapshot().candidate?.id).toBe(b.id);
    vi.mocked(h.ports.unpublish).mockRejectedValueOnce(new Error("IPC unavailable"));
    await expect(h.ctl.stopSharing()).rejects.toThrow(/IPC/);
    expect(h.ctl.getSnapshot().published?.id).toBe(a.id);
    expect(h.ctl.getSnapshot().roomSource?.state).toBe("live");
  });
  it("keeps a cancel failure visible and retryable rather than orphaning a receiver", async () => {
    const h = harness(); const a = await h.preview();
    vi.mocked(h.ports.stop).mockRejectedValueOnce(new Error("Stop failed"));
    await expect(h.ctl.cancelPreview()).rejects.toThrow(/Stop failed/);
    expect(h.ctl.getSnapshot().candidate?.id).toBe(a.id);
    expect(h.ctl.getSnapshot().error).toBe("Stop failed");
    await h.ctl.cancelPreview();
    expect(h.ctl.getSnapshot().candidate).toBeNull();
  });
});

describe("Premiere source generations and cancellation", () => {
  it("drains a cancelled pending start before admitting its replacement", async () => {
    const h = harness(); const pending = deferred<NdiStarted>();
    vi.mocked(h.ports.start).mockReturnValueOnce(pending.promise);
    const old = h.ctl.preview("old"); await Promise.resolve();
    const cancel = h.ctl.cancelPreview();
    // Cancellation itself is a serialized mutation. Wait for its completion
    // before the UI admits another source, even while native teardown drains.
    expect(() => h.ctl.preview("new")).toThrow(/sharing change/);
    pending.resolve({ id: "old-id", name: "old", url: "/old" });
    await old; await cancel; await h.preview("new");
    expect(h.ports.stop).toHaveBeenCalledExactlyOnceWith("old-id");
    expect(h.ctl.getSnapshot().candidate?.name).toBe("new");
  });
  it("coalesces rapid replacement requests, not a backlog of receivers", async () => {
    const h = harness(); const pending = deferred<NdiStarted>();
    vi.mocked(h.ports.start).mockReturnValueOnce(pending.promise);
    const a = h.ctl.preview("A"); await Promise.resolve();
    const b = h.ctl.preview("B"), c = h.ctl.preview("C");
    pending.resolve({ id: "cancelled-A", name: "A", url: "/a" });
    await Promise.all([a, b, c]);
    expect(vi.mocked(h.ports.start).mock.calls.map(([name]) => name)).toEqual(["A", "C"]);
    expect(h.ports.stop).toHaveBeenCalledExactlyOnceWith("cancelled-A");
    expect(h.ctl.getSnapshot().candidate?.name).toBe("C");
  });
  it("invalidates late publication by the exact old room/epoch/revision", async () => {
    const h = harness(); const a = await h.preview(); const pending = deferred<number>();
    vi.mocked(h.ports.publish).mockReturnValueOnce(pending.promise);
    const publish = h.ctl.publish(); await Promise.resolve();
    const completion = expect(publish).rejects.toThrow(/session changed/);
    h.ctl.setRoom(room(2, 3));
    pending.resolve(77); await completion;
    expect(h.ports.unpublish).toHaveBeenCalledExactlyOnceWith({ id: a.id, generation: 1, epoch: 0, revision: 77 });
    expect(h.ctl.getSnapshot().published).toBeNull();
    expect(h.ctl.getSnapshot().roomSource).toBeNull();
  });
  it("does not report a queued publication as committed after leaving the room", async () => {
    const h = harness(); await h.preview();
    const committed = vi.fn();
    const completion = expect(h.ctl.publish().then(committed)).rejects.toThrow(/session changed/);
    h.ctl.setRoom(null);
    await completion;
    expect(h.ports.publish).not.toHaveBeenCalled();
    expect(committed).not.toHaveBeenCalled();
    expect(h.ctl.getSnapshot().error).toBeNull();
  });
  it("does not run a completion callback for an obsolete publication while cleanup drains", async () => {
    const h = harness(); const a = await h.publish(); await h.preview("B");
    const cleanupStarted = deferred<void>(), cleanupFinished = deferred<void>();
    vi.mocked(h.ports.stop).mockImplementationOnce(async id => {
      expect(id).toBe(a.id); cleanupStarted.resolve(); await cleanupFinished.promise;
    });
    const committed = vi.fn();
    const completion = expect(h.ctl.publish().then(committed)).rejects.toThrow(/session changed/);
    await cleanupStarted.promise;
    h.ctl.setRoom(room(2, 3));
    cleanupFinished.resolve(); await completion;
    expect(committed).not.toHaveBeenCalled();
    expect(h.ctl.getSnapshot().room).toEqual(room(2, 3));
    expect(h.ctl.getSnapshot().error).toBeNull();
  });
  it("does not let Escape or a second click partially undo an in-flight publication", async () => {
    const h = harness(); await h.preview(); const pending = deferred<number>();
    vi.mocked(h.ports.publish).mockReturnValueOnce(pending.promise);
    const publish = h.ctl.publish(); await Promise.resolve();
    expect(() => h.ctl.cancelPreview()).toThrow(/sharing change/);
    expect(() => h.ctl.preview("B")).toThrow(/sharing change/);
    await expect(h.ctl.publish()).rejects.toThrow(/decoded preview/);
    pending.resolve(40); await publish;
    expect(h.ports.publish).toHaveBeenCalledTimes(1);
  });
  it("does not apply a cancelled source's decoded frame or telemetry to a newer source", async () => {
    const h = harness(); const a = await h.preview(); await h.ctl.cancelPreview();
    await h.ctl.preview("B"); const b = h.ctl.getSnapshot().candidate!;
    h.ctl.frameDecoded(a.id); h.ctl.telemetry({ ...a.telemetry, phase: "error", error: "Old error" });
    expect(h.ctl.getSnapshot().candidate?.id).toBe(b.id);
    expect(h.ctl.getSnapshot().candidate?.decodedReady).toBe(false);
    expect(h.ctl.getSnapshot().candidate?.telemetry.error).toBeNull();
  });
  it("preserves standalone preview on off-room refresh and discards room-owned preview on handoff", async () => {
    const standalone = harness(false); const a = await standalone.preview();
    standalone.ctl.setRoom(null);
    expect(standalone.ctl.getSnapshot().candidate?.id).toBe(a.id);
    const host = harness(); await host.preview();
    host.ctl.setRoom({ ...room(1, 1), presenting: false });
    expect(host.ctl.getSnapshot().candidate).toBeNull();
    expect(host.ports.stop).not.toHaveBeenCalled(); // Native room teardown owns it.
  });
  it("permits a parked connected source but not a disconnected or failed one", async () => {
    const h = harness(); const a = await h.preview();
    h.ctl.telemetry({ ...a.telemetry, phase: "stale", connectionCount: 1, lastInputAgeMs: 4000 });
    expect(canPublishNdi(h.ctl.getSnapshot())).toBe(true);
    h.ctl.telemetry({ ...a.telemetry, phase: "stale", connectionCount: 0, lastInputAgeMs: 4000 });
    expect(canPublishNdi(h.ctl.getSnapshot())).toBe(false);
    h.ctl.telemetry({ ...a.telemetry, phase: "error", error: "Encoder stopped" });
    expect(canPublishNdi(h.ctl.getSnapshot())).toBe(false);
  });
  it("requires a new decoded picture after a playback failure", async () => {
    const h = harness(); const a = await h.preview();
    h.ctl.pictureFailed(a.id);
    expect(canPublishNdi(h.ctl.getSnapshot())).toBe(false);
    h.ctl.frameDecoded(a.id);
    expect(canPublishNdi(h.ctl.getSnapshot())).toBe(true);
  });
  it("does not let a late status reply erase a newer native encoder failure", async () => {
    const h = harness(); const a = await h.preview(); const pending = deferred<NdiStatusResult>();
    vi.mocked(h.ports.status).mockReturnValueOnce(pending.promise);
    const status = h.ctl.refreshStatus(a.id);
    h.ctl.telemetry({ ...a.telemetry, phase: "error", error: "Encoder failed" });
    pending.resolve(ready(a)); await status;
    expect(h.ctl.getSnapshot().candidate?.telemetry.error).toBe("Encoder failed");
    expect(canPublishNdi(h.ctl.getSnapshot())).toBe(false);
  });
  it("restores a stopped room without exposing a private receiver or losing its pass", () => {
    const h = harness();
    const privateSource = { id: "private", name: "B", url: "/b" };
    h.ctl.restore({ programs: [ready(privateSource)], room: { ...room(),
      source: { id: "old", name: "A", reviewKey: "ndi:existing-pass", state: "stopped" } } });
    expect(h.ctl.getSnapshot().candidate?.id).toBe("private");
    expect(h.ctl.getSnapshot().published).toBeNull();
    expect(h.ctl.getSnapshot().roomSource).toMatchObject({ id: "old", reviewKey: "ndi:existing-pass", state: "stopped" });
    expect(h.ports.publish).not.toHaveBeenCalled();
  });
  it("reattaches to opened sessions without starting a receiver or claiming a decoded frame", () => {
    const h = harness();
    const a = { id: "a", name: "A", url: "/a" }, b = { id: "b", name: "B", url: "/b" };
    h.ctl.restore({ programs: [ready(a), ready(b)], room: { ...room(), publishedId: "a", publicationRevision: 9 } });
    expect(h.ctl.getSnapshot().published?.id).toBe("a");
    expect(h.ctl.getSnapshot().candidate?.id).toBe("b");
    expect(h.ctl.getSnapshot().lease?.revision).toBe(9);
    expect(canPublishNdi(h.ctl.getSnapshot())).toBe(false);
    expect(h.ports.start).not.toHaveBeenCalled();
    expect(h.ports.publish).not.toHaveBeenCalled();
  });
  it("keeps a stable snapshot between changes and supports unsubscribing", async () => {
    const h = harness(); const listener = vi.fn(); const off = h.ctl.subscribe(listener);
    const before = h.ctl.getSnapshot();
    expect(h.ctl.getSnapshot()).toBe(before);
    await h.preview(); expect(listener).toHaveBeenCalled();
    off(); listener.mockClear(); h.ctl.frameDecoded("not-active");
    expect(listener).not.toHaveBeenCalled();
  });
  it("releases leases before local receivers on application disposal", async () => {
    const h = harness(); const a = await h.publish(); const b = await h.preview("B");
    const order: string[] = [];
    vi.mocked(h.ports.unpublish).mockImplementationOnce(async () => { order.push("unpublish"); });
    vi.mocked(h.ports.stop).mockImplementation(async id => { order.push(`stop:${id}`); });
    await h.ctl.dispose();
    expect(order[0]).toBe("unpublish");
    expect(new Set(order.slice(1))).toEqual(new Set([`stop:${a.id}`, `stop:${b.id}`]));
    expect(() => h.ctl.preview("C")).toThrow(/closed/);
  });
});
