// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * "Where is this file?" (docs/RECONNECT-MEDIA-SPEC-2026-10-05.md, phase 2):
 * a drive that is not connected is waited for, a file that moved is located
 * and checked, and the others that moved with it come along.
 */
const h = vi.hoisted(() => ({
  online: new Set<string>(),
  offlineDrive: false,
  picked: null as string | null,
  probed: { duration: 61 as number | null },
  mounted: null as null | ((event: { payload: null }) => void),
  moved: [] as [string, string][][],
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args: { paths?: string[]; path?: string }) => {
    if (cmd === "media_availability") return args.paths!.map((path) => ({ path,
      state: h.online.has(path) ? "online" : h.offlineDrive ? "driveOffline" : "missing", volume: h.offlineDrive ? "NEXIS" : null, folder: false }));
    if (cmd === "probe_local_file") return { path: args.path, filename: args.path!.split("/").pop(), duration: h.probed.duration, size_bytes: 1 };
    return null;
  },
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: async () => h.picked }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, handler: (event: { payload: null }) => void) => { if (event === "media:volumes-changed") h.mounted = handler; return () => {}; },
}));
vi.mock("../lib/relink", async (load) => ({
  ...(await load<typeof import("../lib/relink")>()),
  reconnectFiles: (pairs: [string, string][]) => { h.moved.push(pairs); },
}));

import { ReconnectFileSheet } from "./ReconnectFileSheet";
const old = "/Volumes/NEXIS/Show/Day 3/A001.mov", found = "/Volumes/NEXIS 1/Show/Day 3/A001.mov";
beforeEach(() => { h.online.clear(); h.offlineDrive = false; h.picked = null; h.probed.duration = 61; h.moved = []; h.mounted = null; });
afterEach(cleanup);

it("waits for a drive that is not connected and opens the file when it mounts, moving nothing", async () => {
  h.offlineDrive = true;
  const onDone = vi.fn();
  render(<ReconnectFileSheet request={{ path: old, title: "A001" }} known={[]} onDone={onDone} onCancel={vi.fn()}/>);
  await screen.findByRole("heading", { name: "NEXIS is not connected" });
  expect(screen.getByRole("button", { name: "Locate elsewhere…" })).toBeTruthy();
  h.online.add(old);
  await act(async () => { h.mounted!({ payload: null }); });
  await waitFor(() => expect(onDone).toHaveBeenCalledWith(old, 0));
  expect(h.moved).toEqual([]);
});

it("locates a moved file, checks it, and brings the others that moved with it", async () => {
  const onDone = vi.fn();
  const sibling = "/Volumes/NEXIS/Show/Day 3/A002.mov", siblingFound = "/Volumes/NEXIS 1/Show/Day 3/A002.mov";
  const stayed = "/Volumes/NEXIS/Show/Day 3/A003.mov";
  h.online.add(siblingFound); h.online.add(stayed); h.online.add("/Volumes/NEXIS 1/Show/Day 3/A003.mov");
  h.picked = found;
  render(<ReconnectFileSheet request={{ path: old, title: "A001", durationSeconds: 61 }} known={[sibling, stayed]} onDone={onDone} onCancel={vi.fn()}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Locate file…" }));
  await waitFor(() => expect(onDone).toHaveBeenCalledWith(found, 1));
  // A003 is still at its old place, so it is not moved even though a copy exists at the new one.
  expect(h.moved).toEqual([[[old, found], [sibling, siblingFound]]]);
});

it("shows how a different file differs and moves nothing until it is accepted", async () => {
  const onDone = vi.fn();
  h.picked = "/Users/editor/Exports/A001_v2.mov"; h.probed.duration = 75;
  render(<ReconnectFileSheet request={{ path: old, title: "A001", durationSeconds: 61 }} known={[]} onDone={onDone} onCancel={vi.fn()}/>);
  fireEvent.click(await screen.findByRole("button", { name: "Locate file…" }));
  await screen.findByText("Name: A001_v2.mov (was A001.mov)");
  screen.getByText("Length: 01:15 (was 01:01)");
  expect(h.moved).toEqual([]); expect(onDone).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Use this file anyway" }));
  await waitFor(() => expect(onDone).toHaveBeenCalledWith("/Users/editor/Exports/A001_v2.mov", 0));
  expect(h.moved).toEqual([[[old, "/Users/editor/Exports/A001_v2.mov"]]]);
});
