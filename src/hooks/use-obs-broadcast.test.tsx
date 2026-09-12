// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useObsBroadcasts, type ObsBroadcastSource } from "./use-obs-broadcast";
import { ObsBroadcastControls } from "../components/ObsBroadcastControls";
import { ObsBroadcastIndicator } from "../components/ObsBroadcastIndicator";
import { NdiPreviewHeader } from "../components/NdiPreviewHeader";
import type { ObsBroadcastStatus } from "../bindings/ObsBroadcastStatus";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
const SOURCE = "a".repeat(32);
let native: ObsBroadcastStatus;
function Parent({ sourceId = SOURCE, settings = true, file = false }: { sourceId?: string | null; settings?: boolean; file?: boolean }) {
  const manager = useObsBroadcasts(sourceId ? [{ sourceId, sourceName: "Generated editor" }] : []);
  const broadcast = manager.forSource(sourceId);
  if (!broadcast) return null;
  return <>
    {file ? <ObsBroadcastIndicator broadcast={broadcast} sourceName="Generated editor"/>
      : <NdiPreviewHeader sharing="private" broadcasts={[{ broadcast, sourceName: "Generated editor" }]}/>}
    {settings && <ObsBroadcastControls broadcast={broadcast}/>}
  </>;
}
function Sources({ sources }: { sources: ObsBroadcastSource[] }) {
  const manager = useObsBroadcasts(sources);
  return <>
    <NdiPreviewHeader sharing="private" broadcasts={manager.notices}/>
    {manager.notices.filter(notice => sources.some(source => source.sourceId === notice.broadcast.sourceId))
      .map(notice => <ObsBroadcastControls key={notice.broadcast.sourceId} broadcast={notice.broadcast}/>)}
  </>;
}
async function settle() { await act(async () => { await Promise.resolve(); }); }
async function poll() { await act(async () => { await vi.advanceTimersByTimeAsync(750); }); }
const writes = () => mocks.invoke.mock.calls.filter(([name]) => name !== "obs_broadcast_status");
const notice = () => screen.getByRole("status", { name: "Network broadcast" });
beforeEach(() => {
  vi.useFakeTimers(); native = { sourceId: SOURCE, attempt: 0, phase: "off", error: null };
  mocks.invoke.mockReset();
  mocks.invoke.mockImplementation((name, args) => {
    if (name === "obs_broadcast_start") native = { ...native, attempt: args.attempt, phase: "starting" };
    if (name === "obs_broadcast_stop") native = { ...native, attempt: args.attempt, phase: "stopped" };
    return Promise.resolve(native);
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("performs no reads or native mutations without a local capture source", async () => {
  render(<Parent sourceId={null}/>); await settle(); await poll();
  expect(mocks.invoke).not.toHaveBeenCalled();
  expect(screen.queryByRole("status", { name: "Network broadcast" })).toBeNull();
});

it("continues observing with settings closed and allows Stop without reopening them", async () => {
  const view = render(<Parent/>); await settle();
  fireEvent.click(screen.getByRole("button", { name: "Broadcast to NDI" })); await settle();
  expect(notice().textContent).toContain("Starting NDI broadcast…");
  view.rerender(<Parent settings={false}/>);
  expect(screen.queryByRole("status", { name: "NDI broadcast" })).toBeNull();
  expect(writes()).toEqual([["obs_broadcast_start", { id: SOURCE, attempt: 1 }]]);
  native = { ...native, phase: "live" }; await poll();
  expect(notice().textContent).toContain("Broadcasting to NDI");
  expect(screen.getByText("Not shared with room")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Stop NDI broadcast from Generated editor" })); await settle();
  expect(writes()).toEqual([["obs_broadcast_start", { id: SOURCE, attempt: 1 }],
    ["obs_broadcast_stop", { id: SOURCE, attempt: 1 }]]);
  expect(screen.queryByRole("status", { name: "Network broadcast" })).toBeNull();
});

it("keeps a retained capture's notice available while the file picture replaces its header", async () => {
  native = { ...native, attempt: 7, phase: "live" };
  const view = render(<Parent settings={false}/>); await settle();
  view.rerender(<Parent settings={false} file/>);
  expect(screen.queryByRole("status", { name: "Timeline timecode unavailable" })).toBeNull();
  expect(notice().textContent).toContain("Broadcasting to NDI");
  expect(writes()).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Stop NDI broadcast from Generated editor" })); await settle();
  expect(writes()).toEqual([["obs_broadcast_stop", { id: SOURCE, attempt: 7 }]]);
});

it("does not hide a native error or failed status read after closing settings", async () => {
  native = { ...native, attempt: 3, phase: "live" };
  const view = render(<Parent/>); await settle();
  view.rerender(<Parent settings={false}/>);
  mocks.invoke.mockRejectedValueOnce(new Error("Generated transport unavailable")); await poll();
  expect(notice().textContent).toContain("NDI broadcast status unavailable");
  expect(notice().title).toContain("Generated transport unavailable");
  expect((screen.getByRole("button", { name: "Stop NDI broadcast from Generated editor" }) as HTMLButtonElement).disabled).toBe(false);
  native = { ...native, phase: "error", error: "Cleanup could not be confirmed" }; await poll();
  expect(notice().textContent).toContain("NDI broadcast needs attention");
  expect(notice().title).toBe("Cleanup could not be confirmed");
  expect(writes()).toEqual([]);
});

it("serializes Stop from two visible controls into one exact-source request", async () => {
  native = { ...native, attempt: 5, phase: "live" };
  let complete!: (status: ObsBroadcastStatus) => void;
  mocks.invoke.mockImplementation(name => name === "obs_broadcast_stop"
    ? new Promise<ObsBroadcastStatus>(resolve => { complete = resolve; }) : Promise.resolve(native));
  render(<Parent/>); await settle();
  const outside = screen.getByRole("button", { name: "Stop NDI broadcast from Generated editor" });
  const inside = screen.getByRole("button", { name: "Stop broadcast" });
  act(() => { fireEvent.click(outside); fireEvent.click(inside); });
  expect(writes()).toEqual([["obs_broadcast_stop", { id: SOURCE, attempt: 5 }]]);
  await act(async () => complete({ ...native, phase: "stopped" }));
  expect(screen.queryByRole("status", { name: "Network broadcast" })).toBeNull();
});

it("retains the newer attempt if a later poll returns an older nonterminal snapshot", async () => {
  native = { ...native, attempt: 4, phase: "live" };
  const view = render(<Parent/>); await settle();
  view.rerender(<Parent settings={false}/>);
  mocks.invoke.mockResolvedValueOnce({ ...native, attempt: 3, phase: "starting" }); await poll();
  expect(notice().textContent).toContain("Broadcasting to NDI");
  expect(writes()).toHaveLength(0);
});

it("deduplicates a capture used by both private preview and room", async () => {
  native = { ...native, phase: "live", attempt: 2 };
  const source = { sourceId: SOURCE, sourceName: "Generated editor" };
  render(<Sources sources={[source, source]}/>); await settle();
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("obs_broadcast_status", { id: SOURCE });
  expect(screen.getAllByRole("status", { name: "Network broadcast" })).toHaveLength(1);
  expect(writes()).toEqual([]);
});

it("retains a replaced sender and its name through native shutdown without issuing Stop", async () => {
  const B = "b".repeat(32);
  const states = new Map<string, ObsBroadcastStatus>([
    [SOURCE, { sourceId: SOURCE, phase: "live", attempt: 6, error: null }],
    [B, { sourceId: B, phase: "off", attempt: 0, error: null }],
  ]);
  mocks.invoke.mockImplementation((_name, args) => Promise.resolve(states.get(args.id)));
  const view = render(<Sources sources={[{ sourceId: SOURCE, sourceName: "Previous editor" }]}/>); await settle();
  states.set(SOURCE, { ...states.get(SOURCE)!, phase: "stopping" });
  view.rerender(<Sources sources={[{ sourceId: B, sourceName: "Current editor" }]}/>); await settle();
  expect(notice().textContent).toBe("Stopping NDI broadcast… · Previous editor");
  expect(writes()).toEqual([]);
  states.set(SOURCE, { ...states.get(SOURCE)!, phase: "error", error: "Cleanup could not be confirmed" }); await poll();
  expect(notice().textContent).toBe("NDI broadcast needs attention · Previous editor");
  expect(notice().title).toBe("Cleanup could not be confirmed");
  states.set(SOURCE, { ...states.get(SOURCE)!, phase: "stopped", error: null }); await poll();
  expect(screen.queryByRole("status", { name: "Network broadcast" })).toBeNull();
  mocks.invoke.mockClear(); await poll();
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith("obs_broadcast_status", { id: B });
  expect(writes()).toEqual([]);
});

it("retains an unconfirmed retired sender when no current capture is selected", async () => {
  native = { ...native, attempt: 8, phase: "live" };
  const view = render(<Sources sources={[{ sourceId: SOURCE, sourceName: "Retired editor" }]}/>); await settle();
  mocks.invoke.mockRejectedValueOnce(new Error("Generated status unavailable"));
  view.rerender(<Sources sources={[]}/>); await settle();
  expect(notice().textContent).toContain("NDI broadcast status unavailable");
  expect(screen.getByRole("button", { name: "Stop NDI broadcast from Retired editor" })).toBeTruthy();
  expect(writes()).toEqual([]);
  native = { ...native, phase: "stopped" }; await poll();
  expect(screen.queryByRole("status", { name: "Network broadcast" })).toBeNull();
  mocks.invoke.mockClear(); await poll();
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it("accepts native Off/0 after another source prunes a retired terminal entry", async () => {
  native = { ...native, attempt: 9, phase: "live" };
  const view = render(<Sources sources={[{ sourceId: SOURCE, sourceName: "Retired editor" }]}/>); await settle();
  view.rerender(<Sources sources={[]}/>); await settle();
  expect(notice().textContent).toContain("Broadcasting to NDI");
  native = { ...native, attempt: 0, phase: "off" }; await poll();
  expect(screen.queryByRole("status", { name: "Network broadcast" })).toBeNull();
  mocks.invoke.mockClear(); await poll(); expect(mocks.invoke).not.toHaveBeenCalled();
});

it("retires a sole removed source when its persistent Error includes completed native cleanup", async () => {
  native = { ...native, attempt: 9, phase: "live" };
  const view = render(<Sources sources={[{ sourceId: SOURCE, sourceName: "Retired editor" }]}/>); await settle();
  view.rerender(<Sources sources={[]}/>); await settle();
  native = { ...native, phase: "error", error: "The application preview stopped. NDI broadcasting ended.", cleanupConfirmed: true };
  await poll();
  expect(screen.queryByRole("status", { name: "Network broadcast" })).toBeNull();
  // Native keeps this final Error indefinitely. Retirement must not depend
  // on a different source causing the native registry to prune its entry.
  mocks.invoke.mockClear(); await poll(); await poll();
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it.each([undefined, false])("keeps retired Error observations when cleanup proof is %s", async cleanupConfirmed => {
  native = { ...native, attempt: 3, phase: "error", error: "Cleanup could not be confirmed", cleanupConfirmed };
  const view = render(<Sources sources={[{ sourceId: SOURCE, sourceName: "Retired editor" }]}/>); await settle();
  view.rerender(<Sources sources={[]}/>); await settle(); await poll();
  expect(notice().textContent).toContain("NDI broadcast needs attention");
  expect(notice().title).toBe("Cleanup could not be confirmed");
  expect(writes()).toEqual([]);
  native = { ...native, cleanupConfirmed: true }; await poll();
  expect(screen.queryByRole("status", { name: "Network broadcast" })).toBeNull();
});

it("keeps the failure of a still-selected source visible even after native cleanup is confirmed", async () => {
  native = { ...native, attempt: 3, phase: "error", error: "NDI broadcasting failed", cleanupConfirmed: true };
  render(<Sources sources={[{ sourceId: SOURCE, sourceName: "Current editor" }]}/>); await settle(); await poll();
  expect(notice().textContent).toContain("NDI broadcast needs attention");
  expect(screen.getByRole("button", { name: "Broadcast to NDI" })).toBeTruthy();
  expect(writes()).toEqual([]);
});

it("does not let a pre-Stop Off/0 read retire a pending explicit shutdown", async () => {
  native = { ...native, phase: "live", attempt: 5 };
  let finishRead!: (status: ObsBroadcastStatus) => void, finishStop!: (status: ObsBroadcastStatus) => void;
  let reads = 0;
  mocks.invoke.mockImplementation(name => name === "obs_broadcast_stop"
    ? new Promise<ObsBroadcastStatus>(resolve => { finishStop = resolve; })
    : ++reads === 2 ? new Promise<ObsBroadcastStatus>(resolve => { finishRead = resolve; }) : Promise.resolve(native));
  const view = render(<Sources sources={[{ sourceId: SOURCE, sourceName: "Retired editor" }]}/>); await settle(); await poll();
  fireEvent.click(screen.getByRole("button", { name: "Stop NDI broadcast from Retired editor" }));
  view.rerender(<Sources sources={[]}/>);
  await act(async () => finishRead({ ...native, attempt: 0, phase: "off" }));
  expect(notice().textContent).toBe("Stopping NDI broadcast… · Retired editor");
  await act(async () => finishStop({ ...native, phase: "stopped" }));
  expect(screen.queryByRole("status", { name: "Network broadcast" })).toBeNull();
  expect(writes()).toEqual([["obs_broadcast_stop", { id: SOURCE, attempt: 5 }]]);
});
