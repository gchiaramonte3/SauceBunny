// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RoomSourceBar } from "./RoomSourceBar";

afterEach(cleanup);

it("offers a visible Load action and retains the address for correction or retry", () => {
  const onLoadUrl = vi.fn();
  render(<RoomSourceBar hasSource={false} onLoadUrl={onLoadUrl} onImportFile={vi.fn()} onClear={vi.fn()} />);
  const field = screen.getByRole("textbox", { name: "Load a source for the room" }) as HTMLInputElement;
  expect(screen.queryByRole("button", { name: "Load source" })).toBeNull();
  fireEvent.change(field, { target: { value: "  https://example.test/video  " } });
  fireEvent.click(screen.getByRole("button", { name: "Load source" }));
  expect(onLoadUrl).toHaveBeenCalledExactlyOnceWith("https://example.test/video");
  expect(field.value).toBe("  https://example.test/video  ");
  fireEvent.keyDown(field, { key: "Enter" });
  expect(onLoadUrl).toHaveBeenCalledTimes(2);
  fireEvent.change(field, { target: { value: "   " } });
  fireEvent.keyDown(field, { key: "Enter" });
  expect(onLoadUrl).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("button", { name: "Load source" })).toBeNull();
});
