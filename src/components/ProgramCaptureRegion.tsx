import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ObsCrop } from "../bindings/ObsCrop";
import type { ProgramCaptureSnapshot } from "../bindings/ProgramCaptureSnapshot";
import { formatError } from "../lib/error-format";
import { CaptureRegionEditor, captureRegionValid } from "./CaptureSourcePicker";

/** A still of one pick, and which pick it is of. */
export type RegionPicture = ProgramCaptureSnapshot & { choice: string };

/**
 * The area of a picked screen to capture, drawn on a still of that screen.
 * The still comes from the capture helper's own stream on the pick, so it
 * needs no permission the picker did not already give; it is never shared.
 */
export function ProgramCaptureRegion({ choice, label, picture, onPicture, region, onChange, onForget, disabled }: {
  choice: string; label: string; picture: RegionPicture | null; onPicture: (picture: RegionPicture | null) => void;
  region: ObsCrop | null; onChange: (region: ObsCrop | null) => void; onForget: () => void; disabled: boolean;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState(0);
  const current = picture?.choice === choice ? picture : null;

  useEffect(() => {
    if (current && request === 0) return;
    let live = true;
    setLoading(true); setError(null);
    invoke<ProgramCaptureSnapshot>("program_capture_snapshot", { choice })
      .then(still => { if (live) onPicture({ ...still, choice }); })
      .catch(cause => {
        if (!live) return;
        const message = formatError(cause);
        if (/choose again/i.test(message)) { onForget(); return; }
        setError(message);
      })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
    // A new still only for a new pick or an explicit refresh; `current` is what a fetch produces.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choice, request]);

  const width = current?.width ?? 0, height = current?.height ?? 0;
  const valid = !!region && captureRegionValid(region, width, height);
  const area = valid && region ? `${Math.round(region.width * width)} × ${Math.round(region.height * height)}` : null;
  return <>
    {loading && <p role="status">Taking a still of {label}…</p>}
    {error && <p role="alert">{error}</p>}
    {current && <CaptureRegionEditor thumbnail={current.image} label={label} width={width} height={height}
      crop={region} disabled={disabled || loading}
      onChange={onChange}/>}
    <div className="cp-capture-snapshot-note">
      <span>{area ? `Captures ${area} of ${label}.` : "Drag over the still to choose the area. It stays on this Mac."}</span>
      <button type="button" className="cp-toolbar-disclosure" disabled={disabled || loading}
        onClick={() => setRequest(value => value + 1)}>Refresh still</button>
    </div>
  </>;
}
