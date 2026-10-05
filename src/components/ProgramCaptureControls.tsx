import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProgramCaptureChooseResult } from "../bindings/ProgramCaptureChooseResult";
import type { ProgramCapturePreflight } from "../bindings/ProgramCapturePreflight";
import type { ProgramCaptureSelection } from "../bindings/ProgramCaptureSelection";
import { formatError } from "../lib/error-format";
import { newJobId } from "../lib/job-id";
import { isPickedCapture } from "../lib/ndi-program-source";
import { CaptureAudioOption } from "./CaptureSourcePicker";
import { CapturePreviewFooter } from "./CapturePreviewFooter";
import type { ObsCaptureControlProps } from "./ObsCaptureControls";

const UNAVAILABLE: ProgramCapturePreflight = { available: false, error: null, kinds: [], systemAudio: false };

/**
 * Screen through macOS's own sharing picker (docs/PROGRAM-CAPTURE.md). The
 * picker needs no Screen Recording permission and never offers Sauce Bunny's
 * own windows. Choosing is separate from starting, and a pick lives only as
 * long as the capture helper does: after a relaunch the person chooses again.
 */
export function ProgramCaptureControls({ open, disabled, initialSelection, onSelectionChange, onPreview, footerTarget, reportedPreviewError }: ObsCaptureControlProps) {
  const [preflight, setPreflight] = useState<ProgramCapturePreflight | null>(null);
  const [selection, setSelection] = useState<ProgramCaptureSelection | null>(
    () => initialSelection && isPickedCapture(initialSelection) && initialSelection.kind === "screen" ? initialSelection : null);
  const [choosing, setChoosing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const job = useRef<string | null>(null), turn = useRef(0);

  useEffect(() => {
    let live = true;
    invoke<ProgramCapturePreflight>("program_capture_preflight")
      .then(value => { if (live) setPreflight(value ?? UNAVAILABLE); })
      .catch(cause => { if (live) setPreflight({ ...UNAVAILABLE, error: formatError(cause) }); });
    return () => { live = false; };
  }, []);
  // Leaving the dialog while macOS's picker is open withdraws the request.
  useEffect(() => () => { if (job.current) void invoke("program_capture_cancel_choose", { jobId: job.current }).catch(() => undefined); }, []);

  const change = (next: ProgramCaptureSelection | null) => { setSelection(next); if (next) onSelectionChange?.(next); };
  const preview = useCallback((next: ProgramCaptureSelection) => {
    const mine = ++turn.current;
    setStarting(true); setError(null);
    void onPreview({ ...next }).catch(cause => {
      if (mine !== turn.current) return;
      const message = formatError(cause);
      setError(message);
      // The helper restarted and no longer holds this pick: ask for it again.
      if (/choose again/i.test(message)) setSelection(null);
    }).finally(() => { if (mine === turn.current) setStarting(false); });
  }, [onPreview]);

  async function choose() {
    if (job.current) return;
    const id = newJobId();
    job.current = id;
    setChoosing(true); setError(null);
    try {
      const result = await invoke<ProgramCaptureChooseResult>("program_capture_choose", { jobId: id, kind: "screen" });
      if (result.outcome !== "chosen") return;
      const next: ProgramCaptureSelection = { choice: result.choice.choice, kind: "screen", label: result.choice.label, audio: selection?.audio ?? false };
      change(next);
      // The picker's Share click is the person's go-ahead: start the preview at once.
      preview(next);
    } catch (cause) {
      setError(formatError(cause));
    } finally {
      if (job.current === id) job.current = null;
      setChoosing(false);
    }
  }

  if (!open) return null;
  const available = preflight?.available ?? false;
  const busy = disabled || choosing || starting;
  return <div className="cp-obs-capture-controls">
    <p>Choose a screen in macOS's own picker. Sauce Bunny's windows are never offered, and no screen recording permission is needed.</p>
    {!preflight ? <p role="status">Checking screen capture…</p>
      : !available && <p role="alert">{preflight.error || "This build does not include screen capture."}</p>}
    {available && <div className="cp-capture-choice">
      {choosing ? <>
        <p role="status">Waiting for your choice in the macOS picker…</p>
        <button type="button" className="cp-toolbar-disclosure"
          onClick={() => { if (job.current) void invoke("program_capture_cancel_choose", { jobId: job.current }).catch(() => undefined); }}>Cancel choosing</button>
      </> : <>
        {selection && <p className="cp-capture-selected" role="status" aria-label="Selected screen">Selected: {selection.label}</p>}
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void choose()}>
          {selection ? "Choose another screen…" : "Choose screen…"}</button>
      </>}
    </div>}
    {error && error !== reportedPreviewError && <p role="alert">{error}</p>}
    <CapturePreviewFooter target={footerTarget}>
      <CaptureAudioOption checked={selection?.audio ?? false} onChange={audio => { if (selection) change({ ...selection, audio }); }}
        label="Include system audio" disabled={!selection || busy || !preflight?.systemAudio}
        description={preflight && !preflight.systemAudio ? "System audio needs macOS 14.2 or later."
          : "Includes other apps' sound. Sauce Bunny's own playback is left out. Microphone stays separate."}/>
      <button type="button" className="btn cp-ndi-input-preview" disabled={!selection || busy || !available}
        onClick={() => { if (selection) preview(selection); }}>{starting ? "Starting preview…" : "Preview source"}</button>
    </CapturePreviewFooter>
  </div>;
}
