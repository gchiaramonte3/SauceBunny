// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CueSelectionMenu } from "./CueSelectionMenu";

// This repo does not run vitest with `globals: true`, so RTL never registers
// its auto-cleanup and renders pile up in one document. Without this the
// four-speaker cases leave eight rows behind and the big-cast cases "find"
// them, which reads as the component failing to collapse.
afterEach(cleanup);

/**
 * A cue menu that stayed usable when the cast got big.
 *
 * Reported from a documentary with a lot of speakers: one "Assign to …" row
 * per person, inline, so the menu ran past the bottom of the screen and Play
 * and Clear speaker were somewhere below the desk. Two things were wrong and
 * only one of them was the length.
 *
 * The other was the order. This call site passed the roster's own order, which
 * is FIRST APPEARANCE, while every other speaker surface in the app sorts by
 * talk time — so the menu showed Speaker 16 above Speaker 8 whenever 16 spoke
 * first, and scattered the people you had named among the ones you had not.
 * The component's prop doc claimed the list arrived "already display-named and
 * ordered" the whole time, which is why nobody looked.
 */

const mk = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    tag: `SPEAKER_${i}`, name: `Speaker ${i + 1}`, color: "#888",
  }));

function open(count: number, extra: Partial<Parameters<typeof CueSelectionMenu>[0]> = {}) {
  const onAssign = vi.fn();
  render(
    <CueSelectionMenu
      anchor={{ x: 10, y: 10 }}
      cueCount={1}
      speakers={mk(count)}
      currentTag={null}
      onAssign={onAssign}
      onNewSpeaker={() => {}}
      onPlay={() => {}}
      onClose={() => {}}
      {...extra}
    />,
  );
  return { onAssign };
}

const labels = () => screen.getAllByRole("menuitem").map((b) => b.textContent ?? "");

describe("CueSelectionMenu with a small cast", () => {
  it("lists everyone inline — a flat list is one click and beats a submenu", () => {
    open(4);
    expect(labels().filter((t) => /^Assign to Speaker/.test(t))).toHaveLength(4);
    expect(screen.queryByText(/Assign to speaker \(/)).toBeNull();
  });

  it("still shows the verbs that are not reassignment", () => {
    open(4);
    expect(labels().some((t) => /a new speaker/.test(t))).toBe(true);
    expect(labels().some((t) => /^Play /.test(t))).toBe(true);
  });
});

describe("CueSelectionMenu with a big cast", () => {
  it("collapses into one submenu row past the threshold", () => {
    open(12);
    // One row, not twelve, and it says how many are behind it.
    expect(labels().filter((t) => /^Assign to Speaker \d/.test(t))).toHaveLength(0);
    const row = screen.getByRole("menuitem", { name: /Assign to speaker \(12\)/ });
    expect(row.getAttribute("aria-haspopup")).toBe("menu");
    expect(row.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps Play and Clear reachable, which is the point of collapsing", () => {
    // The actual complaint: the useful verbs were pushed off the end.
    open(30, { currentTag: "SPEAKER_0" });
    expect(labels().some((t) => /^Play /.test(t))).toBe(true);
    expect(labels().some((t) => /Clear speaker/.test(t))).toBe(true);
  });

  it("opens the flyout on click and assigns from it", () => {
    const { onAssign } = open(12);
    fireEvent.click(screen.getByRole("menuitem", { name: /Assign to speaker/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Speaker 3" }));
    expect(onAssign).toHaveBeenCalledWith("SPEAKER_2");
  });

  it("opens on ArrowRight, for a menu reached by keyboard", () => {
    open(12);
    const row = screen.getByRole("menuitem", { name: /Assign to speaker/ });
    fireEvent.keyDown(row, { key: "ArrowRight" });
    expect(row.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByLabelText("Filter speakers")).toBeTruthy();
  });

  it("filters to the person you are typing", () => {
    open(30);
    fireEvent.click(screen.getByRole("menuitem", { name: /Assign to speaker/ }));
    fireEvent.change(screen.getByLabelText("Filter speakers"), { target: { value: "Speaker 17" } });
    const rows = screen.getAllByRole("menuitem").map((b) => b.textContent ?? "");
    expect(rows).toContain("Speaker 17");
    expect(rows).not.toContain("Speaker 3");
  });

  it("says so when nothing matches, rather than showing an empty panel", () => {
    open(12);
    fireEvent.click(screen.getByRole("menuitem", { name: /Assign to speaker/ }));
    fireEvent.change(screen.getByLabelText("Filter speakers"), { target: { value: "zzz" } });
    expect(screen.getByText(/No speaker matches/)).toBeTruthy();
  });

  it("never offers the speaker the selection already has", () => {
    open(12, { currentTag: "SPEAKER_0" });
    // 12 speakers minus the current one = 11 behind the submenu.
    expect(screen.getByRole("menuitem", { name: /Assign to speaker \(11\)/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: /Assign to speaker/ }));
    expect(screen.queryByRole("menuitem", { name: "Speaker 1" })).toBeNull();
  });

  it("Escape backs out of the flyout without discarding the selection", () => {
    // Two panels, one Escape each. Closing both at once would throw away the
    // lasso the user is still working on, which is the expensive half.
    const onClose = vi.fn();
    open(12, { onClose });
    fireEvent.click(screen.getByRole("menuitem", { name: /Assign to speaker/ }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose, "the whole menu closed on the first Escape").not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Filter speakers")).toBeNull();
  });
});
