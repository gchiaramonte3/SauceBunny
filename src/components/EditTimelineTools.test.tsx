// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { EditTimelineTools } from "./EditTimelineTools";

afterEach(cleanup);

type Props = React.ComponentProps<typeof EditTimelineTools>;
const props = (overrides: Partial<Props> = {}): Props => ({
  marks: { in: null, out: null }, canMark: true, snap: true, follow: false, loop: false, finding: false, hasPrevious: false, hasNext: false,
  onAddEdit: vi.fn(), onMarkIn: vi.fn(), onMarkClip: vi.fn(), onFindDead: vi.fn(), onMarkOut: vi.fn(), onLift: vi.fn(), onExtract: vi.fn(), onMarker: vi.fn(),
  onSnap: vi.fn(), onFollow: vi.fn(), onLoop: vi.fn(), onPrevious: vi.fn(), onNext: vi.fn(), allText: false, onAllText: vi.fn(),
  view: { waveforms: false, speakerColours: true, height: "medium" }, onView: vi.fn(), measuring: false,
  audio: { crossfade: 2, roomTone: false }, onAudio: vi.fn(), zoom: 1, onZoom: vi.fn(), ...overrides,
});

it("will not look for dead space until every mic is measured, and says how to measure them", () => {
  const view = render(<EditTimelineTools {...props({ deadHint: "Turn on View ▸ Waveforms to measure each mic first" })} />);
  const button = screen.getByRole("button", { name: "Remove dead space" });
  // An unmeasured mic has no audible spans, which would read as silence.
  expect((button as HTMLButtonElement).disabled).toBe(true);
  expect(button.getAttribute("title")).toBe("Remove dead space. Turn on View ▸ Waveforms to measure each mic first");
  view.rerender(<EditTimelineTools {...props()} />);
  expect((button as HTMLButtonElement).disabled).toBe(false);
  expect(button.getAttribute("title")).toBe("Remove dead space");
});

it("View ▸ Waveforms reports the choice and says while waveforms are building", () => {
  const onView = vi.fn();
  const view = render(<EditTimelineTools {...props({ onView })} />);
  fireEvent.click(screen.getByRole("button", { name: "View" }));
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Waveforms" }));
  expect(onView).toHaveBeenCalledWith({ waveforms: true, speakerColours: true, height: "medium" });
  view.rerender(<EditTimelineTools {...props({ onView, measuring: true, view: { waveforms: true, speakerColours: true, height: "medium" } })} />);
  expect(screen.getByRole("menuitemcheckbox", { name: "Waveforms (building)" }).getAttribute("aria-checked")).toBe("true");
});
