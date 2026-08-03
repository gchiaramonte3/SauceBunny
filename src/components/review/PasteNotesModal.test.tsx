// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PasteNotesModal } from "./PasteNotesModal";

afterEach(cleanup);

function show(over: Partial<React.ComponentProps<typeof PasteNotesModal>> = {}) {
  const onImport = vi.fn();
  const onClose = vi.fn();
  render(
    <PasteNotesModal
      durationSec={185} fps={30} defaultAuthor="Gasper"
      onImport={onImport} onClose={onClose}
      {...over}
    />,
  );
  return { onImport, onClose };
}

const paste = (text: string) =>
  fireEvent.change(screen.getByPlaceholderText(/Paste from a Google Doc/), { target: { value: text } });
const importBtn = () =>
  screen.getByRole("button", { name: /Import/ }) as HTMLButtonElement;
const rows = () => Array.from(document.querySelectorAll(".cp-pastenotes-row"));

describe("PasteNotesModal", () => {
  it("starts empty with import disabled", () => {
    show();
    expect(rows()).toHaveLength(0);
    expect(importBtn().disabled).toBe(true);
  });

  it("previews each pasted line with its parsed anchor", () => {
    show();
    paste("00:05 - too sparse here\n2:52 - 3:00, reorder these shots\nAt the end, add the bites?");
    expect(rows()).toHaveLength(3);
    const tcs = rows().map((r) => r.querySelector(".cp-pastenotes-tc")?.textContent);
    expect(tcs[0]).toBe("0:05");
    expect(tcs[1]).toBe("2:52-3:00");
    expect(tcs[2]).toBe("General");
  });

  it("default-unchecks sheet furniture but keeps it visible", () => {
    // The paste is often the WHOLE sheet. Headers ride along; they must not
    // become comments, and must not silently vanish either.
    show();
    paste("STORY NOTES\n00:05 - a real note");
    const boxes = rows().map((r) => r.querySelector("input") as HTMLInputElement);
    expect(boxes[0].checked).toBe(false);
    expect(boxes[1].checked).toBe(true);
    expect(importBtn().textContent).toBe("Import 1 note");
  });

  it("lets a row be toggled, and the count follows", () => {
    show();
    paste("00:05 - keep\n00:10 - skip this one");
    fireEvent.click(rows()[1].querySelector("input")!);
    expect(importBtn().textContent).toBe("Import 1 note");
  });

  it("imports only the ticked rows, with parsed anchors", () => {
    const props = show();
    paste("00:05 - keep\nNOTE\n00:21 -00:43 - a range");
    fireEvent.click(importBtn());
    expect(props.onImport).toHaveBeenCalledTimes(1);
    const [imported, author] = props.onImport.mock.calls[0];
    expect(imported).toEqual([
      { startSec: 5, endSec: null, body: "keep" },
      { startSec: 21, endSec: 43, body: "a range" },
    ]);
    expect(author).toBe("Gasper");
  });

  it("hands over the edited author name", () => {
    // The notes are usually someone ELSE'S words; the signature must be able
    // to say so.
    const props = show();
    paste("00:05 - note");
    fireEvent.change(screen.getByPlaceholderText("Gasper"), { target: { value: "Nika" } });
    fireEvent.click(importBtn());
    expect(props.onImport.mock.calls[0][1]).toBe("Nika");
  });

  it("falls back to the default author when the field is blanked", () => {
    const props = show();
    paste("00:05 - note");
    fireEvent.change(screen.getByPlaceholderText("Gasper"), { target: { value: "   " } });
    fireEvent.click(importBtn());
    expect(props.onImport.mock.calls[0][1]).toBe("Gasper");
  });

  it("clears stale row toggles when the text changes", () => {
    // Indexes mean nothing across a re-paste; a kept override would untick an
    // arbitrary different note.
    show();
    paste("00:05 - a\n00:10 - b");
    fireEvent.click(rows()[1].querySelector("input")!); // skip "b"
    paste("00:07 - c\n00:12 - d");
    const boxes = rows().map((r) => r.querySelector("input") as HTMLInputElement);
    expect(boxes.every((b) => b.checked)).toBe(true);
  });

  it("closes on Escape", () => {
    const props = show();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalled();
  });
});
