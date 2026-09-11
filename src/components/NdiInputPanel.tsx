import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { createPortal } from "react-dom";
import { useModalFocus } from "../hooks/use-modal-focus";
import { loadJson, saveJson } from "../lib/storage";
import { formatError } from "../lib/error-format";
import type { NdiDiscovery, NdiInput } from "../hooks/use-ndi-input";
import { PremiereConnectionStatus } from "./PremiereConnectionStatus";
import { AvidNdiSetup } from "./AvidNdiSetup";
import type { NdiPlaybackRecovery } from "./NdiProgramMonitor";
import "../styles/ndi-input.css";

/** Shared with the Preview settings gear; opening this dialog does not publish. */
export const NDI_INPUT_PANEL_ID = "cp-premiere-input";

export type NdiPreviewInput = Pick<NdiInput, "previewProgram" | "previewState" | "program" | "state" | "snapshot" | "canShare" | "start" | "cancelPreview" | "share" | "previewFrameDecoded" | "previewPictureFailed">;
type Props = {
  input: NdiPreviewInput;
  onClose: () => void;
  open?: boolean;
  /** Every explicit settings request refreshes discovery, even when open. */
  refreshRequest?: number;
  onPreviewRequested?: () => void;
  onShared?: () => void;
  onReconnectPicture?: () => void;
  onCompanionSetup?: () => void;
  /** Stable transport trigger, including when opened from the Share menu. */
  returnFocus?: RefObject<HTMLElement | null>;
  recovery?: NdiPlaybackRecovery | null;
  /** Guests may recover their own decoder, but never change the room source. */
  canManageSource?: boolean;
  previewVisible?: boolean;
};

/** Connection controls only. Picture and audio belong to the existing Preview
 * stage, so opening or closing this panel cannot replace its decoder. */
