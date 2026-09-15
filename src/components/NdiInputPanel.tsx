import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { createPortal } from "react-dom";
import { useModalFocus } from "../hooks/use-modal-focus";
import { useCapturePreviewReveal } from "../hooks/use-capture-preview-reveal";
import { loadJson, saveJson } from "../lib/storage";
import { formatError } from "../lib/error-format";
import type { NdiDiscovery, NdiInput } from "../hooks/use-ndi-input";
import { PremiereConnectionStatus } from "./PremiereConnectionStatus";
import { AvidNdiSetup } from "./AvidNdiSetup";
import { ObsCaptureControls, type CaptureMode } from "./ObsCaptureControls";
import { CaptureSourceTabs } from "./CaptureSourcePicker";
import { ObsBroadcastControls } from "./ObsBroadcastControls";
import type { ObsBroadcast } from "../hooks/use-obs-broadcast";
import type { ObsSelection } from "../bindings/ObsSelection";
import { copyCaptureSelection, isDisplayCapture, sameProgramSource } from "../lib/ndi-program-source";
import type { NdiPlaybackRecovery } from "./NdiProgramMonitor";
import "../styles/ndi-input.css";

/** Shared with the Preview settings gear; opening this dialog does not publish. */
export const NDI_INPUT_PANEL_ID = "cp-premiere-input";

export type NdiPreviewInput = Pick<NdiInput, "previewProgram" | "previewState" | "program" | "state" | "snapshot" | "canShare" | "start" | "cancelPreview" | "share" | "previewFrameDecoded" | "previewPictureFailed"> & Partial<Pick<NdiInput, "startCapture">>;
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
  broadcast?: ObsBroadcast;
  /** Explicit desktop region Edit, scoped to a still-owned capture source. */
  editRequest?: { sourceId: string; serial: number };
  /** An explicit Review entry point chooses a category, never a capture. */
  sourceRequest?: { kind: "ndi" | "screen" | "window" | "region"; serial: number };
};

type SourceTab = "ndi" | CaptureMode;
const SOURCE_TABS: { id: SourceTab; label: string }[] = [
  { id: "ndi", label: "NDI" }, { id: "screen", label: "Screen" },
  { id: "window", label: "Window" }, { id: "region", label: "Region" },
];
const captureTab = (selection: ObsSelection): CaptureMode => {
  if (!isDisplayCapture(selection)) return "window";
  const { crop } = selection;
  return crop.x === 0 && crop.y === 0 && crop.width === 1 && crop.height === 1 ? "screen" : "region";
};

/** Connection controls only. Picture and audio belong to the existing Preview
 * stage, so opening or closing this panel cannot replace its decoder. */
