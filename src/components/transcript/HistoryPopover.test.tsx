// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { HistoryPopover } from "./HistoryPopover";
import type { TranscriptHistoryEntry } from "../../lib/transcript-history";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => 1) }));

afterEach(cleanup);

/**
 * The transcript history list was mouse-only.
 *
 * Its rows carried `role="menuitem"` - so a screen reader announced a menu
 * full of items - on a plain `<div>` with an onClick and nothing else. No
 * tabIndex, so Tab never reached them; no key handler, so Enter did nothing;
 * and the popover has no arrow-key navigation either. There was no way to
 * open a past transcript without a pointer.
 *
 * The row is NOT a <button>, which would normally be the better fix: it
 * already contains the remove button, and a button inside a button is invalid
 * HTML. tabIndex plus Enter/Space is the ARIA menu pattern regardless.
 */
const entry = (over: Partial<TranscriptHistoryEntry> = {}): TranscriptHistoryEntry =>
  ({
    id: "e1", srtPath: "/lib/a.srt", title: "First interview",
    lastOpenedAt: 1_700_000_000_000, origin: "whisper",
    sourcePath: "/lib/a.mov", sourceUrl: null,
    ...over,
  }) as TranscriptHistoryEntry;

function open(over: Partial<Parameters<typeof HistoryPopover>[0]> = {}) {
  // The mocks are returned separately rather than read back off the merged
  // props: merging widens their type to the plain callback signature, so
  // `.mock` is not visible on them and tsc rejects the assertions.
  const onPick = vi.fn<(e: TranscriptHistoryEntry) => void>();
  const onRemove = vi.fn<(id: string) => void>();
  const onClose = vi.fn();
  render(
    <HistoryPopover
      anchor={{ top: 10, right: 400, bottom: 30, left: 200, width: 200, height: 20 } as DOMRect}
      entries={[entry(), entry({ id: "e2", title: "Second interview", srtPath: "/lib/b.srt" })]}
      activePath={null}
      onClose={onClose}
      onPick={onPick}
      onRemove={onRemove}
      onClearAll={vi.fn()}
      {...over}
    />,
  );
  return { onPick, onRemove, onClose };
}

describe("HistoryPopover rows are operable from the keyboard", () => {
  it("puts every row in the tab order", () => {
    open();
    const rows = screen.getAllByRole("menuitem");
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) expect(r.getAttribute("tabindex")).toBe("0");
  });

  it("opens the entry on Enter", () => {
    const { onPick } = open();
    fireEvent.keyDown(screen.getAllByRole("menuitem")[0], { key: "Enter" });
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0].id).toBe("e1");
  });

  it("opens the entry on Space, and stops the page scrolling", () => {
    const { onPick } = open();
    const row = screen.getAllByRole("menuitem")[1];
    const e = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
    row.dispatchEvent(e);
    expect(onPick.mock.calls[0][0].id).toBe("e2");
    expect(e.defaultPrevented, "Space must not also scroll the list").toBe(true);
  });

  it("ignores other keys", () => {
    const { onPick } = open();
    fireEvent.keyDown(screen.getAllByRole("menuitem")[0], { key: "a" });
    fireEvent.keyDown(screen.getAllByRole("menuitem")[0], { key: "Escape" });
    expect(onPick).not.toHaveBeenCalled();
  });

  it("does not open the entry when Enter lands on the remove button inside it", () => {
    // The nested control is why the row cannot simply be a <button>, and why
    // the handler checks the event target: without that, activating Remove
    // from the keyboard would ALSO open the transcript it just removed.
    const { onPick } = open();
    const remove = screen.getAllByRole("button", { name: /remove from history/i })[0];
    fireEvent.keyDown(remove, { key: "Enter" });
    expect(onPick).not.toHaveBeenCalled();
  });
});
