// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { multitrackFixture, multitrackGroupFixture, multitrackTranscript } from "../test/multitrack-fixture";
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
  expect(mocks.invoke).toHaveBeenCalledTimes(3);
  for (const [index, [command, args]] of mocks.invoke.mock.calls.slice(1).entries()) { expect(command).toBe("write_text_to_path"); expect(args).toMatchObject({ atomic: true, unique: true }); expect(args.text).toContain(`\t01:00:09:23\tA${index + 1}\tred\t`); }
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
  mocks.invoke.mockResolvedValueOnce(fixture()).mockResolvedValueOnce("saved").mockRejectedValueOnce(new Error("Disk full"));
  await act(async () => { await Promise.all([result.current.downloadPeople(), result.current.downloadPeople()]); });
  expect(mocks.invoke).toHaveBeenCalledTimes(3); expect(result.current.error).toContain("1 of 2 marker files saved"); expect(result.current.error).toContain("Disk full");
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
it.each(["txt", "csv", "pdf", "srt", "avid", "print"] as const)("selected %s output includes only the chosen source IDs even when owners match", async format => {
  const doc = fixture(); doc.transcripts.push({ ...multitrackTranscript("track-3"), cues: [{ ...multitrackTranscript().cues[0], text: "Room sound" }] });
  doc.labels = doc.manifest.tracks.map(track => ({ track_id: track.id, owner_name: "Same owner", cast_member_id: null, color: null, marker_color: track.id === "track-3" ? "pink" : "blue" }));
  mocks.invoke.mockImplementation(async command => command === "aaf_open" ? doc : "/exports/Selected tracks.txt");
  const { result } = renderHook(() => useMultitrackExport(doc));
  await act(async () => result.current.download(format, ["track-1", "track-3"], "Selected tracks"));
  const call = mocks.invoke.mock.calls.at(-1)!;
  const text = call[1][format === "pdf" || format === "print" ? "html" : "text"];
  expect(text).toContain("This is the first answer"); expect(text).toContain("Room sound");
  expect(text).not.toContain("Sam's reply"); expect(text).not.toContain("Sam&#39;s reply");
  expect(text).toContain("A1"); expect(text).toContain("A3"); expect(text).not.toContain("A2");
  if (format === "avid") { expect(text).toContain("\tA1\tblue\t"); expect(text).toContain("\tA3\tpink\t"); }
  if (format !== "print") expect(mocks.save.mock.calls[0][0].defaultPath).toContain("Selected tracks");
});
it("keeps the clicked selection through Save As while picking up newly committed text", async () => {
  let finish!: (path: string | null) => void;
  mocks.save.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const { result, rerender } = renderHook(({ doc }) => useMultitrackExport(doc), { initialProps: { doc: fixture() } });
  let work!: Promise<void>;
  await act(async () => { work = result.current.download("txt", ["track-2"], "Selected tracks"); });
  const newer = fixture(); newer.transcripts[1].cues[0].text = "Latest selected result";
  mocks.invoke.mockImplementation(async command => command === "aaf_open" ? newer : "/exports/chosen.txt");
  rerender({ doc: newer });
  await act(async () => { finish("/exports/chosen.txt"); await work; });
  const text = mocks.invoke.mock.calls.at(-1)![1].text;
  expect(text).toContain("Latest selected result"); expect(text).not.toContain("This is the first answer");
  mocks.invoke.mockClear();
  await act(async () => { work = result.current.download("txt", ["track-1"], "Selected tracks"); });
  await act(async () => { finish(null); await work; });
  expect(mocks.invoke).not.toHaveBeenCalled(); expect(result.current.phase).toBe("idle");
});

