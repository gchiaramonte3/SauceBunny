import type { PremiereAnchor } from "../bindings/PremiereAnchor";
import type { PremiereBinding } from "../bindings/PremiereBinding";
import type { PremiereMarkerRequest } from "../bindings/PremiereMarkerRequest";
import type { ReviewDoc } from "./review";

/** A binding is a user's explicit choice, not a claim about the NDI picture. */
export type PremiereContext = {
  t: "premiere-context"; protocol: 1; sessionId: string;
  reviewKey: string; sourceId: string; binding: PremiereBinding | null;
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
    && (v.binding === null || isPremiereBinding(v.binding));
}

/** The output PTS is retained as evidence ONLY. It is never converted to sequence ticks. */
export function capturePremiereAnchor(binding: PremiereBinding, sourceId: string,
  frame: DisplayedProgramFrame | null, now = Date.now()): PremiereAnchor {
  return { binding: { ...binding }, sourceId, capturedAt: now, verification: "unverified",
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
      author: comment.author, body: comment.body, anchor: comment.premiere }];
  });
}
