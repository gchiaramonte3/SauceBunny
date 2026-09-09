import { BridgeClient } from "./bridge-client";
import { PremiereAdapter, type Placement } from "./premiere";
import { sameBinding, type BridgeStatus, type MarkerNote, type NotePage } from "./protocol";

export type CompanionSnapshot = { connected: boolean; status: BridgeStatus | null; notes: MarkerNote[]; message: string; page: NotePage };

export class Companion {
  private listeners = new Set<(snapshot: CompanionSnapshot) => void>();
  private value: CompanionSnapshot = { connected: false, status: null, notes: [], message: "Not paired.", page: { offset: 0, total: 0, hasMore: false } };
  private writing = false;
  private generation = 0;
  constructor(private client: BridgeClient, private premiere: PremiereAdapter) {
    client.onSnapshot = reply => {
      this.value = { ...this.value, connected: reply.status.phase === "connected", status: reply.status, notes: reply.notes, page: reply.page };
      this.publish();
    };
    client.onDisconnect = message => {
      this.generation++;
      this.value = { ...this.value, connected: false, status: null, message };
      this.publish();
    };
  }
  snapshot() { return this.value; }
  subscribe(listener: (snapshot: CompanionSnapshot) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private publish() { for (const listener of this.listeners) listener(this.value); }
  async pair(url: string, token: string) { await this.client.pair(url, token); }
  disconnect() { this.client.disconnect(); }
  async bind() { const binding = await this.premiere.bindActive(); await this.client.request({ type: "bind", binding }); }
  async restore(note: MarkerNote) {
    const binding = await this.premiere.restoreBinding(note.request.anchor.binding);
    await this.client.request({ type: "bind", binding });
  }
  async page(offset: number) { await this.client.request({ type: "poll", offset: Math.max(0, offset) }); }
  async setSync(enabled: boolean) { await this.client.request({ type: "setSync", enabled }); }
  private requireNote(note: MarkerNote) {
    if (!this.value.connected || !this.value.status?.syncEnabled || !sameBinding(this.value.status.binding, note.request.anchor.binding)) {
      throw new Error("Bind the note's original sequence and enable marker sync first.");
    }
  }
  async prepare(note: MarkerNote) {
    this.requireNote(note);
    return this.premiere.capturePlacement(note.request.anchor.binding);
  }
  async reconcile(note: MarkerNote) {
    this.requireNote(note);
    const result = await this.premiere.reconcile(note);
    await this.client.request({ type: "reconcile", noteId: note.id, binding: note.request.anchor.binding,
      outcome: result.outcome === "uncertain" ? "absent" : result.outcome,
      ...(result.outcome === "found" ? { markerGuid: result.markerGuid } : {}) });
    if (result.outcome === "uncertain") throw new Error("A previous transaction is uncertain. It will not be repeated automatically. Inspect the sequence and preserve Undo.");
    return result;
  }
  async confirm(note: MarkerNote, placement: Placement) {
    this.requireNote(note);
    if (this.writing) throw new Error("Finish the current marker operation first.");
    this.writing = true;
    const generation = this.generation;
    const requireCurrent = () => {
      if (generation !== this.generation) throw new Error("The connection changed. No new marker operation will start.");
      this.requireNote(note);
    };
    try {
      const prior = await this.premiere.reconcile(note);
      requireCurrent();
      if (prior.outcome !== "absent") { await this.reconcile(note); return; }
      const reply = await this.client.request({ type: "confirm", noteId: note.id, binding: placement.binding,
        sequenceTicks: placement.sequenceTicks, retryConfirmed: note.status === "uncertain" });
      if (reply.type !== "insert" || reply.note.id !== note.id) throw new Error("The marker confirmation did not match this note.");
      requireCurrent();
      const result = await this.premiere.insertConfirmed(reply.note, placement, requireCurrent);
      if (result.outcome === "found") {
        await this.client.request({ type: "ack", noteId: note.id, binding: placement.binding, markerGuid: result.markerGuid });
      } else {
        await this.client.request({ type: "reconcile", noteId: note.id, binding: placement.binding,
          outcome: result.outcome === "undone" ? "undone" : "absent" });
        throw new Error("The transaction needs checking. No automatic retry will run.");
      }
    } finally { this.writing = false; }
  }
}
