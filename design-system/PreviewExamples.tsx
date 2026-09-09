import { useId, useState } from "react";
import { IconChevronDown } from "../src/components/Icons";
import { VolumeControl } from "../src/components/VolumeControl";
import { NdiPreviewHeader } from "../src/components/NdiPreviewHeader";
import { StatusBadge } from "./StatusBadge";
import "./participants.css";
import "../src/styles/ndi-input.css";

/** Production disclosure styling, isolated local state. */
function SourceSpecimen({ state }: { state: "disabled" | "focus" | "expanded" | "narrow" }) {
  const [open, setOpen] = useState(state === "expanded");
  const id = useId();
  return <section className={`cp-ds-preview-specimen cp-ds-preview-specimen-${state}`} data-testid={`preview-state-${state}`}>
    <h4 className="cp-ds-fixture-title">{state === "narrow" ? "Narrow · 200px" : state.charAt(0).toUpperCase() + state.slice(1)}</h4>
    <div className="cp-ds-preview-source">
      <span className="cp-source-status">Live</span>
      <button type="button" className="cp-toolbar-disclosure" disabled={state === "disabled"} aria-expanded={open}
        aria-controls={id} onClick={() => setOpen(value => !value)}>
        {state === "narrow" ? "Connect Premiere" : "Premiere"}<IconChevronDown size={12} />
      </button>
    </div>
    <p id={id} className="cp-ds-fixture-caption" hidden={!open}>Source details · local fixture</p>
    {state === "disabled" && <p className="cp-ds-fixture-caption">Unavailable action, explicitly disabled. Live remains passive.</p>}
    {state === "focus" && <p className="cp-ds-fixture-caption">Illustrative focus ring. Tab to the main disclosure to test real keyboard focus.</p>}
  </section>;
}

export function PreviewExamples() {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [muted, setMuted] = useState(true);
  const [volume, setVolume] = useState(.65);
  const [shared, setShared] = useState(false);
  const [posted, setPosted] = useState(false);
  return <div className="cp-ds-preview-examples">
    <section className="cp-ds-preview-proposed" data-testid="preview-proposed" data-ds-example="proposed">
      <h3 className="cp-ds-fixture-title">Corrected · Preview source controls</h3>
      <p className="cp-ds-fixture-caption">Source-markup fixture using the production status and disclosure recipes. Audio uses the existing VolumeControl with local state.</p>
      <NdiPreviewHeader sharing={shared ? "shared" : "private"} />
      <div className="cp-ds-preview-monitor" aria-label="Static Preview monitor, no live media">
        <div className="cp-ds-preview-slate"><span>Premiere sequence</span><strong>Picture stays in Preview</strong><span>Static catalog fixture · not a live connection</span></div>
      </div>
      <div className="cp-ds-preview-toolbar" role="region" aria-label="Corrected Preview transport">
        <div className="cp-ds-preview-source">
          <span className="cp-source-status" data-testid="preview-live-status">Live</span>
          <button type="button" className="cp-toolbar-disclosure" data-testid="preview-source-disclosure" aria-expanded={detailsOpen} aria-controls="cp-ds-preview-source-details" onClick={() => setDetailsOpen((s) => !s)}>Premiere <IconChevronDown size={12} /></button>
        </div>
        <span className="cp-ds-fixture-caption">Playback controlled in Premiere</span>
        <div className="cp-ds-preview-volume">
          <VolumeControl volume={volume} muted={muted} onVolumeChange={setVolume} onMutedChange={setMuted} />
        </div>
      </div>
      <div className="cp-ds-preview-source-details" id="cp-ds-preview-source-details" data-testid="preview-source-details" hidden={!detailsOpen}>
        <div><strong>Premiere sequence</strong><StatusBadge>Private preview</StatusBadge></div>
        <p>Playback stays in Premiere. Connecting does not share with a room.</p>
        <p>Local audio: {muted ? "Muted" : `Enabled · ${Math.round(volume * 100)}%`} · simulation only</p>
        <p>Installation and connection diagnostics live in Settings → Integrations. The application offers a shortcut here; this fixture opens no settings or connections.</p>
      </div>
      <p className="cp-ds-fixture-caption">The header above is the production NdiPreviewHeader: sharing status and centered, explicitly unavailable sequence timecode outside the picture. In the application, source and audio-recovery details open in NDI settings from the gear beside volume; the text disclosure here only demonstrates the earlier control recipe. Play and step controls belong to file playback.</p>
      <div className="cp-ds-inline"><button type="button" className="btn cp-toolbar-disclosure cp-ndi-share-action" disabled={shared} onClick={() => setShared(true)}>Share with room</button><div className="cp-review-composer"><button type="button" className="btn btn-primary btn-compact cp-review-post" disabled={posted} onClick={() => setPosted(true)}>Post</button></div></div>
      <p className="cp-ds-fixture-caption" role="status">{shared ? "Sharing simulated. " : "Private fixture. "}{posted ? "Post simulated. " : "No note posted. "}Green identifies these explicitly approved actions, not connection health. No session or storage is accessed.</p>
      <div className="cp-ds-preview-specimens">{(["disabled", "focus", "expanded", "narrow"] as const).map(state => <SourceSpecimen key={state} state={state} />)}</div>
    </section>
    <details className="cp-ds-before-fix" data-testid="preview-before-fix">
      <summary>Before the fix</summary>
      <section className="cp-ds-preview-current" data-testid="preview-current" data-ds-example="current" data-known-defect="preview-control-vocabulary">
        <h3 className="cp-ds-fixture-title">Historical · mixed control vocabulary</h3>
        <div className="cp-ds-preview-current-row">
          <span className="cp-ds-history-timecode">Live</span>
          <span className="cp-ds-history-premiere" aria-hidden="true">Premiere…</span>
        </div>
        <p className="cp-ds-fixture-caption">Frozen historical styles, not an approved control recipe. The Live readout inherited a timecode-sized box; the source action used a different compact treatment.</p>
      </section>
    </details>
  </div>;
}
