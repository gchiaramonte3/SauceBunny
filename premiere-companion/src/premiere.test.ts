import { describe, expect, it, vi } from "vitest";
import type { Action, Marker, Markers, Project, Sequence } from "@adobe/premierepro";
import { MarkerLedger } from "./ledger";
import { PremiereAdapter, type AdobeApi } from "./premiere";
import type { Binding, MarkerNote } from "./protocol";

const guid = (id: string) => ({ toString: () => id });
const timebase = "10594584000"; // 23.976 fps, exact Adobe ticks.
const position = (BigInt(timebase) * 2_000_000n).toString();
function fixture() {
  const saved = new Map<string, string>();
  const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: vi.fn((key: string, value: string) => { saved.set(key, value); }) };
  const ledger = new MarkerLedger(storage);
  const nativeMarkers: Marker[] = [];
  const actions: { name: string; kind: string; ticks: string; duration: string; comments: string }[] = [];
  const sequence = { guid: guid("sequence-A"), name: "Cut v3", getTimebase: vi.fn(async () => timebase),
    getSequenceVideoTimeDisplayFormat: vi.fn(async () => ({ type: 110 })), getZeroPoint: vi.fn(async () => ({ ticks: "0" })),
    getPlayerPosition: vi.fn(async () => ({ ticks: position })), setPlayerPosition: vi.fn() };
  const project = { guid: guid("project-A"), name: "Commercial", path: "/private/editor/Commercial.prproj",
    getActiveSequence: vi.fn(async () => sequence as unknown as Sequence),
    getSequence: vi.fn((id: { toString(): string }) => id.toString() === "sequence-A" ? sequence as unknown as Sequence : undefined),
    lockedAccess: vi.fn((callback: () => void) => callback()),
    executeTransaction: vi.fn((callback: (compound: { addAction(action: Action): void }) => void) => {
      callback({ addAction: action => {
        const spec = action as unknown as typeof actions[number];
        actions.push(spec);
        nativeMarkers.push({ guid: guid(`marker-${actions.length}`), getComments: () => spec.comments } as Marker);
      } });
      return true;
    }), save: vi.fn(), setActiveSequence: vi.fn() };
  const markers = { getMarkers: () => nativeMarkers, createAddMarkerAction: (name: string, kind: string, start: { ticks: string }, duration: { ticks: string }, comments: string) =>
    ({ name, kind, ticks: start.ticks, duration: duration.ticks, comments }) as unknown as Action } as unknown as Markers;
  const api = { Guid: { fromString: guid }, TickTime: { createWithTicks: (ticks: string) => ({ ticks }) },
    Project: { getActiveProject: vi.fn(async () => project), getProject: vi.fn((id: { toString(): string }) => id.toString() === "project-A" ? project : undefined) },
    Markers: { getMarkers: vi.fn(async () => markers) } };
  const adapter = new PremiereAdapter(api as unknown as AdobeApi, ledger);
  return { adapter, api, project, sequence, nativeMarkers, actions, ledger, storage, saved };
}
function note(binding: Binding): MarkerNote {
  return { id: "a".repeat(64), request: { reviewKey: "review", versionId: "version", commentId: "comment", sessionId: "room",
    author: "Alex", body: "Hold this shot longer", anchor: { binding, sourceId: "ndi-source", capturedAt: 123, verification: "unverified" } },
    status: "dispatching", sequenceTicks: position, markerGuid: null, error: null };
}

