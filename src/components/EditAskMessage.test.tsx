// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AskMessage } from "../lib/edit-ask";
import { EditAskMessage } from "./EditAskMessage";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const line = { track: "t1", text: "My brother always won.", wordIds: ["w1"] } as unknown as AskMessage["lines"][number];
const props = { colors: {}, where: () => "DONNIE · 21:10:05:00", busy: false, onJump: () => undefined, onApply: () => undefined, onOpen: () => undefined };

it("copies a question, puts it back to edit, and runs it again", async () => {
  const writeText = vi.fn(() => Promise.resolve());
  Object.assign(navigator, { clipboard: { writeText } });
  const onRun = vi.fn(), onEdit = vi.fn();
  render(<EditAskMessage {...props} message={{ id: "q", role: "you", text: "@DONNY who is the better twin?", lines: [], action: null }} onRun={onRun} onEdit={onEdit} />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy" })); });
  expect(writeText).toHaveBeenCalledWith("@DONNY who is the better twin?");
  expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.click(screen.getByRole("button", { name: "Run again" }));
  expect([onEdit.mock.calls.length, onRun.mock.calls.length]).toEqual([1, 1]);
});

it("copies an answer with the lines it cites, and offers Try again only when it failed", async () => {
  const writeText = vi.fn(() => Promise.resolve());
  Object.assign(navigator, { clipboard: { writeText } });
  const view = render(<EditAskMessage {...props} message={{ id: "a", role: "ask", text: "Donnie brings it up first.", lines: [line], action: null }} />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy" })); });
  expect(writeText).toHaveBeenCalledWith("Donnie brings it up first.\nDONNIE · 21:10:05:00  My brother always won.");
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  view.rerender(<EditAskMessage {...props} message={{ id: "a", role: "ask", text: "ChatGPT error 400", lines: [], action: null, failed: true }} onRun={() => undefined} />);
  expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
});

it("shows a story cut beat by beat with its running time, and builds it as a new string out", () => {
  const cite = (id: string, from: number, to: number, text: string) => ({ source: "s1", track: "t1", from, to, text, wordIds: [id] });
  const message: AskMessage = { id: "c", role: "ask", text: "Opens on the bet, pays off at the fall.", lines: [], action: { kind: "cut", title: "The bet", target: 60, beats: [
    { title: "The bet", purpose: "Donnie bets dinner.", lines: [cite("w1", 10, 12, "We bet dinner."), cite("w2", 13, 14, "You're on.")] },
    { title: "The fall", purpose: "", lines: [cite("w3", 200, 201, "Pay up.")] },
  ] } };
  const onApply = vi.fn();
  render(<EditAskMessage {...props} message={message} onApply={onApply} />);
  // 10 to 14 is one stretch (4 s), 200 to 201 another (1 s), each with 0.75 s of handles, and a second's pause between beats.
  expect(screen.getByText('Cut "The bet": about 0:08 of 1:00 asked for, 2 beats, 3 lines')).toBeTruthy();
  expect(screen.getByText("1. The bet · 0:05")).toBeTruthy();
  expect(screen.getByText("Donnie bets dinner.")).toBeTruthy();
  expect(screen.getByText("2. The fall · 0:02")).toBeTruthy();
  expect(screen.getByText("Pay up.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Make new string out" }));
  expect(onApply).toHaveBeenCalledWith(message, "new");
  expect(screen.getByRole("button", { name: "Replace this one" })).toBeTruthy();
});
