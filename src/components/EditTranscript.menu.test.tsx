// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createFrameStore } from "../lib/frame-store";
import { paragraphs, placeWords, recordOrder, type TimelineWord } from "../lib/edit-model";
import { EditTranscript, type EditSelection } from "./EditTranscript";

afterEach(cleanup);

const word = (id: string, track: string, start: number, text: string, cue: string): TimelineWord =>
  ({ id, source: "s1", track, text, start, end: start + 0.4, cue });
// Jordan's line plays; Brandon, beside him in the clip, is muted for all of it (Focus on Marked Lines).
const words = [word("j1", "jordan", 1, "These", "j"), word("b1", "brandon", 1.2, "Go", "b"), word("j2", "jordan", 1.5, "two", "j"), word("b2", "brandon", 1.7, "girl", "b")];
const timeline = { segments: [{ id: "a", source: "s1", srcIn: 0, srcOut: 5, tracks: ["jordan", "brandon"] }], mutes: [{ source: "s1", track: "brandon", srcIn: 0, srcOut: 5 }] };

function draw(selection: EditSelection = { anchor: 0, focus: 0, collapsed: true }, ghosts: [] | null = []) {
  const placed = recordOrder(placeWords(words, timeline));
  const onDelete = vi.fn(), onSelect = vi.fn();
  render(<EditTranscript speakers={[{ id: "jordan", name: "JORDAN", track: 1 }, { id: "brandon", name: "BRANDON", track: 2 }]} colors={{}} fps={24} recordStart={86400}
    paragraphs={paragraphs(placed)} placed={placed} selection={selection} frames={createFrameStore(0)} sourceLabel={() => "HEAT 1"}
    seams={{}} seam={null} onSeam={() => undefined} ghosts={ghosts} onRestore={() => undefined} corrections={{}} editing={null} onCorrect={() => undefined}
    onSelect={onSelect} onDelete={onDelete} onScrub={() => undefined} onMove={() => undefined} onEdit={() => undefined} />);
  return { placed, onDelete, onSelect };
}

it("a right-click on a muted line offers Unmute, for that person's line", () => {
  const { placed, onDelete, onSelect } = draw();
  fireEvent.contextMenu(screen.getByText("girl"));
  const unmute = screen.getByRole("menuitem", { name: "Unmute" });
  expect(screen.getByRole("menu", { name: "BRANDON's line" })).toBeTruthy();
  fireEvent.click(unmute);
  // Brandon's whole phrase, never Jordan's words beside it.
  const [from, to] = onDelete.mock.calls[0][1] as [number, number];
  expect(onDelete).toHaveBeenCalledWith(true, [from, to]);
  expect(placed.slice(from, to + 1).map((item) => item.word.text)).toEqual(["Go", "girl"]);
  expect(onSelect).toHaveBeenCalledWith({ anchor: from, focus: to, collapsed: false }, false);
  expect(screen.queryByRole("menu")).toBeNull();
});

it("a right-click on a line that plays offers Mute, and a Control-click does not move the caret first", () => {
  const { placed, onDelete, onSelect } = draw();
  fireEvent.pointerDown(screen.getByText("two"), { button: 0, ctrlKey: true });
  expect(onSelect).not.toHaveBeenCalled();
  fireEvent.contextMenu(screen.getByText("two"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Mute" }));
  const [from, to] = onDelete.mock.calls[0][1] as [number, number];
  expect(placed.slice(from, to + 1).map((item) => item.word.text)).toEqual(["These", "two"]);
});

it("inside a selection, the menu acts on the selection", () => {
  const { onDelete } = draw({ anchor: 0, focus: 3, collapsed: false });
  fireEvent.contextMenu(screen.getByText("These"));
  fireEvent.click(screen.getByRole("menuitem", { name: "Mute" }));
  expect(onDelete).toHaveBeenCalledWith(true, [0, 3]);
});

it("hides a line nobody hears unless removed lines are shown", () => {
  draw(undefined, null);
  expect(screen.queryByText("girl")).toBeNull();
  expect(screen.getByText("These")).toBeTruthy();
});
