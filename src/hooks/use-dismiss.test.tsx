// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { useRef } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useDismiss } from "./use-dismiss";

afterEach(cleanup);

function Popover({ onClose, enabled }: { onClose: () => void; enabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useDismiss(ref, onClose, enabled);
  return (
    <div>
      <div ref={ref} data-testid="pop">
        inside
        <button type="button" data-testid="child">child</button>
      </div>
      <div data-testid="outside">outside</div>
    </div>
  );
}

/** Attach is deferred by a tick, so tests have to let that tick happen. */
async function settle() {
  await act(async () => { await new Promise((r) => setTimeout(r, 1)); });
}

describe("useDismiss", () => {
  it("closes on a click outside", async () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<Popover onClose={onClose} />);
    await settle();
    fireEvent.mouseDown(getByTestId("outside"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays open when the click is inside, including on a child", async () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<Popover onClose={onClose} />);
    await settle();
    fireEvent.mouseDown(getByTestId("pop"));
    fireEvent.mouseDown(getByTestId("child"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("closes on Escape wherever the focus is", async () => {
    // Document-level, not element-level: several popovers only listen on
    // themselves, so Escape does nothing there unless focus is already inside.
    const onClose = vi.fn();
    render(<Popover onClose={onClose} />);
    await settle();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores other keys", async () => {
    const onClose = vi.fn();
    render(<Popover onClose={onClose} />);
    await settle();
    fireEvent.keyDown(document, { key: "Enter" });
    fireEvent.keyDown(document, { key: "a" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does not close on the very click that opened it", () => {
    // The reason for the deferred attach. Without it the opening mousedown is
    // still propagating when the effect runs, so the popover closes in the
    // same gesture that opened it and never visibly appears. Every hand-rolled
    // copy carries the same setTimeout, which says it was learned the hard way.
    const onClose = vi.fn();
    const { getByTestId } = render(<Popover onClose={onClose} />);
    fireEvent.mouseDown(getByTestId("outside")); // same tick as mount
    expect(onClose).not.toHaveBeenCalled();
  });

  it("stops listening once unmounted", async () => {
    const onClose = vi.fn();
    const { unmount } = render(<Popover onClose={onClose} />);
    await settle();
    unmount();
    fireEvent.mouseDown(document.body);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("does nothing at all when disabled", async () => {
    const onClose = vi.fn();
    const { getByTestId } = render(<Popover onClose={onClose} enabled={false} />);
    await settle();
    fireEvent.mouseDown(getByTestId("outside"));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
  });
});
