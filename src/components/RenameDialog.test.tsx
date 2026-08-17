// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { RenameDialog } from "./RenameDialog";

/**
 * The rename dialog asks before it touches the disk, once.
 *
 * The preview has always shown old -> new NAMES, and that is exactly the
 * problem: a list of names reads like editing labels in a catalogue, and
 * nothing on it says the files themselves are being moved. A user who believes
 * they are renaming a library entry has not agreed to what Apply does.
 *
 * So the first Apply on an install stops at a step that says "on your Mac", and
 * every one after it goes straight through — because a warning shown every time
 * is a warning nobody reads. The tests below are about that asymmetry, and about
 * the checkbox meaning what it says in both directions.
 */

const ACK = "saucebunny.renameDiskAck";

const items = [
  { path: "/Users/me/Movies/a.mov", modifiedMs: 0, durationSec: null },
  { path: "/Users/me/Movies/b.mov", modifiedMs: 0, durationSec: null },
];

function setup(over: { items?: typeof items } = {}) {
  const onApply = vi.fn();
  const onCancel = vi.fn();
  render(
    <RenameDialog
      items={over.items ?? items}
      existingNames={[]}
      onCancel={onCancel}
      onApply={onApply}
      failures={new Map()}
    />,
  );
  return { onApply, onCancel };
}

/**
 * Type a pattern that changes every name, so Rename is enabled.
 *
 * fireEvent rather than user-event: the repo does not carry
 * @testing-library/user-event, and adding a dependency to click two buttons is
 * not a trade CLAUDE.md would make. A controlled input needs one change event,
 * which is all this does.
 */
function makeARealChange() {
  // {counter}, not {n}: an unknown token stays LITERAL by design, so "{n}" gives
  // every file the same name, which collides and leaves the plan invalid - and
  // Rename stays disabled. That is the module behaving correctly and my first
  // pattern being wrong.
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "renamed-{counter}" } });
}

afterEach(() => { cleanup(); localStorage.clear(); });

describe("the first rename on an install", () => {
  it("does NOT write until the disk warning is accepted", () => {
    const { onApply } = setup();
    makeARealChange();
    fireEvent.click(screen.getByRole("button", { name: /^Rename$/ }));
    expect(onApply, "the rename was applied before the warning was seen").not.toHaveBeenCalled();
    expect(screen.getByText(/on your Mac/i)).toBeTruthy();
  });

  it("says the files are moved, not merely relabelled", () => {
    // The whole point of the copy. "Rename 2 files" alone is what the user
    // already thought they were doing.
    setup();
    makeARealChange();
    fireEvent.click(screen.getByRole("button", { name: /^Rename$/ }));
    expect(screen.getByText(/not just their names in the library/i)).toBeTruthy();
  });

  it("also says what SURVIVES the rename", () => {
    // Without this the warning reads as "your notes may be lost", which is
    // frightening and untrue — repathIdentity carries the poster, the source
    // timecode and the review to the new name.
    setup();
    makeARealChange();
    fireEvent.click(screen.getByRole("button", { name: /^Rename$/ }));
    expect(screen.getByText(/follow the new name/i)).toBeTruthy();
  });

  it("keeps the preview visible while asking", () => {
    // The list is the thing being consented to; a dialog that covered it would
    // be asking the user to approve something they can no longer see.
    setup();
    makeARealChange();
    fireEvent.click(screen.getByRole("button", { name: /^Rename$/ }));
    expect(screen.getByText(/renamed-1/)).toBeTruthy();
  });

  it("writes once confirmed", () => {
    const { onApply } = setup();
    makeARealChange();
    fireEvent.click(screen.getByRole("button", { name: /^Rename$/ }));
    fireEvent.click(screen.getByRole("button", { name: /Rename 2 files/ }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toHaveLength(2);
  });

  it("Back returns to the preview without writing", () => {
    // A confirm step with no way out is a trap, and Escape closes the whole
    // dialog rather than the step.
    const { onApply } = setup();
    makeARealChange();
    fireEvent.click(screen.getByRole("button", { name: /^Rename$/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Back$/ }));
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^Rename$/ })).toBeTruthy();
  });

  it("names one file in the singular", () => {
    setup({ items: [items[0]] });
    makeARealChange();
    fireEvent.click(screen.getByRole("button", { name: /^Rename$/ }));
    expect(screen.getByText(/renames the file on your Mac/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Rename the file/ })).toBeTruthy();
  });
});

describe("don't warn me again", () => {
  it("persists only when the box is CHECKED", () => {
    setup();
    makeARealChange();
    fireEvent.click(screen.getByRole("button", { name: /^Rename$/ }));
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /Rename 2 files/ }));
    expect(localStorage.getItem(ACK)).toBe("true");
  });

  it("does NOT persist when the box is left alone", () => {
    // Confirming once must not quietly opt the user out of every future
    // warning; that is the failure mode of a checkbox nobody ticked.
    setup();
    makeARealChange();
    fireEvent.click(screen.getByRole("button", { name: /^Rename$/ }));
    fireEvent.click(screen.getByRole("button", { name: /Rename 2 files/ }));
    expect(localStorage.getItem(ACK), "the ack was stored without being asked for").toBeNull();
  });

  it("skips the warning entirely on a later install-wide rename", () => {
    // The other half of the asymmetry: once acknowledged, Rename writes
    // immediately. A warning on every rename is one nobody reads.
    localStorage.setItem(ACK, "true");
    const { onApply } = setup();
    makeARealChange();
    fireEvent.click(screen.getByRole("button", { name: /^Rename$/ }));
    expect(onApply, "an acknowledged install still stopped to warn").toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/on your Mac/i)).toBeNull();
  });
});

describe("the warning cannot be reached for a no-op", () => {
  it("stays unreachable while Rename is disabled", () => {
    // An unchanged pattern leaves Apply disabled, so there is nothing to warn
    // about. Asking for consent to do nothing trains the user to click through.
    setup();
    const foot = screen.getByRole("button", { name: /^Rename$/ });
    // No jest-dom in this repo, so the DOM property rather than toBeDisabled().
    expect((foot as HTMLButtonElement).disabled).toBe(true);
    expect(within(document.body).queryByText(/on your Mac/i)).toBeNull();
  });
});
