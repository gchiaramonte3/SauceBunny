/** Measured receiver statistics. Missing browser fields stay unavailable, not zero. */
export type ProgramDiagnostics = {
  width: number | null; height: number | null; fps: number | null;
  bitrate: number | null; droppedFrames: number | null; receiveBufferMs: number | null;
  /** RTP stats do not establish cross-track presentation alignment. */
  avDriftMs: null;
};

type VideoSample = Partial<RTCInboundRtpStreamStats> & { id: string; timestamp: number };
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

export function createProgramStatsSampler() {
  let previous: VideoSample | null = null;
  return (sample: VideoSample): ProgramDiagnostics => {
    const prev = previous?.id === sample.id ? previous : null;
    const seconds = prev ? (sample.timestamp - prev.timestamp) / 1000 : 0;
    const perSecond = (now: number | undefined, before: number | undefined) =>
      seconds > 0 && finite(now) && finite(before) && now >= before ? (now - before) / seconds : null;
    const bytes = perSecond(sample.bytesReceived, prev?.bytesReceived);
    const decoded = perSecond(sample.framesDecoded, prev?.framesDecoded);
    const delay = finite(sample.jitterBufferDelay) && finite(prev?.jitterBufferDelay)
      ? sample.jitterBufferDelay - prev.jitterBufferDelay : null;
    const emitted = finite(sample.jitterBufferEmittedCount) && finite(prev?.jitterBufferEmittedCount)
      ? sample.jitterBufferEmittedCount - prev.jitterBufferEmittedCount : 0;
    previous = sample;
    return {
      width: finite(sample.frameWidth) ? sample.frameWidth : null,
      height: finite(sample.frameHeight) ? sample.frameHeight : null,
      fps: finite(sample.framesPerSecond) ? sample.framesPerSecond : decoded,
      bitrate: bytes == null ? null : bytes * 8,
      droppedFrames: finite(sample.framesDropped) ? sample.framesDropped : null,
      receiveBufferMs: delay != null && delay >= 0 && emitted > 0 ? delay / emitted * 1000 : null,
      avDriftMs: null,
    };
  };
}
