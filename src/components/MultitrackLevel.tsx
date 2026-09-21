import { useCallback, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useDismiss } from "../hooks/use-dismiss";
import { IconRefresh, IconVolume, IconVolumeMuted } from "./Icons";
import { formatTrackGain, parseTrackGain, trackDbToGain, trackGainToDb, TRACK_GAIN_MAX_DB, TRACK_GAIN_OFF } from "../lib/multitrack-gain";

const ticks = [36, 12, 0, -24, -48, TRACK_GAIN_OFF];

/** Track gain is audition-only. The popup escapes the scrolling lane mask. */
export function MultitrackLevel({ owner, value, onChange }: { owner: string; value: number; onChange: (value: number) => void }) {
  const [open, setOpen] = useState(false), [position, setPosition] = useState({ left: 0, top: 0 });
  const [draft, setDraft] = useState<string | null>(null), pending = useRef<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null), slider = useRef<HTMLInputElement>(null);
  const id = useId(), label = formatTrackGain(value), db = trackGainToDb(value);
  const writeDraft = (text: string | null) => { pending.current = text; setDraft(text); };
  const commit = useCallback(() => {
    if (pending.current !== null) {
      const gain = parseTrackGain(pending.current);
      if (gain !== null) onChange(gain);
    }
    pending.current = null; setDraft(null);
  }, [onChange]);
  const close = useCallback(() => { commit(); setOpen(false); trigger.current?.focus(); }, [commit]);
  const faderKey = (event: KeyboardEvent<HTMLInputElement>) => {
    // WebKit reverses Home/End on an RTL vertical range; keep numeric slider
    // semantics identical across engines (Up increases, Home is silence).
    const targets: Record<string, number> = { Home: TRACK_GAIN_OFF, End: TRACK_GAIN_MAX_DB,
      ArrowUp: db + 1, ArrowRight: db + 1, ArrowDown: db - 1, ArrowLeft: db - 1, PageUp: db + 6, PageDown: db - 6 };
    const next = targets[event.key];
    if (next === undefined) return;
    event.preventDefault(); event.stopPropagation(); writeDraft(null); onChange(trackDbToGain(next));
  };
  useDismiss(panel, close, open);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect(), bounds = panel.current?.getBoundingClientRect();
      if (anchor && bounds) setPosition({ left: Math.max(8, Math.min(anchor.left, innerWidth - bounds.width - 8)), top: Math.max(8, Math.min(anchor.bottom + 4, innerHeight - bounds.height - 8)) });
    };
    place(); slider.current?.focus();
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true); };
  }, [open]);
  return <>
    <button ref={trigger} className={`cp-icon-btn cp-multitrack-level${open ? " active" : ""}`} aria-label={`${owner} volume: ${label}`} title={`${owner} volume: ${label}`} aria-expanded={open} aria-controls={open ? id : undefined}
      onMouseDown={(event) => event.stopPropagation()} onClick={() => { if (open) close(); else setOpen(true); }}>
      {value === 0 ? <IconVolumeMuted size={15} /> : <IconVolume size={15} />}
    </button>
    {open && createPortal(<div ref={panel} id={id} className="cp-multitrack-level-popover" role="group" aria-label={`${owner} volume controls`} style={position}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); writeDraft(null); close(); }
      }}>
      <div className="cp-multitrack-level-heading" title={owner}>{owner} · Gain</div>
      <div className="cp-multitrack-fader">
        <input ref={slider} className="cp-multitrack-gain-slider" aria-label={`${owner} gain`} aria-valuetext={label} aria-orientation="vertical" type="range"
          min={TRACK_GAIN_OFF} max={TRACK_GAIN_MAX_DB} step={1} value={db} onKeyDown={faderKey} onChange={(event) => { writeDraft(null); onChange(trackDbToGain(Number(event.target.value))); }} />
        <div className="cp-multitrack-gain-ticks">{ticks.map((tick) => <span key={tick} className={tick === 0 ? "cp-multitrack-gain-unity" : undefined}
          style={{ top: `${(TRACK_GAIN_MAX_DB - tick) / (TRACK_GAIN_MAX_DB - TRACK_GAIN_OFF) * 100}%` }}>
          <span aria-hidden="true">{tick === TRACK_GAIN_OFF ? "−∞" : `${tick > 0 ? "+" : ""}${tick}`}</span>
          {tick === 0 && <button type="button" className="cp-icon-btn cp-multitrack-gain-reset" aria-label="Reset to 0 dB" title="Reset to 0 dB"
            onClick={() => { writeDraft(null); onChange(1); }}><IconRefresh size={13} /></button>}
        </span>)}</div>
      </div>
      <input className={`cp-input cp-multitrack-gain-value${db > 12 ? " is-boosted" : ""}`} aria-label={`${owner} gain in decibels`}
        type="text" inputMode="decimal" autoComplete="off" spellCheck={false} value={draft ?? label}
        onMouseDown={(event) => { event.preventDefault(); event.currentTarget.focus(); event.currentTarget.select(); }}
        onFocus={(event) => event.currentTarget.select()} onClick={(event) => event.currentTarget.select()}
        onChange={(event) => { if (/^\s*[+-]?\d*(?:\.\d*)?\s*(?:d(?:b)?)?\s*$/i.test(event.target.value)) writeDraft(event.target.value); }}
        onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(); event.currentTarget.blur(); slider.current?.focus(); } }} />
    </div>, document.body)}
  </>;
}
