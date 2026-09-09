// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ExpectedSpeakersMenu } from "./ExpectedSpeakersMenu";
afterEach(cleanup);
describe("expected speaker count", () => {
  it("opens on the selected value, navigates by keyboard, and returns focus", () => {
    const changed = vi.fn();
    render(<ExpectedSpeakersMenu value={2} disabled={false} onChange={changed} />);
    const trigger = screen.getByRole("button", { name: "Expected speakers: 2" });
    fireEvent.click(trigger);
    const current = screen.getByRole("menuitemradio", { name: "2" });
    expect(document.activeElement).toBe(current);
    expect(current.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("menu").parentElement).toBe(document.body);
    fireEvent.keyDown(current, { key: "ArrowDown" });
    const next = screen.getByRole("menuitemradio", { name: "3" });
    expect(document.activeElement).toBe(next);
    fireEvent.click(next);
    expect(changed).toHaveBeenCalledWith(3);
    expect(document.activeElement).toBe(trigger);
  });
  it("closes when speaker detection starts and cannot edit a running job", () => {
    const props = { value: 0, onChange: vi.fn() };
    const { rerender } = render(<ExpectedSpeakersMenu {...props} disabled={false} />);
    fireEvent.click(screen.getByRole("button"));
    rerender(<ExpectedSpeakersMenu {...props} disabled />);
    expect(screen.queryByRole("menu")).toBeNull();
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
    expect(props.onChange).not.toHaveBeenCalled();
  });
});
