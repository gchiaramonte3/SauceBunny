// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { RenamePopover, type RenameState } from "./RenamePopover";
import { BADGE_ICONS } from "./badge-icons";

afterEach(cleanup);
beforeEach(() => localStorage.clear());

const RECT = { top: 100, bottom: 120, left: 200, right: 260, width: 60, height: 20 } as DOMRect;

const STATE: RenameState = {
  turnIdx: 3,
  originalTag: "SPEAKER_02",
  currentName: "Harry Jowsey",
  rect: RECT,
};

function show(over: Partial<React.ComponentProps<typeof RenamePopover>> = {}) {
  const props = {
    state: STATE,
    onCancel: vi.fn(),
    onApply: vi.fn(),
    onPickIcon: vi.fn(),
    iconValue: null,
    ...over,
  };
  render(<RenamePopover {...props} />);
  return props;
}

const rowButtons = () =>
  Array.from(document.querySelectorAll(".cp-tx-rename-icon")) as HTMLButtonElement[];
const hint = () => document.querySelector(".cp-tx-rename-iconhint")?.textContent;
const sheet = () => document.querySelector(".cp-badgesheet") as HTMLElement | null;
const plus = () => screen.getByTitle("All icons");

describe("the icon row", () => {
  it("is not there at all when the parent cannot accept an icon", () => {
    show({ onPickIcon: undefined });
    expect(rowButtons()).toHaveLength(0);
  });

  it("fills its width: initials, four kinds, four recents, and the plus", () => {
    // The complaint that started this. Five circles in a 300px row read as an
    // unfinished control, not as a deliberate shortlist.
    show();
    expect(rowButtons()).toHaveLength(10);
  });

  it("offers the four non-speech kinds by name", () => {
    show();
    for (const label of ["Music", "Lyrics", "Sound effects", "Inaudible"]) {
      expect(screen.getByTitle(label)).toBeTruthy();
    }
  });

  it("names an icon on hover, instantly and in one fixed place", () => {
    // `title` alone does not answer "what is this": it waits about a second,
    // follows the cursor, and never fires for keyboard focus.
    show();
    fireEvent.mouseEnter(screen.getByTitle("Music"));
    expect(hint()).toBe("Music");
    fireEvent.mouseEnter(screen.getByTitle("Sound effects"));
    expect(hint()).toBe("Sound effects");
  });

  it("names an icon on keyboard focus too", () => {
    show();
    fireEvent.focus(screen.getByTitle("Lyrics"));
    expect(hint()).toBe("Lyrics");
  });

  it("rests on the CURRENT choice rather than going blank", () => {
    show({ iconValue: "crown" });
    expect(hint()).toBe("Lead");
  });

  it("calls the current state Automatic, not Initials, when nothing was picked", () => {
    // With no explicit pick the badge is DERIVED — a group called "Music" shows
    // a note under exactly this value, so "Initials" would be a claim the badge
    // beside it visibly contradicts.
    show({ iconValue: null });
    expect(hint()).toBe("Automatic");
    cleanup();
    show({ iconValue: "none" });
    expect(hint()).toBe("Initials");
  });

  it("hands back the id it was asked for", () => {
    const props = show();
    fireEvent.click(screen.getByTitle("Music"));
    expect(props.onPickIcon).toHaveBeenCalledWith("music");
  });

  it("hands back null for initials, which is the way back", () => {
    const props = show();
    fireEvent.click(screen.getByTitle("Initials"));
    expect(props.onPickIcon).toHaveBeenCalledWith(null);
  });

  it("marks the chosen one, and only it", () => {
    show({ iconValue: "music" });
    const picked = rowButtons().filter((b) => b.className.includes("picked"));
    expect(picked).toHaveLength(1);
    expect(picked[0].title).toBe("Music");
  });

  it("always carries the icon this speaker is already wearing", () => {
    // Otherwise a speaker whose icon has aged out of recents opens a row where
    // nothing is ringed, while the badge beside it plainly shows one.
    show({ iconValue: "coffee" });
    const worn = rowButtons().find((b) => b.title === "Break");
    expect(worn).toBeTruthy();
    expect(worn!.className).toContain("picked");
    expect(rowButtons()).toHaveLength(10); // it displaces, it does not append
  });

  it("does not duplicate the worn icon when it is already a recent", () => {
    show({ iconValue: "mic" });
    expect(rowButtons().filter((b) => b.title === "Host")).toHaveLength(1);
    expect(rowButtons()).toHaveLength(10);
  });
});

