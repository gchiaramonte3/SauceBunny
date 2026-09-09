import type { DisplayedProgramFrame } from "./premiere-notes";

// One sample per decoder surface. No React subscribers, frame queues or native
// media buffers. A note takes a COPY of the most recently presented sample.
const frames = new Map<string, { owner: string; frame: DisplayedProgramFrame }>();
export function recordPremiereFrame(streamId: string, owner: string, mediaSeconds: number, presentedFrames: number): void {
  if (!Number.isFinite(mediaSeconds) || mediaSeconds < 0) return;
  frames.set(streamId, { owner, frame: { streamId, frameId: `${owner}:${presentedFrames}`,
    mediaSeconds, displayedAt: Date.now() } });
}
export function lastPremiereFrame(streamId: string): DisplayedProgramFrame | null {
  const frame = frames.get(streamId)?.frame;
  return frame ? { ...frame } : null;
}
export function forgetPremiereFrame(streamId: string, owner: string): void {
  if (frames.get(streamId)?.owner === owner) frames.delete(streamId);
}
