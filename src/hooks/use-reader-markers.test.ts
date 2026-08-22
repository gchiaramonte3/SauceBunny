// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { CHAPTERS_CHANGED_EVENT, saveChapters } from "../lib/chapters";
import { useReaderMarkers } from "./use-reader-markers";

const CLIP = "/media/loaded.mov";
const OTHER = "/media/something-else.mov";

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

const args = {
  readerPath: CLIP, clipPath: CLIP, clipSourceKey: CLIP,
  inFrames: 240, outFrames: 720, fps: 24,
};

describe("useReaderMarkers", () => {
  it("converts the transport's frame marks to seconds", () => {
    const { result } = renderHook(() => useReaderMarkers(args));
    expect(result.current.markIn).toBe(10);
    expect(result.current.markOut).toBe(30);
  });

  it("does NOT show Clip's marks when the reader is on another source", () => {
    // The bug this guards: marks are transport state belonging to the loaded
    // source. Drawn on a different recording's bar they are real marks about
    // something else, which is worse than none.
    const { result } = renderHook(() => useReaderMarkers({ ...args, readerPath: OTHER }));
    expect(result.current.markIn).toBeNull();
    expect(result.current.markOut).toBeNull();
  });

  it("still shows that other source's own chapters", () => {
    // Chapters are keyed by source, so they belong to whatever you opened -
    // gating them on Clip would leave the panel blank in the normal case of
    // reading a transcript without loading it in Clip.
    saveChapters(OTHER, [{ time: 12, title: "Cold open" }]);
    const { result } = renderHook(() => useReaderMarkers({ ...args, readerPath: OTHER }));
    expect(result.current.chapters).toEqual([{ time: 12, title: "Cold open" }]);
  });

  it("prefers Clip's resolved key for the source Clip has loaded", () => {
    // That key may be a fingerprint resolution pointing at a doc written under
    // an older path; the raw path would miss those chapters entirely.
    saveChapters("resolved-key", [{ time: 3, title: "From the old path" }]);
    const { result } = renderHook(() => useReaderMarkers({ ...args, clipSourceKey: "resolved-key" }));
    expect(result.current.chapters).toEqual([{ time: 3, title: "From the old path" }]);
  });

  it("does not use Clip's key for a source Clip has not loaded", () => {
    saveChapters("resolved-key", [{ time: 3, title: "Wrong source" }]);
    const { result } = renderHook(() => useReaderMarkers({
      ...args, readerPath: OTHER, clipSourceKey: "resolved-key",
    }));
    expect(result.current.chapters).toEqual([]);
  });

  it("has nothing to show with no source", () => {
    const { result } = renderHook(() => useReaderMarkers({ ...args, readerPath: null }));
    expect(result.current).toEqual({ markIn: null, markOut: null, chapters: [], comments: [] });
  });

  it("treats an unknown fps as unknown marks, not as marks at zero", () => {
    const { result } = renderHook(() => useReaderMarkers({ ...args, fps: 0 }));
    expect(result.current.markIn).toBeNull();
  });

  it("re-reads when chapters change under it", () => {
    // The AI Summary tab writes chapters while the reader is open. Without the
    // listener the bar keeps showing the pins from before the run.
    const { result } = renderHook(() => useReaderMarkers(args));
    expect(result.current.chapters).toEqual([]);
    act(() => {
      saveChapters(CLIP, [{ time: 5, title: "New" }]);
      window.dispatchEvent(new CustomEvent(CHAPTERS_CHANGED_EVENT, { detail: { sourceKey: CLIP } }));
    });
    expect(result.current.chapters).toEqual([{ time: 5, title: "New" }]);
  });
});
