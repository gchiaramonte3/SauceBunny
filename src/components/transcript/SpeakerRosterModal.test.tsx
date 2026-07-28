// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { SpeakerRosterModal, type RosterItem } from "./SpeakerRosterModal";

/**
 * What this modal is FOR is a twenty-six person cast, so every test here runs
 * against one. The old modal passed any test written against four speakers and
 * still fell over at a full one.
 */
afterEach(cleanup);

const CAST: RosterItem[] = [
  // Deliberately NOT in talk-time order, so a test asserting the default sort
  // can tell the difference between "sorted" and "happened to be right".
  { tag: "Speaker", colorTag: null, name: "Unassigned", turnCount: 3, talkSeconds: 12 },
  { tag: "SPEAKER_00", colorTag: "SPEAKER_00", name: "Ada", turnCount: 4, talkSeconds: 40 },
  { tag: "SPEAKER_01", colorTag: "SPEAKER_01", name: "Basil", turnCount: 90, talkSeconds: 900 },
  { tag: "SPEAKER_02", colorTag: "SPEAKER_02", name: "Cleo", turnCount: 12, talkSeconds: 300 },
  ...Array.from({ length: 22 }, (_, i) => ({
    tag: `SPEAKER_${10 + i}`,
    colorTag: `SPEAKER_${10 + i}`,
    name: `Extra ${i + 1}`,
    turnCount: 1,
    talkSeconds: 2,
  })),
];

function show(over: Partial<React.ComponentProps<typeof SpeakerRosterModal>> = {}) {
  const props = {
    roster: CAST,
    onRename: vi.fn(),
    onMergeMany: vi.fn(),
    onPlaySpeaker: vi.fn(),
    onApplyCast: vi.fn(),
    colorOf: () => "#FD8A8C",
    onPickColor: vi.fn(),
    onClose: vi.fn(),
  };
  render(<SpeakerRosterModal {...props} {...over} />);
  return props;
}

const rows = () => Array.from(document.querySelectorAll<HTMLElement>(".cp-spk-row"));
const namesShown = () =>
  rows().map((r) => (r.querySelector(".cp-spk-name") as HTMLInputElement).value);
const checkboxOf = (name: string) =>
  within(rows().find((r) =>
    (r.querySelector(".cp-spk-name") as HTMLInputElement).value === name,
  )!).getByRole("checkbox") as HTMLInputElement;

describe("SpeakerRosterModal at cast scale", () => {
  it("mounts no merge control until something is selected", () => {
    // THE regression this guards. Every row used to own a <select> listing
    // every other speaker: 26 arrays and ~650 option nodes rebuilt on each
    // render. If someone reintroduces a per-row select, this count explodes.
    show();
    expect(document.querySelectorAll("select")).toHaveLength(0);
    expect(document.querySelectorAll("option")).toHaveLength(0);

    fireEvent.click(checkboxOf("Ada"));
    expect(document.querySelectorAll("select")).toHaveLength(1);
  });

  it("merges every selected speaker in ONE call", () => {
    // Not N calls: the whole point is one undo step for one intent. A loop
    // calling a single-pair merge would pass a "did it merge?" test and still
    // leave the user pressing cmd+Z three times.
    const props = show();
    fireEvent.click(checkboxOf("Ada"));
    fireEvent.click(checkboxOf("Cleo"));
    fireEvent.change(document.querySelector("select")!, { target: { value: "SPEAKER_01" } });

    expect(props.onMergeMany).toHaveBeenCalledTimes(1);
    const [sources, target] = props.onMergeMany.mock.calls[0];
    expect([...sources].sort()).toEqual(["SPEAKER_00", "SPEAKER_02"]);
    expect(target).toBe("SPEAKER_01");
  });

  it("never offers a selected speaker as its own merge target", () => {
    show();
    fireEvent.click(checkboxOf("Ada"));
    fireEvent.click(checkboxOf("Cleo"));
    const options = Array.from(document.querySelectorAll("option")).map((o) => o.textContent);
    expect(options).not.toContain("Ada");
    expect(options).not.toContain("Cleo");
    expect(options).toContain("Basil");
    // …nor the untagged group, which has no alias to rewrite.
    expect(options).not.toContain("Unassigned");
  });

  it("refuses to select the untagged group as a merge source", () => {
    show();
    expect(checkboxOf("Unassigned").disabled).toBe(true);
    expect(checkboxOf("Ada").disabled).toBe(false);
  });

  it("clears the selection after a merge, so the bar cannot fire twice", () => {
    show();
    fireEvent.click(checkboxOf("Ada"));
    fireEvent.change(document.querySelector("select")!, { target: { value: "SPEAKER_01" } });
    expect(document.querySelectorAll("select")).toHaveLength(0);
  });

  it("sorts by talk time descending by default", () => {
    // The leads are who you opened this to name. Roster order would put a
    // two-line bit-part on top purely because the diarizer heard it first.
    show();
    expect(namesShown().slice(0, 3)).toEqual(["Basil", "Cleo", "Ada"]);
  });

  it("switches to alphabetical on demand", () => {
    show();
    fireEvent.click(screen.getByRole("tab", { name: "Name" }));
    const shown = namesShown();
    expect(shown[0]).toBe("Ada");
    expect(shown).toEqual([...shown].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })));
  });

  it("filters to the typed name and says so when nothing matches", () => {
    show();
    const filter = screen.getByLabelText("Filter speakers");
    fireEvent.change(filter, { target: { value: "cle" } });
    expect(namesShown()).toEqual(["Cleo"]);

    fireEvent.change(filter, { target: { value: "zzz" } });
    expect(rows()).toHaveLength(0);
    expect(screen.getByText(/No speaker matches/)).toBeTruthy();
  });

  it("takes focus into the filter on open", () => {
    show();
    expect(document.activeElement).toBe(screen.getByLabelText("Filter speakers"));
  });

  it("can play a speaker without leaving the modal", () => {
    // Before this the modal was a dead end for the one question it exists to
    // answer: which voice is this?
    const props = show();
    fireEvent.click(screen.getByRole("button", { name: "Play Cleo" }));
    expect(props.onPlaySpeaker).toHaveBeenCalledWith("SPEAKER_02");
  });

  it("commits a rename on blur, not on every keystroke", () => {
    const props = show();
    const field = rows().map((r) => r.querySelector(".cp-spk-name") as HTMLInputElement)
      .find((f) => f.value === "Ada")!;
    fireEvent.change(field, { target: { value: "Ada Lovelace" } });
    expect(props.onRename).not.toHaveBeenCalled();
    fireEvent.blur(field);
    expect(props.onRename).toHaveBeenCalledWith("SPEAKER_00", "Ada Lovelace");
  });
});
