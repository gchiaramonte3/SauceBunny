// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { callStats, describeCall, inFlight, measure, pipelineActivity, pipelineInvoke, pipelineLog, subscribePipelineActivity, waitMilestone, watchPage } from "./pipeline";

/** Every row written to the journal so far, flattened. */
const logged = () => mocks.invoke.mock.calls.filter(([command]) => command === "pipeline_log")
  .flatMap(([, args]) => (args as { rows: { level: string; stage: string; message: string }[] }).rows);

beforeEach(() => { vi.useFakeTimers(); mocks.invoke.mockReset(); });
afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers(); });

it("says a call is still waiting at 2, 10, 30 and 60 seconds, as it waits, then how it ended", async () => {
  let answer!: (value: string) => void;
  mocks.invoke.mockImplementation((command: string) => command === "aaf_speech" ? new Promise((resolve) => { answer = resolve; }) : Promise.resolve());
  const invoke = pipelineInvoke("String Outs");
  const call = invoke<string>("aaf_speech", { documentId: "47ab163205dc7aab", trackId: "12" });
  expect(inFlight().map((item) => item.label)).toEqual(["aaf_speech (documentId 47ab1632, trackId 12)"]);
  expect(pipelineActivity()).toEqual({ busy: true, waiting: null });
  await vi.advanceTimersByTimeAsync(61_000);
  const waits = logged().filter((row) => row.level === "warn").map((row) => row.message);
  expect(waits).toHaveLength(4);
  expect(waits[0]).toMatch(/^Still waiting on aaf_speech \(documentId 47ab1632, trackId 12\) after 2\.0 s/);
  expect(waits[3]).toMatch(/after 60 s/);
  expect(pipelineActivity().waiting).toBe("aaf_speech (documentId 47ab1632, trackId 12)");
  answer("done");
  await expect(call).resolves.toBe("done");
  await vi.advanceTimersByTimeAsync(500);
  expect(logged().at(-1)).toMatchObject({ level: "ok", message: expect.stringMatching(/finished after 61 s/) });
  expect(pipelineActivity()).toEqual({ busy: false, waiting: null });
  expect(callStats().find((stat) => stat.command === "aaf_speech")).toMatchObject({ calls: 1, failed: 0 });
});

it("tells the pill about calls made one after another once, not twice a call", async () => {
  // String Outs reads a string out's mics this way: 121 calls for eight
  // sequences. Each idle-then-busy flip re-rendered the whole Pipeline.
  mocks.invoke.mockResolvedValue("ok");
  const invoke = pipelineInvoke("String Outs");
  const heard = vi.fn();
  const stop = subscribePipelineActivity(heard);
  for (let index = 0; index < 40; index++) await invoke("aaf_speech", { documentId: "d", trackId: String(index) });
  expect(heard).toHaveBeenCalledTimes(1);
  expect(pipelineActivity()).toEqual({ busy: true, waiting: null });
  await vi.advanceTimersByTimeAsync(500);
  expect(heard).toHaveBeenCalledTimes(2);
  expect(pipelineActivity()).toEqual({ busy: false, waiting: null });
  stop();
});

it("logs a failure with its message, but not a waveform that was never built or a call the user stopped", async () => {
  const invoke = pipelineInvoke("String Outs");
  mocks.invoke.mockImplementation((command: string) => command === "edit_commit" ? Promise.reject(new Error("database is locked"))
    : command === "aaf_waveform" ? Promise.reject(new Error("This track's waveform has not been built"))
      : command === "aaf_prepare_audio" ? Promise.reject(new Error("Cancelled")) : Promise.resolve());
  await expect(invoke("edit_commit", { id: "edit-1", document: { title: "Sam's bites" } })).rejects.toThrow("database is locked");
  await expect(invoke("aaf_waveform", { documentId: "d", trackId: "t" })).rejects.toThrow();
  await expect(invoke("aaf_prepare_audio", { jobId: "j" })).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(500);
  const rows = logged();
  expect(rows.filter((row) => row.level === "err").map((row) => row.message)).toEqual([expect.stringMatching(/^edit_commit \(id edit-1\) failed after .*: database is locked$/)]);
  expect(JSON.stringify(rows)).not.toContain("Sam's bites");
  expect(callStats().find((stat) => stat.command === "aaf_waveform")).toMatchObject({ failed: 0 });
});

it("describes a call by its ids, never its text, and passes the call through exactly as written", () => {
  expect(describeCall("assistant_chat", { args: { question: "Where does Sam say tired" } })).toBe("assistant_chat");
  expect(describeCall("edit_commit", { id: "1a2b3c4d5e6f7a8b9c", label: "Insert Sam", document: {} })).toBe("edit_commit (id 1a2b3c4d)");
  expect(describeCall("aaf_open", new Uint8Array([1]))).toBe("aaf_open");
  mocks.invoke.mockResolvedValue(undefined);
  const invoke = pipelineInvoke("String Outs");
  void invoke("edit_list");
  void invoke("edit_head", { id: "e" });
  expect(mocks.invoke.mock.calls.slice(0, 2)).toEqual([["edit_list"], ["edit_head", { id: "e" }]]);
});

it("logs a calculation that held the page, and nothing for one that did not", async () => {
  const clock = vi.spyOn(performance, "now");
  clock.mockReturnValueOnce(0).mockReturnValueOnce(1_400);
  expect(measure("String Outs", "Placing 146,018 words", () => 7)).toBe(7);
  clock.mockReturnValueOnce(0).mockReturnValueOnce(20);
  measure("String Outs", "Placing 12 words", () => 1);
  clock.mockRestore();
  await vi.advanceTimersByTimeAsync(500);
  expect(logged().map((row) => [row.level, row.message])).toEqual([["warn", "Placing 146,018 words held the page for 1.4 s."]]);
});

it("beats for the watchdog while the page shows, logs a stall, and catches what nothing else caught", async () => {
  mocks.invoke.mockResolvedValue(undefined);
  const stop = watchPage("String Outs");
  await vi.advanceTimersByTimeAsync(1_000);
  expect(mocks.invoke).toHaveBeenCalledWith("pipeline_heartbeat", { page: "String Outs", visible: true });
  // The page's thread held for 3 s: the next tick arrives that late.
  const now = performance.now();
  vi.spyOn(performance, "now").mockReturnValue(now + 3_250);
  await vi.advanceTimersByTimeAsync(250);
  vi.restoreAllMocks();
  window.dispatchEvent(new ErrorEvent("error", { message: "boom", filename: "http://localhost/src/EditTranscript.tsx", lineno: 12 }));
  pipelineLog("String Outs", "flush");
  await vi.advanceTimersByTimeAsync(500);
  const messages = logged().map((row) => row.message);
  expect(messages).toContainEqual(expect.stringMatching(/^The page did not respond for 3\.\d s/));
  expect(messages).toContain("Uncaught error: boom (EditTranscript.tsx:12)");
  stop();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.invoke).toHaveBeenCalledWith("pipeline_heartbeat", { page: "String Outs", visible: false });
});

it("reports a wait at the milestones the backend's watchdog uses", () => {
  expect([0, 1, 2, 3, 4, 5].map(waitMilestone)).toEqual([2_000, 10_000, 30_000, 60_000, 120_000, 180_000]);
});
