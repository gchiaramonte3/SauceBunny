import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ObsDisplayChoice } from "../bindings/ObsDisplayChoice";
import type { ObsDisplaySelection } from "../bindings/ObsDisplaySelection";
import type { ObsPreflight } from "../bindings/ObsPreflight";
import { copyCaptureSelection, isDisplayCapture } from "../lib/ndi-program-source";
import { formatError } from "../lib/error-format";
import { captureDisplayKey, useCaptureDisplayThumbnails } from "../hooks/use-capture-display-thumbnails";
import { CaptureAudioOption, CaptureRegionEditor, CaptureSourceGrid, captureRegionValid } from "./CaptureSourcePicker";
import type { ObsCaptureControlProps } from "./ObsCaptureControls";
import { CapturePreviewFooter } from "./CapturePreviewFooter";

const FULL_DISPLAY = { x: 0, y: 0, width: 1, height: 1 };
const EMPTY_REGION = { x: 0, y: 0, width: 0, height: 0 };
const DISPLAYS_PER_PAGE = 9;
type Discovery = { phase: "idle" | "loading" | "ready" | "error"; error: string | null };

/** A screen or region uses an exact observed display, never a main-display fallback. */
export function ObsDisplayCaptureControls({ mode, open, disabled, initialSelection, onSelectionChange, onPreview, refreshRequest = 0, footerTarget, reportedPreviewError }:
  ObsCaptureControlProps & { mode: "screen" | "region" }) {
  const [selection, setSelection] = useState<ObsDisplaySelection | null>(() => initialSelection && isDisplayCapture(initialSelection) ? initialSelection : null);
  const [displays, setDisplays] = useState<ObsDisplayChoice[]>([]);
  const [runtime, setRuntime] = useState<ObsPreflight | null>(null);
  const [runtimeDiscovery, setRuntimeDiscovery] = useState<Discovery>({ phase: "idle", error: null });
  const [displayDiscovery, setDisplayDiscovery] = useState<Discovery>({ phase: "idle", error: null });
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [page, setPage] = useState(0), [snapshotRequest, setSnapshotRequest] = useState(0);
  const scan = useRef(0), action = useRef(false), previewGeneration = useRef(0);
  const cancelScan = useCallback(() => { scan.current++; }, []);
  const cancelPreviewFeedback = useCallback(() => { previewGeneration.current++; }, []);
  useEffect(() => {
    if (initialSelection && isDisplayCapture(initialSelection)) setSelection(initialSelection);
  }, [initialSelection]);
  useEffect(() => {
    if (!open) { action.current = false; setStarting(false); }
    return cancelPreviewFeedback;
  }, [open, cancelPreviewFeedback]);
  const change = (next: ObsDisplaySelection) => { setSelection(next); onSelectionChange?.(next); };
  const discover = useCallback(async () => {
    const turn = ++scan.current;
    setRuntimeDiscovery(previous => ({ ...previous, phase: "loading" }));
    setDisplayDiscovery(previous => previous.phase === "loading" ? { ...previous, phase: "idle" } : previous);
    let check: ObsPreflight;
    try {
      check = await invoke<ObsPreflight>("obs_preflight", {});
      if (turn !== scan.current) return;
      setRuntime(check); setRuntimeDiscovery({ phase: "ready", error: null });
    } catch (cause) {
      if (turn === scan.current) setRuntimeDiscovery({ phase: "error", error: formatError(cause) });
      return;
    }
    if (!check.available) return;
    setDisplayDiscovery(previous => ({ ...previous, phase: "loading" }));
    try {
      const choices = await invoke<ObsDisplayChoice[]>("obs_displays", {});
      if (turn === scan.current) { setDisplays(choices); setDisplayDiscovery({ phase: "ready", error: null }); }
    } catch (cause) { if (turn === scan.current) setDisplayDiscovery({ phase: "error", error: formatError(cause) }); }
  }, []);
  useEffect(() => {
    if (!open) return;
    void discover();
    const focus = () => { void discover(); };
    window.addEventListener("focus", focus);
    return () => { cancelScan(); window.removeEventListener("focus", focus); };
  }, [open, refreshRequest, discover, cancelScan]);
  const scanning = runtimeDiscovery.phase === "loading" || displayDiscovery.phase === "loading";
  const ready = !!runtime?.available && runtimeDiscovery.phase === "ready" && displayDiscovery.phase === "ready";
  const selectedDisplay = selection ? displays.find(display => captureDisplayKey(display) === captureDisplayKey(selection)) : undefined;
  useEffect(() => {
    const index = displays.findIndex(display => display === selectedDisplay);
    setPage(index < 0 ? 0 : Math.floor(index / DISPLAYS_PER_PAGE));
  }, [displays, selectedDisplay]);
  const visibleDisplays = useMemo(() => displays.slice(page * DISPLAYS_PER_PAGE, (page + 1) * DISPLAYS_PER_PAGE), [displays, page]);
  const thumbnails = useCaptureDisplayThumbnails(visibleDisplays, open && ready, snapshotRequest);
  const thumbnail = selectedDisplay ? thumbnails[captureDisplayKey(selectedDisplay)] : undefined;
  const cropValid = !!selectedDisplay && !!selection && captureRegionValid(selection.crop,
    selectedDisplay.geometry.width, selectedDisplay.geometry.height);
  const fullDisplay = selection?.crop.x === 0 && selection.crop.y === 0 && selection.crop.width === 1 && selection.crop.height === 1;
  const busy = disabled || starting;
  const canPreview = ready && !!selection && !!selectedDisplay && visibleDisplays.includes(selectedDisplay)
    && cropValid && (mode === "region" || fullDisplay) && !busy;
  const emptyLabel = runtime && !runtime.available ? "Screen capture is unavailable in this build."
    : ready ? "No displays to choose from."
      : runtimeDiscovery.phase === "error" || displayDiscovery.phase === "error" ? "Displays could not be loaded. Refresh displays to try again."
        : "Looking for displays…";
  if (!open) return null;
  return <div className="cp-obs-capture-controls">
    <p>{mode === "region" ? "Choose a display, then mark the area to preview privately. Only picture inside that region is captured."
      : "Choose a display to preview privately."}</p>
    <div className="cp-ndi-input-source-label">
      <span>Displays</span>
      <button type="button" className="cp-toolbar-disclosure" disabled={scanning || busy} onClick={() => void discover()}>Refresh displays</button>
    </div>
    <CaptureSourceGrid sources={visibleDisplays.map(display => ({ id: captureDisplayKey(display), label: display.label,
      description: `${display.geometry.width} × ${display.geometry.height} points · Display ${display.displayId}`,
      thumbnail: thumbnails[captureDisplayKey(display)]?.image,
      thumbnailState: thumbnails[captureDisplayKey(display)]?.phase === "error" ? "error" : "loading",
    }))} selectedId={selectedDisplay ? captureDisplayKey(selectedDisplay) : null} busy={scanning}
      disabled={!ready || busy} emptyLabel={emptyLabel} onSelect={id => {
        const display = visibleDisplays.find(display => captureDisplayKey(display) === id);
        if (!display || (selection && captureDisplayKey(selection) === id)) return;
        change({ kind: "display", displayUuid: display.displayUuid, displayId: display.displayId,
          geometry: { ...display.geometry }, crop: { ...(mode === "screen" ? FULL_DISPLAY : EMPTY_REGION) }, audio: false });
      }}/>
    {displays.length > DISPLAYS_PER_PAGE && <div className="cp-capture-pagination" aria-label="Display pages">
      <button type="button" className="cp-toolbar-disclosure" disabled={page === 0 || busy} onClick={() => setPage(value => value - 1)}>Previous</button>
      <span>Page {page + 1} of {Math.ceil(displays.length / DISPLAYS_PER_PAGE)}</span>
      <button type="button" className="cp-toolbar-disclosure" disabled={(page + 1) * DISPLAYS_PER_PAGE >= displays.length || busy} onClick={() => setPage(value => value + 1)}>Next</button>
    </div>}
    {selectedDisplay && <p className="cp-capture-selected" role="status" aria-label="Selected display">Selected: {selectedDisplay.label} · Display {selectedDisplay.displayId}</p>}
    {selection && !selectedDisplay && ready && <p role="status" aria-label="Selected display">Display {selection.displayId} is unavailable or its arrangement changed. Choose the display again; no replacement will be selected automatically.</p>}
    {visibleDisplays.length > 0 && <div className="cp-capture-snapshot-note">
      <span>Display snapshots stay on this Mac. They are not a live share.</span>
      <button type="button" className="cp-toolbar-disclosure" disabled={busy || Object.values(thumbnails).some(item => item.phase === "loading")}
        onClick={() => setSnapshotRequest(value => value + 1)}>Refresh previews</button>
    </div>}
    {thumbnail?.error && <p role="status">Snapshot unavailable: {thumbnail.error}</p>}
    <p role="status" aria-label="Display discovery">{scanning ? "Looking for displays…" : runtimeDiscovery.error ? "Capture availability needs attention."
      : displayDiscovery.error ? "Display discovery needs attention." : !runtime ? "Capture not checked"
        : !runtime.available ? "Screen capture unavailable" : ready && !displays.length ? "No connected displays found. Reconnect the display, then refresh."
          : mode === "region" ? cropValid ? "Only the selected region is captured." : "A region must be selected before preview can start." : "Only the selected display is captured."}</p>
    {runtime && !runtime.available && <p role="alert">{runtime.error || "This build does not include screen capture."}</p>}
    {mode === "region" && selectedDisplay && selection && <CaptureRegionEditor key={captureDisplayKey(selectedDisplay)}
      thumbnail={thumbnail?.image ?? null} label={selectedDisplay.label} width={selectedDisplay.geometry.width}
      height={selectedDisplay.geometry.height} crop={selection.crop} disabled={busy || !ready}
      onChange={crop => change({ ...selection, crop: crop ?? { ...EMPTY_REGION } })}/>}
    {runtimeDiscovery.error && <p role="alert">{runtimeDiscovery.error}</p>}
    {displayDiscovery.error && <p role="alert">{displayDiscovery.error}</p>}
    {previewError && previewError !== reportedPreviewError && <p role="alert">{previewError}</p>}
    <CapturePreviewFooter target={footerTarget}>
      <CaptureAudioOption checked={selection?.audio ?? false} onChange={audio => { if (selection) change({ ...selection, audio }); }}
        label="Include system audio" disabled={!ready || !selectedDisplay || busy}
        description="Includes other apps' sound. Hides Sauce Bunny's windows and excludes its playback audio. Microphone stays separate."/>
      <button type="button" className="btn cp-ndi-input-preview" disabled={!canPreview} onClick={() => {
        if (!canPreview || !selection || action.current) return;
        action.current = true; setStarting(true); setPreviewError(null);
        const turn = ++previewGeneration.current;
        void onPreview(copyCaptureSelection(selection)).catch(cause => {
          if (turn === previewGeneration.current) setPreviewError(formatError(cause));
        }).finally(() => { if (turn === previewGeneration.current) { action.current = false; setStarting(false); } });
      }}>{starting ? "Starting preview…" : "Preview source"}</button>
    </CapturePreviewFooter>
  </div>;
}
