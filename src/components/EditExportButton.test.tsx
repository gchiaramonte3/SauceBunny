// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditExportButton } from "./EditExportButton";

const mocks = vi.hoisted(() => ({ exportEdit: vi.fn(), save: vi.fn(), invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: mocks.save }));
vi.mock("../lib/edit-export", async (actual) => ({ ...(await actual<typeof import("../lib/edit-export")>()), exportEdit: mocks.exportEdit }));

afterEach(cleanup);
// cancel_job resolves, as the real command does: Stop chains a .catch on it.
beforeEach(() => { vi.clearAllMocks(); mocks.save.mockResolvedValue("/Users/me/Rosa.aaf"); mocks.invoke.mockResolvedValue(undefined); });

it("keeps picture groups by default (V1 switchable, each person's own mic), and says where the file and markers went", async () => {
  const onDone = vi.fn();
  mocks.exportEdit.mockResolvedValue({ output: "/Users/me/Rosa.aaf", markers_output: "/Users/me/Rosa - Avid markers.txt", name: "Rosa", duration_frames: 480, segments: 3, markers: 3, copied_mobs: 9, warnings: [] });
  render(<EditExportButton editId="e1" title="Rosa" disabled={false} onDone={onDone} />);
  const mode = screen.getByRole("combobox", { name: "Group clips" }) as HTMLSelectElement;
  expect(mode.value).toBe("V");
  expect([...mode.options].map((option) => option.text)).toEqual(["Keep picture groups", "Keep all groups", "Clip that plays"]);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Export AAF/ })); });
  expect(mocks.exportEdit).toHaveBeenCalledWith("e1", "/Users/me/Rosa.aaf", "V", expect.any(String));
  expect(onDone).toHaveBeenCalledWith("Exported Rosa: 3 segments, markers beside it.");
});

it("when Keep groups cannot trim an effect, says the other kind can write it", async () => {
  const onDone = vi.fn();
  mocks.exportEdit.mockRejectedValue({ kind: "SidecarFailed", data: { name: "saucebunny-aaf", exit_code: 2,
    tail: "Segment 1 on V1 (source frames 1000 to 1480): Motion Control changes speed. Render it in Avid before exporting the bite." } });
  render(<EditExportButton editId="e1" title="Rosa" disabled={false} onDone={onDone} />);
  fireEvent.change(screen.getByRole("combobox", { name: "Group clips" }), { target: { value: "C" } });
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Export AAF/ })); });
  expect(mocks.exportEdit).toHaveBeenCalledWith("e1", "/Users/me/Rosa.aaf", "C", expect.any(String));
  expect(onDone.mock.calls[0][0]).toMatch(/^Export failed: .*Motion Control.* Clip that plays can write this bite: choose it and export again\.$/);
});

it("keeps exporting when another string out is opened, and reports when this one is open again", async () => {
  let land!: (value: unknown) => void;
  mocks.exportEdit.mockReturnValue(new Promise((done) => { land = done; }));
  const first = vi.fn();
  const view = render(<EditExportButton editId="e2" title="Rosa" disabled={false} onDone={first} />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Export AAF/ })); });
  expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
  view.unmount();
  // Switching tabs used to cancel it; now nothing is cancelled.
  expect(mocks.invoke).not.toHaveBeenCalledWith("cancel_job", expect.anything());
  await act(async () => land({ output: "/o.aaf", markers_output: null, name: "Rosa", duration_frames: 1, segments: 2, markers: 0, copied_mobs: 1, warnings: [] }));
  expect(first).not.toHaveBeenCalled();
  const again = vi.fn();
  render(<EditExportButton editId="e2" title="Rosa" disabled={false} onDone={again} />);
  expect(again).toHaveBeenCalledWith("Exported Rosa: 2 segments.");
  expect(screen.getByRole("button", { name: /Export AAF/ })).toBeTruthy();
});

it("a string out opened again mid-export shows Stop, and Stop says it stopped", async () => {
  let fail!: (cause: unknown) => void;
  mocks.exportEdit.mockReturnValue(new Promise((_done, reject) => { fail = reject; }));
  const view = render(<EditExportButton editId="e3" title="Rosa" disabled={false} onDone={vi.fn()} />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Export AAF/ })); });
  view.unmount();
  const onDone = vi.fn();
  render(<EditExportButton editId="e3" title="Rosa" disabled={false} onDone={onDone} />);
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(mocks.invoke).toHaveBeenCalledWith("cancel_job", { jobId: expect.any(String) });
  await act(async () => fail({ kind: "Cancelled" }));
  expect(onDone).toHaveBeenCalledWith("Export stopped.");
});
