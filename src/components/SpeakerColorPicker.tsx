import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { type Hsv, hsvToHex, rgbToHsv, parseHex, clamp01, SPEAKER_PRESETS } from "../lib/color";

/**
 * Hand-rolled, dependency-free colour picker for recolouring a speaker pip.
 * HSV is the source of truth (so dragging to black/grey keeps the hue); hex is
 * derived for display + parsed on input. Anchored as a fixed popover above the
 * Speakers modal, flipping/​clamping to stay on-screen. Commits on settle
 * (pointer-up, preset click, Enter, swatch) — Escape / outside-click closes.
 */
export function SpeakerColorPicker({
  value,
  anchorRect,
  onCommit,
  compact = false,
  onReset,
  onClose,
}: {
  value: string;
  anchorRect: DOMRect | null;
  /** Inline preset-swatch row only (the rename popover's variant) -
   *  no anchored panel, no SV/hue surface, same commit path. */
  compact?: boolean;
  onCommit: (hex: string) => void;
  onReset?: () => void;
  onClose: () => void;
}) {
  const [hsv, setHsv] = useState<Hsv>(() => {
    const rgb = parseHex(value);
    return rgb ? rgbToHsv(rgb) : { h: 210, s: 0.7, v: 0.95 };
  });
  const [hexField, setHexField] = useState(value);
  const rootRef = useRef<HTMLDivElement>(null);
  const svRef = useRef<HTMLDivElement>(null);
  const hueRef = useRef<HTMLDivElement>(null);

  const hex = hsvToHex(hsv);

  // Keep the editable hex field in step with drags (but let the user type freely).
  useEffect(() => { setHexField(hex); }, [hex]);

  // Position: prefer below the pip, flip above / clamp horizontally to viewport.
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  useLayoutEffect(() => {
    if (!anchorRect) return;
    const W = 268, H = 320, gap = 8, pad = 10;
    let left = anchorRect.left;
    let top = anchorRect.bottom + gap;
    if (left + W > window.innerWidth - pad) left = window.innerWidth - W - pad;
    if (left < pad) left = pad;
    if (top + H > window.innerHeight - pad) top = Math.max(pad, anchorRect.top - H - gap);
    setPos({ top, left });
  }, [anchorRect]);

  // Dismiss on outside-click / Escape; close commits the current colour already
  // applied via the swatch/drag handlers, so this just tears the popover down.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  const commit = (next: Hsv) => onCommit(hsvToHex(next));

  // ── SV square drag (X = saturation, Y = 1 − value) ──
  const svFromEvent = (e: React.PointerEvent | PointerEvent) => {
    const r = svRef.current!.getBoundingClientRect();
    const s = clamp01((e.clientX - r.left) / r.width);
    const v = 1 - clamp01((e.clientY - r.top) / r.height);
    return { ...hsv, s, v };
  };
  const onSvDown = (e: React.PointerEvent) => {
    e.preventDefault();
    svRef.current?.setPointerCapture(e.pointerId);
    setHsv(svFromEvent(e));
  };
  const onSvMove = (e: React.PointerEvent) => {
    if (svRef.current?.hasPointerCapture(e.pointerId)) setHsv(svFromEvent(e));
  };
  const onSvUp = (e: React.PointerEvent) => {
    if (svRef.current?.hasPointerCapture(e.pointerId)) {
      svRef.current.releasePointerCapture(e.pointerId);
      commit(svFromEvent(e));
    }
  };

  // ── Hue slider drag ──
  const hueFromEvent = (e: React.PointerEvent | PointerEvent) => {
    const r = hueRef.current!.getBoundingClientRect();
    return { ...hsv, h: clamp01((e.clientX - r.left) / r.width) * 360 };
  };
  const onHueDown = (e: React.PointerEvent) => {
    e.preventDefault();
    hueRef.current?.setPointerCapture(e.pointerId);
    setHsv(hueFromEvent(e));
  };
  const onHueMove = (e: React.PointerEvent) => {
    if (hueRef.current?.hasPointerCapture(e.pointerId)) setHsv(hueFromEvent(e));
  };
  const onHueUp = (e: React.PointerEvent) => {
    if (hueRef.current?.hasPointerCapture(e.pointerId)) {
      hueRef.current.releasePointerCapture(e.pointerId);
      commit(hueFromEvent(e));
    }
  };

  const applyHexField = () => {
    const rgb = parseHex(hexField);
    if (rgb) { const next = rgbToHsv(rgb); setHsv(next); commit(next); }
    else setHexField(hex);
  };

  const pickPreset = (p: string) => {
    const rgb = parseHex(p)!;
    const next = rgbToHsv(rgb);
    setHsv(next);
    commit(next);
  };

  if (compact) {
    return (
      <div className="cp-colorpick-compact" role="listbox" aria-label="Speaker color">
        {SPEAKER_PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            role="option"
            aria-selected={p.toLowerCase() === hex.toLowerCase()}
            className={"cp-colorpick-swatch" + (p.toLowerCase() === hex.toLowerCase() ? " sel" : "")}
            style={{ background: p }}
            title={p}
            onClick={() => onCommit(p)}
          />
        ))}
      </div>
    );
  }

  return (
    <div
      ref={rootRef}
      className="cp-colorpick"
      role="dialog"
      aria-label="Choose speaker colour"
      style={{ top: pos.top, left: pos.left }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div
        ref={svRef}
        className="cp-colorpick-sv"
        role="slider"
        tabIndex={0}
        aria-label="Saturation and brightness"
        aria-valuetext={`${Math.round(hsv.s * 100)}% saturation, ${Math.round(hsv.v * 100)}% brightness`}
        style={{ ["--cp-hue" as string]: hsv.h }}
        onPointerDown={onSvDown}
        onPointerMove={onSvMove}
        onPointerUp={onSvUp}
        onPointerCancel={(e) => { if (svRef.current?.hasPointerCapture(e.pointerId)) svRef.current.releasePointerCapture(e.pointerId); }}
        onKeyDown={(e) => {
          const step = e.shiftKey ? 0.1 : 0.02;
          let { s, v } = hsv;
          if (e.key === "ArrowLeft") s = clamp01(s - step);
          else if (e.key === "ArrowRight") s = clamp01(s + step);
          else if (e.key === "ArrowUp") v = clamp01(v + step);
          else if (e.key === "ArrowDown") v = clamp01(v - step);
          else return;
          e.preventDefault();
          const next = { ...hsv, s, v };
          setHsv(next); commit(next);
        }}
      >
        <span
          className="cp-colorpick-thumb"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }}
        />
      </div>

      <div className="cp-colorpick-controls">
        <span className="cp-colorpick-preview" style={{ ["--cp-current" as string]: hex }} />
        <div
          ref={hueRef}
          className="cp-colorpick-hue"
          role="slider"
          tabIndex={0}
          aria-label="Hue"
          aria-valuemin={0}
          aria-valuemax={360}
          aria-valuenow={Math.round(hsv.h)}
          onPointerDown={onHueDown}
          onPointerMove={onHueMove}
          onPointerUp={onHueUp}
          onPointerCancel={(e) => { if (hueRef.current?.hasPointerCapture(e.pointerId)) hueRef.current.releasePointerCapture(e.pointerId); }}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 15 : 3;
            let h = hsv.h;
            if (e.key === "ArrowLeft") h = (h - step + 360) % 360;
            else if (e.key === "ArrowRight") h = (h + step) % 360;
            else return;
            e.preventDefault();
            const next = { ...hsv, h };
            setHsv(next); commit(next);
          }}
        >
          <span className="cp-colorpick-hue-thumb" style={{ left: `${(hsv.h / 360) * 100}%` }} />
        </div>
      </div>

      <div className="cp-colorpick-row">
        <div className="cp-colorpick-hex">
          <span aria-hidden>#</span>
          <input
            value={hexField.replace(/^#/, "")}
            spellCheck={false}
            maxLength={6}
            aria-label="Hex colour"
            onChange={(e) => setHexField(e.target.value)}
            onBlur={applyHexField}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); applyHexField(); } }}
          />
        </div>
        {onReset && (
          <button className="btn btn-ghost cp-colorpick-reset" onClick={onReset} title="Reset to the automatic colour">
            Reset
          </button>
        )}
      </div>

      <div className="cp-colorpick-presets" role="listbox" aria-label="Preset colours">
        {SPEAKER_PRESETS.map((p) => (
          <button
            key={p}
            role="option"
            aria-selected={p.toLowerCase() === hex.toLowerCase()}
            className={"cp-colorpick-swatch" + (p.toLowerCase() === hex.toLowerCase() ? " sel" : "")}
            style={{ background: p }}
            title={p}
            onClick={() => pickPreset(p)}
          />
        ))}
      </div>
    </div>
  );
}
