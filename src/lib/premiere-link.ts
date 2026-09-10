import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { PremiereBridgeSnapshot } from "../bindings/PremiereBridgeSnapshot";
import type { PremiereMarkerRecord } from "../bindings/PremiereMarkerRecord";
import type { PremiereBinding } from "../bindings/PremiereBinding";
import type { ReviewDoc } from "./review";
import { persistedReviews, subscribePersistedReviews } from "./review-store";
import { copyPremiereAnchor, copyPremiereBinding, isPremiereContext, isPremiereReceipts, premiereRequests, samePremiereBinding,
  type PremiereContext, type PremiereReceipt, type PremiereReceipts } from "./premiere-notes";
import type { ReviewEnvelope } from "./review-delivery";
import { formatError } from "./error-format";
import { PREMIERE_ROOM_MARKERS_ENABLED } from "./premiere-permissions";

type VisibleInput = { sourceId: string; streamId: string; name: string };
type Association = { sourceId: string; streamId: string; binding: PremiereBinding };
type RoomSource = { reviewKey: string; programId: string; presenterEpoch: number };
type Snapshot = {
  bridge: PremiereBridgeSnapshot | null; visible: VisibleInput | null;
  association: Association | null; remote: PremiereContext | null;
  records: readonly PremiereMarkerRecord[]; error: string | null;
  receipts: readonly PremiereReceipt[];
};
let value: Snapshot = { bridge: null, visible: null, association: null, remote: null, records: [], receipts: [], error: null };
const listeners = new Set<() => void>();
// Do not assume solo before native session_state has returned (webview reload
// can reattach to a running guest room).
let role = "unknown", sessionId = "", active = 0;
let roomSource: RoomSource | null = null;
let contextKey = "", contextRevision = 0, receiptRevision = -1;
let refreshGeneration = 0;
let loadedLedgerKey: string | null = null, scannedBinding: string | null = null;
const retryDocs = new Map<string, ReviewDoc>();
const delivered = new Set<string>(), inflight = new Set<string>();
export const getPremiereLink = (): Snapshot => value;
export function subscribePremiereLink(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
function update(patch: Partial<Snapshot>) {
  value = { ...value, ...patch }; listeners.forEach(listener => listener());
}
export function setPremiereVisibleInput(input: VisibleInput | null): void {
  if (input?.sourceId === value.visible?.sourceId && input?.streamId === value.visible?.streamId) return;
  update({ visible: input, association: input?.sourceId === value.association?.sourceId
    && input?.streamId === value.association?.streamId ? value.association : null });
}
export function associatePremiereInput(): void {
  if (!value.visible || !value.bridge?.binding || value.bridge.phase !== "connected" || !["off", "host"].includes(role)) {
    throw new Error("Connect and bind the editor’s Premiere companion, then open a live Premiere input first.");
  }
  update({ association: { sourceId: value.visible.sourceId, streamId: value.visible.streamId, binding: { ...value.bridge.binding } } });
}
export function setPremiereRoom(nextRole: string, nextSession: string): void {
  if (role === nextRole && sessionId === nextSession) return;
  role = nextRole; sessionId = nextSession;
  roomSource = null;
  scannedBinding = null;
  receiptRevision = -1;
  update({ remote: null, receipts: [] });
}
/** Native room/source events own this scope, never a peer's context packet. */
export function setPremiereRoomSource(source: RoomSource | null): void {
  if (source?.reviewKey === roomSource?.reviewKey && source?.programId === roomSource?.programId
    && source?.presenterEpoch === roomSource?.presenterEpoch) return;
  roomSource = source ? { ...source } : null;
  receiptRevision = -1;
  update({ remote: null, receipts: [] });
}
export function acceptPremiereContext(context: unknown, from: string): void {
  if (!PREMIERE_ROOM_MARKERS_ENABLED || role !== "peer" || from !== "m0" || !isPremiereContext(context)
    || context.sessionId !== sessionId || !roomSource || context.reviewKey !== roomSource.reviewKey
    || context.sourceId !== roomSource.reviewKey || context.programId !== roomSource.programId
    || context.presenterEpoch !== roomSource.presenterEpoch
    || (value.remote && context.revision < value.remote.revision)) return;
  const changed = value.remote?.revision !== context.revision;
  if (changed) receiptRevision = -1;
  update({ remote: { t: "premiere-context", protocol: 1, sessionId, ...roomSource,
    sourceId: context.sourceId, revision: context.revision,
    binding: context.binding ? copyPremiereBinding(context.binding) : null },
    ...(changed ? { receipts: [] } : {}) });
}
export function premiereBindingForSource(sourceId: string): PremiereBinding | null {
  if (role === "unknown") return null;
  if (role !== "off" && !PREMIERE_ROOM_MARKERS_ENABLED) return null;
  if (role === "peer") return value.remote?.sourceId === sourceId
    && value.visible?.sourceId === sourceId && value.visible.streamId === value.remote.programId ? value.remote.binding : null;
  return value.association?.sourceId === sourceId && value.bridge?.phase === "connected"
    && value.bridge.syncEnabled && samePremiereBinding(value.association.binding, value.bridge.binding)
    ? value.association.binding : null;
}
export function premiereRoomContext(reviewKey: string, programId: string, presenterEpoch: number): PremiereContext {
  const binding = role === "host" && roomSource?.reviewKey === reviewKey && roomSource.programId === programId
    && roomSource.presenterEpoch === presenterEpoch && value.association?.streamId === programId
    ? premiereBindingForSource(reviewKey) : null;
  const key = JSON.stringify([sessionId, reviewKey, programId, presenterEpoch, binding]);
  if (key !== contextKey) { contextKey = key; contextRevision++; }
  return { t: "premiere-context", protocol: 1, sessionId, reviewKey, sourceId: reviewKey, programId, presenterEpoch,
    revision: contextRevision, binding: binding ? copyPremiereBinding(binding) : null };
}
export function currentPremiereRoomContext(): PremiereContext | null {
  if (!PREMIERE_ROOM_MARKERS_ENABLED || !roomSource || role !== "host") return null;
  return premiereRoomContext(roomSource.reviewKey, roomSource.programId, roomSource.presenterEpoch);
}
/** Scope a new intent; retries keep the ORIGINAL scope instead of silently
 * targeting a replacement sequence, room, or publication. */
export function scopePremiereEnvelope(envelope: ReviewEnvelope): ReviewEnvelope {
  if (envelope.op.t !== "add" || !envelope.op.comment.premiere) return envelope;
  const context = role === "host" ? currentPremiereRoomContext() : value.remote;
  if (!PREMIERE_ROOM_MARKERS_ENABLED || !context?.binding || context.reviewKey !== envelope.reviewKey
    || context.sessionId !== envelope.sessionId
    || !samePremiereBinding(context.binding, envelope.op.comment.premiere.binding))
    throw new Error("The Premiere target changed. Reopen the room picture and choose Send this note to Premiere again. Your draft is kept.");
  const { programId, presenterEpoch, revision } = context;
  return { ...envelope, premiereContext: { programId, presenterEpoch, revision } };
}
/** Host-only gate, called at the head of the durable review commit queue. */
export function authorizePremiereEnvelope(envelope: ReviewEnvelope): ReviewEnvelope {
  if (envelope.op.t !== "add" || !envelope.op.comment.premiere) return envelope;
  const context = currentPremiereRoomContext(), scope = envelope.premiereContext;
  const anchor = envelope.op.comment.premiere;
  if (!context?.binding || !scope || context.sessionId !== envelope.sessionId
    || context.reviewKey !== envelope.reviewKey || anchor.sourceId !== context.sourceId
    || scope.programId !== context.programId || scope.presenterEpoch !== context.presenterEpoch || scope.revision !== context.revision
    || !samePremiereBinding(anchor.binding, context.binding)
    || (anchor.streamId != null && anchor.streamId !== context.programId))
    throw new Error("Premiere note not queued: the room or selected sequence changed. The saved draft has not been retargeted.");
  // A guest's claimed ticks or verification can NEVER grant placement. Only
  // the local editor captures and confirms a timeline position in Premiere.
  const safe = copyPremiereAnchor(anchor);
  safe.binding = copyPremiereBinding(context.binding);
  safe.verification = "unverified"; safe.sequenceTicks = undefined;
  safe.reason = "Room note received; editor confirmation of its sequence position is required.";
  return { ...envelope, premiereContext: { programId: scope.programId, presenterEpoch: scope.presenterEpoch, revision: scope.revision },
    op: { ...envelope.op, comment: { ...envelope.op.comment, premiere: safe } } };
}
/** Only IDs/statuses for notes actually in the current shared review. Never
 * send native errors, marker GUIDs, other projects, pairing data, or paths. */
export function premiereRoomReceipts(doc: ReviewDoc): PremiereReceipts[] {
  const context = currentPremiereRoomContext();
  if (!context?.binding || doc.sourceKey !== context.reviewKey || doc.sync?.sessionId !== sessionId) return [];
  const items = value.records.flatMap(record => {
    const request = record.request;
    return request.reviewKey === context.reviewKey
      && samePremiereBinding(request.anchor.binding, context.binding)
      && doc.comments.some(c => c.id === request.commentId && c.versionId === request.versionId && c.premiere)
      ? [{ commentId: request.commentId, versionId: request.versionId, bindingId: context.binding!.bindingId, status: record.status }] : [];
  });
  const batches: PremiereReceipts[] = [];
  for (let offset = 0; offset < items.length; offset += 100) batches.push({ t: "premiere-receipts", protocol: 1,
    sessionId, reviewKey: context.reviewKey, programId: context.programId, presenterEpoch: context.presenterEpoch,
    revision: context.revision, ledgerRevision: value.bridge?.ledgerRevision ?? 0, items: items.slice(offset, offset + 100) });
  return batches;
}
export function acceptPremiereReceipts(message: unknown, from: string, doc: ReviewDoc | null): void {
  const context = value.remote;
  if (!PREMIERE_ROOM_MARKERS_ENABLED || role !== "peer" || from !== "m0" || !isPremiereReceipts(message)
    || !context?.binding || !doc || message.sessionId !== sessionId || message.reviewKey !== context.reviewKey
    || doc.sourceKey !== context.reviewKey || message.programId !== context.programId
    || message.presenterEpoch !== context.presenterEpoch || message.revision !== context.revision
    || message.ledgerRevision < receiptRevision) return;
  receiptRevision = message.ledgerRevision;
  const accepted = message.items.filter(r => r.bindingId === context.binding!.bindingId
    && doc.comments.some(c => c.id === r.commentId && c.versionId === r.versionId
      && samePremiereBinding(c.premiere?.binding ?? null, context.binding)));
  const receipts = new Map(value.receipts.map(r => [JSON.stringify([r.versionId, r.commentId]), r]));
  for (const { commentId, versionId, bindingId, status } of accepted)
    receipts.set(JSON.stringify([versionId, commentId]), { commentId, versionId, bindingId, status });
  update({ receipts: [...receipts.values()] });
}

async function queueSavedDoc(doc: ReviewDoc): Promise<void> {
  const bound = value.bridge?.binding;
  if (!["off", "host"].includes(role) || !bound || value.bridge?.phase !== "connected") return;
  retryDocs.delete(doc.sourceKey);
  for (const request of premiereRequests(doc)) {
    // Optimistic UI writes and received snapshots are not host acceptance.
    // The canonical add must have survived the completed durable commit.
    const comment = doc.comments.find(c => c.id === request.commentId);
    if (role === "host" || comment?.sessionId) {
      const committed = Object.values(doc.sync?.commits ?? {}).some(c => c.op.t === "add"
        && c.op.comment.id === request.commentId && c.op.comment.versionId === request.versionId
        && c.op.comment.sessionId === request.sessionId && c.op.comment.premiere
        && JSON.stringify(copyPremiereAnchor(c.op.comment.premiere)) === JSON.stringify(request.anchor));
      if (!committed) continue;
    }
    if (!["off", "host"].includes(role) || value.bridge?.phase !== "connected"
      || !samePremiereBinding(bound, value.bridge.binding)) return;
    // Only this editing project's notes enter this installation's queue.
    // The original bindingId remains unchanged even across a later re-bind.
    if (request.anchor.binding.projectId !== bound.projectId || request.anchor.binding.sequenceId !== bound.sequenceId) continue;
    const key = JSON.stringify([request.reviewKey, request.versionId, request.commentId]);
    if (delivered.has(key) || inflight.has(key)) continue;
    inflight.add(key);
    try {
      const result = await invoke<PremiereMarkerRecord>("premiere_enqueue_note", { request });
      if (!result?.id) throw new Error("Premiere marker queue did not acknowledge storage.");
      delivered.add(key);
      update({ records: [...value.records.filter(record => record.id !== result.id), result], error: null });
    } catch (cause) {
      retryDocs.set(doc.sourceKey, doc);
      update({ error: `Note saved in Sauce Bunny; waiting for the Premiere queue. ${formatError(cause)}` });
    }
    finally { inflight.delete(key); }
  }
}
export async function refreshPremiereLink(): Promise<void> {
  const turn = ++refreshGeneration;
  const bridge = await invoke<PremiereBridgeSnapshot>("premiere_bridge_status");
  if (turn !== refreshGeneration || !bridge || !["off", "pairing", "connected"].includes(bridge.phase)) return;
  const association = value.association && samePremiereBinding(value.association.binding, bridge.binding)
    ? value.association : null;
  if (JSON.stringify(value.bridge) !== JSON.stringify(bridge) || association !== value.association)
    update({ bridge, association });
  if (bridge.phase === "connected") {
    const key = `${bridge.binding?.bindingId ?? "none"}:${bridge.ledgerRevision}`;
    if (loadedLedgerKey !== key) {
      const records = await invoke<PremiereMarkerRecord[]>("premiere_marker_notes");
      if (turn !== refreshGeneration) return;
      if (Array.isArray(records)) {
        for (const record of records) delivered.add(JSON.stringify([record.request.reviewKey, record.request.versionId, record.request.commentId]));
        loadedLedgerKey = key;
        update({ records });
      }
    }
    const bindingKey = bridge.binding?.bindingId ?? null;
    if (bindingKey && scannedBinding !== bindingKey) {
      scannedBinding = bindingKey;
      for (const doc of persistedReviews()) void queueSavedDoc(doc);
    } else for (const doc of retryDocs.values()) void queueSavedDoc(doc);
  } else { loadedLedgerKey = null; scannedBinding = null; }
}

/** Mount once in App, not Settings or the player. This reads status only;
 * opening Sauce Bunny never starts a server, capture, pairing, or room. */
export function observePremiereLink(): () => void {
  if (++active !== 1) return () => { active--; };
  let disposed = false, reading = false;
  const refresh = () => {
    if (disposed || reading) return;
    reading = true;
    void refreshPremiereLink().catch(cause => {
      if (!disposed) update({ error: formatError(cause) });
    }).finally(() => { reading = false; });
  };
  const offSaved = subscribePersistedReviews(doc => { void queueSavedDoc(doc); });
  const onPremiereBridgeChanged = refresh;
  const offNative = listen("premiere-bridge-changed", onPremiereBridgeChanged);
  refresh();
  const timer = window.setInterval(refresh, 5000);
  return () => {
    active--; disposed = true; offSaved(); window.clearInterval(timer);
    void offNative.then(off => off()).catch(() => {});
  };
}
