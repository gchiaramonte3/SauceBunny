// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ShotAnalysisTable } from "./ShotAnalysisTable";
import { emptyCorrection } from "../lib/scene-analysis/corrections";
import type { AnalysisEditDocument } from "../bindings/AnalysisEditDocument";
afterEach(cleanup);
const snapshot: AnalysisEditDocument = { schema_version: 1, revision: 0, source: { path: "/clip.mp4", sha256: "a".repeat(64), origin_us: 0, duration_us: 10e6 }, fps: 24, model: "model", corrections: {},
  rows: [{ id: 1, start_us: 0, end_us: 2e6, picture: "Generated description", dialogue: "Original words", summary: "Original summary" }] };
const props = () => ({ rows: snapshot.rows, snapshot, corrections: {}, tab: "All" as const, editing: true, fps: 24, busy: false, dialogueEmpty: "No dialogue", onSeek: vi.fn(), onSave: vi.fn().mockResolvedValue(undefined) });

it("keeps seek controls in normal mode and makes every shot column editable in Edit mode", () => {
  const p = props(); const view = render(<ShotAnalysisTable {...p} editing={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Shot 1 end at 00:00:02:00" }));
  expect(p.onSeek).toHaveBeenCalledWith(2);
  view.rerender(<ShotAnalysisTable {...p} />);
  for (const label of ["shot", "start", "end", "duration", "picture", "dialogue"]) expect(screen.getByRole("button", { name: `Edit shot 1 ${label}` })).toBeTruthy();
  fireEvent.click(screen.getByText("Transcript summary"));
  expect(screen.getByRole("button", { name: "Edit shot 1 transcript summary" })).toBeTruthy();
});
it("does not overwrite the draft/revision when model or other-window updates arrive", async () => {
  const p = props(); const view = render(<ShotAnalysisTable {...p} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit shot 1 picture" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Picture" }), { target: { value: "My correction 東京" } });
  view.rerender(<ShotAnalysisTable {...p} rows={[{ ...snapshot.rows[0], picture: "Later model response" }]} corrections={{ "0:2000000": { ...emptyCorrection(), revision: 2, dialogue: "Another window" } }} />);
  expect((screen.getByRole("textbox", { name: "Picture" }) as HTMLTextAreaElement).value).toBe("My correction 東京");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(p.onSave).toHaveBeenCalledWith(snapshot, "0:2000000", { ...emptyCorrection(), picture: "My correction 東京" });
});
it("retains the draft on a save failure and cancels without saving", async () => {
  const p = props(); p.onSave.mockRejectedValue(new Error("Disk full")); render(<ShotAnalysisTable {...p} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit shot 1 dialogue" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Dialogue" }), { target: { value: "Corrected words" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Disk full");
  expect(screen.getByRole("textbox", { name: "Dialogue" })).toHaveProperty("value", "Corrected words");
  fireEvent.keyDown(screen.getByRole("textbox", { name: "Dialogue" }), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull(); expect(p.onSave).toHaveBeenCalledTimes(1);
});
it("accepts numeric timecode only, validates frames and commits on Enter without seeking", async () => {
  const p = props(); render(<ShotAnalysisTable {...p} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit shot 1 end" }));
  const input = screen.getByRole("textbox", { name: "End" });
  fireEvent.change(input, { target: { value: "letters" } }); expect(input).toHaveProperty("value", "00:00:02:00");
  fireEvent.change(input, { target: { value: "25" } }); fireEvent.keyDown(input, { key: "Enter" });
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Enter a valid HH:MM:SS:FF timecode for this frame rate.");
  expect(p.onSave).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "100" } }); fireEvent.keyDown(input, { key: "Enter" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(p.onSave).toHaveBeenCalledWith(snapshot, "0:2000000", { ...emptyCorrection(), end_us: 1e6 });
  expect(p.onSeek).not.toHaveBeenCalled();
});
it("preserves intentional empty text and resets only the selected field", async () => {
  const p = props(); const correction = { ...emptyCorrection(), revision: 3, picture: "", dialogue: "User words" };
  render(<ShotAnalysisTable {...p} corrections={{ "0:2000000": correction }} />);
  expect(screen.getByRole("button", { name: "Edit shot 1 picture" }).textContent).toBe("Empty");
  fireEvent.click(screen.getByRole("button", { name: "Edit shot 1 picture" }));
  fireEvent.click(screen.getByRole("button", { name: "Reset field" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(p.onSave).toHaveBeenCalledWith(snapshot, "0:2000000", { ...correction, picture: null });
});
it("owns an in-flight save and rejects duplicate clicks/escape until it commits", async () => {
  let finish!: () => void; const p = props(); p.onSave.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
  render(<ShotAnalysisTable {...p} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit shot 1 shot" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Shot" }), { target: { value: "1B" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(screen.getByRole("dialog")).toBeTruthy(); expect(p.onSave).toHaveBeenCalledTimes(1);
  await act(async () => finish()); expect(screen.queryByRole("dialog")).toBeNull();
});
