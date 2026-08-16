// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { useRef } from "react";
import { cleanup, render } from "@testing-library/react";
import { useModalFocus } from "./use-modal-focus";

/**
 * jsdom does no layout, so `offsetParent` is always null and the hook's
 * "skip hidden controls" filter drops every candidate - the trap then takes
 * its empty-dialog path and focus never moves.
 *
 * Stubbed here rather than worked around, and worth being precise about what
 * that costs: the VISIBILITY filter is no longer exercised by this file. It is
 * not what these tests are for - they check the wrap logic - and the e2e runs
 * the same hook in a real browser with real layout, where a hidden control
 * genuinely has no offsetParent.
 */
Object.defineProperty(HTMLElement.prototype, "offsetParent", {
  configurable: true,
  get(this: HTMLElement) {
    return this.parentElement;
  },
});

afterEach(cleanup);

/**
 * The container-focused Shift+Tab case, which the e2e caught and this pins.
 *
 * On open the hook focuses the dialog CONTAINER, which carries tabIndex={-1}
 * and is therefore excluded from the FOCUSABLE query. So the active element is
 * inside the dialog but is never the `first` focusable, the trap's shift
 * branch declined to act, and the browser's default took focus backwards out
 * of the modal on the very first Shift+Tab - onto whatever sat behind the
 * scrim. Forward Tab was unaffected, which is why it went unnoticed: with a
 * mouse, and with Tab, the modal behaves perfectly.
 */
function Dialog({ open }: { open: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(open, ref);
  return (
    <>
      <button type="button" data-testid="behind">behind the scrim</button>
      {open && (
        <div ref={ref} tabIndex={-1} data-testid="dialog">
          <button type="button" data-testid="first">first</button>
          <button type="button" data-testid="last">last</button>
        </div>
      )}
    </>
  );
}

const tab = (shift: boolean) => {
  const e = new KeyboardEvent("keydown", { key: "Tab", shiftKey: shift, bubbles: true, cancelable: true });
  window.dispatchEvent(e);
  return e;
};

describe("useModalFocus", () => {
  it("focuses the dialog container on open", () => {
    const { getByTestId } = render(<Dialog open />);
    expect(document.activeElement).toBe(getByTestId("dialog"));
  });

  it("wraps Shift+Tab from the container to the last control", () => {
    // The regression. Without the `active === el` case the hook does nothing
    // here and the browser walks focus out of the dialog.
    const { getByTestId } = render(<Dialog open />);
    expect(document.activeElement).toBe(getByTestId("dialog"));
    const e = tab(true);
    expect(e.defaultPrevented, "the trap let the browser handle it").toBe(true);
    expect(document.activeElement).toBe(getByTestId("last"));
  });

  it("wraps Shift+Tab from the first control to the last", () => {
    const { getByTestId } = render(<Dialog open />);
    getByTestId("first").focus();
    tab(true);
    expect(document.activeElement).toBe(getByTestId("last"));
  });

  it("wraps Tab from the last control to the first", () => {
    const { getByTestId } = render(<Dialog open />);
    getByTestId("last").focus();
    tab(false);
    expect(document.activeElement).toBe(getByTestId("first"));
  });

  it("pulls focus back when it is somehow outside", () => {
    const { getByTestId } = render(<Dialog open />);
    getByTestId("behind").focus();
    tab(false);
    expect(document.activeElement).toBe(getByTestId("first"));
  });

  it("leaves other keys alone", () => {
    render(<Dialog open />);
    const e = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });

  it("does nothing while closed", () => {
    const { getByTestId } = render(<Dialog open={false} />);
    getByTestId("behind").focus();
    const e = tab(true);
    expect(e.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(getByTestId("behind"));
  });
});