export function NdiInputPanel({ input, onClose, open = true, refreshRequest = 0, onPreviewRequested, onShared, onReconnectPicture, onCompanionSetup, returnFocus, recovery, canManageSource = true, previewVisible = true }: Props) {
  const inspectingPreview = previewVisible && !!input.previewProgram;
  const state = inspectingPreview ? input.previewState : input.state;
  const currentProgram = inspectingPreview ? input.previewProgram : input.program;
  const [discovery, setDiscovery] = useState<NdiDiscovery | null>(null);
  const [selected, setSelected] = useState(() => loadJson("saucebunny.ndiLastSource", ""));
  const [discovering, setDiscovering] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLElement>(null);
  useModalFocus(open, dialog, returnFocus);
  const generation = useRef(0), actionPending = useRef(false);
  const cancel = useCallback(() => { generation.current++; }, []);
  const discover = useCallback(async () => {
    const turn = ++generation.current;
    setDiscovering(true); setError(null);
    try {
      const data = await invoke<NdiDiscovery>("ndi_discover", {});
      if (turn !== generation.current) return;
      setDiscovery(data);
      // Discovery never chooses another feed or clears the user's picture.
    } catch (cause) { if (turn === generation.current) setError(formatError(cause)); }
    finally { if (turn === generation.current) setDiscovering(false); }
  }, []);
  useEffect(() => {
    if (open && canManageSource) void discover();
    return cancel;
  }, [discover, open, refreshRequest, cancel, canManageSource]);
  useEffect(() => {
    if (!open || !canManageSource) return;
    const focus = () => { void discover(); };
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [discover, open, canManageSource]);
  const run = async (action: () => Promise<void>) => {
    if (actionPending.current) return;
    actionPending.current = true; setActing(true); setError(null);
    try { await action(); }
    catch (cause) { setError(formatError(cause)); }
    finally { actionPending.current = false; setActing(false); }
  };

  const ready = input.snapshot.candidate?.decodedReady && input.snapshot.candidate.encodedReady;
  const pictureError = state.error || input.snapshot.error;
  const status = currentProgram?.stopped ? "Sharing stopped · Last picture retained"
    : pictureError ? "Picture needs attention"
    : state.connectionCount === 0 && currentProgram ? "Input disconnected · Last picture retained"
    : state.phase === "stale" ? state.connectionCount ? "Connected · Picture parked" : "No recent picture · Checking input"
    : inspectingPreview ? ready ? "Preview ready · Not shared" : "Connecting picture…"
    : input.program ? "Shared with room" : input.snapshot.busy === "starting" ? "Connecting to NDI…" : "Choose a source to preview";
  const selectedAvailable = !!discovery?.sources.some(source => source.name === selected);
  const canPreview = !!(selectedAvailable && discovery?.bridgeCompiled && discovery.runtime === "ready"
    && !discovering && !acting && !input.snapshot.busy);

  // Keep discovery/selection state mounted, but only expose a dialog while open.
  // No media element lives in this portal; closing it cannot reset playback.
  if (!open) return null;
  return createPortal(<div className="cp-modal-backdrop"
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialog} tabIndex={-1} id={NDI_INPUT_PANEL_ID} className="cp-modal cp-ndi-input"
      role="dialog" aria-modal="true" aria-label="NDI settings"
      onKeyDown={event => { event.stopPropagation(); if (event.key === "Escape") { event.preventDefault(); onClose(); } }}>
    <header className="cp-ndi-input-header">
      <h2>NDI</h2><span className="cp-premiere-beta">Beta</span>
      <button className="cp-modal-close" type="button" onClick={onClose} aria-label="Close NDI settings">✕</button>
    </header>
    <div className="cp-ndi-input-body">
      <p className="cp-ndi-input-intro">Preview picture and audio from Avid, Premiere, or another NDI sender. Playback stays at the source.</p>
      {canManageSource && <>
        <div className="cp-ndi-input-source-label">
          <label htmlFor="ndi-input-source">NDI source</label>
          <button type="button" className="cp-toolbar-disclosure" disabled={discovering}
            onClick={() => void discover()}>{discovering ? "Checking…" : "Refresh sources"}</button>
        </div>
        <select id="ndi-input-source" className="cp-select" value={selected}
          disabled={discovering || acting || !!input.snapshot.busy || !discovery?.sources.length}
          onChange={event => { setSelected(event.target.value); saveJson("saucebunny.ndiLastSource", event.target.value); }}>
          <option value="">Choose a source…</option>
          {selected && !selectedAvailable && <option value={selected} disabled>{selected} · Not currently found</option>}
          {discovery?.sources.map(source => <option key={source.name} value={source.name}>{source.name}</option>)}
        </select>
        {discovery && !discovery.bridgeCompiled && <p role="alert">This Sauce Bunny build does not include the native NDI bridge. Install a build with NDI input support.</p>}
        {discovery?.bridgeCompiled && discovery.runtime === "missing" && <p role="alert">{discovery.error || "The included NDI runtime is missing. Reinstall Sauce Bunny."}</p>}
        {discovery?.bridgeCompiled && discovery.runtime === "incompatible" && <p role="alert">{discovery.error || "The included NDI runtime is incompatible. Reinstall Sauce Bunny."}</p>}
        <p role="status" aria-label="Source discovery">{discovering ? "Looking for sources…" : discovery ? `Sources refreshed · ${discovery.sources.length} available` : "Sources not checked"}</p>
        {discovery?.runtime === "ready" && discovery.sources.length === 0 && <p>No NDI source found. Enable output in the source application, then refresh. Setup help is below.</p>}
        {discovery?.error && discovery.runtime === "ready" && <p role="alert">{discovery.error}</p>}
        <button type="button" className="btn cp-ndi-input-preview" disabled={!canPreview}
          onClick={() => { onPreviewRequested?.(); void run(() => input.start(selected)); }}>Preview source</button>
      </>}
        <div className="cp-ndi-input-connection">
          {currentProgram && <strong title={currentProgram.name}>{currentProgram.name}</strong>}
          <p role="status" aria-label="NDI connection">{status}{state.inputWidth ? <span className="cp-ndi-input-format">{state.inputWidth} × {state.inputHeight}{state.inputFps != null ? ` · Source ${state.inputFps.toFixed(2)} fps` : " · Source rate unavailable"}{` · Preview ${state.outputFps.toFixed(1)} fps`}</span> : null}</p>
          {currentProgram && <p>Use the Preview speaker control for program audio. Camera and microphone stay separate.</p>}
          {recovery && !recovery.error && <div className="cp-ndi-input-recovery">
            <p>Program playback needs a click to resume on this device.</p>
            <button type="button" className="cp-toolbar-disclosure" onClick={recovery.resume}>{recovery.label}</button>
          </div>}
          {currentProgram && canManageSource && <PremiereConnectionStatus sourceId={currentProgram.reviewKey} onSetup={onCompanionSetup} />}
          {currentProgram && onReconnectPicture && <button type="button" className="cp-toolbar-disclosure cp-ndi-input-reconnect"
            disabled={acting || !!input.snapshot.busy} onClick={onReconnectPicture}>Reconnect picture</button>}
        </div>
        {(error || pictureError || recovery?.error) && <p role="alert">{error || pictureError || recovery?.error}</p>}
        {!canManageSource && <p>The presenter chooses the NDI source. Audio and picture recovery here affect only this device.</p>}
        {inspectingPreview && <p>Private preview · Not shared. {input.snapshot.room?.presenting
          ? "The room keeps its current source until you share."
          : "Start a session when you are ready to share."}</p>}
        {canManageSource && inspectingPreview && input.snapshot.room?.presenting && <button type="button" className="btn cp-ndi-input-share"
          disabled={acting || !input.canShare} onClick={() => void run(async () => {
            await input.share(); onShared?.(); onClose();
          })}>Share NDI with room</button>}
        <p>Not shared refers to the Sauce Bunny room, not the sender’s NDI broadcast on your network.</p>
        <div className="cp-ndi-input-actions">
          {canManageSource && input.previewProgram && <button type="button" className="btn btn-ghost"
            disabled={acting || input.snapshot.busy === "publishing" || input.snapshot.busy === "stopping"}
            onClick={() => void run(input.cancelPreview)}>Cancel preview</button>}
          <button type="button" className="btn" onClick={onClose}>Done</button>
        </div>
      {canManageSource && <>
        <AvidNdiSetup />
        <button type="button" className="cp-toolbar-disclosure cp-ndi-input-settings" onClick={onCompanionSetup}
          disabled={!onCompanionSetup}>Install or set up Premiere…</button>
      </>}
    </div>
  </section></div>, document.body);
}
