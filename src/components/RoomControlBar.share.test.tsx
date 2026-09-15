// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RoomControlBar } from "./RoomControlBar";
afterEach(cleanup);

it("routes an existing program through explicit source settings without starting another share", () => {
  const choose = vi.fn(), start = vi.fn(), noop = vi.fn();
  render(<RoomControlBar micOn={false} camOn={false} onToggleMic={noop} onToggleCam={noop}
    shareState="idle" onStartShare={start} onStopShare={noop} onChooseSource={choose} theater={false}
    onToggleTheater={noop} onReact={noop} handRaised={false} onToggleHand={noop}
    liveDrawOn={false} onToggleLiveDraw={noop} onClearLiveDraw={noop} liveDrawHasMarks={false}/>);
  fireEvent.click(screen.getByRole("button", { name: /^Share your screen\./ }));
  expect(choose).toHaveBeenCalledOnce(); expect(start).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog", { name: "Share your screen" })).toBeNull();
});

it("keeps cancellation reachable while screen sharing is starting", () => {
  const stop = vi.fn(), start = vi.fn(), noop = vi.fn();
  render(<RoomControlBar micOn={false} camOn={false} onToggleMic={noop} onToggleCam={noop}
    shareState="starting" onStartShare={start} onStopShare={stop} theater={false}
    onToggleTheater={noop} onReact={noop} handRaised={false} onToggleHand={noop}
    liveDrawOn={false} onToggleLiveDraw={noop} onClearLiveDraw={noop} liveDrawHasMarks={false}/>);
  const button = screen.getByRole("button", { name: "Cancel screen sharing startup" }) as HTMLButtonElement;
  expect(button.disabled).toBe(false); expect(button.getAttribute("aria-busy")).toBe("true");
  fireEvent.click(button);
  expect(stop).toHaveBeenCalledTimes(1); expect(start).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog", { name: "Share your screen" })).toBeNull();
});
