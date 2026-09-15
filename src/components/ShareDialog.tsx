import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { loadJson, saveJson } from "../lib/storage";
import { IconVideoOff } from "./Icons";
import { useModalFocus } from "../hooks/use-modal-focus";
import type { ShareSourceArg } from "../bindings/ShareSourceArg";
import type { ShareSources } from "../bindings/ShareSources";
import { formatError } from "../lib/error-format";
import { CaptureSourceGrid, CaptureSourceTabs, CaptureRegionEditor, CaptureAudioOption,
  captureRegionValid, MIN_CAPTURE_REGION_PX, type CaptureRegion } from "./CaptureSourcePicker";

type Tab = "screens" | "windows" | "portion";
type Crop = { x: number; y: number; w: number; h: number };

/**
 * A dragged region has to clear this in BOTH dimensions to be shareable.
 * A one-pixel-tall strip is a mis-drag, not a selection.
 */
export const MIN_CROP_PX = MIN_CAPTURE_REGION_PX;

/** The Share button's gate. */
export function cropShareable(c: Crop | null): boolean {
  return c != null && Object.values(c).every(Number.isFinite) && c.x >= 0 && c.y >= 0
    && c.w > MIN_CROP_PX && c.h > MIN_CROP_PX;
}

/**
 * What the foot says about the current drag - derived from the SAME predicate
 * the Share button uses, which is the point of it being a function.
 *
 * These two had drifted: the gate wanted both dimensions over the floor, the
 * readout checked only the width. Drag a wide, short strip across a title bar
 * and the dialog printed "420x9 on Built-in Display", drew the rectangle, and
 * left Share dead with nothing on screen disagreeing. A caption that confirms
 * a selection the button rejects is worse than no caption: it sends the user
 * looking for the fault somewhere else entirely.
 */
export function cropStatus(c: Crop | null, label: string): string {
  if (!c || (c.w <= MIN_CROP_PX && c.h <= MIN_CROP_PX)) return "Drag the area to share.";
  const size = `${Math.round(c.w)}×${Math.round(c.h)}`;
  if (!cropShareable(c)) return `${size} is too small to share.`;
  return `${size} on ${label}`;
}

/**
 * The share dialog - the Meet/Zoom picker shape: tabs for entire screens,
 * app windows, and a portion of a screen (drag a rect on the screen's
 * thumbnail), bounded snapshots and an explicit audio inclusion choice.
 * Opening checks access; only a labelled user action requests permission.
 */