describe("the sheet behind the plus", () => {
  it("is closed until asked for", () => {
    show();
    expect(sheet()).toBeNull();
  });

  it("opens, and offers the whole catalogue", () => {
    show();
    fireEvent.click(plus());
    const box = sheet();
    expect(box).toBeTruthy();
    // Every catalogue entry plus the initials row.
    expect(within(box!).getAllByRole("button")).toHaveLength(BADGE_ICONS.length + 1);
  });

  it("closes again on a second press of the plus", () => {
    show();
    fireEvent.click(plus());
    fireEvent.click(plus());
    expect(sheet()).toBeNull();
  });

  it("narrows to a search, and says so when nothing matches", () => {
    show();
    fireEvent.click(plus());
    const search = screen.getByPlaceholderText("Search icons");
    fireEvent.change(search, { target: { value: "phone" } });
    expect(within(sheet()!).getAllByRole("button").length).toBeLessThan(BADGE_ICONS.length);
    expect(within(sheet()!).getByTitle("Phone")).toBeTruthy();
    fireEvent.change(search, { target: { value: "zzzz" } });
    expect(within(sheet()!).getByText("No icon matches that")).toBeTruthy();
  });

  it("takes the best match on Enter, so a search finishes on the keyboard", () => {
    const props = show();
    fireEvent.click(plus());
    const search = screen.getByPlaceholderText("Search icons");
    fireEvent.change(search, { target: { value: "crown" } });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(props.onPickIcon).toHaveBeenCalledWith("crown");
  });

  it("names an icon in its own strip on hover", () => {
    show();
    fireEvent.click(plus());
    const strip = () => document.querySelector(".cp-badgesheet-hint")?.textContent;
    expect(strip()).toBe("Hover an icon to see what it is");
    fireEvent.mouseEnter(within(sheet()!).getByTitle("Careful"));
    expect(strip()).toBe("Careful");
  });

  it("picks, closes, and promotes the pick into the row", () => {
    // The row is how the sheet stays worth opening once: what you reach for
    // ends up one press away next time.
    const props = show();
    expect(screen.queryByTitle("Lead")).toBeNull();
    fireEvent.click(plus());
    fireEvent.click(within(sheet()!).getByTitle("Lead"));
    expect(props.onPickIcon).toHaveBeenCalledWith("crown");
    expect(sheet()).toBeNull();
    expect(screen.getByTitle("Lead")).toBeTruthy();
    expect(rowButtons()).toHaveLength(10); // still exactly ten
  });

  it("does not let a kind picked from the sheet displace a recent", () => {
    show();
    const before = rowButtons().map((b) => b.title);
    fireEvent.click(plus());
    fireEvent.click(within(sheet()!).getByTitle("Music"));
    expect(rowButtons().map((b) => b.title)).toEqual(before);
  });

  it("carries the way back to initials, so the sheet is self-sufficient", () => {
    const props = show({ iconValue: "crown" });
    fireEvent.click(plus());
    fireEvent.click(within(sheet()!).getByTitle("Initials"));
    expect(props.onPickIcon).toHaveBeenCalledWith(null);
  });
});

describe("the icon row holds still", () => {
  it("does not re-order when you pick from it", () => {
    // Reported: "when I click the icons they move around". Picking promoted the
    // icon to the front of recents and fed that straight back into state, so
    // the buttons swapped under the cursor and a second pick landed somewhere
    // other than where it was aimed. A control has to stay put while in use.
    const props = show();
    const order = () => rowButtons().map((b) => b.getAttribute("title") ?? "");
    const before = order();
    const star = rowButtons().find((b) => /star/i.test(b.getAttribute("title") ?? ""));
    expect(star, "no star in the default row").toBeTruthy();
    fireEvent.click(star!);
    expect(props.onPickIcon, "the pick never reached the handler").toHaveBeenCalled();
    expect(order(), "the row re-ordered under the cursor").toEqual(before);
  });

  it("still records the use, so the order settles on the NEXT open", () => {
    // Freezing the row must not throw the recency away: it is persisted now and
    // applied when the popover reopens, which is when moving costs nothing.
    show();
    const star = rowButtons().find((b) => /star/i.test(b.getAttribute("title") ?? ""));
    fireEvent.click(star!);
    expect(localStorage.getItem("saucebunny.badgeIconRecents"), "the use was not recorded")
      .toContain("star");
  });
});
