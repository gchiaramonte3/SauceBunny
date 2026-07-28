// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CastApply } from "./CastApply";
import { newCast, newMember } from "../../lib/cast";
import type { RosterItem } from "./SpeakerRosterModal";

afterEach(cleanup);

const CAST = newCast("The Show", [
  newMember("Ada", "#FD8A8C"),
  newMember("Basil", "#0AF2CD"),
  newMember("Cleo", "#FBD509"),
]);

const ROSTER: RosterItem[] = [
  { tag: "Speaker", colorTag: null, name: "Unassigned", turnCount: 2, talkSeconds: 10 },
  { tag: "S0", colorTag: "S0", name: "SPEAKER_00", turnCount: 4, talkSeconds: 40 },
  { tag: "S1", colorTag: "S1", name: "Basil", turnCount: 9, talkSeconds: 400 },
];

function show(over: Partial<React.ComponentProps<typeof CastApply>> = {}) {
  const props = { cast: CAST, roster: ROSTER, onCommit: vi.fn(), onBack: vi.fn() };
  render(<CastApply {...props} {...over} />);
  return props;
}

const selects = () => Array.from(document.querySelectorAll<HTMLSelectElement>("select"));
const selectFor = (name: string) =>
  screen.getByLabelText(`Cast member for ${name}`) as HTMLSelectElement;
const apply = () => screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement;

describe("CastApply", () => {
  it("orders speakers by talk time, so the leads are assigned first", () => {
    show();
    const labels = Array.from(document.querySelectorAll(".cp-cast-from")).map((e) => e.textContent);
    expect(labels).toEqual(["Basil", "SPEAKER_00"]);
  });

  it("offers no row for the untagged bucket", () => {
    // It is a bucket, not a person: naming it would put a cast member's name
    // on every scrap the diarizer could not attribute.
    show();
    expect(selects()).toHaveLength(2);
    expect(screen.queryByLabelText("Cast member for Unassigned")).toBeNull();
  });

  it("pre-fills only the exact name match", () => {
    show();
    expect(selectFor("Basil").value).toBe(CAST.members[1].id);
    // A fresh diarizer tag matches nothing, and must not be guessed at.
    expect(selectFor("SPEAKER_00").value).toBe("");
  });

  it("hides a member already spoken for, but keeps it in its own row", () => {
    show();
    const free = Array.from(selectFor("SPEAKER_00").options).map((o) => o.textContent);
    expect(free).not.toContain("Basil"); // taken by the auto-match
    expect(free).toEqual(expect.arrayContaining(["Ada", "Cleo", "Leave as is"]));
    // The row holding the match still lists it, or you could not see or change it.
    expect(Array.from(selectFor("Basil").options).map((o) => o.textContent)).toContain("Basil");
  });

  it("commits the names AND colours of what was assigned", () => {
    const props = show();
    fireEvent.change(selectFor("SPEAKER_00"), { target: { value: CAST.members[0].id } });
    fireEvent.click(apply());
    expect(props.onCommit).toHaveBeenCalledTimes(1);
    const [names, colors, castName] = props.onCommit.mock.calls[0];
    expect(names).toEqual({ S0: "Ada", S1: "Basil" });
    expect(colors).toEqual({ S0: "#FD8A8C", S1: "#0AF2CD" });
    expect(castName).toBe("The Show");
  });

  it("omits a speaker set back to 'Leave as is'", () => {
    // Un-assigning has to mean the speaker keeps the name it already has,
    // rather than being blanked by an empty write. Overriding a WRONG
    // auto-match is the main reason this is a review step at all.
    const props = show();
    fireEvent.change(selectFor("SPEAKER_00"), { target: { value: CAST.members[0].id } });
    fireEvent.change(selectFor("Basil"), { target: { value: "" } });
    fireEvent.click(apply());
    const [names, colors] = props.onCommit.mock.calls[0];
    expect(names).toEqual({ S0: "Ada" });
    expect(colors).toEqual({ S0: "#FD8A8C" });
  });

  it("frees a member again when the row that held it is cleared", () => {
    show();
    expect(Array.from(selectFor("SPEAKER_00").options).map((o) => o.textContent)).not.toContain("Basil");
    fireEvent.change(selectFor("Basil"), { target: { value: "" } });
    expect(Array.from(selectFor("SPEAKER_00").options).map((o) => o.textContent)).toContain("Basil");
  });

  it("cannot apply when nothing is assigned", () => {
    const bare = newCast("Empty-ish", [newMember("Nobody", "#FD8A8C")]);
    const props = show({ cast: bare });
    expect(apply().disabled).toBe(true);
    fireEvent.click(apply());
    expect(props.onCommit).not.toHaveBeenCalled();
  });

  it("says what will happen before it happens", () => {
    show();
    expect(screen.getByText("1 of 2 will be renamed")).toBeTruthy();
    fireEvent.change(selectFor("SPEAKER_00"), { target: { value: CAST.members[0].id } });
    expect(screen.getByText("2 of 2 will be renamed")).toBeTruthy();
  });

  it("explains an empty auto-match rather than looking broken", () => {
    const props = show({ roster: [{ tag: "S0", colorTag: "S0", name: "SPEAKER_00", turnCount: 1, talkSeconds: 5 }] });
    expect(screen.getByText(/Nothing matched by name/)).toBeTruthy();
    expect(props.onCommit).not.toHaveBeenCalled();
  });
});
