import { describe, expect, it } from "vitest";
import { createProgramStatsSampler } from "./program-diagnostics";

describe("program diagnostics", () => {
  it("measures interval bitrate, decoded fps, and jitter-buffer delay", () => {
    const sample = createProgramStatsSampler();
    sample({ id: "video", timestamp: 1000, bytesReceived: 1000, framesDecoded: 5,
      jitterBufferDelay: 1, jitterBufferEmittedCount: 10 });
    const next = sample({ id: "video", timestamp: 3000, bytesReceived: 2_001_000, framesDecoded: 65,
      frameWidth: 1920, frameHeight: 1080, framesDropped: 2,
      jitterBufferDelay: 2.2, jitterBufferEmittedCount: 70 });
    expect(next).toMatchObject({ bitrate: 8_000_000, fps: 30, width: 1920, height: 1080, droppedFrames: 2, avDriftMs: null });
    expect(next.receiveBufferMs).toBeCloseTo(20);
  });
  it("does not invent zeros or reuse counters across receiver changes", () => {
    const sample = createProgramStatsSampler();
    expect(sample({ id: "first", timestamp: 1000 }).bitrate).toBeNull();
    sample({ id: "first", timestamp: 2000, bytesReceived: 500_000 });
    expect(sample({ id: "second", timestamp: 3000, bytesReceived: 600_000 }).bitrate).toBeNull();
    expect(sample({ id: "second", timestamp: 4000, bytesReceived: 0 }).bitrate).toBeNull();
  });
});
