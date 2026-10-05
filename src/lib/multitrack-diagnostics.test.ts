import { expect, it } from "vitest";
import type { AafDiagnosticEvent } from "../bindings/AafDiagnosticEvent";
import { mergeMultitrackLogs } from "./multitrack-diagnostics";
const row = (id: number): AafDiagnosticEvent => ({ id: String(id), timestamp_ms: id, job_id: "import-1", level: "warn", stage: "candidate", message: `Missing /Volumes/Show/track-${id}.mxf`, active: null });
it("deduplicates snapshot/live overlap, orders rows and bounds retention", () => {
  const rows = mergeMultitrackLogs([row(3), row(1)], [row(2), row(3)]);
  expect(rows.map(r => r.id)).toEqual(["1", "2", "3"]);
  const many = mergeMultitrackLogs(Array.from({ length: 1600 }, (_, n) => row(n)));
  expect(many).toHaveLength(1500); expect(many[0].id).toBe("100");
});
