import type { AnnotationStrokes } from "./review";
import type { ReviewRangeDraft } from "../types";
import type { SeekResult } from "../components/player-handle";
import type { PlaybackSessionController } from "./playback-session-controller";
import { subscribeReviewDoc } from "./review-store";

/** The picture actually occupying the program monitor, not a hidden file. */
export type LiveProgramSource = {
  id: string;
  ownerId: string;
  kind: "screen" | "ndi";
  label: string;
  privatePreview?: boolean;
  notesBlocked?: string;
};
export const noProgramSource = (): LiveProgramSource | null => null;
export const noProgramSubscription = (): (() => void) => () => {};
export const noInspectionBlock = (): string | null => null;

export type ReviewRangeCommands = {
  markIn: () => void;
  markOut: () => void;
};

export type ReviewSessionActions = {
  setCommentRange: (range: ReviewRangeDraft | null) => void;
  showAnnotation: (annotation: AnnotationStrokes | null, color?: string, time?: number) => void;
};

export type ReviewSession = {
  readonly rangeCommandsRef: { current: ReviewRangeCommands | null };
  setSourceIdentity(sourceId: string | null): void;
  getSourceIdentity(): string | null;
  setProgramSource(source: LiveProgramSource | null): void;
  getProgramSource(): LiveProgramSource | null;
  subscribeProgram(listener: () => void): () => void;
  setInspectionBlock(reason: string | null): void;
  getInspectionBlock(): string | null;
  subscribeDocument(sourceKey: string, listener: () => void): () => void;
  configure(actions: ReviewSessionActions): () => void;
  jumpToComment(seconds: number): Promise<SeekResult>;
  setCommentRange(range: ReviewRangeDraft | null): void;
  showAnnotation(annotation: AnnotationStrokes | null, color?: string, time?: number): void;
  registerRangeCommands(commands: ReviewRangeCommands | null): void;
};

/**
 * Domain boundary between the Review workspace and the shared player.
 *
 * Review components describe what the user meant; this source-keyed service
 * owns the cross-workspace effects. That keeps player handles and App callback
 * plumbing out of the comment list while preserving the existing review store
 * and floating-panel compatibility.
 */
export function createReviewSession(playback: PlaybackSessionController): ReviewSession {
  let sourceId: string | null = null;
  let actions: ReviewSessionActions | null = null;
  let program: LiveProgramSource | null = null;
  let inspectionBlock: string | null = null;
  const programListeners = new Set<() => void>();
  const rangeCommandsRef: { current: ReviewRangeCommands | null } = { current: null };

  return {
    rangeCommandsRef,
    setSourceIdentity(next) {
      if (sourceId === next) return;
      sourceId = next;
      rangeCommandsRef.current = null;
    },
    getSourceIdentity: () => sourceId,
    setProgramSource(next) {
      if (program?.id === next?.id && program?.ownerId === next?.ownerId
        && program?.label === next?.label && program?.kind === next?.kind
        && program?.privatePreview === next?.privatePreview && program?.notesBlocked === next?.notesBlocked) return;
      program = next;
      rangeCommandsRef.current = null;
      actions?.setCommentRange(null);
      actions?.showAnnotation(null);
      for (const listener of programListeners) listener();
    },
    getProgramSource: () => program,
    // Local inspection is not a source change. Keep drafts, ranges, and the
    // room document intact while disabling intents aimed at the hidden file.
    setInspectionBlock(reason) {
      if (reason === inspectionBlock) return;
      inspectionBlock = reason;
      for (const listener of programListeners) listener();
    },
    getInspectionBlock: () => inspectionBlock,
    subscribeProgram(listener) {
      programListeners.add(listener);
      return () => { programListeners.delete(listener); };
    },
    subscribeDocument: subscribeReviewDoc,
    configure(next) {
      actions = next;
      return () => {
        if (actions === next) actions = null;
      };
    },
    jumpToComment(seconds) {
      const target = Math.max(0, seconds);
      if (sourceId == null || program || inspectionBlock) {
        return Promise.resolve({
          requestedSeconds: target,
          presentedSeconds: playback.getSnapshot().presentedSeconds,
          status: "unavailable",
        });
      }
      return playback.seekTo(target);
    },
    setCommentRange(range) {
      if (inspectionBlock) return;
      if (program && range) return;
      actions?.setCommentRange(range);
    },
    showAnnotation(annotation, color, time) {
      if (inspectionBlock) return;
      if (program && annotation) return;
      actions?.showAnnotation(annotation, color, time);
    },
    registerRangeCommands(commands) {
      rangeCommandsRef.current = program ? null : commands;
    },
  };
}
