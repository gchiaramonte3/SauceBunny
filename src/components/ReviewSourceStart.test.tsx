// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ReviewSourceStart } from "./ReviewSourceStart";
afterEach(cleanup);
const callbacks = () => ({ onImportFile: vi.fn(), onLoadUrl: vi.fn(), onChooseLiveSource: vi.fn() });

it("offers six explicit source choices without Resume or effects on mount", () => {
  const props = callbacks();
  render(<ReviewSourceStart inSession={false} {...props} />);
  expect(screen.getAllByRole("button")).toHaveLength(6);
  expect(screen.queryByText(/Resume/)).toBeNull();
  for (const callback of Object.values(props)) expect(callback).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /^Local file/ }));
  expect(props.onImportFile).toHaveBeenCalledOnce();
  for (const label of ["Screen", "Window", "Region", "NDI"]) {
    fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${label} `) }));
    expect(props.onChooseLiveSource).toHaveBeenLastCalledWith(label.toLowerCase());
  }
  expect(props.onChooseLiveSource).toHaveBeenCalledTimes(4);
});

it("focuses a URL form and loads only after explicit submission", () => {
  const props = callbacks();
  render(<ReviewSourceStart inSession {...props} />);
  fireEvent.click(screen.getByRole("button", { name: /^Link / }));
  const url = screen.getByRole("textbox", { name: "Video URL" });
  expect(document.activeElement).toBe(url);
  fireEvent.change(url, { target: { value: "https://example.com/video" } });
  expect(props.onLoadUrl).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Open link" }));
  expect(props.onLoadUrl).toHaveBeenCalledWith("https://example.com/video");
  fireEvent.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getAllByRole("button")).toHaveLength(6);
  expect(props.onChooseLiveSource).not.toHaveBeenCalled();
  expect(props.onImportFile).not.toHaveBeenCalled();
});
