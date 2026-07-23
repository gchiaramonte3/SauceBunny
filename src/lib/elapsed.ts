/**
 * Human durations for the pipeline log (mirror of Rust's `fmt_elapsed` in
 * src-tauri/src/commands/mod.rs — keep the two in step so a log reads
 * consistently whichever side produced the line).
 *
 * Tuned for reporting, not precision: the unit steps down as the number grows
 * so the string stays short enough to scan, and to paste into a bug report.
 */
export function fmtElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const total = Math.floor(secs);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}h ${String(m).padStart(2, "0")}m`
    : `${m}m ${String(s).padStart(2, "0")}s`;
}

/** Pipeline phase ids -> what a human calls that stage. */
export function stageLabel(phase: string): string {
  switch (phase) {
    case "extract": return "Audio prep";
    case "whisper": return "Whisper";
    case "parakeet": return "Parakeet";
    case "diarize-prepare": return "Speaker models";
    case "diarize-process": return "Speaker detection";
    case "diarize-merge": return "Speaker merge";
    default: return phase;
  }
}
