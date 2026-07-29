import { describe, expect, it } from "vitest";
import { formatBytes } from "./library";

describe("formatBytes — the one byte formatter", () => {
  it("shows small files as a real size, not as nothing", () => {
    // THE bug this consolidation fixes. MediaInfoModal carried its own copy
    // with no KB tier, so an SRT sidecar rendered "0.0 MB" - which reads as
    // an empty or broken file rather than a 4 KB one.
    expect(formatBytes(4096)).toBe("4 KB");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(0)).toBe("0 B");
  });

  it("keeps one significant decimal only where it carries information", () => {
    expect(formatBytes(1.5 * 1024 ** 2)).toBe("1.5 MB");
    // Past 10 the decimal is noise on a file size.
    expect(formatBytes(160 * 1024 ** 2)).toBe("160 MB");
    expect(formatBytes(2.5 * 1024 ** 3)).toBe("2.5 GB");
  });

  it("steps up exactly at each boundary rather than near it", () => {
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1 KB");
    expect(formatBytes(1024 ** 2 - 1)).toBe("1024 KB");
    expect(formatBytes(1024 ** 2)).toBe("1.0 MB");
  });

  it("returns empty for a non-size rather than NaN", () => {
    // Callers render this straight into a cell; "NaN MB" is worse than blank.
    expect(formatBytes(Number.NaN)).toBe("");
    expect(formatBytes(-1)).toBe("");
    expect(formatBytes(Infinity)).toBe("");
  });
});
