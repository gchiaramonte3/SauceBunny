// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  fireEvent.click(screen.getByRole("button", { name: "Reset to 0 dB" }));
  expect(changed).toHaveBeenLastCalledWith(1); expect(input.value).toBe("0 dB");
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
it("keeps fader keyboard direction and limits consistent across browsers", () => {
  const { slider, input } = mount();
  for (const [key, value] of [["End", "+36 dB"], ["ArrowUp", "+36 dB"], ["ArrowDown", "+35 dB"],
    ["PageDown", "+29 dB"], ["Home", "−∞ dB"], ["ArrowDown", "−∞ dB"], ["ArrowUp", "-60 dB"]]) {
    fireEvent.keyDown(slider, { key }); expect(input.value).toBe(value);
  }
});
