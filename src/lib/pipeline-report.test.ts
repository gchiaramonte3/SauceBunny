import { expect, it } from "vitest";
import type { AafDiagnosticEvent } from "../bindings/AafDiagnosticEvent";
import type { PipelineHealth } from "../bindings/PipelineHealth";
import { pipelineReport } from "./pipeline-report";

const row = (id: number): AafDiagnosticEvent => ({ id: String(id), timestamp_ms: id, job_id: "import-1", level: "warn", stage: "candidate", message: `Missing /Volumes/Show/track-${id}.mxf`, active: null });
const health: PipelineHealth = { resident_bytes: 1_610_612_736, uptime_seconds: 3_700, running_jobs: ["job-aaf-7"], main_thread_wait_ms: 12_000,
  volumes: ["/Volumes/Show · avidfos · network · from //[account]@nexis/Show"], latest_hang: "/logs/hang-1.txt\nCall graph:\n    2001 Thread_1   com.apple.main-thread\n      2001 read" };
const base = { page: "String Outs", rows: [], health: null, context: null, inflight: [], stats: [], userAgent: "WebKit", now: new Date(0) };

it("exports failed imports without a document and includes full timestamps and native errors", () => {
  const report = pipelineReport({ ...base, page: "AAF Audio", snapshots: [{ events: [row(1)], active_jobs: [], persistence_error: "Disk full", context: '{"document":null,"app_version":"0.5.1"}' }], rows: [row(1), row(2)] });
  expect(report).toContain('"document":null'); expect(report).toContain("Disk full");
  expect(report).toContain("1970-01-01T00:00:00.001Z [warn] candidate [import-1]");
  expect(report.match(/Missing \/Volumes\/Show\/track-1.mxf/g)).toHaveLength(1);
  expect(report).toContain("not uploaded automatically");
});

it("says what a hang looked like: the main thread, the volumes, what was in flight and how every call has done", () => {
  const report = pipelineReport({ ...base, health,
    snapshots: [{ events: [], active_jobs: [], persistence_error: null, context: "{}" }, { events: [], active_jobs: [], persistence_error: null, context: "{}" }],
    context: { text: "String out 1a2b3c4d · 2 sources · 41 clips", documentIds: ["a", "b"] },
    inflight: [{ stage: "String Outs", label: "aaf_speech (documentId 47ab1632, trackId 12)", ms: 34_000, warned: true }],
    stats: [{ command: "aaf_speech", calls: 20, failed: 1, totalMs: 8_000, maxMs: 34_000, lastError: "Timed out" }] });
  expect(report).toContain("Main thread: NOT ANSWERING for 12 s");
  expect(report).toContain("1.50 GB resident");
  expect(report).toContain("/Volumes/Show · avidfos · network");
  expect(report).toContain("34 s · String Outs · aaf_speech (documentId 47ab1632, trackId 12) · waiting");
  expect(report).toContain("aaf_speech · 20 · 1 · 400 ms · 34 s · Timed out");
  expect(report).toContain("LATEST HANG SAMPLE");
  expect(report).toContain("CONTEXT 2 of 2");
  expect(report).toContain("String out 1a2b3c4d · 2 sources");
});

it("still reports when the health check could not answer", () => {
  const report = pipelineReport({ ...base, snapshots: [], healthError: "Native unavailable" });
  expect(report).toContain("HEALTH\nUnavailable: Native unavailable");
  expect(report).toContain("IN FLIGHT NOW (calls the page is waiting on, oldest first)\nNothing.");
});
