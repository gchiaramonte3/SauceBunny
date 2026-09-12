import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ObsApplication } from "../bindings/ObsApplication";
import type { ObsWindow } from "../bindings/ObsWindow";
import type { ObsSelection } from "../bindings/ObsSelection";
import type { ObsPreflight } from "../bindings/ObsPreflight";
import { formatError } from "../lib/error-format";
import { copyCaptureSelection } from "../lib/ndi-program-source";

const FULL_WINDOW = { x: 0, y: 0, width: 1, height: 1 };
const EMPTY_SELECTION: ObsSelection = { application: "", process: 0, window: 0, crop: FULL_WINDOW };
const cropFields = [["x", "Left"], ["y", "Top"], ["width", "Width"], ["height", "Height"]] as const;

type Props = {
  open: boolean;
  disabled: boolean;
  initialSelection?: ObsSelection;
  onSelectionChange?: (selection: ObsSelection) => void;
  onPreview: (selection: ObsSelection) => Promise<void>;
  refreshRequest?: number;
};

/** Discovery is passive. Only Preview submits an exact window/PID/crop. */
export function ObsCaptureControls({ open, disabled, initialSelection, onSelectionChange, onPreview, refreshRequest = 0 }: Props) {
  const [selection, setSelection] = useState<ObsSelection>(() => initialSelection ?? EMPTY_SELECTION);
  const [applications, setApplications] = useState<ObsApplication[]>([]);
  const [windows, setWindows] = useState<ObsWindow[]>([]);
  const [runtime, setRuntime] = useState<ObsPreflight | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanningWindows, setScanningWindows] = useState(false);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scan = useRef(0), windowScan = useRef(0), action = useRef(false);
  const cancelScan = useCallback(() => { scan.current++; }, []);
  const cancelWindowScan = useCallback(() => { windowScan.current++; }, []);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const change = (next: ObsSelection) => { setSelection(next); onSelectionChange?.(next); setError(null); };
  const discover = useCallback(async () => {
    const turn = ++scan.current;
    setScanning(true); setError(null);
    try {
      const check = await invoke<ObsPreflight>("obs_preflight", {});
      if (turn !== scan.current) return;
      setRuntime(check);
      const apps = check.available ? await invoke<ObsApplication[]>("obs_applications", {}) : [];
      if (turn === scan.current) setApplications(apps);
    } catch (cause) { if (turn === scan.current) setError(formatError(cause)); }
    finally { if (turn === scan.current) setScanning(false); }
  }, []);
  const discoverWindows = useCallback(async () => {
    const turn = ++windowScan.current;
    setWindows([]);
    if (!selection.application) { setScanningWindows(false); return; }
    setScanningWindows(true);
    try {
      const found = await invoke<ObsWindow[]>("obs_windows", { application: selection.application });
      if (turn === windowScan.current) setWindows(found.filter(item => item.app === selection.application && item.pid === selection.process));
    } catch (cause) { if (turn === windowScan.current) setError(formatError(cause)); }
    finally { if (turn === windowScan.current) setScanningWindows(false); }
  }, [selection.application, selection.process]);
  useEffect(() => {
    if (!open) return;
    void discover();
    const focus = () => { void discover(); };
    window.addEventListener("focus", focus);
    return () => { cancelScan(); window.removeEventListener("focus", focus); };
  }, [open, refreshRequest, discover, cancelScan]);
  useEffect(() => {
    if (!open) return;
    void discoverWindows();
    const focus = () => { void discoverWindows(); };
    window.addEventListener("focus", focus);
    return () => { cancelWindowScan(); window.removeEventListener("focus", focus); };
  }, [open, refreshRequest, discoverWindows, cancelWindowScan]);
  const appAvailable = applications.some(app => app.app === selection.application && app.pid === selection.process);
  const windowAvailable = windows.some(window => window.id === selection.window);
  const crop = selection.crop;
  const cropValid = Object.values(crop).every(Number.isFinite) && crop.x >= 0 && crop.y >= 0
    && crop.width > 0 && crop.height > 0 && crop.x + crop.width <= 1 && crop.y + crop.height <= 1;
  const busy = disabled || starting;
  const canPreview = !!runtime?.available && appAvailable && windowAvailable && cropValid && !busy && !scanning && !scanningWindows;
  if (!open) return null;
  return <div className="cp-obs-capture-controls">
    <p>Capture one window and its application audio.</p>
    <div className="cp-ndi-input-source-label">
      <label htmlFor="obs-application">Application</label>
      <button type="button" className="cp-toolbar-disclosure" disabled={scanning || busy} onClick={() => void discover()}>Refresh applications</button>
    </div>
    <select id="obs-application" className="cp-select" value={selection.application ? `${selection.application}:${selection.process}` : ""} disabled={scanning || busy}
      onChange={event => {
        const app = applications.find(item => `${item.app}:${item.pid}` === event.target.value);
        change(app ? { application: app.app, process: app.pid, window: 0, crop: { ...FULL_WINDOW } } : EMPTY_SELECTION);
      }}>
      <option value="">Choose an application…</option>
      {selection.application && !appAvailable && <option value={`${selection.application}:${selection.process}`} disabled>{selection.application} · Not currently found</option>}
      {applications.map(app => <option key={`${app.app}:${app.pid}`} value={`${app.app}:${app.pid}`}>{app.name}{applications.filter(other => other.name === app.name).length > 1 ? ` · ${app.pid}` : ""}</option>)}
    </select>
    <div className="cp-ndi-input-source-label">
      <label htmlFor="obs-window">Window</label>
      <button type="button" className="cp-toolbar-disclosure" disabled={!appAvailable || scanningWindows || busy} onClick={() => void discoverWindows()}>Refresh windows</button>
    </div>
    <select id="obs-window" className="cp-select" value={selection.window || ""} disabled={!appAvailable || scanningWindows || busy}
      onChange={event => change({ ...selection, window: Number(event.target.value), crop: { ...FULL_WINDOW } })}>
      <option value="">Choose a window…</option>
      {selection.window !== 0 && !windowAvailable && <option value={selection.window} disabled>Window {selection.window} · Not currently found</option>}
      {windows.map(window => <option key={window.id} value={window.id}>{window.title || "Untitled window"} · {window.width} × {window.height}{windows.filter(other => other.title === window.title).length > 1 ? ` · ${window.id}` : ""}</option>)}
    </select>
    <p role="status" aria-label="Application discovery">{scanning || scanningWindows ? "Looking for windows…" : !runtime ? "Capture not checked" : !runtime.available ? "Application capture unavailable" : selection.application && appAvailable && !windows.length ? "No visible windows found. Bring the window onto this display, then refresh." : "Only the selected window is captured. Other application windows are excluded from the picture."}</p>
    {runtime && !runtime.available && <p role="alert">{runtime.error || "This build does not include application capture."}</p>}
    <details className="cp-obs-crop">
      <summary>Crop</summary>
      <p>Percent of the selected window. Leave unchanged to show the full window.</p>
      <div className="cp-obs-crop-fields">
        {cropFields.map(([key, label]) => <label key={key}>{label}<input className="cp-input" type="number" min={key === "width" || key === "height" ? 0.1 : 0} max={100} step={0.1}
          value={Number.isFinite(crop[key]) ? Math.round(crop[key] * 1000) / 10 : ""} disabled={busy}
          aria-invalid={!cropValid || undefined} aria-describedby={!cropValid ? "obs-crop-error" : undefined}
          onChange={event => change({ ...selection, crop: { ...crop, [key]: event.target.value === "" ? NaN : Number(event.target.value) / 100 } })}/></label>)}
      </div>
      {!cropValid && <p id="obs-crop-error" role="alert">Keep the crop inside the window, with a width and height greater than zero.</p>}
    </details>
    {error && <p role="alert">{error}</p>}
    <button type="button" className="btn cp-ndi-input-preview" disabled={!canPreview} onClick={() => {
      if (!canPreview || action.current) return;
      action.current = true; setStarting(true); setError(null);
      const exact = copyCaptureSelection(selection);
      void onPreview(exact).catch(cause => { if (alive.current) setError(formatError(cause)); }).finally(() => {
        action.current = false; if (alive.current) setStarting(false);
      });
    }}>{starting ? "Starting preview…" : "Preview source"}</button>
  </div>;
}
