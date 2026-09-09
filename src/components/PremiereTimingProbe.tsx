import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { NdiTimingProbeResult } from "../bindings/NdiTimingProbeResult";
import { getPremiereLink, subscribePremiereLink } from "../lib/premiere-link";
import { formatError } from "../lib/error-format";
import { CollapsibleSection } from "./CollapsibleSection";

/** Diagnostic collection is explicit, bounded, and stopped on panel exit. */
export function PremiereTimingProbe() {
  const link = useSyncExternalStore(subscribePremiereLink, getPremiereLink);
  const [probe, setProbe] = useState<NdiTimingProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const current = useRef<NdiTimingProbeResult | null>(null);
  const generation = useRef(0);
  const stop = async () => {
    const previous = current.current; current.current = null;
    ++generation.current;
    if (!previous) return;
    const result = await invoke<NdiTimingProbeResult>("ndi_timing_probe_stop", { id: previous.sourceId, probeId: previous.probeId });
    setProbe(result);
  };
  useEffect(() => {
    let disposed = false, reading = false;
    const invalidate = () => { generation.current += 1; };
    const timer = window.setInterval(() => {
      const capture = current.current, turn = generation.current;
      if (!capture || capture.phase !== "running" || reading) return;
      reading = true;
      void invoke<NdiTimingProbeResult>("ndi_timing_probe_read", { id: capture.sourceId, probeId: capture.probeId })
        .then(result => { if (!disposed && turn === generation.current) { current.current = result; setProbe(result); } })
        .catch(cause => { if (!disposed && turn === generation.current) { current.current = null; setError(formatError(cause)); } })
        .finally(() => { reading = false; });
    }, 1000);
    return () => {
      disposed = true; invalidate(); window.clearInterval(timer);
      const capture = current.current; current.current = null;
      if (capture) void invoke("ndi_timing_probe_stop", { id: capture.sourceId, probeId: capture.probeId }).catch(() => {});
    };
  }, []);
  return <CollapsibleSection id="premiere-settings-timing" label="Timing proof diagnostics" open={expanded} onToggle={() => setExpanded(value => !value)}>
    <p>Enable transmitted sequence-timecode overlays in Premiere for comparison. Raw NDI clocks and metadata are not verified sequence timecode. This does not enable automatic markers.</p>
    <div className="cp-premiere-companion-actions">
      <button type="button" className="btn" disabled={busy || !link.visible || probe?.phase === "running"} onClick={() => {
        const id = link.visible?.streamId; if (!id) return;
        const turn = ++generation.current; setBusy(true); setError(null);
        void invoke<NdiTimingProbeResult>("ndi_timing_probe_start", { id, durationSeconds: 15 }).then(result => {
          if (turn !== generation.current) {
            void invoke("ndi_timing_probe_stop", { id: result.sourceId, probeId: result.probeId }).catch(() => {});
            return;
          }
          current.current = result; setProbe(result);
        }).catch(cause => { if (turn === generation.current) setError(formatError(cause)); })
          .finally(() => { if (turn === generation.current) setBusy(false); });
      }}>Capture 15-second timing sample</button>
      {probe?.phase === "running" && <button type="button" className="btn btn-ghost" onClick={() => {
        void stop().catch(cause => setError(formatError(cause)));
      }}>Stop timing capture</button>}
    </div>
    {probe && <>
      <p role="status">{probe.phase} · {probe.samples.length} retained observations · {probe.overwrittenSamples} older samples replaced · Timing unverified</p>
      <pre aria-label="Latest raw timing observations">{JSON.stringify(probe.samples.slice(-3), null, 2)}</pre>
    </>}
    {error && <p role="alert">{error}</p>}
  </CollapsibleSection>;
}
