// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SpeakerGroups, type SpeakerGroup } from "./SpeakerGroups";
import type { Turn } from "../../lib/srt";

afterEach(cleanup);

/**
 * Two speakers, five turns, interleaved in TIME so the chronological order and
 * the talk-time order genuinely differ. A fixture where they agree would let a
 * broken sort pass.
 *
 *   turn 0  Ada    (cues 0)
 *   turn 1  Basil  (cues 1,2)
 *   turn 2  Ada    (cues 3)
 *   turn 3  Basil  (cues 4)
 *   turn 4  Basil  (cues 5)
 */
const turns = [
  { speaker: "S0", start: 0,  end: 2,  cues: [{ start: 0,  end: 2,  text: "Ada one" }] },
  { speaker: "S1", start: 2,  end: 40, cues: [{ start: 2, end: 20, text: "Basil one" }, { start: 20, end: 40, text: "Basil two" }] },
  { speaker: "S0", start: 40, end: 43, cues: [{ start: 40, end: 43, text: "Ada two" }] },
  { speaker: "S1", start: 43, end: 90, cues: [{ start: 43, end: 90, text: "Basil three" }] },
  { speaker: "S1", start: 90, end: 95, cues: [{ start: 90, end: 95, text: "Basil four" }] },
] as unknown as Turn[];

const cueStartIndices = [0, 1, 3, 4, 5];

/** Passed in the order the CALLER decided: loudest first. */
const groups: SpeakerGroup[] = [
  { tag: "S1", name: "Basil", color: "#0AF2CD", talkSeconds: 105, turnCount: 3, turnIdxs: [1, 3, 4] },
  { tag: "S0", name: "Ada",   color: "#FD8A8C", talkSeconds: 5,   turnCount: 2, turnIdxs: [0, 2] },
];

function show(over: Partial<React.ComponentProps<typeof SpeakerGroups>> = {}) {
  const props = {
    groups, turns, cueStartIndices,
    activeCueIdx: -1,
    query: "",
    onSeek: vi.fn(),
    formatTime: (s: number) => `t${Math.round(s)}`,
  };
  render(<SpeakerGroups {...props} {...over} />);
  return props;
}

const headNames = () =>
  Array.from(document.querySelectorAll(".cp-tx-group-name")).map((e) => e.textContent);
const lineTexts = () =>
  Array.from(document.querySelectorAll(".cp-tx-group-text")).map((e) => e.textContent);
const headFor = (name: string) =>
  screen.getByRole("button", { expanded: false, name: new RegExp(name) });

describe("the cast list", () => {
  it("renders in the order it was given, loudest first", () => {
    // Ada speaks FIRST in time and Basil speaks MOST. This view answers "how
    // much of it is them", so Basil is on top; chronological is the Text view.
    show();
    expect(headNames()).toEqual(["Basil", "Ada"]);
  });

  it("shows talk time and line count, so the order has a visible reason", () => {
    show();
    const talks = Array.from(document.querySelectorAll(".cp-tx-group-talk")).map((e) => e.textContent);
    expect(talks).toEqual(["1m", "5s"]);
    const counts = Array.from(document.querySelectorAll(".cp-tx-group-turns")).map((e) => e.textContent);
    expect(counts).toEqual(["3 lines", "2 lines"]);
  });

  it("starts collapsed", () => {
    // A twenty-six person cast expanded is just the transcript again in a
    // stranger order. Collapsed it is a cast list you can read in one screen.
    show();
    expect(lineTexts()).toEqual([]);
  });
});

describe("expanding", () => {
  it("shows only that speaker's lines, in time order", () => {
    show();
    fireEvent.click(headFor("Basil"));
    expect(lineTexts()).toEqual(["Basil one Basil two", "Basil three", "Basil four"]);
  });

  it("joins the cues of one turn into one line rather than splitting them", () => {
    // A turn is what a person said before somebody else spoke. Splitting it
    // per cue would make a paragraph look like three interruptions.
    show();
    fireEvent.click(headFor("Basil"));
    expect(lineTexts()[0]).toBe("Basil one Basil two");
  });

  it("keeps several speakers open at once", () => {
    show();
    fireEvent.click(headFor("Basil"));
    fireEvent.click(headFor("Ada"));
    expect(lineTexts()).toHaveLength(5);
  });

  it("collapses again on a second press", () => {
    show();
    fireEvent.click(headFor("Basil"));
    expect(lineTexts()).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { expanded: true }));
    expect(lineTexts()).toEqual([]);
  });

  it("seeks to the start of the line that was clicked", () => {
    const props = show();
    fireEvent.click(headFor("Basil"));
    fireEvent.click(screen.getByText("Basil three").closest("button")!);
    expect(props.onSeek).toHaveBeenCalledWith(43);
  });
});

describe("staying tied to playback", () => {
  it("marks whoever is speaking right now", () => {
    // Cue 4 belongs to turn 3, which is Basil's.
    show({ activeCueIdx: 4 });
    const speaking = document.querySelectorAll(".cp-tx-group.speaking");
    expect(speaking).toHaveLength(1);
    expect(speaking[0].textContent).toContain("Basil");
  });

  it("resolves a cue in the MIDDLE of a multi-cue turn", () => {
    // Cue 2 is turn 1's second cue. A naive start-index compare would miss it
    // and light nobody up for the whole of a long paragraph.
    show({ activeCueIdx: 2 });
    expect(document.querySelector(".cp-tx-group.speaking")?.textContent).toContain("Basil");
  });

  it("attributes a cue to the right speaker, not just the first group", () => {
    // Cue 3 is turn 2 — Ada's, and Ada is rendered SECOND. A bug that returned
    // the first group would still light something up and look fine.
    show({ activeCueIdx: 3 });
    expect(document.querySelector(".cp-tx-group.speaking")?.textContent).toContain("Ada");
  });

  it("lights nobody up when the playhead is outside every cue", () => {
    show({ activeCueIdx: -1 });
    expect(document.querySelectorAll(".cp-tx-group.speaking")).toHaveLength(0);
  });

  it("highlights the live line inside an expanded speaker", () => {
    show({ activeCueIdx: 2 });
    fireEvent.click(headFor("Basil"));
    const live = document.querySelectorAll(".cp-tx-group-line.live");
    expect(live).toHaveLength(1);
    expect(live[0].textContent).toContain("Basil one Basil two");
  });
});

describe("filtering by speaker name", () => {
  it("dims non-matches rather than removing them", () => {
    // A speaker that vanishes reads as deleted, and the counts around it stop
    // making sense.
    show({ query: "bas" });
    expect(headNames()).toEqual(["Basil", "Ada"]);
    const dim = document.querySelectorAll(".cp-tx-group.dim");
    expect(dim).toHaveLength(1);
    expect(dim[0].textContent).toContain("Ada");
  });

  it("dims nobody on an empty query", () => {
    show({ query: "   " });
    expect(document.querySelectorAll(".cp-tx-group.dim")).toHaveLength(0);
  });
});
