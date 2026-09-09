// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SpeedControl } from "./SpeedControl";
it("shows the proxy's actual 1× rate without overwriting the stored native preference", () => {
  const change = vi.fn();
  const view = render(<SpeedControl rate={2} supported={false} onRateChange={change} />);
  expect(screen.getByRole("button", { name: "Playback speed: 1×" }).textContent).toBe("1×");
  view.rerender(<SpeedControl rate={2} supported onRateChange={change} />);
  expect(screen.getByRole("button", { name: "Playback speed: 2×" }).textContent).toBe("2×");
  expect(change).not.toHaveBeenCalled();
});