function groupFixture() {
  const doc = multitrackGroupFixture();
  doc.transcripts = doc.manifest.tracks.map(track => ({ ...multitrackTranscript(track.id), cues: [{ ...multitrackTranscript().cues[0], text: `Dialogue from ${track.id}` }] }));
  doc.labels = doc.manifest.tracks.map(track => ({ track_id: track.id, owner_name: "Same name", cast_member_id: null, color: null, marker_color: track.id === "track-2" ? "blue" : "pink" }));
  doc.manifest.tracks[0].physical_track_number = 4;
  return doc;
}
it.each(["selected", "entire", "by-mic"])("%s Avid exports keep group microphones separate and write an import guide", async action => {
  const doc = groupFixture();
  mocks.invoke.mockImplementation(async (command, args) => command === "aaf_open" ? doc : args.path.replace(".txt", " (2).txt"));
  const { result } = renderHook(() => useMultitrackExport(doc));
  await act(async () => action === "by-mic" ? result.current.downloadPeople() : result.current.download("avid", action === "selected" ? ["track-2", "track-3"] : undefined));
  expect(mocks.save).not.toHaveBeenCalled(); expect(mocks.open.mock.calls[0][0].title).toContain("parent sequence tracks");
  const writes = mocks.invoke.mock.calls.filter(([command]) => command === "write_text_to_path").map(([, args]) => args);
  const markers = writes.filter(args => args.path.endsWith(".txt")), guide = writes.find(args => args.path.endsWith(".md"));
  expect(markers).toHaveLength(action === "selected" ? 2 : 3);
  expect(new Set(markers.map(args => args.path)).size).toBe(markers.length);
  for (const args of writes) expect(args).toMatchObject({ atomic: true, unique: true });
  expect(markers.every(args => args.text.trim().split("\n").length === 1 && args.text.includes("\tA4\t"))).toBe(true);
  expect(guide.text).toContain(" (2).txt"); expect(guide.text).toContain("one microphone file per parent track");
  expect(result.current.status).toContain("not the source group"); expect(result.current.phase).toBe("success");
});
it("an individual offline group microphone uses named Save As and only its own text/color", async () => {
  const doc = groupFixture(); doc.manifest.graph!.lanes[1].availability = "offline";
  mocks.invoke.mockImplementation(async command => command === "aaf_open" ? doc : "/exports/Mic.txt");
  const { result } = renderHook(() => useMultitrackExport(doc));
  await act(async () => result.current.download("avid", ["track-2"], "My mic"));
  expect(mocks.open).not.toHaveBeenCalled(); expect(mocks.save.mock.calls[0][0]).toMatchObject({ defaultPath: "Interview - My mic - Avid markers.txt", title: expect.stringContaining("parent sequence track") });
  const text = mocks.invoke.mock.calls.at(-1)![1].text;
  expect(text).toContain("\tA4\tblue\t"); expect(text).toContain("Dialogue from track-2"); expect(text).not.toContain("Dialogue from track-1");
});
it("folder exports snapshot selection but read newly committed transcripts after the chooser", async () => {
  const doc = groupFixture(), ids = ["track-2", "track-3"];
  let choose!: (path: string | null) => void;
  mocks.open.mockImplementation(() => new Promise(resolve => { choose = resolve; }));
  const { result } = renderHook(() => useMultitrackExport(doc));
  let work!: Promise<void>;
  await act(async () => { work = result.current.download("avid", ids); });
  ids.splice(0, 2, "track-1");
  const newer = groupFixture(); newer.transcripts[1].cues[0].text = "Committed during folder chooser";
  mocks.invoke.mockImplementation(async (command, args) => command === "aaf_open" ? newer : args.path);
  await act(async () => { choose("/exports"); await work; });
  const text = mocks.invoke.mock.calls.filter(([command, args]) => command === "write_text_to_path" && args.path.endsWith(".txt")).map(([, args]) => args.text).join("");
  expect(text).toContain("Committed during folder chooser"); expect(text).toContain("Dialogue from track-3"); expect(text).not.toContain("Dialogue from track-1");
});
it("group folder cancellation writes nothing and unmount stops after the last completed file", async () => {
  mocks.open.mockResolvedValueOnce(null);
  const doc = groupFixture();
  const { result, unmount } = renderHook(() => useMultitrackExport(doc));
  await act(async () => result.current.download("avid")); expect(mocks.invoke).not.toHaveBeenCalled();
  let finish!: (path: string) => void;
  mocks.invoke.mockImplementation(command => command === "aaf_open" ? Promise.resolve(doc) : new Promise(resolve => { finish = resolve; }));
  let work!: Promise<void>;
  await act(async () => { work = result.current.download("avid"); });
  unmount();
  await act(async () => { finish("/exports/first.txt"); await work; });
  expect(mocks.invoke.mock.calls.filter(([command]) => command === "write_text_to_path")).toHaveLength(1);
});
it("reports partial group writes and guide failures without claiming a completed export", async () => {
  const doc = groupFixture();
  mocks.invoke.mockResolvedValueOnce(doc).mockResolvedValueOnce("/exports/first.txt").mockRejectedValueOnce(new Error("Disk full"));
  const { result } = renderHook(() => useMultitrackExport(doc));
  await act(async () => result.current.download("avid"));
  expect(result.current.error).toContain("1 of 3 marker files saved"); expect(result.current.status).toBe("");
  mocks.invoke.mockImplementation(async (command, args) => { if (command === "aaf_open") return doc; if (args.path.endsWith(".md")) throw new Error("Cannot write guide"); return args.path; });
  await act(async () => result.current.download("avid"));
  expect(result.current.error).toContain("3 of 3 marker files saved"); expect(result.current.error).toContain("Cannot write guide"); expect(result.current.phase).toBe("error");
});
