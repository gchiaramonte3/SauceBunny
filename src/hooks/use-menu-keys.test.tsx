// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useMenuKeys } from "./use-menu-keys";

/**
 * Eleven menus were built as role="menu" holding role="menuitem" buttons, and
 * two of them handled an arrow key. role="menu" is a promise: a screen reader
 * that meets one puts its user into menu navigation and tells them to arrow.
 * A menu that only answers Tab has advertised a model it does not implement,
 * and plain buttons would have been more accessible than the role.
 */

const ITEMS = ["Rename", "Reveal", "Duplicate", "Delete"];

function Menu({ onClose = () => {}, disabled = [] as string[], checked = "" }) {
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  useMenuKeys(ref, open, () => { setOpen(false); onClose(); });
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>Open</button>
      <button type="button">After</button>
      {open && (
        <div ref={ref} role="menu" aria-label="Row actions">
          {ITEMS.map((label) => (
            <button
              key={label}
              type="button"
              role={checked ? "menuitemradio" : "menuitem"}
              aria-checked={checked ? label === checked : undefined}
              disabled={disabled.includes(label)}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

const focused = () => (document.activeElement as HTMLElement | null)?.textContent ?? "NONE";
/** Focus the trigger THEN click, which is what a real click does - jsdom's
 *  .click() moves no focus, and a menu that captured <body> as its opener
 *  would look fine here while dropping focus in the browser. */
const openMenu = () => act(() => {
  const t = screen.getByText("Open");
  t.focus();
  t.click();
});
const key = (k: string) => act(() => {
  fireEvent.keyDown(screen.getByRole("menu"), { key: k, bubbles: true });
});

afterEach(cleanup);

describe("opening a menu", () => {
  it("moves focus onto the first item", () => {
    // Not "focus stays on the trigger". A portalled menu sits nowhere near its
    // trigger in the document, so if opening takes no focus there is no way to
    // reach it at all.
    render(<Menu />);
    openMenu();
    expect(focused()).toBe("Rename");
  });

  it("opens on the CHECKED item in a radio menu", () => {
    // A speed menu should open on the current speed, not on the top of the
    // list - otherwise arrowing starts from somewhere the user did not choose.
    render(<Menu checked="Duplicate" />);
    openMenu();
    expect(focused()).toBe("Duplicate");
  });

  it("takes every item out of the page's tab order", () => {
    // Native buttons are focusable, so without this a menu adds one tab stop
    // per item - precisely what the menu role exists to prevent.
    render(<Menu />);
    openMenu();
    const stops = screen.getAllByRole("menuitem").filter((el) => el.tabIndex !== -1);
    expect(stops.map((el) => el.textContent)).toEqual([]);
  });
});

describe("moving inside a menu", () => {
  it("arrows down and up, and wraps at both ends", () => {
    render(<Menu />);
    openMenu();
    key("ArrowDown"); expect(focused()).toBe("Reveal");
    key("ArrowUp"); expect(focused()).toBe("Rename");
    key("ArrowUp"); expect(focused(), "wraps to the bottom").toBe("Delete");
    key("ArrowDown"); expect(focused(), "and back round to the top").toBe("Rename");
  });

  it("Home and End go to the ends", () => {
    render(<Menu />);
    openMenu();
    key("End"); expect(focused()).toBe("Delete");
    key("Home"); expect(focused()).toBe("Rename");
  });

  it("skips disabled items rather than parking on them", () => {
    // Focusing a disabled control announces it and does nothing, which reads
    // as the menu having stopped responding.
    render(<Menu disabled={["Reveal"]} />);
    openMenu();
    key("ArrowDown");
    expect(focused()).toBe("Duplicate");
  });

  it("jumps by typing, and repeating a letter cycles", () => {
    // The transcript Tools menu has ten items; arrowing to the last one is
    // nine keystrokes.
    render(<Menu />);
    openMenu();
    key("d"); expect(focused()).toBe("Duplicate");
    key("d"); expect(focused(), "the next D, not the same one").toBe("Delete");
    key("d"); expect(focused(), "and round again").toBe("Duplicate");
  });

  it("leaves modifier chords alone", () => {
    // CANARY: without the modifier check, type-ahead would swallow every
    // application shortcut typed while a menu happens to be open.
    render(<Menu />);
    openMenu();
    act(() => {
      fireEvent.keyDown(screen.getByRole("menu"), { key: "d", metaKey: true, bubbles: true });
    });
    expect(focused(), "cmd+D must not be read as type-ahead").toBe("Rename");
  });
});

describe("leaving a menu", () => {
  it("Escape closes it", () => {
    const onClose = vi.fn();
    render(<Menu onClose={onClose} />);
    openMenu();
    key("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("Tab closes it, because a menu is ONE tab stop", () => {
    // The part that looks like a regression and is not: internal Tab
    // navigation is what the menu role replaces.
    const onClose = vi.fn();
    render(<Menu onClose={onClose} />);
    openMenu();
    key("Tab");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("hands focus back to whatever opened it", () => {
    render(<Menu />);
    openMenu();
    expect(focused()).toBe("Rename");
    key("Escape");
    expect(focused(), "focus must not be dropped on the body").toBe("Open");
  });
});
