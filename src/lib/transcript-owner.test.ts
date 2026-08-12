import { describe, expect, it } from "vitest";
import {
  clipTranscriptPath, transcriptBelongsToSource, type ActiveTranscript,
} from "./transcript-owner";

const tx = (path: string, sourceKey: string | null): ActiveTranscript =>
  ({ path, origin: "whisper", sourceKey });

describe("transcriptBelongsToSource", () => {
  it("lets the Clip render a transcript made for the source it is playing", () => {
    expect(transcriptBelongsToSource(tx("/t/ai.srt", "/v/ai.mp4"), "/v/ai.mp4")).toBe(true);
  });

  it("REFUSES one made for a different source", () => {
    // The reported bug: open a transcript in the reader, switch to Clip, and
    // one film's dialogue renders over another film's picture. Everything
    // draws, nothing errors, and the captions are confidently wrong.
    expect(transcriptBelongsToSource(tx("/t/bachelor.srt", "/v/bachelor.mp4"), "/v/ai.mp4"))
      .toBe(false);
  });

  it("refuses an owned transcript when the Clip has nothing loaded", () => {
    expect(transcriptBelongsToSource(tx("/t/a.srt", "/v/a.mp4"), null)).toBe(false);
  });

  it("allows an UNKNOWN owner, because absent is weaker than wrong", () => {
    // Transcripts predating the field, and history entries with no linked
    // source, were being shown quite correctly before this rule existed.
    // Hiding them would be a regression dressed up as a fix.
    expect(transcriptBelongsToSource(tx("/t/a.srt", null), "/v/anything.mp4")).toBe(true);
    expect(transcriptBelongsToSource(tx("/t/a.srt", null), null)).toBe(true);
  });

  it("is false when there is no transcript at all", () => {
    expect(transcriptBelongsToSource(null, "/v/a.mp4")).toBe(false);
    expect(transcriptBelongsToSource(null, null)).toBe(false);
  });

  it("compares exactly — a different file is a different subject", () => {
    expect(transcriptBelongsToSource(tx("/t/a.srt", "/v/a.mp4"), "/v/a copy.mp4")).toBe(false);
    expect(transcriptBelongsToSource(tx("/t/a.srt", "https://x/1"), "https://x/2")).toBe(false);
    expect(transcriptBelongsToSource(tx("/t/a.srt", "https://x/1"), "https://x/1")).toBe(true);
  });
});

describe("clipTranscriptPath", () => {
  it("hands back the path only when it is the Clip's own", () => {
    expect(clipTranscriptPath(tx("/t/ai.srt", "/v/ai.mp4"), "/v/ai.mp4")).toBe("/t/ai.srt");
    expect(clipTranscriptPath(tx("/t/bach.srt", "/v/bach.mp4"), "/v/ai.mp4")).toBeNull();
    expect(clipTranscriptPath(null, "/v/ai.mp4")).toBeNull();
  });

  it("is the ONE place the rule lives, so four consumers cannot disagree", () => {
    // Captions, the transcript panel, the AI summary and the speaker lanes all
    // read this. Inlining the comparison four times is how three stay right.
    const a = tx("/t/a.srt", "/v/a.mp4");
    for (const cur of ["/v/a.mp4", "/v/b.mp4", null]) {
      expect(clipTranscriptPath(a, cur))
        .toBe(transcriptBelongsToSource(a, cur) ? a.path : null);
    }
  });
});
