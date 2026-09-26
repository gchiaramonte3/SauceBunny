import { expect, it } from "vitest";
import type { AafDiagnosticEvent } from "../bindings/AafDiagnosticEvent";
import { mergeMultitrackLogs, multitrackDiagnosticsText } from "./multitrack-diagnostics";
const row = (id: number): AafDiagnosticEvent => ({ id: String(id), timestamp_ms: id, job_id: "import-1", level: "warn", stage: "candidate", message: `Missing /Volumes/Show/track-${id}.mxf`, active: null });
it("deduplicates snapshot/live overlap, orders rows and bounds retention", () => {
  const rows = mergeMultitrackLogs([row(3), row(1)], [row(2), row(3)]);
  expect(rows.map(r => r.id)).toEqual(["1", "2", "3"]);
  const many = mergeMultitrackLogs(Array.from({ length: 1600 }, (_, n) => row(n)));
  expect(many).toHaveLength(1500); expect(many[0].id).toBe("100");
});
it("exports failed imports without a document and includes full timestamps and native errors", () => {
  const report = multitrackDiagnosticsText({ events: [row(1)], active_jobs: [], persistence_error: "Disk full", context: '{"document":null,"app_version":"0.5.1"}' }, [row(1), row(2)], "WebKit", new Date(0));
  expect(report).toContain('"document":null'); expect(report).toContain("Disk full");
  expect(report).toContain("1970-01-01T00:00:00.001Z [warn] candidate [import-1]");
  expect(report.match(/Missing \/Volumes\/Show\/track-1.mxf/g)).toHaveLength(1);
  expect(report).toContain("not uploaded automatically");
});
