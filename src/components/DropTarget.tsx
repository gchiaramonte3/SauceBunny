import { useEffect, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { ToastKind } from "./CanvasToast";
import { IconImport } from "./Icons";
import { isMediaFile, isTranscriptFile } from "../lib/import-extensions";

/**
 * Full-window drop target for OS file drags — main window only (PanelApp
 * never mounts this, so the floating panel ignores drops).
 *
 * Files arrive through Tauri's webview drag-drop events
 * (`getCurrentWebview().onDragDropEvent`), NOT HTML5 drag-and-drop:
 * WKWebView never exposes real file paths on `dataTransfer`; the Rust shell
 * forwards the OS drag as `tauri://drag-*` events instead. On macOS the
 * `enter` payload already carries the dragged paths, so the overlay can say
 * whether the drop will load media or a transcript; if a platform ever
 * delivers an empty `enter`, the copy degrades to a generic "Drop to import".
 *
 * Routing on drop (mirrors the Toolbar import button — media goes through
 * the same loadLocalPath core, so recents/session-restore come for free):
 *   - a single .srt/.vtt      → transcript import (needs a loaded source)
 *   - first accepted media    → media import (single-source app: first wins)
 *   - anything else           → toast, no state change
 * Drops while an import/export is in flight are refused with a toast rather
 * than yanking the session out from under the running job.
 */

type DropTargetProps = {
  /** An import/export/prep job is running — refuse drops instead of interrupting it. */
  busy: boolean;
  /** A media source is loaded — required before a transcript drop makes sense. */
  hasSource: boolean;
  onImportMedia: (path: string) => void;
  onImportTranscript: (path: string) => void;
  notify: (kind: ToastKind, title: string, body: string) => void;
};

type DropKind = "media" | "transcript" | "unsupported" | "unknown";

function classifyDrag(paths: string[]): { kind: DropKind; path: string | null } {
  if (paths.length === 1 && isTranscriptFile(paths[0])) {
    return { kind: "transcript", path: paths[0] };
  }
  const media = paths.find(isMediaFile);
  if (media) return { kind: "media", path: media };
  return { kind: paths.length === 0 ? "unknown" : "unsupported", path: null };
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function DropTarget({ busy, hasSource, onImportMedia, onImportTranscript, notify }: DropTargetProps) {
  const [hover, setHover] = useState<{ kind: DropKind; filename: string | null } | null>(null);

  // Subscribe to the webview exactly once; the drop handler reads live props
  // through this ref so a busy-flag flip mid-drag can't lose events in an
  // unlisten/relisten gap.
  const propsRef = useRef({ busy, hasSource, onImportMedia, onImportTranscript, notify });
  propsRef.current = { busy, hasSource, onImportMedia, onImportTranscript, notify };

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    const handleDrop = (paths: string[]) => {
      const p = propsRef.current;
      if (p.busy) {
        p.notify("info", "Import busy",
          "A job is already running — wait for it to finish (or stop it), then drop again.");
        return;
      }
      const { kind, path } = classifyDrag(paths);
      if (kind === "media" && path) { p.onImportMedia(path); return; }
      if (kind === "transcript" && path) {
        if (p.hasSource) p.onImportTranscript(path);
        else p.notify("info", "Load media first",
          "Import a video or audio file, then drop the transcript to pair it.");
        return;
      }
      p.notify("error", "Nothing to import",
        "Drop a video or audio file (mp4, mov, mp3, …) or an .srt/.vtt transcript.");
    };

    void getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === "enter") {
        const { kind, path } = classifyDrag(p.paths);
        setHover({ kind, filename: path ? basename(path) : null });
      } else if (p.type === "leave") {
        setHover(null);
      } else if (p.type === "drop") {
        setHover(null);
        handleDrop(p.paths);
      }
      // "over" only carries a position — the enter classification stands.
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => { disposed = true; unlisten?.(); };
  }, []);

  if (!hover) return null;

  const { kind, filename } = hover;
  const variant = busy ? "busy" : kind;
  const generic = "Video, audio, or .srt/.vtt transcript files.";
  const title =
    busy ? "Import in progress"
    : kind === "transcript" ? (hasSource ? "Drop to load transcript" : "Transcript needs media")
    : kind === "unsupported" ? "Unsupported file type"
    : "Drop to import";
  const hint =
    busy ? "Wait for the current job to finish, then drop again."
    : kind === "transcript" ? (hasSource ? filename ?? "" : "Import a video or audio file first.")
    : kind === "unsupported" ? generic
    : filename ?? generic;

  return (
    <div className="cp-drop-overlay" role="presentation">
      <div className={`cp-drop-card ${variant}`}>
        <IconImport size={28} className="cp-drop-icon" />
        <div className="cp-drop-title">{title}</div>
        {hint && <div className="cp-drop-hint">{hint}</div>}
      </div>
    </div>
  );
}