export function NdiInputPanel({ input, onClose, open = true, refreshRequest = 0, onPreviewRequested, onShared, onReconnectPicture, onCompanionSetup, returnFocus, recovery, canManageSource = true, previewVisible = true, broadcast, editRequest, sourceRequest }: Props) {
  const inspectingPreview = previewVisible && !!input.previewProgram;
  const state = inspectingPreview ? input.previewState : input.state;
  const currentProgram = inspectingPreview ? input.previewProgram : input.program;
  const [sourceKind, setSourceKind] = useState<SourceTab>("ndi");
  const [captureFooter, setCaptureFooter] = useState<HTMLDivElement | null>(null);
  const [captureDrafts, setCaptureDrafts] = useState<Partial<Record<CaptureMode, ObsSelection>>>({});
  const requestedCapture = useRef<{ selection: ObsSelection; tab: CaptureMode; restoreDraft: boolean } | null>(null);
  const editingCaptureDraft = useRef(false);
  useEffect(() => { if (!open) { requestedCapture.current = null; editingCaptureDraft.current = false; } }, [open]);
  const restoredSource = useRef<string | null>(null);
  useEffect(() => {
    if (!currentProgram || restoredSource.current === currentProgram.id) return;
    restoredSource.current = currentProgram.id;
    // Desktop Edit owns this draft until the user leaves or previews it. An
    // earlier authorized startup may finish, but must not replace these edits.
    if (editingCaptureDraft.current) return;
    const capture = currentProgram.capture;
    const requested = requestedCapture.current;
    const matchesRequest = !!capture && !!requested && sameProgramSource(
      { kind: "capture", selection: capture }, { kind: "capture", selection: requested.selection });
    // Revealing the private stage can expose the previous candidate while
    // native startup drains it. That intermediate picture is not a new draft.
    if (requested && !matchesRequest) return;
    const tab = capture ? matchesRequest ? requested!.tab : captureTab(capture) : "ndi";
    // An explicitly started candidate must not pull the user back to a tab
    // they left during startup. External source replacements still restore it.
    if (!matchesRequest) setSourceKind(tab);
    if (capture && tab !== "ndi" && (!matchesRequest || requested?.restoreDraft)) {
      setCaptureDrafts(drafts => ({ ...drafts, [tab]: copyCaptureSelection(capture) }));
    }
    requestedCapture.current = null;
  }, [currentProgram]);
  const [discovery, setDiscovery] = useState<NdiDiscovery | null>(null);
  const [selected, setSelected] = useState(() => loadJson("saucebunny.ndiLastSource", ""));
  const [discovering, setDiscovering] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Preview may reuse an already-published source after draining the private
  // candidate. Readiness still belongs to the exact explicitly requested source.
  const previewReveal = useCapturePreviewReveal({ open, candidate: input.snapshot.candidate ?? input.snapshot.published,
    busy: !!input.snapshot.busy, error: input.snapshot.error, onReveal: onClose });
  const cancelReveal = previewReveal.cancel;
  const appliedSourceRequest = useRef<number | null>(null);
  useEffect(() => {
    if (!open || !canManageSource || !sourceRequest || appliedSourceRequest.current === sourceRequest.serial) return;
    appliedSourceRequest.current = sourceRequest.serial;
    // Keep an already-started request's identity so its late completion cannot
    // restore the old category over this explicit choice.
    cancelReveal(); editingCaptureDraft.current = false;
    setSourceKind(sourceRequest.kind);
  }, [open, canManageSource, sourceRequest, cancelReveal]);
  const appliedEdit = useRef<number | null>(null);
  useEffect(() => {
    if (!open || !canManageSource || !editRequest || appliedEdit.current === editRequest.serial) return;
    appliedEdit.current = editRequest.serial;
    const target = [input.snapshot.candidate, input.snapshot.published].find(source => source?.id === editRequest.sourceId && !source.retired);
    const selection = target?.capture;
    if (!selection || !isDisplayCapture(selection)) return;
    cancelReveal(); requestedCapture.current = null; editingCaptureDraft.current = true;
    setCaptureDrafts(drafts => ({ ...drafts, region: copyCaptureSelection(selection) }));
    setSourceKind("region");
  }, [open, canManageSource, editRequest, input.snapshot.candidate, input.snapshot.published, cancelReveal]);
  const close = () => { previewReveal.cancel(); requestedCapture.current = null; editingCaptureDraft.current = false; onClose(); };
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
    if (open && canManageSource && sourceKind === "ndi") void discover();
    return cancel;
  }, [discover, open, refreshRequest, cancel, canManageSource, sourceKind]);
  useEffect(() => {
    if (!open || !canManageSource || sourceKind !== "ndi") return;
    const focus = () => { void discover(); };
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, [discover, open, canManageSource, sourceKind]);
  const run = async (action: () => Promise<void>) => {
    if (actionPending.current) return;
    actionPending.current = true; setActing(true); setError(null);
    try { await action(); }
    catch (cause) { setError(formatError(cause)); }
    finally { actionPending.current = false; setActing(false); }
  };

  const observedProgram = [input.snapshot.candidate, input.snapshot.published].find(program => program?.id === currentProgram?.id);
  const ready = observedProgram?.decodedReady && observedProgram.encodedReady;
  const pictureError = state.error || input.snapshot.error;
  const status = currentProgram?.stopped ? "Sharing stopped · Last picture retained"
    : pictureError ? "Picture needs attention"
    : state.connectionCount === 0 && currentProgram ? "Input disconnected · Last picture retained"
    : state.phase === "stale" ? state.connectionCount ? "Connected · Picture parked" : "No recent picture · Checking input"
    : inspectingPreview ? ready ? "Preview ready · Not shared with room" : "Connecting picture…"
    : input.program ? "Shared with room" : input.snapshot.busy === "starting" ? "Connecting picture…" : "Choose a source to preview";
  const selectedAvailable = !!discovery?.sources.some(source => source.name === selected);
  const canPreview = !!(selectedAvailable && discovery?.bridgeCompiled && discovery.runtime === "ready"
    && !discovering && !acting && !input.snapshot.busy);
  const captureMode = sourceKind === "ndi" ? null : sourceKind;
  const tabsDisabled = acting || input.snapshot.busy === "publishing" || input.snapshot.busy === "stopping";

  // Keep discovery/selection state mounted, but only expose a dialog while open.
  // No media element lives in this portal; closing it cannot reset playback.
  if (!open) return null;
  return createPortal(<div className="cp-modal-backdrop"
    onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <section ref={dialog} tabIndex={-1} id={NDI_INPUT_PANEL_ID} className={`cp-modal cp-ndi-input${captureMode ? " cp-ndi-input-capture" : ""}`}
      role="dialog" aria-modal="true" aria-label="Source settings"
      onKeyDown={event => { event.stopPropagation(); if (event.key === "Escape") { event.preventDefault(); close(); } }}>
    <header className="cp-ndi-input-header">
      <h2>Source</h2><span className="cp-premiere-beta">Beta</span>
      <button className="cp-modal-close" type="button" onClick={close} aria-label="Close source settings">✕</button>
    </header>
    {canManageSource && input.startCapture && <div className="cp-ndi-input-tabs">
      <CaptureSourceTabs label="Source type" selected={sourceKind}
        tabs={SOURCE_TABS.map(tab => ({ ...tab, panelId: `cp-live-source-${tab.id}`, disabled: tabsDisabled }))}
        onSelect={kind => { if (SOURCE_TABS.some(tab => tab.id === kind)) { previewReveal.cancel(); editingCaptureDraft.current = false; setSourceKind(kind as SourceTab); } }}/>
    </div>}
    <div className="cp-ndi-input-body" id={`cp-live-source-${sourceKind}`} role="tabpanel" aria-label={SOURCE_TABS.find(tab => tab.id === sourceKind)?.label}>
      {sourceKind === "ndi" && <p className="cp-ndi-input-intro">Preview picture and audio from your editor. Playback stays at the source.</p>}
      {canManageSource && captureMode && input.startCapture && <ObsCaptureControls
        key={`${captureMode}:${currentProgram?.id ?? "draft"}`} mode={captureMode} open={open} disabled={acting || !!input.snapshot.busy} footerTarget={captureFooter}
        reportedPreviewError={error || pictureError || recovery?.error}
        initialSelection={captureDrafts[captureMode]}
        onSelectionChange={selection => {
          previewReveal.cancel();
          if (requestedCapture.current?.tab === captureMode) requestedCapture.current.restoreDraft = false;
          setCaptureDrafts(drafts => ({ ...drafts, [captureMode]: copyCaptureSelection(selection) }));
        }} refreshRequest={refreshRequest}
        onPreview={async selection => {
          editingCaptureDraft.current = false;
          const request = { selection: copyCaptureSelection(selection), tab: captureMode, restoreDraft: true };
          requestedCapture.current = request;
          onPreviewRequested?.();
          try { await previewReveal.preview(selection, () => input.startCapture!(selection)); }
          catch (cause) { if (requestedCapture.current === request) requestedCapture.current = null; throw cause; }
        }}/>
      }
      {canManageSource && sourceKind === "ndi" && <>
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
          onClick={() => { requestedCapture.current = null; editingCaptureDraft.current = false; onPreviewRequested?.(); void run(() => input.start(selected)); }}>Preview source</button>
      </>}
        {(currentProgram || sourceKind === "ndi") && <div className="cp-ndi-input-connection">
          {currentProgram && <strong title={currentProgram.name}>{currentProgram.name}</strong>}
          <p role="status" aria-label={currentProgram?.capture ? "Application capture connection" : "NDI connection"}>{status}{state.inputWidth ? <span className="cp-ndi-input-format">{state.inputWidth} × {state.inputHeight}{state.inputFps != null ? ` · Source ${state.inputFps.toFixed(2)} fps` : " · Source rate unavailable"}{` · Preview ${state.outputFps.toFixed(1)} fps`}</span> : null}</p>
          {currentProgram && <p>Use the Preview speaker control for program audio. Camera and microphone stay separate.</p>}
          {recovery && !recovery.error && <div className="cp-ndi-input-recovery">
            <p>Program playback needs a click to resume on this device.</p>
            <button type="button" className="cp-toolbar-disclosure" onClick={recovery.resume}>{recovery.label}</button>
          </div>}
          {currentProgram && !currentProgram.capture && canManageSource && <PremiereConnectionStatus sourceId={currentProgram.reviewKey} onSetup={onCompanionSetup} />}
          {currentProgram && onReconnectPicture && <button type="button" className="cp-toolbar-disclosure cp-ndi-input-reconnect"
            disabled={acting || !!input.snapshot.busy} onClick={onReconnectPicture}>Reconnect picture</button>}
        </div>}
        {(error || pictureError || recovery?.error) && <p role="alert">{error || pictureError || recovery?.error}</p>}
        {!canManageSource && <p>The presenter chooses the source. Audio and picture recovery here affect only this device.</p>}
        {inspectingPreview && <p>Not shared with room. {input.snapshot.room?.presenting
          ? "The room keeps its current source until you share."
          : "Start a session when you are ready to share."}</p>}
        {canManageSource && inspectingPreview && input.snapshot.room?.presenting && <button type="button" className="btn cp-ndi-input-share"
          disabled={acting || !input.canShare} onClick={() => void run(async () => {
            await input.share(); onShared?.(); onClose();
          })}>{currentProgram?.capture ? "Share capture with room" : "Share NDI with room"}</button>}
        {currentProgram?.capture && currentProgram.local && canManageSource && broadcast?.sourceId === currentProgram.id
          ? <ObsBroadcastControls broadcast={broadcast}
              disabled={!!input.snapshot.busy || currentProgram.stopped || !!pictureError || state.connectionCount === 0}/>
          : !currentProgram?.capture && sourceKind === "ndi" && <p>Not shared with room refers to the Sauce Bunny session, not the source application’s NDI broadcast on your network.</p>}
      {canManageSource && sourceKind === "ndi" && <>
        <AvidNdiSetup />
        <button type="button" className="cp-toolbar-disclosure cp-ndi-input-settings" onClick={onCompanionSetup}
          disabled={!onCompanionSetup}>Install or set up Premiere…</button>
      </>}
    </div>
    <footer className="cp-ndi-input-footer">
      {canManageSource && captureMode && input.startCapture && <div ref={setCaptureFooter}/>}
      <div className="cp-ndi-input-actions">
        {canManageSource && input.previewProgram && <button type="button" className="btn btn-ghost"
          disabled={acting || input.snapshot.busy === "publishing" || input.snapshot.busy === "stopping"}
          onClick={() => { previewReveal.cancel(); requestedCapture.current = null; editingCaptureDraft.current = false; void run(input.cancelPreview); }}>Cancel preview</button>}
        <button type="button" className="btn" onClick={close}>Done</button>
      </div>
    </footer>
  </section></div>, document.body);
}
