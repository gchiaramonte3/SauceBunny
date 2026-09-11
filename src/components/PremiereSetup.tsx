import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { NdiPreflightResult } from "../bindings/NdiPreflightResult";
import type { NdiTelemetry } from "../bindings/NdiTelemetry";
import { formatError } from "../lib/error-format";
import ndiTerms from "../../licenses/NDI-RUNTIME-TERMS.txt?raw";
import { open } from "@tauri-apps/plugin-dialog";
import { PremiereCompanionSetup } from "./PremiereCompanionSetup";
import { CollapsibleSection } from "./CollapsibleSection";

export const NDI_LINKS = {
  installer: "https://downloads.ndi.tv/Tools/NDIToolsInstaller.pkg",
  tools: "https://ndi.video/tools/",
  information: "https://ndi.video/",
} as const;

export function PremiereSetupLinks() {
  const [error, setError] = useState<string | null>(null);
  const openLink = async (url: string) => {
    setError(null);
    try { await invoke("open_external_url", { url }); }
    catch (cause) { setError(formatError(cause)); }
  };
  return <div className="cp-premiere-links">
    <p>One-time setup on the editor’s Mac. Reviewers do not need this.</p>
    <div className="cp-ndi-actions">
      <button type="button" className="btn" onClick={() => void openLink(NDI_LINKS.installer)}>Download NDI Tools for Premiere</button>
      <button type="button" className="btn btn-ghost" onClick={() => void openLink(NDI_LINKS.tools)}>NDI Tools website</button>
    </div>
    <p>The download opens in your browser. Run the installer, accept its license, and restart Premiere or your Mac if requested.</p>
    {error && <p role="alert">Could not open the download. {error}</p>}
  </div>;
}

export function NdiAttribution({ compact = true }: { compact?: boolean }) {
  const [error, setError] = useState<string | null>(null);
  return <div className="cp-ndi-attribution">
    <p>NDI® is a registered trademark of Vizrt NDI AB. Sauce Bunny is not endorsed by NDI.</p>
    <button type="button" className={`btn btn-ghost${compact ? " btn-compact" : ""}`} onClick={() => {
      setError(null);
      void invoke("open_external_url", { url: NDI_LINKS.information }).catch(cause => setError(formatError(cause)));
    }}>About NDI</button>
    {error && <p role="alert">{error}</p>}
  </div>;
}

