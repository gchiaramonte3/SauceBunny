// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { EditWave, type Peaks } from "./EditWave";

afterEach(() => { cleanup(); vi.useRealTimers(); });
const overview = (points: number): Peaks => Array.from({ length: points }, () => [-0.5, 0.5]);

it("asks for the visible range at its own resolution when the overview is too coarse to draw it", async () => {
  vi.useFakeTimers();
  // A 3-hour mic's 2,048-point overview is about 5 s a point; this clip shows two seconds of it.
  const detail = vi.fn(async () => overview(400));
  render(<EditWave peaks={overview(2048)} duration={3 * 3600} srcIn={100} srcOut={200} from={150} to={152} detail={detail} detailKey="s1:rosa" />);
  expect(detail).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  expect(detail).toHaveBeenCalledTimes(1);
  // The visible two seconds, a little either side, for that lane.
  const [key, from, to] = detail.mock.calls[0] as unknown as [string, number, number];
  expect(key).toBe("s1:rosa");
  expect(from).toBeLessThanOrEqual(150); expect(to).toBeGreaterThanOrEqual(152);
  expect(to - from).toBeLessThanOrEqual(4.01);
});

it("draws from the overview alone when it is fine enough, and only the part on screen", async () => {
  vi.useFakeTimers();
  const detail = vi.fn(async () => overview(400));
  const { container } = render(<EditWave peaks={overview(2048)} duration={10} srcIn={0} srcOut={10} from={2} to={4} detail={detail} detailKey="s1:rosa" />);
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
  expect(detail).not.toHaveBeenCalled();
  const canvas = container.querySelector("canvas")!;
  expect(canvas.style.left).toBe("20%");
  expect(canvas.style.width).toBe("20%");
});
