import { useEffect, useId, useRef, type KeyboardEvent, type PointerEvent } from "react";
import "../styles/capture-picker.css";

export type CaptureSourceItem = { id: string; label: string; description?: string; thumbnail?: string | null; thumbnailState?: "loading" | "error" };
export type CaptureRegion = { x: number; y: number; width: number; height: number };
export const MIN_CAPTURE_REGION_PX = 16;

/** A missing or invalid crop is never a request to capture the whole source. */
export function captureRegionValid(crop: CaptureRegion | null, width: number, height: number): boolean {
  return crop != null && [width, height, ...Object.values(crop)].every(Number.isFinite)
    && width > 0 && height > 0 && crop.x >= 0 && crop.y >= 0
    && crop.width * width > MIN_CAPTURE_REGION_PX && crop.height * height > MIN_CAPTURE_REGION_PX
    && crop.x + crop.width <= 1 && crop.y + crop.height <= 1;
}

export function CaptureSourceGrid({ sources, selectedId, onSelect, emptyLabel = "No sources available.", busy = false, disabled = false }: {
  sources: CaptureSourceItem[]; selectedId: string | null; onSelect: (id: string) => void;
  emptyLabel?: string; busy?: boolean; disabled?: boolean;
}) {
  return <div className="cp-capture-grid" aria-busy={busy}>
    {busy ? <p className="cp-capture-hint" role="status">Finding sources…</p> : sources.length === 0
      ? <p className="cp-capture-hint" role="status">{emptyLabel}</p>
      : sources.map(source => <button key={source.id} type="button" className="cp-capture-source"
        aria-pressed={selectedId === source.id} data-capture-source-id={source.id}
        aria-label={[source.label, source.description].filter(Boolean).join(" · ")}
        disabled={disabled} onClick={() => onSelect(source.id)}>
        <span className="cp-capture-thumbnail">{source.thumbnail
          ? <img src={source.thumbnail} alt="" draggable={false}/>
          : <span className="cp-capture-hint">{source.thumbnailState === "loading" ? "Loading preview…" : "Preview unavailable"}</span>}</span>
        <span className="cp-capture-source-label">{source.label}</span>
        {source.description && <span className="cp-capture-source-description">{source.description}</span>}
      </button>)}
  </div>;
}

export function CaptureSourceTabs({ tabs, selected, onSelect, label }: {
  tabs: { id: string; label: string; disabled?: boolean; panelId?: string }[]; selected: string;
  onSelect: (id: string) => void; label: string;
}) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = tabs.map((tab, index) => tab.disabled ? -1 : index).filter(index => index >= 0);
  const active = tabs.findIndex(tab => tab.id === selected && !tab.disabled);
  function navigate(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || !enabled.length) return;
    event.preventDefault();
    const position = enabled.indexOf(index);
    const next = event.key === "Home" ? enabled[0] : event.key === "End" ? enabled[enabled.length - 1]
      : enabled[(position + (event.key === "ArrowRight" ? 1 : -1) + enabled.length) % enabled.length];
    onSelect(tabs[next].id); buttons.current[next]?.focus();
  }
  return <div className="cp-capture-tabs" role="tablist" aria-label={label}>
    {tabs.map((tab, index) => <button key={tab.id} ref={node => { buttons.current[index] = node; }}
      type="button" role="tab" aria-selected={tab.id === selected} aria-controls={tab.panelId} disabled={tab.disabled}
      tabIndex={index === (active < 0 ? enabled[0] : active) ? 0 : -1}
      onKeyDown={event => navigate(event, index)} onClick={() => onSelect(tab.id)}>{tab.label}</button>)}
  </div>;
}

export function CaptureAudioOption({ checked, onChange, label, description, disabled = false }: {
  checked: boolean; onChange: (checked: boolean) => void; label: string; description?: string; disabled?: boolean;
}) {
  const descriptionId = useId();
  return <label className="cp-capture-audio">
    <input type="checkbox" checked={checked} onChange={event => { if (!disabled) onChange(event.target.checked); }}
      disabled={disabled} aria-label={label} aria-describedby={description ? descriptionId : undefined}/>
    <span><span>{label}</span>{description && <small id={descriptionId}>{description}</small>}</span>
  </label>;
}

type Drag = { pointer: number; x: number; y: number; crop: CaptureRegion | null; operation: string };
const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
const regionFields = [["x", "Left"], ["y", "Top"], ["width", "Width"], ["height", "Height"]] as const;

