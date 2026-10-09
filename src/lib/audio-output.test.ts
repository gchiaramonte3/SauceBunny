import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AudioOutput, CLOCK_STALL_MS, OUTPUT_IDLE_MS } from "./audio-output";

const log = vi.hoisted(() => vi.fn());
vi.mock("./pipeline", () => ({ pipelineLog: log }));

const made: FakeContext[] = [];
class FakeContext {
  currentTime = 0; state = "running"; onstatechange: (() => void) | null = () => undefined;
  close = vi.fn().mockResolvedValue(undefined);
  constructor() { made.push(this); }
}
let devices: EventTarget;
beforeEach(() => {
  made.length = 0; log.mockClear();
  devices = new EventTarget();
  vi.stubGlobal("AudioContext", FakeContext);
  vi.stubGlobal("navigator", { mediaDevices: devices });
});
afterEach(() => { vi.unstubAllGlobals(); });

it("is made again after a minute without sound, with the player's nodes built on the new one", () => {
  const built: unknown[] = [];
  const output = new AudioOutput("String Outs", (context) => { built.push(context); });
  const start = performance.now();
  expect(built).toEqual([made[0]]);
  expect(output.staleness(start + 30_000)).toBeNull();
  // Sounding keeps it fresh.
  output.touch(start + 30_000);
  expect(output.staleness(start + 30_000 + OUTPUT_IDLE_MS)).toBeNull();
  expect(output.staleness(start + 30_000 + 39 * 60_000)).toBe("39 min without sound");

  output.replace("39 min without sound");
  expect(made).toHaveLength(2);
  expect(output.context).toBe(made[1]);
  expect(built).toEqual([made[0], made[1]]);
  // The old one is let go: closed, and its state changes no longer reach the player.
  expect(made[0].close).toHaveBeenCalled();
  expect(made[0].onstatechange).toBeNull();
  expect(output.staleness()).toBeNull();
  // The Pipeline says why, so the next report shows it.
  expect(log).toHaveBeenCalledWith("audio", "String Outs: made the audio output again (39 min without sound).", "warn");
});

it("is made again after the Mac's audio devices change", () => {
  const output = new AudioOutput("AAF Audio", () => undefined);
  expect(output.staleness()).toBeNull();
  devices.dispatchEvent(new Event("devicechange"));
  expect(output.staleness()).toBe("the Mac's audio devices changed");
  output.replace("the Mac's audio devices changed");
  expect(output.staleness()).toBeNull();
  // Closing stops listening.
  output.close();
  devices.dispatchEvent(new Event("devicechange"));
  expect(made[1].close).toHaveBeenCalled();
});

it("says its clock has stopped once it has not moved for a second and a half while playing", () => {
  const output = new AudioOutput("String Outs", () => undefined), context = made[0];
  expect(output.stalled(0)).toBe(false);
  context.currentTime = 0.5;
  expect(output.stalled(500)).toBe(false);
  expect(output.stalled(500 + CLOCK_STALL_MS)).toBe(false);
  expect(output.stalled(501 + CLOCK_STALL_MS)).toBe(true);
  context.currentTime = 2;
  expect(output.stalled(600 + CLOCK_STALL_MS)).toBe(false);
  // Not watched for longer than that (paused, then Play again): a still clock is not a stall.
  expect(output.stalled(39 * 60_000)).toBe(false);
  expect(output.stalled(39 * 60_000 + 1_000)).toBe(false);
});

it("works where the page cannot hear of device changes", () => {
  vi.stubGlobal("navigator", {});
  const output = new AudioOutput("String Outs", () => undefined);
  expect(output.staleness()).toBeNull();
  output.close();
});
