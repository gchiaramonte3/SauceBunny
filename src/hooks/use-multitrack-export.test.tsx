// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { multitrackFixture, multitrackTranscript } from "../test/multitrack-fixture";
import { useMultitrackExport } from "./use-multitrack-export";
const mocks = vi.hoisted(() => ({ invoke: vi.fn(), open: vi.fn(), save: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: mocks.open, save: mocks.save }));
beforeEach(() => { vi.clearAllMocks(); mocks.invoke.mockImplementation(async command => command === "aaf_open" ? fixture() : "/exports/result.txt"); mocks.open.mockResolvedValue("/exports"); mocks.save.mockResolvedValue("/exports/result.txt"); });
afterEach(cleanup);
function fixture() { const doc = multitrackFixture(); doc.transcripts = [multitrackTranscript(), multitrackTranscript("track-2")]; doc.transcripts[1].cues[0].text = "Sam's reply"; return doc; }
it("exports a scoped transcript and the complete transcript independently of search or Solo", async () => {
  const { result } = renderHook(() => useMultitrackExport(fixture()));
  await act(async () => result.current.download("txt", ["track-2"], "Sam"));
  expect(mocks.invoke.mock.calls[1][1]).toMatchObject({ atomic: true, path: "/exports/result.txt" });
  expect(mocks.invoke.mock.calls[1][1].text).toContain("Sam's reply"); expect(mocks.invoke.mock.calls[1][1].text).not.toContain("This is the first answer");
  await act(async () => result.current.download("txt"));
  expect(mocks.invoke.mock.calls[3][1].text).toContain("This is the first answer");
  expect(result.current.status).toContain("/exports/result.txt");
});
it("bulk Avid export writes one unique atomic file per person and no empty files", async () => {
  const { result } = renderHook(() => useMultitrackExport(fixture()));
  await act(async () => result.current.downloadPeople());
  expect(mocks.invoke).toHaveBeenCalledTimes(2);
  for (const [index, [command, args]] of mocks.invoke.mock.calls.entries()) { expect(command).toBe("write_text_to_path"); expect(args).toMatchObject({ atomic: true, unique: true }); expect(args.text).toContain(`\t01:00:09:23\tA${index + 1}\tred\t`); }
  expect(result.current.status).toContain("2 files saved in /exports");
  expect(result.current.status).toContain("Older import");
});
it.each(["txt", "csv", "srt", "avid"] as const)("exports the entire transcript as %s and honors save cancellation", async (format) => {
  const { result } = renderHook(() => useMultitrackExport(fixture()));
  await act(async () => result.current.download(format));
  const text = mocks.invoke.mock.calls[1][1].text;
  expect(text).toContain("This is the first answer"); expect(text).toContain("Sam's reply");
  expect(text).toContain("A1"); expect(text).toContain("A2"); expect(text).not.toContain("V1");
  expect(mocks.save.mock.calls[0][0].filters[0].extensions).toEqual([format === "avid" ? "txt" : format]);
  mocks.save.mockResolvedValueOnce(null); mocks.invoke.mockClear();
  await act(async () => result.current.download(format)); expect(mocks.invoke).not.toHaveBeenCalled();
});
it("prints escaped HTML separately from named PDF export", async () => {
  const { result } = renderHook(() => useMultitrackExport(fixture()));
  await act(async () => result.current.download("print"));
  expect(mocks.invoke.mock.calls[0][0]).toBe("print_transcript");
  expect(mocks.invoke.mock.calls[0][1].html).toContain("Sam&#39;s reply");
  expect(mocks.invoke.mock.calls[0][1].html).toContain("This is the first answer");
  expect(mocks.save).not.toHaveBeenCalled(); expect(result.current.status).toContain("Print dialog opened");
  mocks.invoke.mockRejectedValueOnce(new Error("Print unavailable"));
  await act(async () => result.current.download("print")); expect(result.current.error).toBe("Print unavailable");
});
it("PDF uses the user's filename and reports success only after the native write finishes", async () => {
  mocks.save.mockResolvedValue("/exports/Épisode shoot.pdf");
  let finish!: () => void;
  mocks.invoke.mockImplementation(command => command === "aaf_open" ? Promise.resolve(fixture()) : new Promise<void>(resolve => { finish = resolve; }));
  const { result } = renderHook(() => useMultitrackExport(fixture()));
  let work!: Promise<void>;
  await act(async () => { work = result.current.download("pdf"); });
  expect(result.current.phase).toBe("loading"); expect(result.current.status).toBe("");
  expect(mocks.invoke).toHaveBeenCalledWith("export_transcript_pdf", { path: "/exports/Épisode shoot.pdf", html: expect.stringContaining("Shoot date: Not provided") });
  await act(async () => { finish(); await work; });
  expect(result.current.status).toBe("Saved to /exports/Épisode shoot.pdf");
  mocks.save.mockResolvedValueOnce(null); mocks.invoke.mockClear();
  await act(async () => result.current.download("pdf")); expect(mocks.invoke).not.toHaveBeenCalled();
});
it("cancel writes nothing, duplicate clicks share the operation, and partial failure is explicit", async () => {
  mocks.open.mockResolvedValueOnce(null);
  const { result } = renderHook(() => useMultitrackExport(fixture()));
  await act(async () => result.current.downloadPeople()); expect(mocks.invoke).not.toHaveBeenCalled(); expect(result.current.phase).toBe("idle");
  mocks.invoke.mockResolvedValueOnce("saved").mockRejectedValueOnce(new Error("Disk full"));
  await act(async () => { await Promise.all([result.current.downloadPeople(), result.current.downloadPeople()]); });
  expect(mocks.invoke).toHaveBeenCalledTimes(2); expect(result.current.error).toContain("1 of 2 files saved"); expect(result.current.error).toContain("Disk full");
});
it("exports untimed text but never invents Avid markers", async () => {
  const doc = fixture(); doc.transcripts = [{ ...doc.transcripts[0], cues: [], timing_issues: [{ id: "bad", text: "Keep me", reported_timing: "invalid", reason: "outside range", chunk_start_frame: 0 }] }];
  mocks.invoke.mockImplementation(async command => command === "aaf_open" ? doc : "/exports/result.txt");
  const { result } = renderHook(() => useMultitrackExport(doc));
  await act(async () => result.current.download("avid")); expect(mocks.invoke).not.toHaveBeenCalledWith("write_text_to_path", expect.anything()); expect(result.current.phase).toBe("error");
  await act(async () => result.current.download("txt")); expect(mocks.invoke.mock.calls.at(-1)![1].text).toContain("Keep me");
});
it("exports the committed shoot date and result even when Save As outlives its render", async () => {
  const newer = fixture(); newer.shoot_date_override = "2026-08-02"; newer.transcripts[0].cues[0].text = "Committed during Save As";
  mocks.invoke.mockImplementation(async command => command === "aaf_open" ? newer : "/exports/result.txt");
  const { result } = renderHook(() => useMultitrackExport(fixture()));
  await act(async () => result.current.download("txt"));
  expect(mocks.invoke.mock.calls.at(-1)![1].text).toContain("Shoot date: 2026-08-02");
  expect(mocks.invoke.mock.calls.at(-1)![1].text).toContain("Committed during Save As");
});
