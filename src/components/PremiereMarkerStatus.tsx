import { useSyncExternalStore } from "react";
import { getPremiereLink, subscribePremiereLink } from "../lib/premiere-link";
import type { ReviewComment } from "../lib/review";

export function PremiereMarkerStatus({ comment }: { comment: ReviewComment }) {
  const link = useSyncExternalStore(subscribePremiereLink, getPremiereLink);
  const marker = link.records.find(record => record.request.commentId === comment.id
    && record.request.versionId === comment.versionId
    && record.request.anchor.binding.bindingId === comment.premiere?.binding.bindingId);
  const receipt = link.receipts.find(r => r.commentId === comment.id && r.versionId === comment.versionId
    && r.bindingId === comment.premiere?.binding.bindingId);
  const status = receipt?.status ?? marker?.status;
  const label = status === "added" ? "Added to Premiere · Save the project separately"
    : status === "removed_in_premiere" ? "Removed in Premiere · Not recreated"
    : status === "uncertain" ? "Waiting for Premiere · Check insertion before retrying"
    : status === "dispatching" ? "Waiting for Premiere confirmation"
    : status ? "Saved in Sauce Bunny · Needs timeline position"
    : "Waiting for Premiere · Needs timeline position";
  return <span className="cp-premiere-marker-status" title={receipt ? undefined : marker?.error ?? undefined}>{label}</span>;
}
