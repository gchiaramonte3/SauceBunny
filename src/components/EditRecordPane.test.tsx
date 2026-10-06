// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { EditRecordPane } from "./EditRecordPane";

afterEach(cleanup);

type Props = React.ComponentProps<typeof EditRecordPane>;
const props = (overrides: Partial<Props> = {}): Props => ({
  playhead: 12, total: 29.5, tc: "01:00:12:00", totalTc: "01:00:29:12", marks: [], playing: false, busy: false, onToggle: vi.fn(), onStart: vi.fn(),
  onScrub: vi.fn(), onScrubStart: vi.fn(), onScrubEnd: vi.fn(), text: { family: "sans", size: 15, leading: "normal" }, onText: vi.fn(), children: <p>The words</p>,
  ...overrides,
});

it("plays and goes to start from its own header, beside its timecode, as the source pane does", () => {
  const onToggle = vi.fn(), onStart = vi.fn();
  const view = render(<EditRecordPane {...props({ onToggle, onStart })} />);
  const pane = screen.getByRole("region", { name: "Record" });
  fireEvent.click(within(pane).getByRole("button", { name: "Play" }));
  fireEvent.click(within(pane).getByRole("button", { name: "Go to start" }));
  expect(onToggle).toHaveBeenCalledTimes(1);
  expect(onStart).toHaveBeenCalledTimes(1);
  expect(pane.querySelector(".cp-te-tools")?.textContent).toContain("01:00:12:00 / 01:00:29:12");
  view.rerender(<EditRecordPane {...props({ playing: true })} />);
  expect(within(pane).getByRole("button", { name: "Pause" }).getAttribute("title")).toBe("Pause (Space)");
});

it("says what the editor last did at its foot, and that audio is loading while it is", () => {
  const view = render(<EditRecordPane {...props({ status: "Lifted 2.40 s." })} />);
  const status = screen.getByRole("status");
  expect(status.textContent).toBe("Lifted 2.40 s.");
  expect(status.closest("footer")?.className).toBe("cp-te-record-foot");
  // Below the words, not above them.
  expect(status.compareDocumentPosition(screen.getByText("The words")) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
  view.rerender(<EditRecordPane {...props({ status: "Lifted 2.40 s.", busy: true })} />);
  expect(screen.getByRole("status").textContent).toBe("Loading audio…");
  expect(screen.getByRole("button", { name: "Play" }).getAttribute("aria-busy")).toBe("true");
});