describe("Premiere sequence marker safety", () => {
  it("binds explicit sequence identity and keeps project paths off the wire", async () => {
    const f = fixture(); const binding = await f.adapter.bindActive();
    expect(binding.projectId).toBe("project-A"); expect(binding.sequenceId).toBe("sequence-A");
    expect(JSON.stringify(binding)).not.toContain("/private/editor");
    expect((await f.adapter.bindActive()).bindingId).toBe(binding.bindingId);
  });
  it("creates one exact native Comment marker without moving transport or saving the project", async () => {
    const f = fixture(); const binding = await f.adapter.bindActive(); const placement = await f.adapter.capturePlacement(binding);
    expect(placement.sequenceTicks).toBe(position); expect(placement.frame).toBe("2000000");
    const result = await f.adapter.insertConfirmed(note(binding), placement);
    expect(result).toEqual({ outcome: "found", markerGuid: "marker-1" });
    expect(f.actions).toHaveLength(1); expect(f.actions[0]).toMatchObject({ kind: "Comment", ticks: position, duration: "0" });
    expect(f.actions[0].comments).toContain(`[Sauce Bunny note:${"a".repeat(64)}]`);
    expect(f.sequence.setPlayerPosition).not.toHaveBeenCalled(); expect(f.project.setActiveSequence).not.toHaveBeenCalled(); expect(f.project.save).not.toHaveBeenCalled();
  });
  it("awaits UXP target lookups before reading their native identity", async () => {
    const f = fixture(); const binding = await f.adapter.bindActive();
    // UXP can return a promise despite the 26.3 declaration's synchronous
    // return type. A Promise has no guid; capture must not dereference it.
    f.api.Project.getProject.mockImplementation(() => Promise.resolve(f.project) as unknown as typeof f.project);
    f.project.getSequence.mockImplementation(() => Promise.resolve(f.sequence) as unknown as Sequence);
    const placement = await f.adapter.capturePlacement(binding);
    expect(placement.sequenceTicks).toBe(position);
    expect(await f.adapter.insertConfirmed(note(binding), placement)).toEqual({ outcome: "found", markerGuid: "marker-1" });
    expect(f.actions).toHaveLength(1);
    f.nativeMarkers.splice(0);
    expect(await f.adapter.reconcile(note(binding))).toEqual({ outcome: "undone" });
  });
  it("deduplicates a retry and a lost acknowledgement after plugin restart", async () => {
    const f = fixture(); const binding = await f.adapter.bindActive(); const placement = await f.adapter.capturePlacement(binding);
    await f.adapter.insertConfirmed(note(binding), placement);
    const restarted = new PremiereAdapter(f.api as unknown as AdobeApi, new MarkerLedger(f.storage));
    expect(await restarted.insertConfirmed(note(binding), placement)).toEqual({ outcome: "found", markerGuid: "marker-1" });
    expect(f.actions).toHaveLength(1);
  });
  it("does not silently reverse Premiere Undo", async () => {
    const f = fixture(); const binding = await f.adapter.bindActive(); const placement = await f.adapter.capturePlacement(binding);
    await f.adapter.insertConfirmed(note(binding), placement); f.nativeMarkers.splice(0);
    expect(await f.adapter.insertConfirmed(note(binding), placement)).toEqual({ outcome: "undone" });
    expect(f.actions).toHaveLength(1);
  });
  it("never treats an unrequested or forged verified note as an insertion command", async () => {
    const f = fixture(); const binding = await f.adapter.bindActive(); const placement = await f.adapter.capturePlacement(binding);
    const incoming = note(binding); incoming.status = "needs_confirmation"; incoming.request.anchor.verification = "verified";
    await expect(f.adapter.insertConfirmed(incoming, placement)).rejects.toThrow("does not match");
    expect(f.actions).toHaveLength(0);
  });
  it("rejects wrong project and sequence IDs instead of active-target fallback", async () => {
    const f = fixture(); const binding = await f.adapter.bindActive();
    await expect(f.adapter.capturePlacement({ ...binding, projectId: "other" })).rejects.toThrow("original bound project");
    await expect(f.adapter.capturePlacement({ ...binding, sequenceId: "other" })).rejects.toThrow("originally bound sequence");
    expect(f.actions).toHaveLength(0);
  });
  it("requires the bound sequence to be active when capturing a manual position", async () => {
    const f = fixture(); const binding = await f.adapter.bindActive();
    f.project.getActiveSequence.mockResolvedValue({ ...f.sequence, guid: guid("other") } as unknown as Sequence);
    await expect(f.adapter.capturePlacement(binding)).rejects.toThrow("Activate and park");
  });
  it("revalidates Save As while an asynchronous target lookup is pending", async () => {
    const f = fixture(); const binding = await f.adapter.bindActive();
    f.project.getSequence.mockImplementation(() => Promise.resolve().then(() => {
      f.project.path = "/other/Save As.prproj";
      return f.sequence;
    }) as unknown as Sequence);
    await expect(f.adapter.capturePlacement(binding)).rejects.toThrow("Save As");
    expect(f.project.executeTransaction).not.toHaveBeenCalled();
  });
  it("preserves the captured position after a long decision delay and later playhead movement", async () => {
    const f = fixture(); const binding = await f.adapter.bindActive(); const placement = await f.adapter.capturePlacement(binding);
    f.sequence.getPlayerPosition.mockResolvedValue({ ticks: "0" });
    await f.adapter.insertConfirmed(note(binding), placement);
    expect(f.actions[0].ticks).toBe(position);
  });
  it("blocks Save As project mutation, including across asynchronous calls", async () => {
    const f = fixture(); const binding = await f.adapter.bindActive(); const placement = await f.adapter.capturePlacement(binding);
    f.api.Markers.getMarkers.mockImplementation(async () => { f.project.path = "/other/Save As.prproj"; return { getMarkers: () => [] } as unknown as Markers; });
    await expect(f.adapter.insertConfirmed(note(binding), placement)).rejects.toThrow("Save As");
    expect(f.actions).toHaveLength(0);
  });
  it("restores a captured binding after restart only with the exact original project", async () => {
    const f = fixture(); const binding = await f.adapter.bindActive();
    const restarted = new PremiereAdapter(f.api as unknown as AdobeApi, new MarkerLedger(f.storage));
    expect(await restarted.restoreBinding(binding)).toEqual(binding);
    f.project.path = "/other/Commercial.prproj";
    await expect(restarted.restoreBinding(binding)).rejects.toThrow("Save As");
    expect(f.project.executeTransaction).not.toHaveBeenCalled();
  });
  it("does not restore a foreign captured binding by name", async () => {
    const f = fixture(); const binding = await f.adapter.bindActive();
    await expect(f.adapter.restoreBinding({ ...binding, bindingId: "foreign-binding" })).rejects.toThrow("not known");
  });
  it("blocks changed timebase or zero point", async () => {
    const f = fixture(); const binding = await f.adapter.bindActive();
    f.sequence.getTimebase.mockResolvedValue("8467200000");
    await expect(f.adapter.capturePlacement(binding)).rejects.toThrow("timing settings changed");
  });
  it("rejects imprecise or non-frame tick positions", async () => {
    const f = fixture(); const binding = await f.adapter.bindActive();
    f.sequence.getPlayerPosition.mockResolvedValue({ ticks: "9007199254740993" });
    await expect(f.adapter.capturePlacement(binding)).rejects.toThrow("valid sequence-frame");
  });
  it("does not mutate Premiere when the pre-transaction ledger cannot be saved", async () => {
    const f = fixture(); const binding = await f.adapter.bindActive(); const placement = await f.adapter.capturePlacement(binding);
    f.storage.setItem.mockImplementation(() => { throw new Error("Storage full"); });
    await expect(f.adapter.insertConfirmed(note(binding), placement)).rejects.toThrow("Storage full");
    expect(f.actions).toHaveLength(0);
  });
  it("holds an interrupted transaction instead of executing it again", async () => {
    const f = fixture(); const binding = await f.adapter.bindActive(); const placement = await f.adapter.capturePlacement(binding);
    f.project.executeTransaction.mockImplementation(() => { throw new Error("Host interrupted"); });
    await expect(f.adapter.insertConfirmed(note(binding), placement)).rejects.toThrow("Host interrupted");
    expect(await f.adapter.insertConfirmed(note(binding), placement)).toEqual({ outcome: "uncertain" });
    expect(f.project.executeTransaction).toHaveBeenCalledTimes(1);
  });
  it("honors scoped cancellation before entering a Premiere transaction", async () => {
    const f = fixture(); const binding = await f.adapter.bindActive(); const placement = await f.adapter.capturePlacement(binding);
    await expect(f.adapter.insertConfirmed(note(binding), placement, () => { throw new Error("Pairing revoked"); })).rejects.toThrow("revoked");
    expect(f.project.executeTransaction).not.toHaveBeenCalled();
  });
  it("preserves corrupt local ledger data and blocks writes", () => {
    const setItem = vi.fn();
    expect(() => new MarkerLedger({ getItem: () => '{"version":2}', setItem })).toThrow("preserved");
    expect(setItem).not.toHaveBeenCalled();
  });
});
