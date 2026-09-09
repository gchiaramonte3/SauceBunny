import { describe, expect, it, vi } from "vitest";
import { createReviewSession } from "./review-session";
import type { PlaybackSessionController } from "./playback-session-controller";

function playback(): PlaybackSessionController {
  return {
    play: vi.fn(), pause: vi.fn(),
    setPlaybackRate: vi.fn(), subscribeCommands: vi.fn(() => () => {}),
    seekTo: vi.fn(async (seconds: number) => ({ requestedSeconds: seconds, presentedSeconds: seconds, status: "presented" as const })),
    beginScrub: vi.fn(), scrubTo: vi.fn(),
    endScrub: vi.fn(async (seconds: number) => ({ requestedSeconds: seconds, presentedSeconds: seconds, status: "presented" as const })),
    subscribe: vi.fn(() => () => {}),
    getSnapshot: () => ({
      sourceId: "player-source", phase: "ready", requestedSeconds: 0, presentedSeconds: 3,
      durationSeconds: 100, playing: false, playbackRate: 1, representation: "proxy",
    }),
  };
}

describe("ReviewSession", () => {
  it("private inspection blocks hidden-source intents without changing the room or clearing drafts", async () => {
    const p = playback();
    const s = createReviewSession(p);
    const setCommentRange = vi.fn(), showAnnotation = vi.fn(), changed = vi.fn();
    s.configure({setCommentRange, showAnnotation});
    s.setSourceIdentity("room-file");
    s.subscribeProgram(changed);
    s.setInspectionBlock("Return to room");
    s.setInspectionBlock("Return to room");
    expect(changed).toHaveBeenCalledOnce();
    expect(s.getSourceIdentity()).toBe("room-file");
    expect(s.getProgramSource()).toBeNull();
    expect(s.getInspectionBlock()).toBe("Return to room");
    await expect(s.jumpToComment(10)).resolves.toMatchObject({status:"unavailable"});
    s.setCommentRange(null);
    s.showAnnotation(null);
    expect(setCommentRange).not.toHaveBeenCalled();
    expect(showAnnotation).not.toHaveBeenCalled();
    expect(p.seekTo).not.toHaveBeenCalled();
    expect(p.pause).not.toHaveBeenCalled();
    s.setInspectionBlock(null);
    await s.jumpToComment(10);
    expect(p.seekTo).toHaveBeenCalledWith(10);
  });
  it("live program ownership disables hidden-file seeks and range/annotation intents", async () => {
    const p = playback();
    const s = createReviewSession(p);
    const changed = vi.fn();
    const setCommentRange = vi.fn();
    const showAnnotation = vi.fn();
    s.configure({ setCommentRange, showAnnotation });
    s.setSourceIdentity("file-underneath");
    s.subscribeProgram(changed);
    const program = { id: "ndi", ownerId: "m0", kind: "ndi" as const, label: "Premiere" };
    s.setProgramSource(program);
    s.setProgramSource({ ...program });
    expect(changed).toHaveBeenCalledOnce();
    await expect(s.jumpToComment(50)).resolves.toMatchObject({ status: "unavailable" });
    expect(p.seekTo).not.toHaveBeenCalled();
    s.setCommentRange({ start: 1, end: 5, color: "#fff", live: false });
    expect(setCommentRange).toHaveBeenCalledExactlyOnceWith(null);
    s.registerRangeCommands({ markIn: vi.fn(), markOut: vi.fn() });
    expect(s.rangeCommandsRef.current).toBeNull();
    s.setProgramSource(null);
    await s.jumpToComment(50);
    expect(p.seekTo).toHaveBeenCalledWith(50);
  });
  it("turns review intents into source-keyed playback and presentation actions", async () => {
    const p = playback();
    const s = createReviewSession(p);
    const setCommentRange = vi.fn();
    const showAnnotation = vi.fn();
    s.configure({ setCommentRange, showAnnotation });

    await expect(s.jumpToComment(12)).resolves.toMatchObject({ status: "unavailable" });
    expect(p.seekTo).not.toHaveBeenCalled();

    s.setSourceIdentity("review-key");
    await s.jumpToComment(12);
    expect(p.seekTo).toHaveBeenCalledWith(12);
    s.setCommentRange({ start: 2, end: 5, color: "#fff", live: false });
    s.showAnnotation(null, "#fff", 12);
    expect(setCommentRange).toHaveBeenCalledOnce();
    expect(showAnnotation).toHaveBeenCalledWith(null, "#fff", 12);
  });

  it("clears source-local range commands when the source changes", () => {
    const s = createReviewSession(playback());
    const commands = { markIn: vi.fn(), markOut: vi.fn() };
    s.setSourceIdentity("one");
    s.registerRangeCommands(commands);
    expect(s.rangeCommandsRef.current).toBe(commands);
    s.setSourceIdentity("two");
    expect(s.rangeCommandsRef.current).toBeNull();
  });
});
