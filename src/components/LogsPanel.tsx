import { useEffect, useRef } from "react";
import { IconChevronDown } from "./Icons";
import type { AppStatus, ClientLog } from "../types";

type Props = {
  open: boolean;
  onToggle: () => void;
  status: AppStatus;
  progress: number;
  lines: ClientLog[];
  onClear: () => void;
  onCopy: () => void;
  /** Optional secondary phase that overrides the status pill when active. */
  transcriptState?: "idle" | "running" | "done" | "error";
  transcriptProgress?: number;
  /**
   * Background phases that show in the pipeline pill without blocking the
   * canvas. metadataLoading = yt-dlp still resolving manifests after the
   * IFrame already mounted; playbackPrepBusy = ffmpeg transcoding an
   * imported file to a WKWebView-friendly format.
   */
  metadataLoading?: boolean;
  playbackPrepBusy?: boolean;
  /** Cancel button shown in the header while something is running. */
  canStop?: boolean;
  onStop?: () => void;
};

function pillFor(status: AppStatus): { label: string; cls: string } {
  switch (status) {
    case "fetching":  return { label: "RESOLVING", cls: "working" };
    case "exporting": return { label: "EXPORTING", cls: "working" };
    case "success":   return { label: "OK",        cls: "success" };
    case "error":     return { label: "ERROR",     cls: "error" };
    case "loaded":    return { label: "READY",     cls: "" };
    default:          return { label: "IDLE",      cls: "" };
  }
}

export function LogsPanel({
  open, onToggle, status, progress, lines, onClear, onCopy,
  transcriptState, transcriptProgress,
  metadataLoading, playbackPrepBusy,
  canStop, onStop,
}: Props) {
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (bodyRef.current && open) {
      bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
    }
  }, [lines, open]);

  // Pill priority (most expensive / blocking first):
  //   1. Exporting   — heavy ffmpeg job, shows %.
  //   2. Whisper     — long transcription, shows %.
  //   3. Playback prep — ffmpeg transcoding a local import.
  //   4. Resolving   — yt-dlp probing manifests after optimistic IFrame mount.
  //   5. Default status pill (ready / idle / error / etc.).
  const whisperRunning = transcriptState === "running";
  const pill = status === "exporting"
    ? { label: `EXPORTING · ${Math.round(progress)}%`, cls: "working" }
    : whisperRunning
      ? { label: `WHISPER · ${Math.round(transcriptProgress ?? 0)}%`, cls: "working" }
      : playbackPrepBusy
        ? { label: "PREPARING PLAYBACK", cls: "working" }
        : metadataLoading
          ? { label: "RESOLVING METADATA", cls: "working" }
          : pillFor(status);
  const showProgress = whisperRunning || status === "exporting";
  const shownProgress = whisperRunning ? (transcriptProgress ?? 0) : progress;

  return (
    <div className={"cp-logs " + (open ? "open" : "collapsed")}>
      <div className="cp-logs-header" onClick={onToggle}>
        <IconChevronDown size={11} className="chev" style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)" }} />
        <span className="title">Pipeline</span>
        <span className={"status-pill " + pill.cls}>{pill.label}</span>
        {showProgress && (
          <div className="progress">
            <div className="progress-bar" style={{ width: `${shownProgress}%` }} />
          </div>
        )}
        <div className="filler" />
        {canStop && (
          <button
            type="button"
            className="cp-logs-stop"
            onClick={(e) => { e.stopPropagation(); onStop?.(); }}
            title="Cancel the running operation"
          >
            <span className="dot" /> Stop
          </button>
        )}
        {/* Copy/Clear use the same .btn-ghost styling as the top toolbar's
            Clear button — single button system across the app. */}
        <div className="actions" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="btn btn-ghost btn-compact" onClick={onCopy}>Copy</button>
          <button type="button" className="btn btn-ghost btn-compact" onClick={onClear}>Clear</button>
        </div>
      </div>
      {open && (
        <div className="cp-logs-body" ref={bodyRef}>
          {lines.length === 0 ? (
            <div className="log-line">
              <span className="ts">—</span>
              <span className="tag info">idle</span>
              <span className="msg">Awaiting source. Logs will populate during fetch and export.</span>
            </div>
          ) : lines.map((l) => (
            <div className="log-line" key={l.id}>
              <span className="ts">{l.ts}</span>
              <span className={"tag " + l.tag}>{l.source}</span>
              <span className="msg">{l.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
