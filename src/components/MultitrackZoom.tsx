import { IconZoomIn, IconZoomOut } from "./Icons";

/**
 * An NLE's zoom: a magnifier at each end of a slider, and Fit. One stop per
 * doubling, 1x to 1024x, so the zoom is always a power of two.
 */
export function MultitrackZoom({ zoom, onZoom }: { zoom: number; onZoom: (zoom: number) => void }) {
  return <div className="cp-multitrack-zoom" role="group" aria-label="Timeline zoom">
    <button className="cp-icon-btn" aria-label="Zoom out" title="Zoom out" disabled={zoom <= 1} onClick={() => onZoom(Math.max(1, zoom / 2))}><IconZoomOut size={15} /></button>
    <input className="cp-multitrack-zoom-slider" type="range" aria-label="Zoom" aria-valuetext={`${zoom}×`} title={`Zoom ${zoom}×`} min={0} max={10} step={1} value={Math.log2(zoom)} onChange={(event) => onZoom(2 ** Number(event.target.value))} />
    <button className="cp-icon-btn" aria-label="Zoom in" title="Zoom in" disabled={zoom >= 1024} onClick={() => onZoom(Math.min(1024, zoom * 2))}><IconZoomIn size={15} /></button>
    <button className="btn btn-ghost" onClick={() => onZoom(1)}>Fit</button>
  </div>;
}
