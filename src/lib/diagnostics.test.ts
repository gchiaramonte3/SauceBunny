import { describe, it, expect } from "vitest";
import {
  buildDiagnosticsReport,
  diagnosticsFilename,
  DIAGNOSTICS_LOG_LIMIT,
  type DiagnosticsInput,
  type DiagnosticsLogLine,
} from "./diagnostics";

const line = (n: number): DiagnosticsLogLine => ({
  ts: "12:00:00",
  tag: "info",
  source: "yt-dlp",
  message: `line ${n}`,
});

const baseInput = (over: Partial<DiagnosticsInput> = {}): DiagnosticsInput => ({
  appVersion: "0.1.0",
  expectedBuildId: "2026-07-08-r108",
  backendBuildId: "2026-07-08-r108",
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
  generatedAt: new Date(2026, 6, 13, 9, 5, 30),
  settings: { whisperModel: "small.en", folder: null, captionSizePx: 13 },
  sidecars: [{ name: "yt-dlp", version: "2026.06.09 (bundled)" }],
  logLines: [line(1), line(2)],
  ...over,
});

describe("diagnosticsFilename", () => {
  it("stamps saucebunny-diagnostics-YYYYMMDD-HHMM.txt in local time, zero-padded", () => {
    expect(diagnosticsFilename(new Date(2026, 6, 13, 9, 5)))
      .toBe("saucebunny-diagnostics-20260713-0905.txt");
    expect(diagnosticsFilename(new Date(2026, 11, 1, 23, 59)))
      .toBe("saucebunny-diagnostics-20261201-2359.txt");
  });
});

describe("buildDiagnosticsReport", () => {
  it("includes every section with the supplied values", () => {
    const r = buildDiagnosticsReport(baseInput());
    expect(r).toContain("Sauce Bunny — diagnostics report");
    expect(r).toContain("App version:     0.1.0");
    expect(r).toContain("Build (frontend): 2026-07-08-r108");
    expect(r).toContain("Build (backend):  2026-07-08-r108 (match)");
    expect(r).toContain("OS / WebView:    Mozilla/5.0");
    expect(r).toContain("== Settings ==");
    expect(r).toContain('whisperModel = "small.en"');
    expect(r).toContain("folder = null");
    expect(r).toContain("yt-dlp: 2026.06.09 (bundled)");
    expect(r).toContain("== Pipeline log (2 lines) ==");
    expect(r).toContain("12:00:00 info  yt-dlp     line 1");
  });

  it("flags a backend/frontend build mismatch loudly", () => {
    const r = buildDiagnosticsReport(baseInput({ backendBuildId: "older-build" }));
    expect(r).toContain("Build (backend):  older-build (MISMATCH)");
    expect(r).not.toContain("(match)");
  });

  it("prints settings keys sorted for a stable report", () => {
    const r = buildDiagnosticsReport(baseInput({ settings: { zebra: 1, alpha: 2 } }));
    expect(r.indexOf("alpha = 2")).toBeGreaterThan(-1);
    expect(r.indexOf("alpha = 2")).toBeLessThan(r.indexOf("zebra = 1"));
  });

  it("caps the log at the last DIAGNOSTICS_LOG_LIMIT lines and says so", () => {
    const many = Array.from({ length: DIAGNOSTICS_LOG_LIMIT + 5 }, (_, i) => line(i + 1));
    const r = buildDiagnosticsReport(baseInput({ logLines: many }));
    expect(r).toContain(`== Pipeline log (last ${DIAGNOSTICS_LOG_LIMIT} of ${many.length} lines) ==`);
    // Oldest lines dropped, newest kept.
    expect(r).not.toContain("line 5\n");
    expect(r).toContain("line 6");
    expect(r).toContain(`line ${many.length}`);
  });

  it("handles an empty log and missing sidecar versions", () => {
    const r = buildDiagnosticsReport(baseInput({ logLines: [], sidecars: [] }));
    expect(r).toContain("== Pipeline log (0 lines) ==");
    expect(r).toContain("(empty)");
    expect(r).toContain("(no sidecar versions available)");
  });
});
