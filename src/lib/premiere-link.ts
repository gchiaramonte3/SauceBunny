import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { PremiereBridgeSnapshot } from "../bindings/PremiereBridgeSnapshot";
import type { PremiereMarkerRecord } from "../bindings/PremiereMarkerRecord";
import type { PremiereBinding } from "../bindings/PremiereBinding";
import type { ReviewDoc } from "./review";
import { persistedReviews, subscribePersistedReviews } from "./review-store";
import { premiereRequests, samePremiereBinding, type PremiereContext } from "./premiere-notes";
import { formatError } from "./error-format";
import { PREMIERE_ROOM_MARKERS_ENABLED } from "./premiere-permissions";

type VisibleInput = { sourceId: string; streamId: string; name: string };
type Association = { sourceId: string; streamId: string; binding: PremiereBinding };
type Snapshot = {
  bridge: PremiereBridgeSnapshot | null; visible: VisibleInput | null;
  association: Association | null; remote: PremiereContext | null;
  records: readonly PremiereMarkerRecord[]; error: string | null;
};
let value: Snapshot = { bridge: null, visible: null, association: null, remote: null, records: [], error: null };
const listeners = new Set<() => void>();
// Do not assume solo before native session_state has returned (webview reload
// can reattach to a running guest room).
let role = "unknown", sessionId = "", active = 0;
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
  scannedBinding = null;
  update({ remote: null });
}
export function acceptPremiereContext(context: PremiereContext, from: string): void {
  if (role !== "peer" || from !== "m0" || context.sessionId !== sessionId) return;
  update({ remote: context });
}
export function premiereBindingForSource(sourceId: string): PremiereBinding | null {
  if (role === "unknown") return null;
  if (role !== "off" && !PREMIERE_ROOM_MARKERS_ENABLED) return null;
  if (role === "peer") return value.remote?.sourceId === sourceId ? value.remote.binding : null;
  return value.association?.sourceId === sourceId && value.bridge?.phase === "connected"
    && value.bridge.syncEnabled && samePremiereBinding(value.association.binding, value.bridge.binding)
    ? value.association.binding : null;
}
export function premiereRoomContext(reviewKey: string, sourceId: string, roomId: string): PremiereContext {
  return { t: "premiere-context", protocol: 1, sessionId: roomId, reviewKey, sourceId,
    binding: premiereBindingForSource(sourceId) };
}

async function queueSavedDoc(doc: ReviewDoc): Promise<void> {
  const bound = value.bridge?.binding;
  if (!["off", "host"].includes(role) || !bound || value.bridge?.phase !== "connected") return;
  retryDocs.delete(doc.sourceKey);
  for (const request of premiereRequests(doc)) {
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
