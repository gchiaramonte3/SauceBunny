import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ObsWindowChoice } from "../bindings/ObsWindowChoice";
import type { ObsSelection } from "../bindings/ObsSelection";
import type { ObsPreflight } from "../bindings/ObsPreflight";
import { formatError } from "../lib/error-format";
import { copyCaptureSelection, isDisplayCapture } from "../lib/ndi-program-source";
import { captureWindowKey, useCaptureWindowThumbnails } from "../hooks/use-capture-window-thumbnails";
import { CaptureSourceGrid, CaptureRegionEditor, CaptureAudioOption, captureRegionValid } from "./CaptureSourcePicker";
import { ObsDisplayCaptureControls } from "./ObsDisplayCaptureControls";
import { CapturePreviewFooter } from "./CapturePreviewFooter";

const FULL_WINDOW = { x: 0, y: 0, width: 1, height: 1 };
type WindowSelection = Extract<ObsSelection, { application: string }>;
const EMPTY_SELECTION: WindowSelection = { application: "", process: 0, window: 0, crop: FULL_WINDOW, audio: false };
const WINDOWS_PER_PAGE = 9;
type DiscoveryState = { phase: "idle" | "loading" | "ready" | "error"; error: string | null };

export type CaptureMode = "window" | "screen" | "region";
export type ObsCaptureControlProps = {
  open: boolean;
  disabled: boolean;
  initialSelection?: ObsSelection;
  onSelectionChange?: (selection: ObsSelection) => void;
  onPreview: (selection: ObsSelection) => Promise<void>;
  refreshRequest?: number;
  mode?: CaptureMode;
  footerTarget?: HTMLElement | null;
  /** Avoid repeating an identical startup failure already shown by the parent. */
  reportedPreviewError?: string | null;
};

/** The source tab selects one private capture path, never a room share. */
export function ObsCaptureControls({ mode = "window", ...props }: ObsCaptureControlProps) {
  return mode === "window" ? <ObsWindowCaptureControls {...props}/>
    : <ObsDisplayCaptureControls key={mode} {...props} mode={mode}/>;
}

/** Metadata discovery is separate from bounded picker snapshots. Only Preview
 * starts continuous capture, with the exact window/PID/crop/audio selection. */
