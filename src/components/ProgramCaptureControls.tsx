import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ObsSelection } from "../bindings/ObsSelection";
import type { ProgramCaptureChooseResult } from "../bindings/ProgramCaptureChooseResult";
import type { ProgramCapturePreflight } from "../bindings/ProgramCapturePreflight";
import type { ProgramCaptureSelection } from "../bindings/ProgramCaptureSelection";
import { formatError } from "../lib/error-format";
import { newJobId } from "../lib/job-id";
import { isPickedCapture } from "../lib/ndi-program-source";
import { CaptureAudioOption, captureRegionValid } from "./CaptureSourcePicker";
import { CapturePreviewFooter } from "./CapturePreviewFooter";
import { ProgramCaptureAudioSource } from "./ProgramCaptureAudioSource";
import { ProgramCaptureRegion, type RegionPicture } from "./ProgramCaptureRegion";

export type CaptureMode = "screen" | "window" | "region";
export type ProgramCaptureControlProps = {
  mode: CaptureMode;
  open: boolean;
  disabled: boolean;
  initialSelection?: ObsSelection;
  onSelectionChange?: (selection: ObsSelection) => void;
  onPreview: (selection: ObsSelection) => Promise<void>;
  footerTarget?: HTMLElement | null;
  /** Avoid repeating an identical startup failure already shown by the parent. */
  reportedPreviewError?: string | null;
};

const UNAVAILABLE: ProgramCapturePreflight = { available: false, error: null, kinds: [], systemAudio: false, applicationAudio: false };
const SYSTEM_AUDIO = { label: "Include system audio", description: "Includes other apps' sound. Sauce Bunny's own playback is left out. Microphone stays separate.", unavailable: "System audio needs macOS 14.2 or later." };
const COPY = {
  screen: { intro: "Choose a screen in macOS's own picker. Sauce Bunny's windows are never offered, and no screen recording permission is needed.",
    thing: "screen", audio: SYSTEM_AUDIO },
  window: { intro: "Choose a window in macOS's own picker. Only that window is captured, and Sauce Bunny's windows are never offered.",
    thing: "window", audio: { label: "Include application audio", description: "Audio from this application only. Camera and microphone stay separate.", unavailable: "Application audio needs macOS 15.2 or later." } },
  region: { intro: "Choose a screen in macOS's own picker, then drag over the part of it to capture.",
    thing: "screen", audio: SYSTEM_AUDIO },
} as const;

/**
 * Screen, Window and Region through macOS's own sharing picker
 * (docs/PROGRAM-CAPTURE.md): no Screen Recording permission, no monthly alert,
 * and Sauce Bunny's own windows are never offered. Choosing is separate from
 * starting, and a pick lives only as long as the capture helper does: after a
 * relaunch the person chooses again. A screen or window previews as soon as
 * it is picked; a region waits until its area is drawn.
 */
export function ProgramCaptureControls({ mode, open, disabled, initialSelection, onSelectionChange, onPreview, footerTarget, reportedPreviewError }: ProgramCaptureControlProps) {
  const copy = COPY[mode];
  const [preflight, setPreflight] = useState<ProgramCapturePreflight | null>(null);
  const [selection, setSelection] = useState<ProgramCaptureSelection | null>(
    () => initialSelection && isPickedCapture(initialSelection) && initialSelection.kind === mode ? initialSelection : null);
  const [picture, setPicture] = useState<RegionPicture | null>(null);
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
  /** Audio on or off, and from whom: chosen apps only mean anything while audio is on. */
  const hear = (audio: boolean, apps?: string[]) => {
    if (!selection) return;
    const next = { ...selection, audio };
    delete next.audioApps;
    change(audio && apps ? { ...next, audioApps: apps } : next);
  };
  const forget = () => { setSelection(null); setPicture(null); };
  const preview = useCallback((next: ProgramCaptureSelection) => {
    const mine = ++turn.current;
    setStarting(true); setError(null);
    void onPreview({ ...next }).catch(cause => {
      if (mine !== turn.current) return;
      const message = formatError(cause);
      setError(message);
      // The helper restarted and no longer holds this pick: ask for it again.
      if (/choose again/i.test(message)) forget();
    }).finally(() => { if (mine === turn.current) setStarting(false); });
  }, [onPreview]);

  async function choose() {
    if (job.current) return;
    const id = newJobId();
    job.current = id;
    setChoosing(true); setError(null);
    try {
      const result = await invoke<ProgramCaptureChooseResult>("program_capture_choose", { jobId: id, kind: mode });
      if (result.outcome !== "chosen") return;
      const audio = selection?.audio ?? (mode === "window" && !!preflight?.applicationAudio);
      const next: ProgramCaptureSelection = { choice: result.choice.choice, kind: mode, label: result.choice.label, audio };
      setPicture(null);
      if (mode === "region") { setSelection(next); return; }
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
  const audioSupported = mode === "window" ? !!preflight?.applicationAudio : !!preflight?.systemAudio;
  const ready = !!selection && (!selection.audio || selection.audioApps?.length !== 0) && (mode !== "region"
    || (!!picture && picture.choice === selection.choice && captureRegionValid(selection.region ?? null, picture.width, picture.height)));
  return <div className="cp-obs-capture-controls">
    <p>{copy.intro}</p>
    {!preflight ? <p role="status">Checking screen capture…</p>
      : !available && <p role="alert">{preflight.error || "This build does not include screen capture."}</p>}
    {available && <div className="cp-capture-choice">
      {choosing ? <>
        <p role="status">Waiting for your choice in the macOS picker…</p>
        <button type="button" className="cp-toolbar-disclosure"
          onClick={() => { if (job.current) void invoke("program_capture_cancel_choose", { jobId: job.current }).catch(() => undefined); }}>Cancel choosing</button>
      </> : <>
        {selection && <p className="cp-capture-selected" role="status" aria-label={`Selected ${copy.thing}`}>Selected: {selection.label}</p>}
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void choose()}>
          {selection ? `Choose another ${copy.thing}…` : `Choose ${copy.thing}…`}</button>
      </>}
    </div>}
    {mode === "region" && selection && <ProgramCaptureRegion choice={selection.choice} label={selection.label} picture={picture}
      onPicture={setPicture} region={selection.region ?? null} disabled={busy} onForget={forget}
      onChange={region => { const next = { ...selection }; delete next.region; change(region ? { ...next, region } : next); }}/>}
    {selection?.audio && audioSupported && <ProgramCaptureAudioSource kind={mode} apps={selection.audioApps} disabled={busy}
      onChange={apps => hear(true, apps)}/>}
    {error && error !== reportedPreviewError && <p role="alert">{error}</p>}
    <CapturePreviewFooter target={footerTarget}>
      <CaptureAudioOption checked={selection?.audio ?? false} onChange={audio => hear(audio, selection?.audioApps)}
        label={copy.audio.label} disabled={!selection || busy || !audioSupported}
        description={preflight && !audioSupported ? copy.audio.unavailable : copy.audio.description}/>
      <button type="button" className="btn cp-ndi-input-preview" disabled={!ready || busy || !available}
        onClick={() => { if (selection && ready) preview(selection); }}>{starting ? "Starting preview…" : "Preview source"}</button>
    </CapturePreviewFooter>
  </div>;
}
