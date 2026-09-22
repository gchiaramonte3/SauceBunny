import type { AnalysisEditDocument } from "../../bindings/AnalysisEditDocument";
import type { AnalysisEditRow } from "../../bindings/AnalysisEditRow";
import type { AnalysisRowCorrection } from "../../bindings/AnalysisRowCorrection";
import type { VideoShotAnswer } from "../../bindings/VideoShotAnswer";
import type { SceneEvidence } from "./evidence";
import { secondsToFrames, tcDigitsToDisplay, tcToFrames } from "../timecode";

export type CorrectionField = "label" | "start_us" | "end_us" | "duration" | "picture" | "dialogue" | "summary";
export const FIELD_NAMES: Record<CorrectionField, string> = {
  label: "Shot", start_us: "Start", end_us: "End", duration: "Duration", picture: "Picture", dialogue: "Dialogue", summary: "Transcript summary",
};
export const emptyCorrection = (): AnalysisRowCorrection => ({ revision: 0, label: null, start_us: null, end_us: null, picture: null, dialogue: null, summary: null });
export const rowAnchor = (row: AnalysisEditRow) => `${row.start_us}:${row.end_us}`;
export const timingField = (field: CorrectionField) => field === "start_us" || field === "end_us" || field === "duration";
export function correctedRow(row: AnalysisEditRow, edit?: AnalysisRowCorrection) {
  return { ...row, label: edit?.label ?? String(row.id), start_us: edit?.start_us ?? row.start_us,
    end_us: edit?.end_us ?? row.end_us, picture: edit?.picture ?? row.picture,
    dialogue: edit?.dialogue ?? row.dialogue, summary: edit?.summary ?? row.summary };
}

/** Baselines are copies for reopening; the detector/model evidence stays frozen. */
export function analysisSnapshot(evidence: SceneEvidence | null, answers: VideoShotAnswer[], dialogue: Record<number, string> | undefined, fps: number, model?: string): AnalysisEditDocument | null {
  const source = evidence?.proxy?.source;
  if (!evidence || !source || !/^[a-f0-9]{64}$/.test(source.sha256) || source.duration_us <= 0 || !Number.isFinite(fps) || fps < 1 || fps > 240) return null;
  return { schema_version: 1, revision: 0, source: { ...source }, fps, model: model ?? null, corrections: {}, rows: evidence.shots.map(shot => {
    const answer = answers.find(item => item.id === shot.id);
    return { id: shot.id, start_us: shot.start_us, end_us: shot.end_us,
      picture: answer?.picture_description ?? answer?.text ?? "", dialogue: shot.transcript || dialogue?.[shot.id] || "", summary: answer?.transcript_summary ?? "" };
  }) };
}

/** Numeric shorthand follows Clip's right-to-left digit entry, with strict
 * frame/minute validation. Never parse floating-point seconds as timecode. */
export function editedCorrection(row: AnalysisEditRow, previous: AnalysisRowCorrection, field: CorrectionField, value: string | null, fps: number, durationUs: number): AnalysisRowCorrection {
  const next = { ...previous };
  if (timingField(field)) {
    if (value === null) {
      if (field === "duration") { next.start_us = null; next.end_us = null; }
      else next[field as "start_us" | "end_us"] = null;
    } else {
      const tc = /^\d{1,8}$/.test(value) ? tcDigitsToDisplay(value) : value;
      const frames = tcToFrames(tc, fps);
      if (frames === null || !Number.isSafeInteger(frames)) throw new Error("Enter a valid HH:MM:SS:FF timecode for this frame rate.");
      const current = correctedRow(row, next);
      if (field === "duration") {
        if (frames === 0) throw new Error("Duration must be at least one frame.");
        next.end_us = Math.round((secondsToFrames(current.start_us / 1e6, fps) + frames) / fps * 1e6);
      } else next[field as "start_us" | "end_us"] = Math.round(frames / fps * 1e6);
    }
    const corrected = correctedRow(row, next);
    if (corrected.start_us < 0 || corrected.end_us > durationUs) throw new Error("Timecode must stay within this clip.");
    if (secondsToFrames(corrected.end_us / 1e6, fps) <= secondsToFrames(corrected.start_us / 1e6, fps)) throw new Error("End must be at least one frame after start.");
  } else {
    if (field === "label" && value !== null && (!value.trim() || [...value].length > 48)) throw new Error("Use 1 to 48 characters for the shot label.");
    if (value !== null && new TextEncoder().encode(value).length > 128 * 1024) throw new Error("This text is too long to save.");
    next[field] = value;
  }
  return next;
}
