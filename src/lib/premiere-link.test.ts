// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import type { ReviewDoc } from "./review";
import type { PremiereBridgeSnapshot } from "../bindings/PremiereBridgeSnapshot";
import type { PremiereMarkerRecord } from "../bindings/PremiereMarkerRecord";
import { isPremiereReceipts, MAX_PREMIERE_RECEIPTS_PER_MESSAGE } from "./premiere-notes";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), saved: null as ((doc: ReviewDoc) => void) | null,
  docs: [] as ReviewDoc[], listen: vi.fn(async () => () => {}), roomEnabled: false }));
vi.mock("./premiere-permissions", () => ({ get PREMIERE_ROOM_MARKERS_ENABLED() { return mocks.roomEnabled; } }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("./review-store", () => ({ persistedReviews: () => mocks.docs.values(),
  subscribePersistedReviews: (listener: (doc: ReviewDoc) => void) => { mocks.saved = listener; return () => { mocks.saved = null; }; } }));
const binding = { bindingId: "binding", projectId: "project", sequenceId: "sequence", projectName: "Project",
  sequenceName: "Sequence", timebaseTicks: "10584000000", displayFormat: "102", zeroPointTicks: "0" };
const connected = (): PremiereBridgeSnapshot => ({ phase: "connected", binding, syncEnabled: true,
  automaticPlacement: false, pendingCount: 0, otherBindingPendingCount: 0, ledgerRevision: 0, error: null });
const document = (): ReviewDoc => ({ sourceKey: "ndi:pass", activeVersionId: "v", versions: [], status: {}, comments: [{
  id: "note", versionId: "v", parentId: null, timeStart: 0, timeEnd: null, body: "A note", author: "Guest",
  createdAt: 100, updatedAt: 100, resolved: false, annotation: null,
  timing: { kind: "general", sourceId: "ndi:pass", pass: "Pass 1" },
  premiere: { binding, sourceId: "ndi:pass", capturedAt: 100, verification: "unverified" },
}] });
let stop: (() => void) | undefined;
beforeEach(() => {
  vi.resetModules(); mocks.invoke.mockReset(); mocks.docs = []; mocks.saved = null; mocks.roomEnabled = false;
  mocks.invoke.mockImplementation(async (command: string, args?: { request: PremiereMarkerRecord["request"] }) => {
    if (command === "premiere_bridge_status") return connected();
    if (command === "premiere_marker_notes") return [];
    if (command === "premiere_enqueue_note") return { id: "record", request: args?.request, status: "needs_confirmation",
      sequenceTicks: null, markerGuid: null, error: null };
    return null;
  });
});

describe("room context isolation (in-memory only, no room transport)", () => {
  const programId = "a".repeat(32);
  const source = () => ({ reviewKey: "ndi:pass", programId, presenterEpoch: 3 });
  const context = () => ({ t: "premiere-context", protocol: 1, sessionId: "room", ...source(), revision: 1, sourceId: "ndi:pass", binding });
  async function guest() {
    mocks.roomEnabled = true;
    const link = await import("./premiere-link");
    link.setPremiereRoom("peer", "room"); link.setPremiereRoomSource(source());
    link.setPremiereVisibleInput({ sourceId: "ndi:pass", streamId: programId, name: "Premiere" });
    return link;
  }
  it("accepts only the host context for the native room/source/epoch", async () => {
    const link = await guest();
    link.acceptPremiereContext(context(), "m1");
    expect(link.getPremiereLink().remote).toBeNull();
    for (const bad of [null, { ...context(), sessionId: "old-room" }, { ...context(), reviewKey: "ndi:old" },
      { ...context(), sourceId: "ndi:other" }, { ...context(), programId: "b".repeat(32) },
      { ...context(), presenterEpoch: 2 }]) {
      link.acceptPremiereContext(bad, "m0"); expect(link.getPremiereLink().remote).toBeNull();
    }
    link.acceptPremiereContext(context(), "m0");
    expect(link.premiereBindingForSource("ndi:pass")).toEqual(binding);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("requires a new native source event after a room change", async () => {
    const link = await guest(); link.acceptPremiereContext(context(), "m0");
    link.setPremiereRoom("peer", "room-2");
    link.acceptPremiereContext({ ...context(), sessionId: "room-2" }, "m0");
    expect(link.getPremiereLink().remote).toBeNull();
    link.setPremiereRoomSource(source());
    link.acceptPremiereContext({ ...context(), sessionId: "room-2" }, "m0");
    expect(link.premiereBindingForSource("ndi:pass")).toEqual(binding);
  });
  it("invalidates context on presenter change and snapshots scope by value", async () => {
    const link = await guest();
    const scope = source(); link.setPremiereRoomSource(null); link.setPremiereRoomSource(scope);
    scope.presenterEpoch = 9;
    link.acceptPremiereContext(context(), "m0");
    expect(link.premiereBindingForSource("ndi:pass")).toEqual(binding);
    link.setPremiereRoomSource(scope);
    expect(link.getPremiereLink().remote).toBeNull();
    link.acceptPremiereContext(context(), "m0");
    expect(link.getPremiereLink().remote).toBeNull();
  });
  it("does not attach room markers to a private preview or different review pass", async () => {
    const link = await guest(); link.acceptPremiereContext(context(), "m0");
    link.setPremiereVisibleInput({ sourceId: "ndi:private", streamId: programId, name: "Same stream, different pass" });
    expect(link.premiereBindingForSource("ndi:pass")).toBeNull();
    link.setPremiereVisibleInput({ sourceId: "ndi:pass", streamId: "b".repeat(32), name: "Private source" });
    expect(link.premiereBindingForSource("ndi:pass")).toBeNull();
  });
  it("copies only permitted binding fields and honors a host revocation", async () => {
    const link = await guest();
    const input = { ...context(), binding: { ...binding, projectPath: "/private/local-project.prproj" } };
    link.acceptPremiereContext(input, "m0"); input.binding.sequenceId = "changed";
    expect(link.getPremiereLink().remote?.binding).toEqual(binding);
    link.acceptPremiereContext({ ...context(), binding: null }, "m0");
    expect(link.premiereBindingForSource("ndi:pass")).toBeNull();
  });
  it("can disable room delivery without enabling any native commands", async () => {
    const link = await guest(); mocks.roomEnabled = false;
    link.acceptPremiereContext(context(), "m0");
    expect(link.getPremiereLink().remote).toBeNull();
    expect(link.premiereBindingForSource("ndi:pass")).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
});
afterEach(() => { stop?.(); stop = undefined; });
describe("native Premiere handoff", () => {
  it("batches all eligible receipts with the same limit used by the receiver", async () => {
    mocks.roomEnabled = true;
    const link = await import("./premiere-link"); link.setPremiereRoom("host", "room");
    await link.refreshPremiereLink();
    const scope = { reviewKey: "ndi:pass", programId: "a".repeat(32), presenterEpoch: 1 };
    link.setPremiereRoomSource(scope); link.setPremiereVisibleInput({ sourceId: "ndi:pass", streamId: scope.programId, name: "Premiere" });
    link.associatePremiereInput();
    const doc = document(), seed = doc.comments[0];
    doc.sync = { sessionId: "room", revision: 1, clock: 1, operations: {} };
    doc.comments = Array.from({ length: MAX_PREMIERE_RECEIPTS_PER_MESSAGE * 2 + 1 }, (_, id) => ({ ...seed, id: `note-${id}` }));
    const records: PremiereMarkerRecord[] = doc.comments.map(comment => ({ id: comment.id,
      request: { reviewKey: doc.sourceKey, versionId: "v", commentId: comment.id, sessionId: "room",
        author: comment.author, body: comment.body, anchor: comment.premiere! },
      status: "added", sequenceTicks: null, markerGuid: null, error: null }));
    mocks.invoke.mockImplementation(async command => command === "premiere_bridge_status" ? { ...connected(), ledgerRevision: 2 }
      : command === "premiere_marker_notes" ? records : null);
    await link.refreshPremiereLink();
    const batches = link.premiereRoomReceipts(doc);
    expect(batches.map(b => b.items.length)).toEqual([MAX_PREMIERE_RECEIPTS_PER_MESSAGE, MAX_PREMIERE_RECEIPTS_PER_MESSAGE, 1]);
    expect(batches.every(isPremiereReceipts)).toBe(true);
    expect(batches.flatMap(b => b.items.map(i => i.commentId))).toEqual(doc.comments.map(c => c.id));
    expect(isPremiereReceipts({ ...batches[0], items: [...batches[0].items, batches[2].items[0]] })).toBe(false);
  });
  it("does not enqueue an optimistic room save or a peer snapshot after leaving the room", async () => {
    mocks.roomEnabled = true;
    const link = await import("./premiere-link"); link.setPremiereRoom("host", "room"); stop = link.observePremiereLink();
    await waitFor(() => expect(link.getPremiereLink().bridge?.phase).toBe("connected"));
    const doc = document();
    doc.comments[0].sessionId = "room";
    doc.sync = { sessionId: "room", revision: 1, clock: 1, operations: { optimistic: 1 } };
    mocks.saved?.(doc);
    expect(mocks.invoke).not.toHaveBeenCalledWith("premiere_enqueue_note", expect.anything());
    link.setPremiereRoom("off", ""); mocks.saved?.(doc);
    expect(mocks.invoke).not.toHaveBeenCalledWith("premiere_enqueue_note", expect.anything());
    doc.sync.commits = { accepted: { op: { t: "add", comment: structuredClone(doc.comments[0]) },
      revision: 1, clock: 1, versionId: "v" } };
    mocks.saved?.(doc);
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("premiere_enqueue_note", expect.anything()));
  });
  it("shares receipts only for matching notes, without other project data or native errors", async () => {
    mocks.roomEnabled = true;
    const link = await import("./premiere-link"); link.setPremiereRoom("host", "room"); stop = link.observePremiereLink();
    await waitFor(() => expect(link.getPremiereLink().bridge?.phase).toBe("connected"));
    const scope = { reviewKey: "ndi:pass", programId: "a".repeat(32), presenterEpoch: 1 };
    link.setPremiereRoomSource(scope); link.setPremiereVisibleInput({ sourceId: "ndi:pass", streamId: scope.programId, name: "Premiere" });
    link.associatePremiereInput();
    const doc = document(); doc.comments[0].sessionId = "old-room";
    const request = { reviewKey: doc.sourceKey, versionId: "v", commentId: "note", sessionId: "old-room",
      author: "Private author", body: "Private body", anchor: doc.comments[0].premiere! };
    const record = { id: "record", request, status: "added", sequenceTicks: "123", markerGuid: "private-guid", error: "/private/error.log" };
    mocks.invoke.mockImplementation(async command => command === "premiere_bridge_status" ? { ...connected(), ledgerRevision: 2 }
      : command === "premiere_marker_notes" ? [record, { ...record, id: "unrelated", request: { ...request, commentId: "other" } }] : null);
    await link.refreshPremiereLink();
    doc.sync = { sessionId: "room", revision: 1, clock: 1, operations: {} };
    const receipts = link.premiereRoomReceipts(doc);
    expect(receipts.flatMap(r => r.items)).toEqual([{ commentId: "note", versionId: "v", bindingId: binding.bindingId, status: "added" }]);
    expect(JSON.stringify(receipts)).not.toMatch(/private|Private|unrelated|old-room/);
  });
  it("status observation never starts pairing, NDI or a session", async () => {
    const link = await import("./premiere-link"); stop = link.observePremiereLink();
    await waitFor(() => expect(link.getPremiereLink().bridge?.phase).toBe("connected"));
    expect(mocks.invoke.mock.calls.every(([command]) => ["premiere_bridge_status", "premiere_marker_notes"].includes(command))).toBe(true);
  });
  it("fails closed until native room role is known, including a restored guest", async () => {
    mocks.docs = [document()];
    const link = await import("./premiere-link"); await link.refreshPremiereLink();
    link.setPremiereVisibleInput({ sourceId: "ndi:pass", streamId: "stream", name: "Premiere" });
    expect(() => link.associatePremiereInput()).toThrow();
    link.setPremiereRoom("peer", "room"); await link.refreshPremiereLink();
    expect(() => link.associatePremiereInput()).toThrow();
    expect(mocks.invoke).not.toHaveBeenCalledWith("premiere_enqueue_note", expect.anything());
  });
  it("only hands off a note after the completed document/index save notification", async () => {
    const link = await import("./premiere-link"); link.setPremiereRoom("off", ""); stop = link.observePremiereLink();
    await waitFor(() => expect(link.getPremiereLink().bridge?.phase).toBe("connected"));
    expect(mocks.invoke).not.toHaveBeenCalledWith("premiere_enqueue_note", expect.anything());
    mocks.saved?.(document());
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("premiere_enqueue_note", expect.objectContaining({ request: expect.objectContaining({ commentId: "note" }) })));
  });
  it("retries a failed queue write from the saved document without duplicating success", async () => {
    const link = await import("./premiere-link"); link.setPremiereRoom("off", ""); stop = link.observePremiereLink();
    await waitFor(() => expect(link.getPremiereLink().bridge?.phase).toBe("connected"));
    mocks.invoke.mockRejectedValueOnce(new Error("Disk full"));
    mocks.saved?.(document());
    await waitFor(() => expect(link.getPremiereLink().error).toContain("waiting for the Premiere queue"));
    await link.refreshPremiereLink();
    await waitFor(() => expect(link.getPremiereLink().records.length).toBe(1));
    await link.refreshPremiereLink(); mocks.saved?.(document());
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "premiere_enqueue_note")).toHaveLength(2);
  });
  it("does not fetch all records on unchanged heartbeats", async () => {
    const link = await import("./premiere-link");
    await link.refreshPremiereLink(); await link.refreshPremiereLink(); await link.refreshPremiereLink();
    expect(mocks.invoke.mock.calls.filter(([command]) => command === "premiere_marker_notes")).toHaveLength(1);
  });
  it("an older status reply cannot restore a disconnected binding", async () => {
    const link = await import("./premiere-link");
    let resolve!: (status: PremiereBridgeSnapshot) => void;
    mocks.invoke.mockReturnValueOnce(new Promise<PremiereBridgeSnapshot>(done => { resolve = done; }));
    const old = link.refreshPremiereLink();
    mocks.invoke.mockResolvedValueOnce({ ...connected(), phase: "off", binding: null, syncEnabled: false });
    await link.refreshPremiereLink(); resolve(connected()); await old;
    expect(link.getPremiereLink().bridge?.phase).toBe("off");
  });
});
