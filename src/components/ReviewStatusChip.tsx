import { STATUS_LABEL, type ReviewStatusState } from "../lib/review";

/** The one approval chip, shared by every surface (Review panel header,
 *  Clip sidebar source header, room stage title, Home/Library cards).
 *  Green = approved (a status semantic, not an accent), amber = changes
 *  requested, neutral = in review. `reviewer` renders "Approved · Nika"
 *  in live sessions and anywhere attribution exists. */
export function ReviewStatusChip({ state, reviewer, compact }: {
  state: ReviewStatusState;
  reviewer?: string;
  compact?: boolean;
}) {
  const label = compact && state === "changes" ? "Changes" : STATUS_LABEL[state];
  return (
    <span className={"cp-status-chip " + state} title={reviewer ? `${STATUS_LABEL[state]} · ${reviewer}` : STATUS_LABEL[state]}>
      {label}
      {!compact && reviewer && <span className="cp-status-chip-who">· {reviewer}</span>}
    </span>
  );
}
