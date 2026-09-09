// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { liveNoteTiming, noteTimingLabel, loadLiveReviewPass, saveLiveReviewPass } from "./live-review";
import { annotationsOf, buildComment, commentMarkers, emptyDoc, reviewToMarkdown } from "./review";

const source = { id: "ndi:pass", ownerId: "m0", kind: "ndi" as const, label: "Premiere" };
afterEach(() => localStorage.clear());
describe("live review timing", () => {
  it("restores the named pass by logical source without changing old notes", () => {
    saveLiveReviewPass("ndi:source-a", "Sequence A / pass 3");
    expect(loadLiveReviewPass("ndi:source-a")).toBe("Sequence A / pass 3");
    expect(loadLiveReviewPass("ndi:source-b")).toBe("Review pass 1");
    saveLiveReviewPass("ndi:source-a", "");
    expect(loadLiveReviewPass("ndi:source-a")).toBe("Sequence A / pass 3");
  });
  it("distinguishes manual and general timing without borrowing a file position", () => {
    expect(liveNoteTiming(source, "Sequence A / pass 2", "")).toEqual({
      kind: "general", sourceId: source.id, pass: "Sequence A / pass 2",
    });
    expect(liveNoteTiming(source, "Pass 2", "01:02:03;04")).toMatchObject({ kind: "manual", timecode: "01:02:03;04" });
    expect(() => liveNoteTiming(source, "", "")).toThrow();
    expect(() => liveNoteTiming(source, "Pass", "00:75:00:00")).toThrow();
  });
  it("does not project unverified notes or drawings onto a hidden file timeline", () => {
    const comment = { ...buildComment({ versionId: "v", timeStart: 0, body: "Fix title", author: "A" }),
      timing: liveNoteTiming(source, "Sequence A", "01:00:30:00"),
      annotation: { strokes: [], labels: [{ text: "Title", x: 0.5, y: 0.5 }] },
    };
    const doc = { ...emptyDoc("review"), activeVersionId: "v", comments: [comment] };
    expect(commentMarkers(doc, "v")).toEqual([]);
    expect(annotationsOf(doc, "v")).toEqual([]);
    expect(reviewToMarkdown(doc)).toContain("Sequence A · Manual 01:00:30:00");
    expect(noteTimingLabel(comment, "00:00:00:00")).not.toContain("00:00:00:00");
  });
});