export function PremiereSetup({ telemetry }: { telemetry?: NdiTelemetry }) {
  const [preflight, setPreflight] = useState<NdiPreflightResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sections, setSections] = useState<Record<string, boolean>>({});
  const disclosure = (id: string, label: string) => ({
    id: `premiere-settings-${id}`, label, open: !!sections[id],
    onToggle: () => setSections(previous => ({ ...previous, [id]: !previous[id] })),
  });
  const generation = useRef(0);
  const pending = useRef(false);
  const check = useCallback(async () => {
    if (pending.current) return;
    const turn = ++generation.current; pending.current = true;
    // A refresh supersedes the previous observation. If it fails, neither a
    // stale "found" nor a stale "not found" result describes this check.
    setBusy(true); setError(null); setPreflight(null);
    try {
      const result = await invoke<NdiPreflightResult>("ndi_preflight");
      if (turn === generation.current) setPreflight(result);
    } catch (cause) { if (turn === generation.current) setError(`Could not check Premiere setup. Try Check again. ${formatError(cause)}`); }
    finally { if (turn === generation.current) { pending.current = false; setBusy(false); } }
  }, []);
  const cancelChecks = useCallback(() => { generation.current++; pending.current = false; }, []);
  useEffect(() => {
    void check();
    const focus = () => { void check(); };
    window.addEventListener("focus", focus);
    return () => { cancelChecks(); window.removeEventListener("focus", focus); };
  }, [check, cancelChecks]);
  return <section className="cp-premiere-setup" aria-label="Premiere integration">
    <h3 className="cp-pane-title">Premiere <span className="cp-premiere-beta">Beta</span></h3>
    <p className="cp-pane-sub">Bring Premiere’s sequence picture and stereo audio into the Sauce Bunny monitor using NDI®. Premiere controls playback; your camera and microphone stay separate.</p>
    <div className="cp-pane-row">
      <div className="k">Premiere output plugin
        <span className="desc" role="status" aria-label="NDI installation">{busy ? "Checking this Mac…" : preflight?.pluginInstalled ? "Premiere output plugin found" : preflight ? "Premiere output plugin not found" : "Installation status unavailable"}</span>
      </div>
      <div className="v"><button type="button" className="btn btn-ghost cp-premiere-recheck" aria-disabled={busy} aria-busy={busy} onClick={() => void check()}>Check again</button></div>
    </div>
    {preflight?.pluginInstalled && <p className="cp-settings-note">The plugin is installed. Enable its output in Premiere, then choose the source in Sauce Bunny. Installation alone does not confirm a working picture.</p>}
    {preflight && !preflight.bridgeCompiled && <p role="alert">This Sauce Bunny build does not include Premiere input. Install a build with NDI support.</p>}
    {preflight?.bridgeCompiled && preflight.runtime !== "ready" && <p role="alert">{preflight.error || "The included NDI runtime could not load. Reinstall Sauce Bunny."}</p>}
    {import.meta.env.DEV && preflight && preflight.runtimeOrigin !== "bundled" && <CollapsibleSection {...disclosure("runtime", "Developer runtime override")}>
      <p>Unbundled developer builds only. Packaged Sauce Bunny always uses its included runtime.</p>
      <button type="button" className="btn" onClick={()=>{
        void (async()=>{
          const path=await open({directory:true,multiple:false,title:"Choose developer NDI runtime folder"});
          if(typeof path!=="string")return;
          await invoke("ndi_set_runtime",{path});await check();
        })().catch(cause=>setError(formatError(cause)));
      }}>Choose developer runtime folder…</button>
    </CollapsibleSection>}
    <PremiereSetupLinks />
    {error && <p role="alert">{error}</p>}
    <CollapsibleSection {...disclosure("output", "Enable Premiere output")}>
      <ol>
        <li>Open Premiere → Settings → Playback and enable Mercury Transmit.</li>
        <li>Select NDI video output and set Primary Audio Device to NDI output.</li>
        <li>Set the Program Monitor’s playback resolution to Full.</li>
        <li>Leave “Disable video output when in the background” off.</li>
        <li>Allow Local Network access for Premiere and Sauce Bunny in macOS System Settings → Privacy &amp; Security.</li>
      </ol>
      <p>Return to the monitor, open NDI settings beside volume, select your source, and preview it before sharing.</p>
    </CollapsibleSection>
    <CollapsibleSection {...disclosure("troubleshoot", "Troubleshoot a missing source")}>
      <p>Open a sequence in Premiere and check Mercury Transmit. If the source still does not appear, check Local Network permission and try Refresh. An empty source list does not prove permission was denied.</p>
      <p>NDI Video Monitor is an optional check: if it cannot receive Premiere either, check the NDI Tools plugin before troubleshooting Sauce Bunny.</p>
    </CollapsibleSection>
    <CollapsibleSection {...disclosure("connection", "Connection details")}>
      {preflight?.premiereVersion && <p>Premiere {preflight.premiereVersion} · tested target: Premiere Pro 2026, 26.3.2</p>}
      {preflight?.runtime === "ready" && <p>NDI runtime {preflight.runtimeVersion || "ready"}{preflight.runtimeOrigin === "bundled" ? " · included with Sauce Bunny" : " · developer installation"}</p>}
      <p>Up to 1080p/30 · Stereo.</p>
      {telemetry?.sourceId ? <>
        <p>{telemetry.inputWidth} × {telemetry.inputHeight} · {telemetry.outputFps.toFixed(1)} fps · {telemetry.phase}</p>
        <p>Frames {telemetry.receivedFrames.toLocaleString()} · NDI drops {telemetry.ndiDroppedFrames.toLocaleString()} · encoder drops {telemetry.encoderDroppedFrames.toLocaleString()} · input age {telemetry.lastInputAgeMs.toLocaleString()} ms{telemetry.encodedBitrateKbps !== null ? ` · ${telemetry.encodedBitrateKbps.toLocaleString()} kbps` : ""}</p>
      </> : <p>No active Premiere input. Connect a source in Preview to see its receiver diagnostics.</p>}
    </CollapsibleSection>
    <CollapsibleSection {...disclosure("terms", "NDI runtime terms")}>
      <pre className="cp-ndi-terms">{ndiTerms}</pre>
    </CollapsibleSection>
    <NdiAttribution compact={false} />
    <PremiereCompanionSetup />
  </section>;
}
