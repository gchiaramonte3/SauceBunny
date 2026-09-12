// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ObsBroadcastControls as BroadcastControls } from "./ObsBroadcastControls";
import { useObsBroadcasts } from "../hooks/use-obs-broadcast";

function ObsBroadcastControls({ sourceId, disabled }: { sourceId: string; disabled?: boolean }) {
  const manager = useObsBroadcasts([{ sourceId, sourceName: "Generated editor" }]);
  const broadcast = manager.forSource(sourceId);
  return broadcast ? <BroadcastControls broadcast={broadcast} disabled={disabled}/> : null;
}

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
type Status = { sourceId: string; attempt: number; phase: "off" | "starting" | "live" | "stopping" | "stopped" | "error"; error: string | null };
const A = "a".repeat(32), B = "b".repeat(32);
const status = (phase: Status["phase"] = "off", attempt = 0, sourceId = A, error: string | null = null): Status => ({ sourceId, attempt, phase, error });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
let native: Status;
function ordinary(command: string, args: { id: string; attempt?: number }) {
  if (command === "obs_broadcast_status") return Promise.resolve({ ...native, sourceId: args.id });
  if (command === "obs_broadcast_start") native = status("starting", args.attempt, args.id);
  else if (command === "obs_broadcast_stop") native = status("stopped", args.attempt, args.id);
  else throw new Error(`Unexpected native mutation from broadcast controls: ${command}`);
  return Promise.resolve(native);
}
async function settle() { await act(async () => { await Promise.resolve(); }); }
async function poll() { await act(async () => { await vi.advanceTimersByTimeAsync(750); }); }
const broadcastState = () => screen.getByRole("status", { name: "NDI broadcast" }).textContent;
const startButton = () => screen.getByRole("button", { name: "Broadcast to NDI" }) as HTMLButtonElement;
const stopButton = () => screen.getByRole("button", { name: "Stop broadcast" }) as HTMLButtonElement;
const writes = () => mocks.invoke.mock.calls.filter(([command]) => command !== "obs_broadcast_status");
beforeEach(() => { vi.useFakeTimers(); native = status(); mocks.invoke.mockReset(); mocks.invoke.mockImplementation(ordinary); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe("explicit native-owned NDI broadcast controls", () => {
  it("only reads exact-source status on mount and leaves the native sender alone on unmount", async () => {
    const view = render(<ObsBroadcastControls sourceId={A}/>);
    expect(startButton().disabled).toBe(true);
    await settle();
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("obs_broadcast_status", { id: A });
    expect(startButton().disabled).toBe(false);
    expect(broadcastState()).toBe("Not broadcasting");
    expect(screen.getByText(/separate from sharing with a Sauce Bunny room/)).toBeTruthy();
    view.unmount(); await poll();
    expect(writes()).toEqual([]);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });

  it("starts only on click, requires native Live, and stops that same exact attempt", async () => {
    native = status("stopped", 4);
    render(<ObsBroadcastControls sourceId={A}/>); await settle();
    fireEvent.click(startButton()); await settle();
    expect(writes()).toEqual([["obs_broadcast_start", { id: A, attempt: 5 }]]);
    expect(broadcastState()).toBe("Starting broadcast…");
    native = status("live", 5); await poll();
    expect(broadcastState()).toBe("Broadcasting on your local network");
    fireEvent.click(stopButton()); await settle();
    expect(writes()).toEqual([["obs_broadcast_start", { id: A, attempt: 5 }], ["obs_broadcast_stop", { id: A, attempt: 5 }]]);
    expect(broadcastState()).toBe("Not broadcasting");
    expect(mocks.invoke.mock.calls.every(([command]) => ["obs_broadcast_status", "obs_broadcast_start", "obs_broadcast_stop"].includes(command))).toBe(true);
  });

  it("can Stop during a pending Start and ignores its late successful response", async () => {
    const started = deferred<Status>(), stopped = deferred<Status>();
    mocks.invoke.mockImplementation((command, args) => command === "obs_broadcast_start" ? started.promise
      : command === "obs_broadcast_stop" ? stopped.promise : ordinary(command, args));
    render(<ObsBroadcastControls sourceId={A}/>); await settle();
    fireEvent.click(startButton());
    expect(stopButton().disabled).toBe(false);
    fireEvent.click(stopButton());
    expect(writes()).toEqual([["obs_broadcast_start", { id: A, attempt: 1 }], ["obs_broadcast_stop", { id: A, attempt: 1 }]]);
    expect(stopButton().disabled).toBe(true);
    await act(async () => started.resolve(status("live", 1)));
    expect(broadcastState()).toBe("Stopping broadcast…");
    await act(async () => stopped.resolve(status("stopped", 1)));
    expect(broadcastState()).toBe("Not broadcasting");
  });

  it("does not let a pre-action status poll erase an explicit start intent", async () => {
    const stale = deferred<Status>(); let reads = 0;
    mocks.invoke.mockImplementation((command, args) => command === "obs_broadcast_status" && ++reads === 2
      ? stale.promise : ordinary(command, args));
    render(<ObsBroadcastControls sourceId={A}/>); await settle(); await poll();
    fireEvent.click(startButton()); await settle();
    await act(async () => stale.resolve(status("off", 0)));
    expect(broadcastState()).toBe("Starting broadcast…");
    expect(stopButton().disabled).toBe(false);
    expect(writes()).toEqual([["obs_broadcast_start", { id: A, attempt: 1 }]]);
  });

  it("does not regress a newer attempt when an old-attempt poll returns after Start", async () => {
    const started = deferred<Status>();
    mocks.invoke.mockImplementation((command, args) => command === "obs_broadcast_start" ? started.promise : ordinary(command, args));
    render(<ObsBroadcastControls sourceId={A}/>); await settle();
    fireEvent.click(startButton());
    // This read starts after the click but the native start request is still
    // in flight; its older attempt is not evidence that attempt 1 was stopped.
    await poll();
    expect(broadcastState()).toBe("Starting broadcast…");
    await act(async () => started.resolve(status("live", 1)));
    expect(broadcastState()).toBe("Broadcasting on your local network");
  });

  it("ignores a late Live status after an explicit Stop of the same attempt", async () => {
    native = status("live", 7);
    const stopped = deferred<Status>();
    mocks.invoke.mockImplementation((command, args) => command === "obs_broadcast_stop" ? stopped.promise : ordinary(command, args));
    render(<ObsBroadcastControls sourceId={A}/>); await settle();
    fireEvent.click(stopButton()); await poll();
    expect(broadcastState()).toBe("Stopping broadcast…");
    expect(stopButton().disabled).toBe(true);
    await act(async () => stopped.resolve(status("stopped", 7)));
    expect(broadcastState()).toBe("Not broadcasting");
    expect(writes()).toEqual([["obs_broadcast_stop", { id: A, attempt: 7 }]]);
  });

  it("isolates source changes from pending old-source action and status responses", async () => {
    const oldStart = deferred<Status>(), oldPoll = deferred<Status>(); let reads = 0;
    mocks.invoke.mockImplementation((command, args) => {
      if (command === "obs_broadcast_start" && args.id === A) return oldStart.promise;
      if (command === "obs_broadcast_status" && args.id === A && ++reads === 2) return oldPoll.promise;
      return ordinary(command, args);
    });
    const view = render(<ObsBroadcastControls sourceId={A}/>); await settle(); await poll();
    fireEvent.click(startButton());
    view.rerender(<ObsBroadcastControls sourceId={B}/>); await settle();
    await act(async () => { oldStart.resolve(status("live", 1, A)); oldPoll.resolve(status("live", 1, A)); });
    expect(broadcastState()).toBe("Not broadcasting");
    fireEvent.click(startButton()); await settle();
    expect(writes()).toEqual([["obs_broadcast_start", { id: A, attempt: 1 }], ["obs_broadcast_start", { id: B, attempt: 1 }]]);
    expect(mocks.invoke).not.toHaveBeenCalledWith("obs_broadcast_stop", expect.anything());
  });

  it("recovers an already-live native attempt after remount without starting another or stopping on close", async () => {
    native = status("live", 9);
    const first = render(<ObsBroadcastControls sourceId={A}/>); await settle();
    expect(broadcastState()).toBe("Broadcasting on your local network");
    first.unmount();
    render(<ObsBroadcastControls sourceId={A}/>); await settle();
    expect(writes()).toEqual([]);
    fireEvent.click(stopButton()); await settle();
    expect(writes()).toEqual([["obs_broadcast_stop", { id: A, attempt: 9 }]]);
  });

  it("keeps Stop available for a live sender even when the parent disables new starts", async () => {
    const view = render(<ObsBroadcastControls sourceId={A} disabled/>); await settle();
    expect(startButton().disabled).toBe(true); fireEvent.click(startButton());
    expect(writes()).toEqual([]);
    native = status("live", 3); await poll();
    expect(stopButton().disabled).toBe(false);
    fireEvent.click(stopButton()); await settle();
    expect(writes()).toEqual([["obs_broadcast_stop", { id: A, attempt: 3 }]]);
    view.unmount();
  });

  it("reports IPC errors without claiming stopped, then reconciles native truth on polling", async () => {
    native = status("live", 2);
    mocks.invoke.mockImplementation((command, args) => command === "obs_broadcast_stop"
      ? Promise.reject(new Error("Generated transport failure")) : ordinary(command, args));
    render(<ObsBroadcastControls sourceId={A}/>); await settle();
    fireEvent.click(stopButton()); await settle();
    expect(screen.getByRole("alert").textContent).toContain("Generated transport failure");
    expect(broadcastState()).toBe("Broadcast status unavailable. Last known state retained.");
    native = status("error", 2, A, "Native cleanup needs attention"); await poll();
    expect(broadcastState()).toBe("Broadcast needs attention");
    expect(screen.getByRole("alert").textContent).toContain("Native cleanup needs attention");
    expect(writes()).toEqual([["obs_broadcast_stop", { id: A, attempt: 2 }]]);
  });

  it("rejects a status response for a different source and never invents start eligibility", async () => {
    mocks.invoke.mockResolvedValue(status("live", 55, B));
    render(<ObsBroadcastControls sourceId={A}/>); await settle();
    expect(startButton().disabled).toBe(true);
    expect(broadcastState()).toBe("Checking broadcast…");
    fireEvent.click(startButton()); expect(writes()).toEqual([]);
  });
});
