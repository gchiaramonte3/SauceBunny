import type { NdiStarted } from "../bindings/NdiStarted";
import type { NdiStatusResult } from "../bindings/NdiStatusResult";
import type { NdiRoomState } from "../bindings/NdiRoomState";
import type { NdiSessionsResult } from "../bindings/NdiSessionsResult";
import type { NdiRoomProgram } from "../bindings/NdiRoomProgram";
import type { NdiTelemetry } from "../bindings/NdiTelemetry";
import { formatError } from "./error-format";

export const emptyNdiTelemetry = (): NdiTelemetry => ({
  sourceId: "", phase: "off", error: null, inputWidth: 0, inputHeight: 0,
  outputFps: 0, inputFps: null, connectionCount: null, receivedFrames: 0,
  ndiDroppedFrames: 0, encoderDroppedFrames: 0, encoderDroppedAudioSamples: 0,
  leftPeak: 0, rightPeak: 0, lastInputAgeMs: 0, encodedBitrateKbps: null,
});

/** A capture id changes when a receiver restarts. A review/pass id does not. */
export type NdiLocalProgram = NdiStarted & {
  reviewKey: string;
  telemetry: NdiTelemetry;
  encodedReady: boolean;
  decodedReady: boolean;
  retired: boolean;
  roomGeneration: number | null;
};
export type NdiPublicationLease = {
  id: string; generation: number; epoch: number; revision: number;
};
export type NdiProgramSnapshot = {
  candidate: NdiLocalProgram | null;
  published: NdiLocalProgram | null;
  lease: NdiPublicationLease | null;
  /** Retained on stop: never fall through to a hidden file's review/clock. */
  roomSource: NdiRoomProgram | null;
  room: NdiRoomState | null;
  busy: "starting" | "publishing" | "stopping" | null;
  error: string | null;
};
export type NdiProgramPorts = {
  start(name: string): Promise<NdiStarted>;
  status(id: string): Promise<NdiStatusResult>;
  stop(id: string): Promise<void>;
  publish(source: NdiLocalProgram, room: NdiRoomState): Promise<number>;
  unpublish(lease: NdiPublicationLease): Promise<void>;
  /** Persisted separately from the native capture so reconnect keeps notes. */
  reviewKey(name: string): string;
};

const roomIdentity = (room: NdiRoomState | null) => room
  ? `${room.generation}:${room.presenterEpoch}:${room.presenting}` : "off";
export function canPublishNdi(snapshot: NdiProgramSnapshot): boolean {
  const p = snapshot.candidate;
  return !!(p && !p.retired && snapshot.room?.presenting && !snapshot.busy && p.decodedReady && p.encodedReady
    && p.telemetry.phase !== "error" && p.telemetry.phase !== "off" && p.telemetry.connectionCount !== 0);
}

/**
 * App-level intent boundary, with no video, microphone, file player or room
 * document handles. Only publish can change publication. All native mutations
 * are serialized so an obsolete start drains before a replacement is admitted.
 * The native boundary independently enforces capacity/ownership/revocation.
 */
