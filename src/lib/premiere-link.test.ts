// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import type { ReviewDoc } from "./review";
import type { PremiereBridgeSnapshot } from "../bindings/PremiereBridgeSnapshot";
import type { PremiereMarkerRecord } from "../bindings/PremiereMarkerRecord";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), saved: null as ((doc: ReviewDoc) => void) | null,
  docs: [] as ReviewDoc[], listen: vi.fn(async () => () => {}) }));
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
  vi.resetModules(); mocks.invoke.mockReset(); mocks.docs = []; mocks.saved = null;
  mocks.invoke.mockImplementation(async (command: string, args?: { request: PremiereMarkerRecord["request"] }) => {
    if (command === "premiere_bridge_status") return connected();
    if (command === "premiere_marker_notes") return [];
    if (command === "premiere_enqueue_note") return { id: "record", request: args?.request, status: "needs_confirmation",
      sequenceTicks: null, markerGuid: null, error: null };
    return null;
  });
});
afterEach(() => { stop?.(); stop = undefined; });
describe("native Premiere handoff", () => {
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
