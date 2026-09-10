import { describe, expect, it, vi } from "vitest";
import { Companion } from "./companion";
import type { BridgeClient } from "./bridge-client";
import type { PremiereAdapter, MarkerResult } from "./premiere";
import type { Binding, MarkerNote, Reply } from "./protocol";

function fixture() {
  const binding: Binding = { bindingId: "bound", projectId: "project", sequenceId: "sequence",
    projectName: "Test", sequenceName: "Sequence", timebaseTicks: "8467200000", displayFormat: "104", zeroPointTicks: "0" };
  const note: MarkerNote = { id: "a".repeat(64), request: { reviewKey: "review", versionId: "version", commentId: "comment",
    sessionId: "room", author: "Tester", body: "Test marker", anchor: { binding, sourceId: "input", capturedAt: 0, verification: "unverified" } },
    status: "added", sequenceTicks: "0", markerGuid: "marker", error: null };
  const snapshot: Extract<Reply, {type: "snapshot"}> = { v: 1, id: "snapshot", type: "snapshot",
    status: { phase: "connected", binding, syncEnabled: true, automaticPlacement: false, pendingCount: 0,
      otherBindingPendingCount: 0, ledgerRevision: 1, error: null }, notes: [note], page: { offset: 0, total: 1, hasMore: false } };
  const client = { request: vi.fn(async () => snapshot), onSnapshot: (_: typeof snapshot) => {}, onDisconnect: (_: string) => {} };
  const premiere = { reconcile: vi.fn(async (): Promise<MarkerResult> => ({ outcome: "undone" })), insertConfirmed: vi.fn() };
  const companion = new Companion(client as unknown as BridgeClient, premiere as unknown as PremiereAdapter);
  client.onSnapshot(snapshot);
  return { companion, client, premiere, snapshot, note };
}

describe("explicit marker reconciliation", () => {
  it("reports Undo without an insertion or a confirmation request", async () => {
    const f = fixture();
    expect(f.premiere.reconcile).not.toHaveBeenCalled();
    await f.companion.reconcile(f.note);
    expect(f.client.request).toHaveBeenCalledExactlyOnceWith({ type: "reconcile", noteId: f.note.id,
      binding: f.note.request.anchor.binding, outcome: "undone" });
    expect(f.premiere.insertConfirmed).not.toHaveBeenCalled();
  });
  it("does not send a late result through a new connection", async () => {
    const f = fixture(); let finish!: (result: MarkerResult) => void;
    f.premiere.reconcile.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const checking = f.companion.reconcile(f.note);
    f.client.onDisconnect("disconnected"); f.client.onSnapshot(f.snapshot);
    finish({ outcome: "undone" });
    await expect(checking).rejects.toThrow("connection changed");
    expect(f.client.request).not.toHaveBeenCalled();
  });
  it("rechecks sync permission after a pending native read", async () => {
    const f = fixture(); let finish!: (result: MarkerResult) => void;
    f.premiere.reconcile.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const checking = f.companion.reconcile(f.note);
    f.client.onSnapshot({ ...f.snapshot, status: { ...f.snapshot.status, syncEnabled: false } });
    finish({ outcome: "undone" });
    await expect(checking).rejects.toThrow("enable marker sync");
    expect(f.client.request).not.toHaveBeenCalled();
  });
});
