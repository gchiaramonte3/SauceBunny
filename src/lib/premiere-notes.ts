import type { PremiereAnchor } from "../bindings/PremiereAnchor";
import type { PremiereBinding } from "../bindings/PremiereBinding";
import type { PremiereMarkerRequest } from "../bindings/PremiereMarkerRequest";
import type { PremiereMarkerState } from "../bindings/PremiereMarkerState";
import type { ReviewDoc } from "./review";

/** A binding is a user's explicit choice, not a claim about the NDI picture. */
export type PremiereContext = {
  t: "premiere-context"; protocol: 1; sessionId: string;
  reviewKey: string; sourceId: string; binding: PremiereBinding | null;
  programId: string; presenterEpoch: number; revision: number;
};
export type PremiereRoomScope = Pick<PremiereContext, "programId" | "presenterEpoch" | "revision">;
export type PremiereReceipt = { commentId: string; versionId: string; bindingId: string; status: PremiereMarkerState };
export type PremiereReceipts = PremiereRoomScope & {
  t: "premiere-receipts"; protocol: 1; sessionId: string; reviewKey: string;
  ledgerRevision: number; items: PremiereReceipt[];
};
export type DisplayedProgramFrame = {
  streamId: string; frameId: string; mediaSeconds: number; displayedAt: number;
};
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown, max = 512): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const ticks = (value: unknown) => typeof value === "string" && /^-?\d{1,24}$/.test(value);

export function isPremiereBinding(value: unknown): value is PremiereBinding {
  const v = record(value);
  return !!v && text(v.bindingId) && text(v.projectId) && text(v.sequenceId)
    && text(v.projectName) && text(v.sequenceName) && text(v.displayFormat, 128)
    && ticks(v.zeroPointTicks) && ticks(v.timebaseTicks) && BigInt(v.timebaseTicks as string) > 0n;
}
export function samePremiereBinding(a: PremiereBinding | null, b: PremiereBinding | null): boolean {
  return !!a && !!b && a.bindingId === b.bindingId && a.projectId === b.projectId
    && a.sequenceId === b.sequenceId && a.timebaseTicks === b.timebaseTicks
    && a.zeroPointTicks === b.zeroPointTicks && a.displayFormat === b.displayFormat;
}
/** Project paths and future private fields must never hitchhike on room data. */
export function copyPremiereBinding(binding: PremiereBinding): PremiereBinding {
  const { bindingId, projectId, sequenceId, projectName, sequenceName, timebaseTicks, displayFormat, zeroPointTicks } = binding;
  return { bindingId, projectId, sequenceId, projectName, sequenceName, timebaseTicks, displayFormat, zeroPointTicks };
}
export function copyPremiereAnchor(anchor: PremiereAnchor): PremiereAnchor {
  const { sourceId, capturedAt, verification, sequenceTicks, frameId, streamId, mediaSeconds, reason } = anchor;
  return { binding: copyPremiereBinding(anchor.binding), sourceId, capturedAt, verification,
    sequenceTicks, frameId, streamId, mediaSeconds, reason };
}
export function isPremiereRoomScope(value: unknown): value is PremiereRoomScope {
  const v = record(value);
  return !!v && typeof v.programId === "string" && /^[a-f0-9]{32}$/i.test(v.programId)
    && Number.isSafeInteger(v.presenterEpoch) && (v.presenterEpoch as number) >= 0
    && Number.isSafeInteger(v.revision) && (v.revision as number) >= 0;
}
export function isPremiereReceipts(value: unknown): value is PremiereReceipts {
  const v = record(value);
  return !!v && v.t === "premiere-receipts" && v.protocol === 1
    && text(v.sessionId) && text(v.reviewKey, 4096)
    && Number.isSafeInteger(v.ledgerRevision) && (v.ledgerRevision as number) >= 0
    && Array.isArray(v.items) && v.items.length <= 100 && v.items.every(item => {
      const r = record(item);
      return !!r && text(r.commentId) && text(r.versionId) && text(r.bindingId)
        && ["needs_confirmation", "dispatching", "uncertain", "added", "removed_in_premiere"].includes(String(r.status));
    }) && isPremiereRoomScope(v);
}
export function isPremiereAnchor(value: unknown): value is PremiereAnchor {
  const v = record(value);
  return !!v && isPremiereBinding(v.binding) && text(v.sourceId, 4096)
    && typeof v.capturedAt === "number" && Number.isFinite(v.capturedAt) && v.capturedAt >= 0
    && (v.verification === "unverified" || v.verification === "verified")
    && (v.sequenceTicks == null || ticks(v.sequenceTicks))
    && (v.frameId == null || text(v.frameId))
    && (v.streamId == null || text(v.streamId, 256))
    && (v.mediaSeconds == null || (typeof v.mediaSeconds === "number" && Number.isFinite(v.mediaSeconds) && v.mediaSeconds >= 0))
    && (v.reason == null || text(v.reason, 1024));
}
export function isPremiereContext(value: unknown): value is PremiereContext {
  const v = record(value);
  return !!v && v.t === "premiere-context" && v.protocol === 1 && text(v.sessionId)
    && text(v.reviewKey, 4096) && text(v.sourceId, 4096)
    && (v.binding === null || isPremiereBinding(v.binding)) && isPremiereRoomScope(v);
}

/** The output PTS is retained as evidence ONLY. It is never converted to sequence ticks. */
export function capturePremiereAnchor(binding: PremiereBinding, sourceId: string,
  frame: DisplayedProgramFrame | null, now = Date.now()): PremiereAnchor {
  return { binding: copyPremiereBinding(binding), sourceId, capturedAt: now, verification: "unverified",
    ...(frame ? { streamId: frame.streamId, frameId: frame.frameId, mediaSeconds: frame.mediaSeconds } : {}),
    reason: frame ? "Displayed program frame captured; its Premiere sequence position is not verified."
      : "No confirmed displayed program frame is available. Editor confirmation is required." };
}

/** General/manual live notes and replies are NOT implicitly marker requests. */
export function premiereRequests(doc: ReviewDoc): PremiereMarkerRequest[] {
  return doc.comments.flatMap(comment => {
    if (!comment || typeof comment !== "object" || comment.parentId || !comment.timing || !isPremiereAnchor(comment.premiere)
      || comment.premiere.sourceId !== comment.timing.sourceId) return [];
    return [{ reviewKey: doc.sourceKey, versionId: comment.versionId, commentId: comment.id,
      sessionId: comment.sessionId ?? doc.sync?.sessionId ?? null,
      author: comment.author, body: comment.body, anchor: copyPremiereAnchor(comment.premiere) }];
  });
}
