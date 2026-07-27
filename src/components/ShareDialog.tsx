import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { loadJson, saveJson } from "../lib/storage";
import { IconVideoOff } from "./Icons";
import type { ShareSourceArg } from "../bindings/ShareSourceArg";
import type { ShareSources } from "../bindings/ShareSources";

type Tab = "screens" | "windows" | "portion";

/**
 * The share dialog - the Meet/Zoom picker shape: tabs for entire screens,
 * app windows, and a portion of a screen (drag a rect on the screen's
 * thumbnail), live thumbnails from the ScreenCaptureKit engine, and a
 * "Share system audio" footer checkbox. Owns the TCC preflight; without
 * the capture engine it degrades honestly to screens-only, no audio.
 */
export function ShareDialog({ onPick, onClose }: {
  onPick: (source: ShareSourceArg) => void;
  onClose: () => void;
}) {
  const [access, setAccess] = useState<"checking" | "granted" | "denied">("checking");
  const [sources, setSources] = useState<ShareSources | null>(null);
  const [tab, setTab] = useState<Tab>("screens");
  const [picked, setPicked] = useState<{ kind: "display" | "window"; id: number } | null>(null);
  const [audio, setAudio] = useState<boolean>(() => loadJson<boolean>("saucebunny.shareAudio", false));
  // Portion state: which display + the dragged rect in DISPLAY points.
  const [portionDisplay, setPortionDisplay] = useState<number | null>(null);
  const [crop, setCrop] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const dragRef = useRef<{ startX: number; startY: number } | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void (async () => {
      let state = await invoke<string>("screen_capture_access", { request: false }).catch(() => "denied");
      if (state === "undetermined") {
        state = await invoke<string>("screen_capture_access", { request: true }).catch(() => "denied");
      }
      if (state !== "granted") {
        setAccess("denied");
        return;
      }
      setAccess("granted");
      const s = await invoke<ShareSources>("list_share_sources").catch(() => null);
      setSources(s ?? { displays: [], windows: [], capture_engine: false });
    })();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const engine = sources?.capture_engine ?? false;
  const displays = sources?.displays ?? [];
  const windows = sources?.windows ?? [];
  const portionSrc = displays.find((d) => d.id === portionDisplay) ?? null;

  const shareReady =
    tab === "portion"
      ? portionSrc != null && crop != null && crop.w > 16 && crop.h > 16
      : picked != null;

  const share = () => {
    saveJson("saucebunny.shareAudio", audio);
    const withAudio = audio && engine;
    if (tab === "portion" && portionSrc && crop) {
      onPick({
        kind: "display", id: portionSrc.id,
        crop: `${Math.round(crop.x)},${Math.round(crop.y)},${Math.round(crop.w)},${Math.round(crop.h)}`,
        audio: withAudio,
      });
    } else if (picked) {
      onPick({ kind: picked.kind, id: picked.id, crop: null, audio: withAudio });
    }
    onClose();
  };

  // Drag-on-thumbnail: pointer coords scale from the rendered surface to
  // display points (SCDisplay dimensions are points).
  const portionPointer = (e: React.PointerEvent, phase: "down" | "move" | "up") => {
    const el = surfaceRef.current;
    if (!el || !portionSrc) return;
    const r = el.getBoundingClientRect();
    const sx = portionSrc.width / r.width;
    const sy = portionSrc.height / r.height;
    const px = Math.min(Math.max(e.clientX - r.left, 0), r.width) * sx;
    const py = Math.min(Math.max(e.clientY - r.top, 0), r.height) * sy;
    if (phase === "down") {
      dragRef.current = { startX: px, startY: py };
      el.setPointerCapture(e.pointerId);
      setCrop({ x: px, y: py, w: 0, h: 0 });
    } else if (dragRef.current && (phase === "move" ? e.buttons > 0 : true)) {
      const { startX, startY } = dragRef.current;
      setCrop({
        x: Math.min(startX, px), y: Math.min(startY, py),
        w: Math.abs(px - startX), h: Math.abs(py - startY),
      });
      if (phase === "up") dragRef.current = null;
    }
  };

  return (
    <div className="cp-share-dialog-backdrop" onClick={onClose}>
      {/* aria-modal is not decoration here: TranscriptViewer gates cmd+F and
          cmd+G on `[role="dialog"][aria-modal="true"]` existing, so without it
          those shortcuts fired at the transcript BEHIND this scrim while the
          user was looking at the dialog. */}
      <div className="cp-share-dialog" role="dialog" aria-modal="true" aria-label="Share your screen" onClick={(e) => e.stopPropagation()}>
        <h2 className="cp-share-dialog-title">Share your screen</h2>

        {access === "checking" && <p className="cp-share-dialog-line">Checking screen access…</p>}
        {access === "denied" && (
          <div className="cp-share-dialog-denied">
            <IconVideoOff size={22} />
            <p className="cp-share-dialog-line">Screen recording is blocked for Sauce Bunny.</p>
            <p className="cp-share-dialog-sub">After allowing it in System Settings, quit and reopen the app. macOS requires it.</p>
            <button type="button" className="btn btn-ghost btn-compact"
              onClick={() => { void invoke("open_privacy_pane", { anchor: "Privacy_ScreenCapture" }).catch(() => {}); }}>
              Open System Settings
            </button>
          </div>
        )}

        {access === "granted" && (
          <>
            <div className="cp-share-tabs" role="tablist">
              <button type="button" role="tab" aria-selected={tab === "screens"}
                className={"cp-share-tab" + (tab === "screens" ? " here" : "")}
                onClick={() => setTab("screens")}>
                Screens
              </button>
              <button type="button" role="tab" aria-selected={tab === "windows"}
                className={"cp-share-tab" + (tab === "windows" ? " here" : "")}
                disabled={!engine}
                title={engine ? undefined : "Needs the capture engine (npm run build:capture)"}
                onClick={() => setTab("windows")}>
                Windows
              </button>
              <button type="button" role="tab" aria-selected={tab === "portion"}
                className={"cp-share-tab" + (tab === "portion" ? " here" : "")}
                disabled={!engine}
                title={engine ? undefined : "Needs the capture engine (npm run build:capture)"}
                onClick={() => setTab("portion")}>
                Portion of screen
              </button>
            </div>

            {sources == null && <p className="cp-share-dialog-line">Finding what you can share…</p>}

            {sources != null && tab === "screens" && (
              <div className="cp-share-grid">
                {displays.map((d) => (
                  <button key={d.id} type="button"
                    className={"cp-share-card" + (picked?.kind === "display" && picked.id === d.id ? " picked" : "")}
                    onClick={() => setPicked({ kind: "display", id: d.id })}>
                    {d.thumb
                      ? <img src={`data:image/jpeg;base64,${d.thumb}`} alt="" />
                      : <span className="cp-share-card-ph" />}
                    <span className="cp-share-card-label">{d.label}</span>
                  </button>
                ))}
                {displays.length === 0 && <p className="cp-share-dialog-line">No displays found.</p>}
              </div>
            )}

            {sources != null && tab === "windows" && (
              <div className="cp-share-grid">
                {windows.map((w) => (
                  <button key={w.id} type="button"
                    className={"cp-share-card" + (picked?.kind === "window" && picked.id === w.id ? " picked" : "")}
                    onClick={() => setPicked({ kind: "window", id: w.id })}>
                    {w.thumb
                      ? <img src={`data:image/jpeg;base64,${w.thumb}`} alt="" />
                      : <span className="cp-share-card-ph" />}
                    <span className="cp-share-card-label" title={`${w.app} - ${w.title}`}>
                      {w.app}{w.title ? ` - ${w.title}` : ""}
                    </span>
                  </button>
                ))}
                {windows.length === 0 && <p className="cp-share-dialog-line">No shareable windows found.</p>}
              </div>
            )}

            {sources != null && tab === "portion" && (
              <div className="cp-share-portion">
                {portionSrc == null && (
                  <>
                    <p className="cp-share-dialog-sub">Pick the screen, then drag the area to share.</p>
                    <div className="cp-share-grid">
                      {displays.map((d) => (
                        <button key={d.id} type="button" className="cp-share-card"
                          onClick={() => { setPortionDisplay(d.id); setCrop(null); }}>
                          {d.thumb
                            ? <img src={`data:image/jpeg;base64,${d.thumb}`} alt="" />
                            : <span className="cp-share-card-ph" />}
                          <span className="cp-share-card-label">{d.label}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
                {portionSrc != null && (
                  <>
                    <div
                      ref={surfaceRef}
                      className="cp-share-portion-surface"
                      onPointerDown={(e) => portionPointer(e, "down")}
                      onPointerMove={(e) => portionPointer(e, "move")}
                      onPointerUp={(e) => portionPointer(e, "up")}
                    >
                      {portionSrc.thumb && <img src={`data:image/jpeg;base64,${portionSrc.thumb}`} alt="" draggable={false} />}
                      {crop && crop.w > 0 && (
                        <span
                          className="cp-share-portion-rect"
                          style={{
                            left: `${(crop.x / portionSrc.width) * 100}%`,
                            top: `${(crop.y / portionSrc.height) * 100}%`,
                            width: `${(crop.w / portionSrc.width) * 100}%`,
                            height: `${(crop.h / portionSrc.height) * 100}%`,
                          }}
                        />
                      )}
                    </div>
                    <div className="cp-share-portion-foot">
                      <span className="cp-share-dialog-sub">
                        {crop && crop.w > 16 ? `${Math.round(crop.w)}×${Math.round(crop.h)} on ${portionSrc.label}` : "Drag the area to share."}
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

            <div className="cp-share-dialog-foot">
              <label className={"cp-share-audio" + (engine ? "" : " off")}>
                <input type="checkbox" checked={audio && engine} disabled={!engine}
                  onChange={(e) => setAudio(e.target.checked)} />
                Share system audio
                {!engine && <span className="cp-share-dialog-sub"> (needs the capture engine)</span>}
              </label>
              <div className="cp-share-dialog-actions">
                <button type="button" className="btn btn-ghost btn-compact" onClick={onClose}>Cancel</button>
                <button type="button" className="btn cp-colobby-cta" disabled={!shareReady} onClick={share}>
                  Share
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