export function CaptureRegionEditor({ thumbnail, label, width, height, crop, onChange, disabled = false }: {
  thumbnail: string | null; label: string; width: number; height: number;
  crop: CaptureRegion | null; onChange: (crop: CaptureRegion | null) => void; disabled?: boolean;
}) {
  const hintId = useId();
  const drag = useRef<Drag | null>(null);
  useEffect(() => { drag.current = null; }, [disabled, thumbnail, width, height, label]);
  const valid = captureRegionValid(crop, width, height);
  const drawable = crop && Object.values(crop).every(Number.isFinite) && crop.x >= 0 && crop.y >= 0
    && crop.width > 0 && crop.height > 0 && crop.x + crop.width <= 1 && crop.y + crop.height <= 1;
  function pointer(event: PointerEvent<HTMLDivElement>, phase: "down" | "move" | "up") {
    if (disabled || !thumbnail || width <= 0 || height <= 0) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const x = clamp((event.clientX - bounds.left) / bounds.width), y = clamp((event.clientY - bounds.top) / bounds.height);
    if (phase === "down") {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement;
      const hit = target.closest<HTMLElement>("[data-crop-operation]")?.dataset.cropOperation ?? "draw";
      const wholeSource = crop?.x === 0 && crop.y === 0 && crop.width === 1 && crop.height === 1;
      const operation = hit === "move" && wholeSource ? "draw" : hit;
      drag.current = { pointer: event.pointerId, x, y, crop: crop ? { ...crop } : null, operation };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.focus();
      if (operation === "draw") onChange({ x, y, width: 0, height: 0 });
      event.preventDefault();
      return;
    }
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    const original = current.crop;
    if (current.operation === "move" && original) {
      onChange({ ...original, x: clamp(original.x + x - current.x, 0, 1 - original.width),
        y: clamp(original.y + y - current.y, 0, 1 - original.height) });
    } else {
      const anchorX = original && current.operation !== "draw"
        ? (current.operation.includes("left") ? original.x + original.width : original.x) : current.x;
      const anchorY = original && current.operation !== "draw"
        ? (current.operation.includes("top") ? original.y + original.height : original.y) : current.y;
      onChange({ x: Math.min(anchorX, x), y: Math.min(anchorY, y), width: Math.abs(x - anchorX), height: Math.abs(y - anchorY) });
    }
    if (phase === "up") { drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }
  }
  function moveWithKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (disabled || event.target !== event.currentTarget || !crop || !valid) return;
    const dx = event.key === "ArrowLeft" ? -1 / width : event.key === "ArrowRight" ? 1 / width : 0;
    const dy = event.key === "ArrowUp" ? -1 / height : event.key === "ArrowDown" ? 1 / height : 0;
    if (!dx && !dy) return;
    event.preventDefault();
    const next = event.shiftKey ? { ...crop, width: clamp(crop.width + dx, 0, 1 - crop.x),
      height: clamp(crop.height + dy, 0, 1 - crop.y) }
      : { ...crop, x: clamp(crop.x + dx, 0, 1 - crop.width), y: clamp(crop.y + dy, 0, 1 - crop.height) };
    if (captureRegionValid(next, width, height)) onChange(next);
  }
  function cancelDrag() { const previous = drag.current; drag.current = null; if (previous) onChange(previous.crop); }
  const aspect = Number.isFinite(width / height) && width > 0 && height > 0 ? width / height : 16 / 9;
  return <div className="cp-capture-region">
    <div className="cp-capture-region-surface" role="group" aria-label={`${label} crop`} aria-describedby={hintId}
      aria-disabled={disabled} tabIndex={disabled ? -1 : 0}
      style={{ aspectRatio: String(aspect), width: `min(100%, ${240 * aspect}px, ${32 * aspect}vh)` }}
      onPointerDown={event => pointer(event, "down")} onPointerMove={event => pointer(event, "move")}
      onPointerUp={event => pointer(event, "up")} onPointerCancel={cancelDrag}
      onLostPointerCapture={cancelDrag} onKeyDown={moveWithKeys}>
      {thumbnail ? <img src={thumbnail} alt={label} draggable={false}/> : <span className="cp-capture-hint">Preview unavailable. Use the fields below.</span>}
      {drawable && crop && <div className="cp-capture-region-rect" data-crop-operation="move"
        style={{ left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%` }}>
        {["top-left", "top-right", "bottom-left", "bottom-right"].map(corner => <span key={corner}
          className={`cp-capture-region-handle ${corner}`} data-crop-operation={corner} aria-hidden="true"/>)}
      </div>}
    </div>
    <p id={hintId} className="cp-capture-hint">Drag to select an area, then move or resize it. Arrow keys move one pixel; Shift + arrow keys resize. Fields are percent of the source.</p>
    <div className="cp-capture-region-fields">{regionFields.map(([key, name]) => <label key={key}>{name}
      <input className="cp-input" type="number" min={0} max={100} step={0.1} value={crop && Number.isFinite(crop[key]) ? Number((crop[key] * 100).toFixed(6)) : ""}
        disabled={disabled} aria-describedby={hintId} aria-invalid={crop != null && !valid}
        onChange={event => { if (!disabled) onChange({ ...(crop ?? { x: 0, y: 0, width: 0, height: 0 }), [key]: event.target.valueAsNumber / 100 }); }}/>
    </label>)}</div>
    {crop && !valid && <p className="cp-capture-hint" role="status">Select an area inside the source, larger than 16 pixels in both dimensions.</p>}
    {crop && <button type="button" className="btn btn-ghost btn-compact" disabled={disabled} onClick={() => onChange(null)}>Clear selection</button>}
  </div>;
}
