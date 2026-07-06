import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { IconAspect, IconFullscreen, IconFullscreenExit, IconInfo } from "./Icons";
import type { AspectId } from "./Monitor";
import { usePopoverDismiss } from "../hooks/use-popover-dismiss";

type Props = {
  aspect: AspectId;
  onAspectChange: (a: AspectId) => void;
  /** Timeline audio waveform lane visibility (persisted in App). */
  waveformVisible: boolean;
  onWaveformVisibleChange: (v: boolean) => void;
  /** Opens the media-info inspector. Only provided when a local source
   *  file is loaded — omitted, the button doesn't render. */
  onShowMediaInfo?: () => void;
};

const ASPECTS: { id: AspectId; label: string; subtitle: string }[] = [
  { id: "off",  label: "Native",   subtitle: "use the source's pixels" },
  { id: "16:9", label: "16 : 9",    subtitle: "standard widescreen" },
  { id: "9:16", label: "9 : 16",    subtitle: "vertical / mobile" },
  { id: "1:1",  label: "1 : 1",     subtitle: "square" },
  { id: "2.39", label: "2.39 : 1",  subtitle: "anamorphic / cinemascope" },
];

export function ViewOptions({ aspect, onAspectChange, waveformVisible, onWaveformVisibleChange, onShowMediaInfo }: Props) {
  const [open, setOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = ASPECTS.find((a) => a.id === aspect) ?? ASPECTS[0];

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const fs = await getCurrentWindow().isFullscreen();
        if (mounted) setFullscreen(fs);
      } catch { /* ignore */ }
    })();
    // Re-read on every resize: fullscreen can also be entered/exited via the
    // View menu or the green traffic-light, which this component never sees —
    // without this the button shows the wrong icon and needs two clicks.
    let unlisten: (() => void) | null = null;
    (async () => {
      try {
        unlisten = await getCurrentWindow().onResized(async () => {
          try {
            const fs = await getCurrentWindow().isFullscreen();
            if (mounted) setFullscreen(fs);
          } catch { /* ignore */ }
        });
        if (!mounted) { unlisten(); unlisten = null; }
      } catch { /* ignore */ }
    })();
    return () => { mounted = false; unlisten?.(); };
  }, []);

  usePopoverDismiss(open, [ref], () => setOpen(false));

  async function toggleFullscreen() {
    try {
      const w = getCurrentWindow();
      // Query-then-toggle against REAL window state, not our possibly-stale
      // local flag (menu / traffic-light fullscreen bypasses this component).
      const cur = await w.isFullscreen();
      await w.setFullscreen(!cur);
      setFullscreen(!cur);
    } catch (err) {
      console.warn("fullscreen toggle failed", err);
    }
  }

  return (
    <div className="cp-view-options" ref={ref}>
      {onShowMediaInfo && (
        <button
          type="button"
          className="cp-view-trigger icon-only"
          onClick={onShowMediaInfo}
          title="Media info"
          aria-label="Media info"
        >
          <IconInfo size={13} />
        </button>
      )}
      <button
        type="button"
        className={"cp-view-trigger" + (open ? " active" : "")}
        onClick={() => setOpen((o) => !o)}
        title="Canvas aspect"
        aria-label="Canvas aspect and view options"
        aria-expanded={open}
      >
        <IconAspect size={13} />
        <span className="label">{current.label}</span>
      </button>
      <button
        type="button"
        className="cp-view-trigger icon-only"
        onClick={toggleFullscreen}
        title={fullscreen ? "Exit full screen" : "Enter full screen"}
        aria-label={fullscreen ? "Exit full screen" : "Enter full screen"}
      >
        {fullscreen ? <IconFullscreenExit size={13} /> : <IconFullscreen size={13} />}
      </button>
      {open && (
        <div className="cp-view-popover" role="menu">
          <div className="cp-popover-header">Canvas aspect</div>
          {ASPECTS.map((o) => (
            <button
              key={o.id}
              type="button"
              role="menuitem"
              className={"cp-popover-item" + (aspect === o.id ? " active" : "")}
              onClick={() => { onAspectChange(o.id); setOpen(false); }}
            >
              <span className="lbl">{o.label}</span>
              <span className="sub">{o.subtitle}</span>
            </button>
          ))}
          <div className="cp-popover-header">Timeline</div>
          {/* Toggle, not a pick-one — stays open so the state flip is visible. */}
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={waveformVisible}
            className={"cp-popover-item" + (waveformVisible ? " active" : "")}
            onClick={() => onWaveformVisibleChange(!waveformVisible)}
          >
            <span className="lbl">Audio waveform</span>
            <span className="sub">{waveformVisible ? "shown on the scrub track" : "hidden"}</span>
          </button>
        </div>
      )}
    </div>
  );
}