export function ShareDialog({ onPick, onClose }: {
  onPick: (source: ShareSourceArg) => void;
  onClose: () => void;
}) {
  const [access, setAccess] = useState<"checking" | "granted" | "denied" | "undetermined" | "error">("checking");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sources, setSources] = useState<ShareSources | null>(null);
  const [tab, setTab] = useState<Tab>("screens");
  const [picked, setPicked] = useState<{ kind: "display" | "window"; id: number } | null>(null);
  const [audio, setAudio] = useState<boolean>(() => loadJson<boolean>("saucebunny.shareAudio", false));
  // Crop coordinates remain normalized until submitting display points.
  const [portionDisplay, setPortionDisplay] = useState<number | null>(null);
  const [crop, setCrop] = useState<CaptureRegion | null>(null);
  const generation = useRef(0), submitted = useRef(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  useModalFocus(true, dialogRef);

  const discover = useCallback(async (request = false) => {
    const turn = ++generation.current;
    setLoading(true); setError(null);
    try {
      const state = await invoke<string>("screen_capture_access", { request });
      if (turn !== generation.current) return;
      if (state !== "granted") {
        setAccess(state === "undetermined" ? "undetermined" : "denied"); setSources(null); return;
      }
      setAccess("granted");
      const found = await invoke<ShareSources>("list_share_sources");
      if (turn === generation.current) setSources(found);
    } catch (cause) {
      if (turn === generation.current) { setAccess("error"); setSources(null); setError(formatError(cause)); }
    } finally { if (turn === generation.current) setLoading(false); }
  }, []);
  const invalidateDiscovery = useCallback(() => { generation.current++; }, []);
  const close = useCallback(() => { invalidateDiscovery(); onClose(); }, [invalidateDiscovery, onClose]);
  useEffect(() => {
    void discover();
    const focus = () => { void discover(); };
    window.addEventListener("focus", focus);
    return () => { invalidateDiscovery(); window.removeEventListener("focus", focus); };
  }, [discover, invalidateDiscovery]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close]);

  const engine = sources?.capture_engine ?? false;
  const displays = sources?.displays ?? [];
  const windows = sources?.windows ?? [];
  const portionSrc = displays.find((d) => d.id === portionDisplay) ?? null;

  const pixelCrop = crop && portionSrc ? { x: Math.round(crop.x * portionSrc.width), y: Math.round(crop.y * portionSrc.height),
    w: Math.min(Math.round(crop.width * portionSrc.width), portionSrc.width - Math.round(crop.x * portionSrc.width)),
    h: Math.min(Math.round(crop.height * portionSrc.height), portionSrc.height - Math.round(crop.y * portionSrc.height)) } : null;
  const shareReady = access === "granted" && !loading && !error && (tab === "portion"
    ? engine && portionSrc != null && captureRegionValid(crop, portionSrc.width, portionSrc.height) && cropShareable(pixelCrop)
    : tab === "screens" ? picked?.kind === "display" && displays.some(display => display.id === picked.id)
      : engine && picked?.kind === "window" && windows.some(window => window.id === picked.id));

  const share = () => {
    if (!shareReady || submitted.current) return;
    submitted.current = true;
    saveJson("saucebunny.shareAudio", audio);
    const withAudio = audio && engine;
    if (tab === "portion" && portionSrc && pixelCrop) {
      onPick({
        kind: "display", id: portionSrc.id,
        crop: `${pixelCrop.x},${pixelCrop.y},${pixelCrop.w},${pixelCrop.h}`,
        audio: withAudio,
      });
    } else if (picked) {
      onPick({ kind: picked.kind, id: picked.id, crop: null, audio: withAudio });
    }
    close();
  };

  return (
    <div className="cp-share-dialog-backdrop" onClick={close}>
      {/* aria-modal is not decoration here: TranscriptViewer gates cmd+F and
          cmd+G on `[role="dialog"][aria-modal="true"]` existing, so without it
          those shortcuts fired at the transcript BEHIND this scrim while the
          user was looking at the dialog. */}
      <div ref={dialogRef} tabIndex={-1} className="cp-share-dialog" role="dialog" aria-modal="true" aria-label="Share your screen" onClick={(e) => e.stopPropagation()}>
        <header className="cp-share-dialog-header">
          <h2 className="cp-share-dialog-title">Share your screen</h2>
          <p className="cp-share-dialog-sub">Choose a screen, window or area. Nothing is shared until you click Share.</p>
          {access === "granted" && <CaptureSourceTabs label="Share source type" selected={tab} tabs={[
            { id: "screens", label: "Screens", panelId: "cp-share-screens" },
            { id: "windows", label: "Windows", panelId: "cp-share-windows", disabled: !engine },
            { id: "portion", label: "Portion of screen", panelId: "cp-share-portion", disabled: !engine },
          ]} onSelect={value => {
            if (value !== "screens" && value !== "windows" && value !== "portion") return;
            setTab(value); setPicked(null); setPortionDisplay(null); setCrop(null);
          }}/>}
        </header>
        <div className="cp-share-dialog-body">
        {access === "checking" && <p className="cp-share-dialog-line">Checking screen access…</p>}
        {access === "undetermined" && <div className="cp-share-dialog-denied">
          <p className="cp-share-dialog-line">Allow Screen Recording to choose a source.</p>
          <button type="button" className="btn" disabled={loading} onClick={() => void discover(true)}>Allow screen access</button>
        </div>}
        {access === "denied" && (
          <div className="cp-share-dialog-denied">
            <IconVideoOff size={22} />
            <p className="cp-share-dialog-line">Screen recording is blocked for Sauce Bunny.</p>
            <p className="cp-share-dialog-sub">After allowing it in System Settings, quit and reopen the app. macOS requires it.</p>
            <button type="button" className="btn btn-ghost btn-compact"
              onClick={() => { void invoke("open_privacy_pane", { anchor: "Privacy_ScreenCapture" }).catch(() => {}); }}>
              Open System Settings
            </button>
            <button type="button" className="btn btn-ghost btn-compact" disabled={loading} onClick={() => void discover()}>Check again</button>
          </div>
        )}
        {error && <div className="cp-share-dialog-denied">
          <p role="alert" className="cp-share-dialog-line">{error}</p>
          <button type="button" className="btn" disabled={loading} onClick={() => void discover()}>Try again</button>
        </div>}

        {access === "granted" && (
          <>
            {loading && <p className="cp-share-dialog-line" role="status">Finding what you can share…</p>}
            {!loading && sources && <button type="button" className="cp-toolbar-disclosure cp-share-refresh" onClick={() => void discover()}>Refresh sources</button>}

            {sources != null && tab === "screens" && (
              <div role="tabpanel" id="cp-share-screens" aria-label="Screens">
                <CaptureSourceGrid sources={displays.map(display => ({ id: String(display.id), label: display.label,
                  description: `${display.width} × ${display.height}`, thumbnail: display.thumb ? `data:image/jpeg;base64,${display.thumb}` : null }))}
                  selectedId={picked?.kind === "display" ? String(picked.id) : null} disabled={loading}
                  emptyLabel="No displays found." onSelect={id => setPicked({ kind: "display", id: Number(id) })}/>
              </div>
            )}

            {sources != null && tab === "windows" && (
              <div role="tabpanel" id="cp-share-windows" aria-label="Windows">
                <CaptureSourceGrid sources={windows.map(window => ({ id: String(window.id), label: window.title || "Untitled window",
                  description: `${window.app} · Window ${window.id}`, thumbnail: window.thumb ? `data:image/jpeg;base64,${window.thumb}` : null }))}
                  selectedId={picked?.kind === "window" ? String(picked.id) : null} disabled={loading}
                  emptyLabel="No shareable windows found." onSelect={id => setPicked({ kind: "window", id: Number(id) })}/>
              </div>
            )}

            {sources != null && tab === "portion" && (
              <div className="cp-share-portion" role="tabpanel" id="cp-share-portion" aria-label="Portion of screen">
                {portionSrc == null && (
                  <>
                    <p className="cp-share-dialog-sub">Pick the screen, then drag the area to share.</p>
                    <CaptureSourceGrid sources={displays.map(display => ({ id: String(display.id), label: display.label,
                      description: `${display.width} × ${display.height}`, thumbnail: display.thumb ? `data:image/jpeg;base64,${display.thumb}` : null }))}
                      selectedId={null} disabled={loading} emptyLabel="No displays found."
                      onSelect={id => { setPortionDisplay(Number(id)); setCrop(null); }}/>
                  </>
                )}
                {portionSrc != null && (
                  <>
                    <CaptureRegionEditor key={portionSrc.id} label={portionSrc.label} width={portionSrc.width} height={portionSrc.height}
                      thumbnail={portionSrc.thumb ? `data:image/jpeg;base64,${portionSrc.thumb}` : null}
                      crop={crop} onChange={setCrop} disabled={loading}/>
                    <div className="cp-share-portion-foot">
                      <span className="cp-share-dialog-sub">
                        {cropStatus(pixelCrop, portionSrc.label)}
                      </span>
                      <button type="button" className="btn btn-ghost btn-compact"
                        onClick={() => { setPortionDisplay(null); setCrop(null); }}>
                        Pick another screen
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}

          </>
        )}
        </div>
        <footer className="cp-share-dialog-foot">
          {access === "granted" && <CaptureAudioOption checked={audio && engine} disabled={!engine || loading}
            onChange={setAudio} label="Share system audio" description="Other applications may be audible. Your microphone stays separate."/>}
          <div className="cp-share-dialog-actions">
            <button type="button" className="btn btn-ghost btn-compact" onClick={close}>Cancel</button>
            <button type="button" className="btn cp-colobby-cta" disabled={!shareReady} onClick={share}>
              Share
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
