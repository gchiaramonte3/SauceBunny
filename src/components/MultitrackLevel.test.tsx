// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MultitrackLevel } from "./MultitrackLevel";
import { TRACK_GAIN_MAX } from "../lib/multitrack-gain";

afterEach(cleanup);
function mount(initial = 1) {
  const changed = vi.fn();
  function Harness() {
    const [value, setValue] = useState(initial);
    return <MultitrackLevel owner="Alex" value={value} onChange={gain => { changed(gain); setValue(gain); }} />;
  }
  render(<Harness />);
  const trigger = screen.getByRole("button", { name: /Alex volume:/ });
  fireEvent.click(trigger);
  return { changed, trigger, input: screen.getByRole("textbox") as HTMLInputElement, slider: screen.getByRole("slider") };
}
it("uses an icon, focuses its vertical slider, boosts to +36 dB and resets", () => {
  const { changed, trigger, slider, input } = mount();
  expect(trigger.textContent).toBe(""); expect(trigger.querySelector("svg")).not.toBeNull();
  expect(document.activeElement).toBe(slider); expect(slider.getAttribute("aria-orientation")).toBe("vertical");
  fireEvent.change(slider, { target: { value: "36" } });
  expect(changed).toHaveBeenLastCalledWith(TRACK_GAIN_MAX); expect(input.value).toBe("+36 dB");
  const reset = screen.getByRole("button", { name: "Reset to 0 dB" });
  expect(reset.textContent).toBe(""); expect(reset.querySelector("svg")).not.toBeNull();
  expect(reset.closest(".cp-multitrack-gain-unity")).not.toBeNull();
  expect(reset.getAttribute("title")).toBe("Reset to 0 dB");
  expect(screen.queryByText("Above +12 dB can clip.")).toBeNull();
  expect(input.hasAttribute("aria-describedby")).toBe(false);
  fireEvent.click(reset);
  expect(changed).toHaveBeenLastCalledWith(1); expect(input.value).toBe("0 dB");
});
it("reset discards a pending gain draft so dismissal cannot restore it", async () => {
  const { input, changed } = mount(TRACK_GAIN_MAX);
  fireEvent.change(input, { target: { value: "+10" } });
  fireEvent.click(screen.getByRole("button", { name: "Reset to 0 dB" }));
  expect(changed).toHaveBeenLastCalledWith(1); expect(input.value).toBe("0 dB");
  await waitFor(() => { fireEvent.mouseDown(document.body); expect(screen.queryByRole("group")).toBeNull(); });
  expect(changed).toHaveBeenCalledTimes(1);
});
it.each(["+10", "+10 dB", "-2.5", ".5"])("selects the old number and commits %s only on Enter", text => {
  const { changed, input } = mount();
  input.focus(); fireEvent.click(input);
  expect(input.selectionStart).toBe(0); expect(input.selectionEnd).toBe(input.value.length);
  fireEvent.change(input, { target: { value: text } }); expect(changed).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: "Enter" });
  expect(changed).toHaveBeenCalledTimes(1); expect(changed).toHaveBeenLastCalledWith(10 ** (parseFloat(text) / 20));
  expect(input.value.endsWith(" dB")).toBe(true);
});
it("rejects unrelated symbols and incomplete drafts without changing gain", () => {
  const { input, changed } = mount();
  fireEvent.change(input, { target: { value: "10oops" } }); expect(input.value).toBe("0 dB");
  for (const text of ["+", "-", ".", ""]) {
    fireEvent.change(input, { target: { value: text } }); fireEvent.blur(input);
    expect(input.value).toBe("0 dB");
  }
  expect(changed).not.toHaveBeenCalled();
});
it("Escape discards an uncommitted edit, closes and returns focus", () => {
  const { input, trigger, changed } = mount(); input.focus();
  fireEvent.change(input, { target: { value: "+36" } }); fireEvent.keyDown(input, { key: "Escape" });
  expect(changed).not.toHaveBeenCalled(); expect(screen.queryByRole("group")).toBeNull(); expect(document.activeElement).toBe(trigger);
});
it("blur and outside dismissal commit valid numbers, never stale drafts", async () => {
  const { input, changed, trigger } = mount();
  fireEvent.change(input, { target: { value: "+10 dB" } }); fireEvent.blur(input);
  expect(changed).toHaveBeenCalledTimes(1);
  fireEvent.change(input, { target: { value: "+12" } });
  await waitFor(() => { fireEvent.mouseDown(document.body); expect(screen.queryByRole("group")).toBeNull(); });
  expect(changed).toHaveBeenCalledTimes(2);
  fireEvent.click(trigger); expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("+12 dB");
});
it("preserves exact silence at the bottom and lets typing replace it", () => {
  const { input, slider, changed } = mount(0);
  expect(input.value).toBe("−∞ dB");
  fireEvent.change(input, { target: { value: "+99" } }); fireEvent.blur(input);
  expect(changed).toHaveBeenLastCalledWith(TRACK_GAIN_MAX);
  fireEvent.change(slider, { target: { value: "-61" } }); expect(changed).toHaveBeenLastCalledWith(0);
});
it("scrolling over the open fader steps it a dB a notch, and adds up a trackpad's small deltas", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const { input } = mount();
    const popover = screen.getByRole("group", { name: "Alex volume controls" });
    const wheel = (deltaY: number, deltaMode = 0) => {
      const event = new WheelEvent("wheel", { deltaY, deltaMode, bubbles: true, cancelable: true });
      act(() => { popover.dispatchEvent(event); });
      return event;
    };
    // Up is louder. The event is consumed so the track list behind stays put.
    expect(wheel(-40).defaultPrevented).toBe(true);
    expect(input.value).toBe("+1 dB");
    wheel(-40); wheel(-40);
    expect(input.value).toBe("+3 dB");
    act(() => { vi.advanceTimersByTime(200); });
    // A trackpad: ten 8 px deltas are two notches, not ten.
    for (let index = 0; index < 10; index++) wheel(8);
    expect(input.value).toBe("+1 dB");
    act(() => { vi.advanceTimersByTime(200); });
    // A slow single click that reports less than a notch still moves once.
    wheel(-4);
    expect(input.value).toBe("+1 dB");
    act(() => { vi.advanceTimersByTime(200); });
    expect(input.value).toBe("+2 dB");
    // Line-mode wheels count a line as a notch, and the top stops at +36.
    wheel(-100, 1);
    expect(input.value).toBe("+36 dB");
  } finally { vi.useRealTimers(); }
});
it("a sideways swipe does not turn the fader, and the wheel never throws away a level being typed", () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const { input } = mount();
    const popover = screen.getByRole("group", { name: "Alex volume controls" });
    const wheel = (deltaY: number, deltaX = 0) => act(() => { popover.dispatchEvent(new WheelEvent("wheel", { deltaY, deltaX, bubbles: true, cancelable: true })); });
    wheel(-6, -80);
    act(() => { vi.advanceTimersByTime(200); });
    expect(input.value).toBe("0 dB");
    fireEvent.change(input, { target: { value: "-12" } });
    wheel(-40);
    act(() => { vi.advanceTimersByTime(200); });
    expect(input.value).toBe("-12");
  } finally { vi.useRealTimers(); }
});
it("keeps fader keyboard direction and limits consistent across browsers", () => {
  const { slider, input } = mount();
  for (const [key, value] of [["End", "+36 dB"], ["ArrowUp", "+36 dB"], ["ArrowDown", "+35 dB"],
    ["PageDown", "+29 dB"], ["Home", "−∞ dB"], ["ArrowDown", "−∞ dB"], ["ArrowUp", "-60 dB"]]) {
    fireEvent.keyDown(slider, { key }); expect(input.value).toBe(value);
  }
});
