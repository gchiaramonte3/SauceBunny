// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NdiPreviewHeader } from "./NdiPreviewHeader";
import type { ObsBroadcast } from "../hooks/use-obs-broadcast";
import type { ObsBroadcastPhase } from "../bindings/ObsBroadcastPhase";
afterEach(cleanup);
it("keeps publication passive and timecode explicitly unavailable", () => {
  const h=render(<NdiPreviewHeader sharing="private"/>);
  expect(screen.getByText("Not shared with room").tagName).toBe("SPAN");
  expect(screen.getByRole("status",{name:"Timeline timecode unavailable"}).textContent).toBe("--:--:--:--");
  expect(h.container.querySelector("button,video")).toBeNull();
  h.rerender(<NdiPreviewHeader sharing="shared"/>);expect(screen.getByText("Shared with room")).toBeTruthy();
  h.rerender(<NdiPreviewHeader sharing="stopped"/>);expect(screen.getByText("Room sharing stopped")).toBeTruthy();
});

function broadcast(phase: ObsBroadcastPhase, sourceId = "generated-source", error: string | null = null): ObsBroadcast {
  return { sourceId, status: { sourceId, phase, attempt: 1, error }, error: null,
    active: ["starting", "live", "stopping"].includes(phase), start: vi.fn(), stop: vi.fn() };
}

it.each([
  ["starting", "Starting NDI broadcast…"], ["live", "Broadcasting to NDI"],
  ["stopping", "Stopping NDI broadcast…"], ["error", "NDI broadcast needs attention"],
] as const)("shows %s network state independently from room sharing", (phase, text) => {
  const state = broadcast(phase);
  render(<NdiPreviewHeader sharing="private" broadcasts={[{ broadcast: state, sourceName: "Generated editor" }]}/>);
  expect(screen.getByText("Not shared with room")).toBeTruthy();
  expect(screen.getByRole("status", { name: "Network broadcast" }).textContent).toBe(`${text} · Generated editor`);
  expect(state.start).not.toHaveBeenCalled(); expect(state.stop).not.toHaveBeenCalled();
  if (phase === "stopping") expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(true);
});

it("keeps each visible Stop bound to its own source", () => {
  const first = broadcast("live", "first"), second = broadcast("starting", "second");
  render(<NdiPreviewHeader sharing="shared" broadcasts={[
    { broadcast: first, sourceName: "First editor" }, { broadcast: second, sourceName: "Second editor" },
  ]}/>);
  expect(screen.getByText("Shared with room")).toBeTruthy();
  expect(screen.getAllByRole("status", { name: "Network broadcast" })).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Stop NDI broadcast from Second editor" }));
  expect(second.stop).toHaveBeenCalledOnce(); expect(first.stop).not.toHaveBeenCalled();
  expect(first.start).not.toHaveBeenCalled(); expect(second.start).not.toHaveBeenCalled();
});

it("does not label an unavailable native status as stopped", () => {
  const state = { ...broadcast("live"), error: "Generated connection failure" };
  render(<NdiPreviewHeader sharing="private" broadcasts={[{ broadcast: state }]}/>);
  expect(screen.getByRole("status", { name: "Network broadcast" }).textContent).toBe("NDI broadcast status unavailable");
  expect(screen.getByRole("status", { name: "Network broadcast" }).title).toBe("Generated connection failure");
  expect((screen.getByRole("button", { name: "Stop NDI broadcast" }) as HTMLButtonElement).disabled).toBe(false);
});

it.each(["off", "stopped"] as const)("keeps a confirmed %s sender out of the header", phase => {
  render(<NdiPreviewHeader sharing="private" broadcasts={[{ broadcast: broadcast(phase) }]}/>);
  expect(screen.queryByRole("status", { name: "Network broadcast" })).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
});