function ObsWindowCaptureControls({ open, disabled, initialSelection, onSelectionChange, onPreview, refreshRequest = 0, footerTarget, reportedPreviewError }: ObsCaptureControlProps) {
  const [selection, setSelection] = useState<WindowSelection>(() => initialSelection && !isDisplayCapture(initialSelection) ? initialSelection : EMPTY_SELECTION);
  const [windows, setWindows] = useState<ObsWindowChoice[]>([]);
  const [runtime, setRuntime] = useState<ObsPreflight | null>(null);
  const [runtimeDiscovery, setRuntimeDiscovery] = useState<DiscoveryState>({ phase: "idle", error: null });
  const [windowDiscovery, setWindowDiscovery] = useState<DiscoveryState>({ phase: "idle", error: null });
  const [starting, setStarting] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [snapshotRequest, setSnapshotRequest] = useState(0);
  const scan = useRef(0), action = useRef(false), previewGeneration = useRef(0);
  const cancelScan = useCallback(() => { scan.current++; }, []);
  const cancelPreviewFeedback = useCallback(() => { previewGeneration.current++; }, []);
  useEffect(() => {
    if (initialSelection && !isDisplayCapture(initialSelection)) setSelection(initialSelection);
  }, [initialSelection]);
  useEffect(() => {
    if (!open) { action.current = false; setStarting(false); }
    return cancelPreviewFeedback;
  }, [open, cancelPreviewFeedback]);
  const change = (next: WindowSelection) => { setSelection(next); onSelectionChange?.(next); };
  const discover = useCallback(async () => {
    const turn = ++scan.current;
    setRuntimeDiscovery(previous => ({ ...previous, phase: "loading" }));
    setWindowDiscovery(previous => previous.phase === "loading" ? { ...previous, phase: "idle" } : previous);
    let check: ObsPreflight;
    try {
      check = await invoke<ObsPreflight>("obs_preflight", {});
      if (turn !== scan.current) return;
      setRuntime(check);
      setRuntimeDiscovery({ phase: "ready", error: null });
    } catch (cause) {
      if (turn === scan.current) setRuntimeDiscovery({ phase: "error", error: formatError(cause) });
      return;
    }
    if (!check.available) return;
    // Keep the exact draft and its previous error until a current lookup
    // succeeds. Cards cannot submit while either check is pending or failed.
    setWindowDiscovery(previous => ({ ...previous, phase: "loading" }));
    try {
      const found = await invoke<ObsWindowChoice[]>("obs_all_windows", {});
      if (turn === scan.current) {
        setWindows(found); setWindowDiscovery({ phase: "ready", error: null });
      }
    } catch (cause) { if (turn === scan.current) setWindowDiscovery({ phase: "error", error: formatError(cause) }); }
  }, []);
  useEffect(() => {
    if (!open) return;
    void discover();
    const focus = () => { void discover(); };
    window.addEventListener("focus", focus);
    return () => { cancelScan(); window.removeEventListener("focus", focus); };
  }, [open, refreshRequest, discover, cancelScan]);
  const scanning = runtimeDiscovery.phase === "loading" || windowDiscovery.phase === "loading";
  const discoveryReady = runtime?.available && runtimeDiscovery.phase === "ready" && windowDiscovery.phase === "ready";
  const windowError = windowDiscovery.error;
  const windowEmptyLabel = runtime && !runtime.available ? "Application capture is unavailable in this build."
    : discoveryReady ? "No windows to choose from."
      : windowDiscovery.phase === "error" || runtimeDiscovery.phase === "error" ? "Windows could not be loaded. Refresh windows to try again."
        : "Looking for windows…";
  const selectedWindow = windows.find(window => window.id === selection.window && window.pid === selection.process && window.app === selection.application);
  const windowAvailable = !!selectedWindow;
  useEffect(() => {
    const index = windows.findIndex(window => window === selectedWindow);
    setPage(index < 0 ? 0 : Math.floor(index / WINDOWS_PER_PAGE));
  }, [windows, selectedWindow]);
  const visibleWindows = useMemo(() => windows.slice(page * WINDOWS_PER_PAGE, (page + 1) * WINDOWS_PER_PAGE), [windows, page]);
  const thumbnails = useCaptureWindowThumbnails(visibleWindows,
    open && !!discoveryReady, snapshotRequest);
  const selectedThumbnail = selectedWindow ? thumbnails[captureWindowKey(selectedWindow)] : undefined;
  const crop = selection.crop;
  const cropValid = !!selectedWindow && captureRegionValid(crop, selectedWindow.width, selectedWindow.height);
  const busy = disabled || starting;
  const canPreview = !!discoveryReady && !!selectedWindow && visibleWindows.includes(selectedWindow) && cropValid && !busy;
  if (!open) return null;
  return <div className="cp-obs-capture-controls">
    <p>Choose a window to preview privately. Only that window is captured.</p>
    <div className="cp-ndi-input-source-label">
      <span>Windows</span>
      <button type="button" className="cp-toolbar-disclosure" disabled={scanning || busy} onClick={() => void discover()}>Refresh windows</button>
    </div>
    <CaptureSourceGrid sources={visibleWindows.map(window => ({
      id: captureWindowKey(window), label: window.title || "Untitled window",
      description: `${window.applicationName} · ${window.width} × ${window.height} · Window ${window.id}`,
      thumbnail: thumbnails[captureWindowKey(window)]?.image,
      thumbnailState: thumbnails[captureWindowKey(window)]?.phase === "error" ? "error" : "loading",
    }))} selectedId={selectedWindow ? captureWindowKey(selectedWindow) : null}
      busy={scanning} disabled={!discoveryReady || busy}
      emptyLabel={windowEmptyLabel}
      onSelect={id => {
        const window = visibleWindows.find(window => captureWindowKey(window) === id);
        if (!window) return;
        change({ ...selection, application: window.app, process: window.pid, window: window.id, crop: { ...FULL_WINDOW } });
      }}/>
    {windows.length > WINDOWS_PER_PAGE && <div className="cp-capture-pagination" aria-label="Window pages">
      <button type="button" className="cp-toolbar-disclosure" disabled={page === 0 || busy} onClick={() => setPage(value => value - 1)}>Previous</button>
      <span>Page {page + 1} of {Math.ceil(windows.length / WINDOWS_PER_PAGE)}</span>
      <button type="button" className="cp-toolbar-disclosure" disabled={(page + 1) * WINDOWS_PER_PAGE >= windows.length || busy} onClick={() => setPage(value => value + 1)}>Next</button>
    </div>}
    {selectedWindow && <p className="cp-capture-selected" role="status" aria-label="Selected window">Selected: {selectedWindow.applicationName} · {selectedWindow.title || "Untitled window"} · Window {selection.window}</p>}
    {selection.window !== 0 && !windowAvailable && discoveryReady && <p role="status" aria-label="Selected window">Window {selection.window} is no longer available. Choose a visible window; no replacement will be selected automatically.</p>}
    {visibleWindows.length > 0 && <div className="cp-capture-snapshot-note">
      <span>Window snapshots stay on this Mac. They are not a live share.</span>
      <button type="button" className="cp-toolbar-disclosure" disabled={busy || Object.values(thumbnails).some(item => item.phase === "loading")}
        onClick={() => setSnapshotRequest(value => value + 1)}>Refresh previews</button>
    </div>}
    {selectedThumbnail?.error && <p role="status">Snapshot unavailable: {selectedThumbnail.error}</p>}
    <p role="status" aria-label="Window discovery">{scanning ? "Looking for windows…" : runtimeDiscovery.error ? "Capture availability needs attention." : windowError ? "Window discovery needs attention." : !runtime ? "Capture not checked" : !runtime.available ? "Application capture unavailable" : discoveryReady && !windows.length ? "No visible windows found. Bring the window onto this display, then refresh." : "Only the selected window is captured. Other application windows are excluded from the picture."}</p>
    {runtime && !runtime.available && <p role="alert">{runtime.error || "This build does not include application capture."}</p>}
    {selectedWindow && <details className="cp-obs-crop">
      <summary>Crop</summary>
      <CaptureRegionEditor key={captureWindowKey(selectedWindow)} thumbnail={selectedThumbnail?.image ?? null} label={selectedWindow.title || "Selected window"}
        width={selectedWindow.width} height={selectedWindow.height} crop={crop} disabled={busy}
        onChange={next => change({ ...selection, crop: next ?? { x: 0, y: 0, width: 0, height: 0 } })}/>
    </details>}
    {runtimeDiscovery.error && <p role="alert">{runtimeDiscovery.error}</p>}
    {windowError && <p role="alert">{windowError}</p>}
    {previewError && previewError !== reportedPreviewError && <p role="alert">{previewError}</p>}
    <CapturePreviewFooter target={footerTarget}>
    <CaptureAudioOption checked={selection.audio ?? true} onChange={audio => change({ ...selection, audio })}
      label="Include application audio" description="Audio from this application only. Camera and microphone stay separate." disabled={busy}/>
    <button type="button" className="btn cp-ndi-input-preview" disabled={!canPreview} onClick={() => {
      if (!canPreview || action.current) return;
      action.current = true; setStarting(true); setPreviewError(null);
      const turn = ++previewGeneration.current;
      const exact = copyCaptureSelection(selection);
      void onPreview(exact).catch(cause => { if (turn === previewGeneration.current) setPreviewError(formatError(cause)); }).finally(() => {
        if (turn === previewGeneration.current) { action.current = false; setStarting(false); }
      });
    }}>{starting ? "Starting preview…" : "Preview source"}</button>
    </CapturePreviewFooter>
  </div>;
}
