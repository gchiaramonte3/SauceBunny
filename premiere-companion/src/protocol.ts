import type { PremiereBinding } from "../../src/bindings/PremiereBinding";
import type { PremiereBridgeSnapshot } from "../../src/bindings/PremiereBridgeSnapshot";
import type { PremiereMarkerRecord } from "../../src/bindings/PremiereMarkerRecord";
import { isPremiereBinding as isBinding } from "../../src/lib/premiere-binding";

export type Binding = PremiereBinding;
export type MarkerNote = PremiereMarkerRecord;
export type BridgeStatus = PremiereBridgeSnapshot;
export type NotePage = { offset: number; total: number; hasMore: boolean };
export type Reply =
  | { v: 1; id: string; type: "snapshot"; status: BridgeStatus; notes: MarkerNote[]; page: NotePage }
  | { v: 1; id: string; type: "insert"; note: MarkerNote }
  | { v: 1; id: string; type: "error"; error: string };
export type Command =
  | { type: "hello"; token: string }
  | { type: "bind"; binding: Binding }
  | { type: "setSync"; enabled: boolean }
  | { type: "poll" | "ping"; offset?: number }
  | { type: "confirm"; noteId: string; binding: Binding; sequenceTicks: string; retryConfirmed: boolean }
  | { type: "ack"; noteId: string; binding: Binding; markerGuid: string }
  | { type: "reconcile"; noteId: string; binding: Binding; outcome: "found" | "absent" | "undone"; markerGuid?: string };

export function validateEndpoint(value: string): string {
  // No hostnames, credentials, redirects or external endpoints. The pairing
  // token goes in the authenticated message, never the URL or a log.
  if (!/^ws:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/premiere$/.test(value)) {
    throw new Error("Paste the local pairing address from Sauce Bunny Settings.");
  }
  const port = Number(value.split(":")[2].split("/")[0]);
  if (port > 65535) throw new Error("The local pairing port is invalid.");
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNote(value: unknown): value is MarkerNote {
  if (!isRecord(value) || typeof value.id !== "string" || !/^[a-f0-9]{64}$/.test(value.id)
    || !["needs_confirmation", "dispatching", "uncertain", "added", "removed_in_premiere"].includes(String(value.status))
    || !(value.sequenceTicks === null || typeof value.sequenceTicks === "string")
    || !(value.markerGuid === null || typeof value.markerGuid === "string")
    || !(value.error === null || typeof value.error === "string") || !isRecord(value.request)) return false;
  const request = value.request;
  return ["reviewKey", "versionId", "commentId", "author", "body"].every(key => typeof request[key] === "string")
    && (request.sessionId === null || typeof request.sessionId === "string") && isRecord(request.anchor)
    && isBinding(request.anchor.binding) && typeof request.anchor.sourceId === "string"
    && typeof request.anchor.capturedAt === "number"
    && ["verified", "unverified"].includes(String(request.anchor.verification));
}
export function parseReply(data: unknown): Reply {
  if (typeof data !== "string" || data.length > 4 * 1024 * 1024) throw new Error("Invalid companion response.");
  const value: unknown = JSON.parse(data);
  if (!isRecord(value) || value.v !== 1 || typeof value.id !== "string") throw new Error("Unsupported companion protocol.");
  if (value.type === "error" && typeof value.error === "string") return value as Reply;
  if (value.type === "insert" && isNote(value.note)) return value as Reply;
  if (value.type === "snapshot" && isRecord(value.status) && Array.isArray(value.notes)
    && value.notes.length <= 120 && value.notes.every(isNote)
    && ["off", "pairing", "connected"].includes(String(value.status.phase))
    && (value.status.binding === null || isBinding(value.status.binding))
    && typeof value.status.syncEnabled === "boolean" && value.status.automaticPlacement === false
    && Number.isSafeInteger(value.status.pendingCount) && Number.isSafeInteger(value.status.otherBindingPendingCount)
    && Number.isSafeInteger(value.status.ledgerRevision) && isRecord(value.page)
    && Number.isSafeInteger(value.page.offset) && Number.isSafeInteger(value.page.total) && typeof value.page.hasMore === "boolean"
    && (value.status.error === null || typeof value.status.error === "string")) return value as Reply;
  throw new Error("Companion response failed validation. No marker was changed.");
}
