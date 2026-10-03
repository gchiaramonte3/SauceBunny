// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { EditTimelineRuler } from "./EditTimelineRuler";

afterEach(cleanup);

const props = { rulerRef: null, fps: 24, recordStart: 86_400, start: 0, span: 100, width: 1000, x: (t: number) => `${t}%`, w: (d: number) => `${d}%`,
  markers: { list: [] }, seams: [], seam: null, describe: () => "", onSeam: () => undefined, scrub: {} };

it("draws a lone In or Out as a stem with its wing, and both as the winged range", () => {
  const view = render(<EditTimelineRuler {...props} marks={{ in: 20, out: null }} />);
  expect((view.container.querySelector(".cp-mark.in") as HTMLElement).style.left).toBe("20%");
  view.rerender(<EditTimelineRuler {...props} marks={{ in: null, out: 60 }} />);
  expect((view.container.querySelector(".cp-mark.out") as HTMLElement).style.left).toBe("60%");
  expect(view.container.querySelector(".cp-mark.in")).toBeNull();
  view.rerender(<EditTimelineRuler {...props} marks={{ in: 20, out: 60 }} />);
  const range = view.container.querySelector(".cp-mark-range.cp-te-tl-marked") as HTMLElement;
  expect([range.style.left, range.style.width]).toEqual(["20%", "40%"]);
  expect(view.container.querySelectorAll(".cp-mark")).toHaveLength(0);
});

it("zoomed out on a long cut, the timecodes step up to minutes and hours and never crowd", () => {
  // Two hours seventeen minutes across a 1,300px ruler: labels need about 104px each.
  const view = render(<EditTimelineRuler {...props} marks={{ in: null, out: null }} span={8230} width={1300} x={(t) => `${(t / 8230) * 100}%`} />);
  const labels = [...view.container.querySelectorAll(".cp-te-tl-tick")].map((tick) => tick.textContent);
  expect(labels.length).toBeGreaterThan(1);
  expect(labels.length).toBeLessThanOrEqual(Math.floor(1300 / 104));
  expect(labels.slice(0, 3)).toEqual(["01:00:00:00", "01:15:00:00", "01:30:00:00"]);
  // Zoomed in on ten seconds, every second.
  view.rerender(<EditTimelineRuler {...props} marks={{ in: null, out: null }} span={10} width={1300} />);
  expect(view.container.querySelectorAll(".cp-te-tl-tick").length).toBeGreaterThanOrEqual(9);
});
