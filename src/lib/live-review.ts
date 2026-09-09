import type { ReviewComment } from "./review";
import type { LiveProgramSource } from "./review-session";

const LIVE_PASS_PREFIX = "saucebunny.liveReviewPass:";
export function loadLiveReviewPass(sourceId: string | null): string {
  try {
    const value = sourceId ? localStorage.getItem(LIVE_PASS_PREFIX + sourceId) : null;
    if (value?.trim() && value.length <= 120) return value;
  } catch { /* Storage may be unavailable. General notes remain usable. */ }
  return "Review pass 1";
}
export function saveLiveReviewPass(sourceId: string, value: string): void {
  if (!value.trim() || value.length > 120) return;
  try { localStorage.setItem(LIVE_PASS_PREFIX + sourceId, value); } catch { /* Keep the in-memory draft. */ }
}

/** Manual labels are preserved verbatim, never converted into verified media positions. */
export function liveNoteTiming(source: LiveProgramSource, pass: string, timecode: string): NonNullable<ReviewComment["timing"]> {
  const label = pass.trim();
  if (!label || label.length > 120) throw new Error("Name the sequence/pass (up to 120 characters).");
  const tc = timecode.trim();
  if (tc && !/^\d{2}:[0-5]\d:[0-5]\d[:;][0-5]\d$/.test(tc)) {
    throw new Error("Enter sequence timecode as HH:MM:SS:FF, or leave it blank for a general note.");
  }
  return { kind: tc ? "manual" : "general", sourceId: source.id, pass: label, ...(tc ? { timecode: tc } : {}) };
}

export function noteTimingLabel(comment: ReviewComment, fileLabel: string): string {
  const timing = comment.timing;
  if (!timing) return fileLabel;
  return `${timing.pass} · ${timing.kind === "manual" ? `Manual ${timing.timecode}` : "General note"}`;
}
