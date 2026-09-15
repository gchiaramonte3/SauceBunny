// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CaptureAudioAcceptance } from "./CaptureAudioAcceptance";
import type { ObsAudioAcceptanceReport } from "../bindings/ObsAudioAcceptanceReport";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), tone: vi.fn(), stop: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("../lib/capture-acceptance-tone", () => ({ startAcceptanceTone: mocks.tone }));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
const calls = (command: string) => mocks.invoke.mock.calls.filter(([name]) => name === command);
function report(verdict = "inconclusive"): ObsAudioAcceptanceReport {
  return { verdict, systemAudio: true,
    capture: { frames: 240_000, sampleRate: 48_000, channels: [
      { rms: .007, longestQuietMs: .02, minimumTone: [.009, 0, 0, 0], maximumTone: [.010, .000001, .000002, .000003] },
      { rms: .008, longestQuietMs: .03, minimumTone: [0, .009, 0, 0], maximumTone: [.000004, .010, .000005, .000006] },
    ] },
    reference: { frames: 240_000, sampleRate: 48_000, channels: [
      { rms: .005, longestQuietMs: 665.7, minimumTone: [0, 0, 0, 0], maximumTone: [.000007, .000008, .010, .000009] },
      { rms: .006, longestQuietMs: 665.8, minimumTone: [0, 0, 0, 0], maximumTone: [.000010, .000011, .000012, .010] },
    ] },
  };
}
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  mocks.tone.mockReturnValue({ ready: Promise.resolve(), stop: mocks.stop });
  mocks.invoke.mockImplementation((command, args) => Promise.resolve(command === "obs_audio_acceptance_read"
    ? { attempt: args.attempt, phase: "running", report: null, error: null } : undefined));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
async function start(name = "Measure HTML audio") {
  render(<CaptureAudioAcceptance sourceId="private-display"/>);
  await act(async () => click(name));
}

it("does nothing on mount and never starts a capture or publication", () => {
  render(<CaptureAudioAcceptance sourceId={null}/>);
  click("Measure HTML audio");
  expect(mocks.invoke).not.toHaveBeenCalled(); expect(mocks.tone).not.toHaveBeenCalled();
});

it.each(["Measure HTML audio", "Measure Web Audio"])("%s is explicit and admits only one bounded measurement", async name => {
  await start(name);
  await act(async () => { click(name); await vi.advanceTimersByTimeAsync(1_000); });
  expect(mocks.tone).toHaveBeenCalledExactlyOnceWith(name.includes("HTML") ? "html" : "web-audio");
  expect(calls("obs_audio_acceptance_start")).toHaveLength(1);
  expect(calls("obs_audio_acceptance_start")[0][1]).toEqual({ id: "private-display", attempt: expect.any(String) });
  expect(mocks.invoke.mock.calls.every(([name]) => ["obs_audio_acceptance_start", "obs_audio_acceptance_read"].includes(name))).toBe(true);
  await act(async () => click("Stop test tones"));
  expect(mocks.stop).toHaveBeenCalled();
  expect(calls("obs_audio_acceptance_cancel")).toHaveLength(1);
  const reads = calls("obs_audio_acceptance_read").length;
  await act(async () => vi.advanceTimersByTimeAsync(20_000));
  expect(calls("obs_audio_acceptance_read")).toHaveLength(reads);
});

it("stops tones on source replacement and ignores the old measurement", async () => {
  const pending = deferred<unknown>();
  mocks.invoke.mockImplementation(command => command === "obs_audio_acceptance_read" ? pending.promise : Promise.resolve());
  const view = render(<CaptureAudioAcceptance sourceId="old"/>);
  await act(async () => click("Measure HTML audio"));
  view.rerender(<CaptureAudioAcceptance sourceId="new"/>);
  expect(mocks.stop).toHaveBeenCalled();
  await act(async () => pending.resolve({ phase: "complete", report: { verdict: "passed" } }));
  expect(screen.queryByText(/Measurement passed/)).toBeNull();
  expect((screen.getByRole("button", { name: "Measure HTML audio" }) as HTMLButtonElement).disabled).toBe(false);
});

it("cancels again when a start reservation responds after Stop", async () => {
  const pending = deferred<void>();
  mocks.invoke.mockImplementation(command => command === "obs_audio_acceptance_start" ? pending.promise : Promise.resolve());
  await start();
  await act(async () => click("Stop test tones"));
  await act(async () => pending.resolve());
  expect(calls("obs_audio_acceptance_cancel")).toHaveLength(2);
  expect(calls("obs_audio_acceptance_read")).toHaveLength(0);
});