export class NdiProgramCoordinator {
  private value: NdiProgramSnapshot = {
    candidate: null, published: null, lease: null, roomSource: null,
    room: null, busy: null, error: null,
  };
  private listeners = new Set<() => void>();
  private serial: Promise<unknown> = Promise.resolve();
  private intent = 0;
  private disposed = false;
  private statusReads = new Map<string, symbol>();
  constructor(private ports: NdiProgramPorts) {}
  getSnapshot = (): NdiProgramSnapshot => this.value;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  };
  private update(patch: Partial<NdiProgramSnapshot>) {
    if (this.disposed) return;
    this.value = { ...this.value, ...patch };
    for (const listener of this.listeners) listener();
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.serial.then(work);
    this.serial = result.catch(() => {});
    return result;
  }
  private valid(turn: number) { return !this.disposed && turn === this.intent; }
  private ensureMutable() {
    if (this.disposed) throw new Error("Premiere connection is closed");
    if (this.value.busy === "publishing" || this.value.busy === "stopping") {
      throw new Error("Wait for the current sharing change to finish");
    }
  }
  private local(started: NdiStarted, room: number | null): NdiLocalProgram {
    return { ...started, reviewKey: this.ports.reviewKey(started.name), roomGeneration: room,
      telemetry: { ...emptyNdiTelemetry(), sourceId: started.id, phase: "connecting" },
      encodedReady: false, decodedReady: false, retired: false };
  }
  private patchProgram(id: string, patch: Partial<NdiLocalProgram>) {
    const next: Partial<NdiProgramSnapshot> = {};
    if (this.value.candidate?.id === id) next.candidate = { ...this.value.candidate, ...patch };
    if (this.value.published?.id === id) next.published = { ...this.value.published, ...patch };
    if (Object.keys(next).length) this.update(next);
  }
  setRoom(room: NdiRoomState | null) {
    const changed = roomIdentity(room) !== roomIdentity(this.value.room);
    if (!changed) { this.update({ room }); return; }
    ++this.intent;
    // Native room teardown owns room-bound receiver cleanup. An unrelated
    // standalone preview survives entering/leaving a room without sharing.
    const candidate = this.value.candidate;
    const keep = candidate?.roomGeneration == null ? candidate :
      (candidate.roomGeneration === room?.generation && room?.presenting ? candidate : null);
    this.update({ room, candidate: keep, published: null, lease: null,
      roomSource: null, busy: null, error: null });
    // This method consumes native room truth, never initiates a room change.
    // Native teardown has already revoked the old lease. An in-flight publish
    // still checks its intent on return and revokes that exact late result.
  }
  /** Reattach only to sessions already opened by this app, never discovery. */
  restore(native: NdiSessionsResult) {
    if (this.disposed) return;
    this.setRoom(native.room);
    if (this.value.busy) return;
    const sources = native.programs.flatMap(status => status.program ? [{
      ...this.local(status.program, status.roomGeneration), telemetry: status.telemetry,
      ...(native.room?.source?.id === status.program.id ? { reviewKey: native.room.source.reviewKey } : {}),
      encodedReady: status.encodedReady,
      decodedReady: this.value.candidate?.id === status.program.id ? this.value.candidate.decodedReady
        : this.value.published?.id === status.program.id ? this.value.published.decodedReady : false,
    }] : []);
    const published = sources.find(p => p.id === native.room?.publishedId) ?? null;
    const candidates = sources.filter(p => p.id !== published?.id);
    const candidate = candidates.find(p => p.id === this.value.candidate?.id)
      ?? (candidates.length === 1 ? candidates[0] : null);
    const lease = published && native.room?.publicationRevision != null ? {
      id: published.id, generation: native.room.generation, epoch: native.room.presenterEpoch,
      revision: native.room.publicationRevision,
    } : null;
    this.update({ candidate, published, lease, roomSource: native.room?.source ?? (published ? {
      id: published.id, name: published.name, reviewKey: published.reviewKey, state: "live",
    } : this.value.roomSource) });
  }
  preview(name: string): Promise<void> {
    this.ensureMutable();
    if (!name.trim()) return Promise.reject(new Error("Choose a Premiere source"));
    const turn = ++this.intent;
    this.update({ busy: "starting", error: null });
    return this.enqueue(async () => {
      if (!this.valid(turn)) return;
      const old = this.value.candidate;
      try {
        if (old?.name === name && !old.retired && old.telemetry.phase !== "error") return;
        if (old && old.id !== this.value.published?.id) {
          await this.ports.stop(old.id);
          if (!this.valid(turn)) return;
          // Keep the old decoded video mounted across native startup. Retiring
          // it removes publication readiness, not the last visible picture.
          this.patchProgram(old.id, { retired: true, encodedReady: false });
        }
        if (this.value.published?.name === name) { this.update({ candidate: null }); return; }
        const roomAtStart = this.value.room?.generation ?? null;
        const started = await this.ports.start(name);
        if (!this.valid(turn)) { await this.ports.stop(started.id); return; }
        this.update({ candidate: this.local(started, roomAtStart) });
        await this.refreshStatus(started.id);
      } catch (cause) {
        if (this.valid(turn)) this.update({ error: formatError(cause) });
        throw cause;
      } finally { if (this.valid(turn)) this.update({ busy: null }); }
    });
  }
  async refreshStatus(id: string): Promise<void> {
    const read = Symbol(id); this.statusReads.set(id, read);
    try {
      const status = await this.ports.status(id);
      if (this.disposed || status.program?.id !== id || this.statusReads.get(id) !== read) return;
      this.patchProgram(id, { telemetry: status.telemetry, encodedReady: status.encodedReady,
        roomGeneration: status.roomGeneration });
    } finally { if (this.statusReads.get(id) === read) this.statusReads.delete(id); }
  }
  telemetry(state: NdiTelemetry) {
    // An event emitted after a snapshot began wins over that older snapshot.
    // In particular a late 'ready' reply cannot erase an encoder failure.
    this.statusReads.delete(state.sourceId);
    this.patchProgram(state.sourceId, { telemetry: state,
      ...(state.phase === "error" || state.phase === "off" ? { encodedReady: false } : {}) });
  }
  /** The decoded picture and native independent-segment readiness are distinct. */
  frameDecoded(id: string) {
    this.patchProgram(id, { decodedReady: true });
  }
  pictureFailed(id: string) { this.patchProgram(id, { decodedReady: false }); }
  publish(): Promise<void> {
    if (!canPublishNdi(this.value)) return Promise.reject(new Error("Wait for a decoded preview picture before sharing"));
    const source = this.value.candidate!, room = this.value.room!, turn = ++this.intent;
    this.update({ busy: "publishing", error: null });
    return this.enqueue(async () => {
      // Callers stop the old share and close setup only after this resolves.
      // An obsolete intent must not masquerade as a committed publication.
      if (!this.valid(turn)) throw new Error("The review session changed before sharing finished.");
      try {
        const revision = await this.ports.publish(source, room);
        const lease = { id: source.id, generation: room.generation, epoch: room.presenterEpoch, revision };
        if (!this.valid(turn) || roomIdentity(room) !== roomIdentity(this.value.room)) {
          await this.ports.unpublish(lease);
          throw new Error("The review session changed before sharing finished.");
        }
        const old = this.value.published;
        const current = this.value.candidate?.id === source.id ? this.value.candidate : source;
        this.update({ published: { ...current, roomGeneration: room.generation }, candidate: null, lease,
          roomSource: { id: source.id, name: source.name, reviewKey: source.reviewKey, state: "live" } });
        if (old && old.id !== source.id) await this.ports.stop(old.id);
        if (!this.valid(turn)) throw new Error("The review session changed before sharing finished.");
      } catch (cause) {
        if (this.valid(turn)) this.update({ error: formatError(cause) });
        throw cause;
      } finally { if (this.valid(turn)) this.update({ busy: null }); }
    });
  }
  cancelPreview(): Promise<void> {
    this.ensureMutable();
    const turn = ++this.intent;
    this.update({ busy: "stopping", error: null });
    return this.enqueue(async () => {
      if (!this.valid(turn)) return;
      try {
        const candidate = this.value.candidate;
        if (candidate && candidate.id !== this.value.published?.id) await this.ports.stop(candidate.id);
        if (this.valid(turn)) this.update({ candidate: null });
      } catch (cause) {
        if (this.valid(turn)) this.update({ error: formatError(cause) });
        throw cause;
      } finally { if (this.valid(turn)) this.update({ busy: null }); }
    });
  }
  stopSharing(): Promise<void> {
    this.ensureMutable();
    const lease = this.value.lease;
    if (!lease) return Promise.resolve();
    const turn = ++this.intent;
    this.update({ busy: "stopping", error: null });
    return this.enqueue(async () => {
      if (!this.valid(turn)) return;
      try {
        await this.ports.unpublish(lease);
        if (!this.valid(turn)) return;
        const previous = this.value.published;
        const candidate = this.value.candidate ?? previous;
        this.update({ lease: null, published: null, candidate,
          roomSource: this.value.roomSource ? { ...this.value.roomSource, state: "stopped" } : null });
        if (previous && previous.id !== candidate?.id) await this.ports.stop(previous.id);
      } catch (cause) {
        if (this.valid(turn)) this.update({ error: formatError(cause) });
        throw cause;
      } finally { if (this.valid(turn)) this.update({ busy: null }); }
    });
  }
  /** Only an explicit switch back to file/web playback may clear this latch. */
  clearStoppedRoomSource() {
    if (this.value.lease || this.value.published) throw new Error("Stop sharing Premiere first");
    this.update({ roomSource: null });
  }
  /** App unload only. Closing the connection panel must not call this. */
  dispose(): Promise<void> {
    this.disposed = true; ++this.intent; this.listeners.clear(); this.statusReads.clear();
    const { candidate, published, lease } = this.value;
    return this.enqueue(async () => {
      if (lease) await this.ports.unpublish(lease);
      for (const id of new Set([candidate?.id, published?.id])) if (id) await this.ports.stop(id);
    });
  }
}
