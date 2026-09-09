import { useSyncExternalStore } from "react";
import { getPremiereLink, subscribePremiereLink } from "../lib/premiere-link";
import type { ReviewComment } from "../lib/review";

export function PremiereMarkerStatus({ comment }: { comment: ReviewComment }) {
  const link = useSyncExternalStore(subscribePremiereLink, getPremiereLink);
  const marker = link.records.find(record => record.request.commentId === comment.id
    && record.request.versionId === comment.versionId
    && record.request.anchor.binding.bindingId === comment.premiere?.binding.bindingId);
  const label = marker?.status === "added" ? "Added to Premiere · Save the project separately"
    : marker?.status === "removed_in_premiere" ? "Removed in Premiere · Not recreated"
    : marker?.status === "uncertain" ? "Waiting for Premiere · Check insertion before retrying"
    : marker?.status === "dispatching" ? "Waiting for Premiere confirmation"
    : marker ? "Saved in Sauce Bunny · Needs timeline position"
    : "Waiting for Premiere · Needs timeline position";
  return <span className="cp-premiere-marker-status" title={marker?.error ?? undefined}>{label}</span>;
}