it("cannot start native observation after an unmounted tone becomes ready", async () => {
  const pending = deferred<void>();
  mocks.tone.mockReturnValue({ ready: pending.promise, stop: mocks.stop });
  await start(); cleanup();
  await act(async () => pending.resolve());
  expect(mocks.stop).toHaveBeenCalled(); expect(calls("obs_audio_acceptance_start")).toHaveLength(0);
});

it("hard-stops an unresponsive native read without reporting success", async () => {
  mocks.invoke.mockImplementation(command => command === "obs_audio_acceptance_read" ? new Promise(() => {}) : Promise.resolve());
  await start();
  await act(async () => vi.advanceTimersByTimeAsync(18_000));
  expect(mocks.stop).toHaveBeenCalled();
  expect(screen.getByRole("status").textContent).toContain("timed out");
  expect(calls("obs_audio_acceptance_read")).toHaveLength(1);
});

it("preserves inconclusive results and releases audio immediately", async () => {
  mocks.invoke.mockImplementation((command, args) => Promise.resolve(command === "obs_audio_acceptance_read"
    ? { attempt: args.attempt, phase: "complete", report: report(), error: null } : undefined));
  await start();
  expect(screen.getByRole("status").textContent).toContain("Measurement inconclusive");
  expect(mocks.stop).toHaveBeenCalled(); expect(calls("obs_audio_acceptance_cancel")).toHaveLength(1);
});

it("exposes each capture/reference channel's numeric evidence as separate short text nodes and retains JSON", async () => {
  const measured = report("failed");
  mocks.invoke.mockImplementation((command, args) => Promise.resolve(command === "obs_audio_acceptance_read"
    ? { attempt: args.attempt, phase: "complete", report: measured, error: null } : undefined));
  await start();
  expect(screen.getByRole("status").textContent).toBe("Measurement failed.");
  for (const kind of ["capture", "reference"] as const) {
    for (const [index, channel] of measured[kind].channels.entries()) {
      const label = `${kind === "capture" ? "Capture" : "Reference"} ${index === 0 ? "left" : "right"}`;
      const group = screen.getByRole("group", { name: `${label} channel` });
      expect(group.children).toHaveLength(7);
      expect(within(group).getByText(`RMS ${channel.rms.toExponential(3)}`).textContent).toBeTruthy();
      expect(within(group).getByText(`Quiet ${channel.longestQuietMs.toFixed(1)} ms`).textContent).toBeTruthy();
      for (const [tone, frequency] of [440, 660, 880, 1320].entries()) {
        expect(within(group).getByText(`${frequency} Hz min ${channel.minimumTone[tone].toExponential(3)} max ${channel.maximumTone[tone].toExponential(3)}`).textContent).toBeTruthy();
      }
      expect(Array.from(group.children).every(node => node.childNodes.length === 1 && node.firstChild?.nodeType === Node.TEXT_NODE)).toBe(true);
    }
  }
  expect(within(screen.getByRole("region", { name: "Audio measurement summary" })).getAllByRole("group")).toHaveLength(4);
  expect(JSON.parse(screen.getByLabelText("Numeric audio measurement").textContent!).report).toEqual(measured);
  expect(mocks.stop).toHaveBeenCalled();
  expect(calls("obs_audio_acceptance_cancel")).toHaveLength(1);
});

it("rejects a mismatched response identity rather than accepting a stale pass", async () => {
  mocks.invoke.mockImplementation(command => Promise.resolve(command === "obs_audio_acceptance_read"
    ? { attempt: "other", phase: "complete", report: { verdict: "passed" } } : undefined));
  await start();
  expect(screen.getByRole("status").textContent).toContain("no pass recorded"); expect(mocks.stop).toHaveBeenCalled();
});

it("clears completed results when a preview stops and cancels despite a tone cleanup error", async () => {
  mocks.invoke.mockImplementation((command, args) => Promise.resolve(command === "obs_audio_acceptance_read"
    ? { attempt: args.attempt, phase: "complete", report: report(), error: null } : undefined));
  mocks.stop.mockImplementationOnce(() => { throw new Error("cleanup"); });
  const view = render(<CaptureAudioAcceptance sourceId="one"/>);
  await act(async () => click("Measure HTML audio"));
  expect(calls("obs_audio_acceptance_cancel")).toHaveLength(1);
  view.rerender(<CaptureAudioAcceptance sourceId={null}/>);
  expect(screen.queryByLabelText("Numeric audio measurement")).toBeNull();
  expect((screen.getByRole("button", { name: "Stop test tones" }) as HTMLButtonElement).disabled).toBe(true);
});
