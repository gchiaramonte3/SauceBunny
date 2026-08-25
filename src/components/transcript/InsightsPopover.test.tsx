// @vitest-environment jsdom
//
// The insights panel printed `s.speaker` - the raw diarization tag - so it
// said SPEAKER_00 while the turns beside it said "Jimmy". It skipped both
// the user's rename and the humanising the rest of the app does, which made
// a rename that HAD saved look like it had not.

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { InsightsPopover } from "./InsightsPopover";
import type { SpeakerStat } from "../../lib/speaker-stats";

const anchor = { x: 0, y: 0, width: 10, height: 10, top: 0, left: 0, right: 10, bottom: 10 } as DOMRect;

const stat = (speaker: string | null, over: Partial<SpeakerStat> = {}): SpeakerStat => ({
  speaker, talkMs: 60_000, sharePct: 50, turns: 3, words: 100, wpm: 120, longestTurnMs: 20_000, ...over,
});

const mount = (stats: SpeakerStat[], nameOf: (s: string | null) => string) =>
  render(
    <InsightsPopover
      anchor={anchor}
      stats={stats}
      colorOf={() => "#888"}
      nameOf={nameOf}
      onClose={vi.fn()}
    />,
  );

describe("speaker insights", () => {
  it("shows the name the user gave a speaker, not the model's tag", () => {
    mount([stat("SPEAKER_00"), stat("SPEAKER_01")], (s) =>
      s === "SPEAKER_00" ? "Jimmy" : "Mike");
    expect(screen.getByText("Jimmy")).toBeTruthy();
    expect(screen.getByText("Mike")).toBeTruthy();
    expect(screen.queryByText("SPEAKER_00")).toBeNull();
    expect(screen.queryByText("SPEAKER_01")).toBeNull();
  });

  it("the tooltip agrees with the label, rather than exposing the raw tag", () => {
    mount([stat("SPEAKER_00")], () => "Jimmy");
    // The name span specifically: its parent row carries the same text, so an
    // unscoped query matches both.
    const label = document.querySelector(".cp-tx-insights-name")!;
    expect(label.textContent).toBe("Jimmy");
    expect(label.getAttribute("title")).toBe("Jimmy");
  });

  it("an un-renamed speaker still reads the way the transcript reads it", () => {
    // The caller humanises SPEAKER_00 to "Speaker 1"; the panel must not
    // second-guess that with a raw tag of its own.
    mount([stat("SPEAKER_00")], () => "Speaker 1");
    expect(screen.getByText("Speaker 1")).toBeTruthy();
  });

  it("a null speaker is whatever the caller calls it", () => {
    mount([stat(null)], (s) => (s === null ? "Unknown speaker" : "?"));
    expect(screen.getByText("Unknown speaker")).toBeTruthy();
  });
});
