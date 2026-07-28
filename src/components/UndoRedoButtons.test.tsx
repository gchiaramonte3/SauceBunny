// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { UndoRedoButtons } from "./UndoRedoButtons";
import { appUndo } from "../lib/undo";

/**
 * The stack has existed since marks and review comments; the only ways to
 * reach it were cmd+Z and the command palette, so a user who did not already
 * know it was there had no reason to believe it was. These assert what a user
 * can actually see and press.
 */
beforeEach(() => appUndo.clear());
afterEach(cleanup);

const undoBtn = () => screen.getByRole("button", { name: /^Undo/ }) as HTMLButtonElement;
const redoBtn = () => screen.getByRole("button", { name: /^Redo/ }) as HTMLButtonElement;

describe("UndoRedoButtons", () => {
  it("is disabled with an empty stack, and says why", () => {
    render(<UndoRedoButtons />);
    expect(undoBtn().disabled).toBe(true);
    expect(redoBtn().disabled).toBe(true);
    expect(undoBtn().getAttribute("title")).toBe("Nothing to undo");
  });

  it("NAMES the action it will reverse", () => {
    // The point of the labels. "Undo merge speakers" is the difference between
    // pressing it and hoping, and pressing it because you can see it is the
    // thing you meant — and a screen reader gets the same sentence.
    render(<UndoRedoButtons />);
    act(() => appUndo.push({ label: "merge speakers", undo: () => {}, redo: () => {} }));
    expect(undoBtn().disabled).toBe(false);
    expect(undoBtn().getAttribute("title")).toBe("Undo merge speakers");
    expect(undoBtn().getAttribute("aria-label")).toBe("Undo merge speakers");
  });

  it("tracks the stack live, without a prop", () => {
    render(<UndoRedoButtons />);
    act(() => appUndo.push({ label: "rename speaker", undo: () => {}, redo: () => {} }));
    expect(undoBtn().disabled).toBe(false);
    expect(redoBtn().disabled).toBe(true);

    act(() => { appUndo.undo(); });
    expect(undoBtn().disabled).toBe(true);
    expect(redoBtn().disabled).toBe(false);
    expect(redoBtn().getAttribute("title")).toBe("Redo rename speaker");
  });

  it("actually runs the entry", () => {
    const undo = vi.fn();
    const redo = vi.fn();
    render(<UndoRedoButtons />);
    act(() => appUndo.push({ label: "reset all speaker names", undo, redo }));
    act(() => { undoBtn().click(); });
    expect(undo).toHaveBeenCalledOnce();
    act(() => { redoBtn().click(); });
    expect(redo).toHaveBeenCalledOnce();
  });

  it("defers to the host's handlers when given them", () => {
    // App passes its own so the toolbar button and cmd+Z are one action —
    // same toast, same draft-first fallback in the review composer.
    const onUndo = vi.fn();
    const entryUndo = vi.fn();
    render(<UndoRedoButtons onUndo={onUndo} />);
    act(() => appUndo.push({ label: "x", undo: entryUndo, redo: () => {} }));
    act(() => { undoBtn().click(); });
    expect(onUndo).toHaveBeenCalledOnce();
    expect(entryUndo).not.toHaveBeenCalled();
  });

  it("is a labelled group, so the pair is one thing to a screen reader", () => {
    render(<UndoRedoButtons />);
    expect(screen.getByRole("group", { name: "Undo and redo" })).toBeTruthy();
  });
});
