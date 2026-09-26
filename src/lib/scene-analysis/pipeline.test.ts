import { beforeEach, describe, expect, it, vi } from "vitest";
import { ANALYSIS_PIPELINE_EVENT, createAnalysisPipeline, isAnalysisPipelineEvent, type AnalysisPipelineEvent } from "./pipeline";

const mocks = vi.hoisted(() => ({ emitTo: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ emitTo: mocks.emitTo }));
beforeEach(() => { vi.resetAllMocks(); mocks.emitTo.mockResolvedValue(undefined); });
const packets = () => mocks.emitTo.mock.calls.map(call => call[2] as AnalysisPipelineEvent);
async function drained() { await vi.waitFor(() => expect(packets().at(-1)?.status).toBe("finished")); }

describe("analysis Pipeline trace", () => {
  it("uses the actual source/model and ordered main-window events, without logging content", async () => {
    const trace = createAnalysisPipeline("/private/DIGGER.mp4", "qwen3.5-4b-video");
    trace.note("Checking source identity…");
    trace.native({ job_id: "job", phase: "loading-model", completed: 0, total: 0 });
    trace.finish("Analysis complete.", "ok");
    await drained();
    expect(mocks.emitTo.mock.calls.every(call => call[0] === "main" && call[1] === ANALYSIS_PIPELINE_EVENT)).toBe(true);
    expect(packets().map(packet => packet.sequence)).toEqual([1, 2, 3, 4]);
    expect(new Set(packets().map(packet => packet.runId)).size).toBe(1);
    expect(packets()[0].message).toContain("DIGGER.mp4 · Starting analysis on this Mac · Qwen3.5 4B");
    expect(packets()[2].message).toContain("Loading Qwen3.5 4B");
    expect(packets().every(isAnalysisPipelineEvent)).toBe(true);
  });
  it("coalesces high-frequency progress and ignores duplicate/backward/invalid counters", async () => {
    const trace = createAnalysisPipeline("/a.mp4", "qwen3.5-9b-video");
    for (let count = 0; count <= 1000; count++) trace.detector(count / 1000);
    trace.detector(0.1); trace.detector(NaN); trace.detector(Infinity); trace.detector(2);
    const update = { job_id: "job", phase: "shot-complete", completed: 1, total: 49 };
    trace.native(update, 64, 113); trace.native(update, 64, 113);
    trace.native({ ...update, completed: 0 }, 64, 113);
    trace.native({ ...update, completed: 50 }, 64, 113);
    trace.finish("Stopped.", "warn");
    await drained();
    expect(packets().filter(packet => packet.message.includes("Detecting shots"))).toHaveLength(21);
    expect(packets().filter(packet => packet.message.includes("Shot 65"))).toHaveLength(1);
    expect(packets().find(packet => packet.message.includes("Shot 65"))?.message).toContain("Shot 65 of 113 ready");
  });
  it("stopping and completion are idempotent and reject late progress", async () => {
    const trace = createAnalysisPipeline("/a.mp4", "qwen3.5-9b-video");
    trace.stopping("playback took priority."); trace.stopping("duplicate");
    trace.note("not allowed"); trace.detector(0.5);
    trace.native({ job_id: "job", phase: "loading-model", completed: 0, total: 0 });
    trace.finish("Stopped.", "warn"); trace.finish("Wrong success.", "ok"); trace.note("late");
    await drained();
    expect(packets().map(packet => packet.status)).toEqual(["active", "stopping", "finished"]);
    expect(packets().at(-1)?.tag).toBe("warn");
  });
  it("distinguishes classifier loading and bounds source/error text", async () => {
    const trace = createAnalysisPipeline("/" + "x".repeat(4000), "qwen3.5-9b-video");
    trace.native({ job_id: "job", phase: "loading-model", completed: 0, total: 0 }, 0, 0, true);
    trace.finish("Failure: " + "x".repeat(4000), "err");
    await drained();
    expect(packets()[1].message).toContain("Loading AST sound classifier");
    expect(packets().every(isAnalysisPipelineEvent)).toBe(true);
    expect(isAnalysisPipelineEvent({ ...packets()[0], sequence: NaN })).toBe(false);
    expect(isAnalysisPipelineEvent({ ...packets()[0], tag: "invented" })).toBe(false);
    expect(isAnalysisPipelineEvent(null)).toBe(false);
  });
  it("does not make a closed main window fail or stall analysis", async () => {
    mocks.emitTo.mockRejectedValue(new Error("Window closed"));
    const trace = createAnalysisPipeline("/a.mp4", "qwen3.5-9b-video");
    trace.finish("Stopped.", "warn");
    await drained();
    expect(packets()).toHaveLength(2);
  });
});
