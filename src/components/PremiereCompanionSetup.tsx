import { useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PremierePairing } from "../bindings/PremierePairing";
import { associatePremiereInput, getPremiereLink, refreshPremiereLink, subscribePremiereLink } from "../lib/premiere-link";
import { formatError } from "../lib/error-format";
import { PremiereTimingProbe } from "./PremiereTimingProbe";
import { PREMIERE_ROOM_MARKERS_ENABLED } from "../lib/premiere-permissions";
import { CollapsibleSection } from "./CollapsibleSection";
import { formatPremierePairingCode } from "../lib/premiere-pairing-code";
import "../styles/premiere-companion.css";

/** Pairing is a deliberate action in Settings, never a side effect of Preview. */
export function PremiereCompanionSetup() {
  const link = useSyncExternalStore(subscribePremiereLink, getPremiereLink);
  const [pairing, setPairing] = useState<PremierePairing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await action(); await refreshPremiereLink(); }
    catch (cause) { setError(formatError(cause)); }
    finally { setBusy(false); }
  };
  const bridge = link.bridge;
  return <section className="cp-premiere-companion" aria-label="Premiere timeline markers"
    onKeyDown={event => { if (event.key !== "Escape") event.stopPropagation(); }}>
    <h4 className="cp-section-label">Timeline markers <span className="cp-premiere-beta">Beta</span></h4>
    <p>The companion panel is separate from NDI. Only the editor installs it; reviewers use Sauce Bunny.</p>
    <div className="cp-premiere-companion-actions">
      <button type="button" className="btn" disabled={busy} onClick={() => void run(async () => {
        await invoke("premiere_install_companion");
      })}>Install Premiere companion…</button>
      <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void run(async () => {
        setCopied(false);
        setPairing(await invoke<PremierePairing>("premiere_bridge_start"));
      })}>{bridge?.phase === "off" || !bridge ? "Pair companion…" : "New pairing…"}</button>
      {bridge && bridge.phase !== "off" && <button type="button" className="btn btn-ghost" disabled={busy}
        onClick={() => void run(async () => { await invoke("premiere_bridge_stop"); setPairing(null); })}>Disconnect companion</button>}
    </div>
    <p role="status">{bridge?.phase === "connected" ? "Companion connected" : bridge?.phase === "pairing" ? "Waiting for the companion to pair" : "Companion disconnected"}
      {bridge?.binding ? ` · ${bridge.binding.sequenceName}` : " · No bound sequence"}</p>
    {pairing && bridge?.phase === "pairing" && <div className="cp-premiere-pairing">
      <p>Copy the code, then paste it into Sauce Bunny’s panel in Premiere and choose Connect.</p>
      <div className="cp-premiere-companion-actions">
        <button type="button" className="btn" onClick={() => {
          setCopied(false); setError(null);
          void (async () => {
            try { await navigator.clipboard.writeText(formatPremierePairingCode(pairing)); setCopied(true); }
            catch (cause) { setError(formatError(cause)); }
          })();
        }}>Copy pairing code</button>
        <span role="status">{copied ? "Copied. Paste in Premiere." : "Address and secret included."}</span>
      </div>
      <p className="cp-premiere-pairing-hint">Private code · Expires after five minutes. Do not send it to reviewers.</p>
    </div>}
    {bridge?.binding && <>
      <p>Bound project: {bridge.binding.projectName}. In the companion, enable “Send review notes to Premiere”.
        {bridge.syncEnabled ? " Marker sync is enabled." : " Marker sync is off."}</p>
      <button type="button" className="btn" disabled={busy || !link.visible || !bridge.syncEnabled}
        onClick={() => { try { associatePremiereInput(); setError(null); } catch (cause) { setError(formatError(cause)); } }}>
        Bind this live input to {bridge.binding.sequenceName}</button>
      {link.visible && <p>Selected input: {link.visible.name}</p>}
      {link.association && <p>Input bound for notes. This does not verify that NDI carries sequence timecode.</p>}
    </>}
    <p>Automatic placement is off. Timeline notes capture the displayed moment and wait for the editor to confirm a position in Premiere. General notes are not turned into markers.</p>
    {!PREMIERE_ROOM_MARKERS_ENABLED && <p>Local companion proof only. Sharing sequence details and marker requests with a review room is not enabled in this build.</p>}
    {bridge && <p>{bridge.pendingCount} notes waiting for Premiere. Added markers still require you to save the Premiere project.</p>}
    {(error || link.error || bridge?.error) && <p role="alert">{error || link.error || bridge?.error}</p>}
    <CollapsibleSection id="premiere-settings-recovery" label="Installation and recovery" open={recoveryOpen} onToggle={() => setRecoveryOpen(value => !value)}>
      <p>This proof targets Premiere Pro 2026, 26.3.2. The install action opens the companion .ccx included with this app in Creative Cloud. You approve installation there; installing Sauce Bunny does not install a Premiere plugin automatically.</p>
      <p>Bind the exact project and sequence in the companion, then bind the live input here. A changed sequence never receives old notes automatically. Confirm pending notes in the companion, not by moving Sauce Bunny’s file playhead.</p>
      <p>If disconnected, notes remain in the saved review and retry into the local marker queue after reconnecting. Premiere Undo is respected; an undone marker is not silently recreated.</p>
    </CollapsibleSection>
    <PremiereTimingProbe />
  </section>;
}
