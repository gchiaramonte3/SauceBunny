import { useState } from "react";
import { IconScreenShare } from "../src/components/Icons";
import { Button } from "./Button";
import { ParticipantTile, type CatalogParticipant } from "./ParticipantTile";
import "./participants.css";

const PEOPLE: CatalogParticipant[] = [
  { id: "m0", name: "Gasper", initials: "GC", color: "var(--novella-violet)", self: true, host: true, presenting: true, muted: true, speaking: true, cameraOff: true, sharing: true, recording: true, handRaised: true, connection: "connected" },
  { id: "m1", name: "Alexandra Montgomery-Chiaramonte", initials: "AM", color: "var(--gold)", cameraOff: true, connection: "connecting" },
];

/** Frozen historical recipe. Never inherits the corrected production classes. */
function CurrentCompact() {
  return <div className="cp-ds-current-people" data-testid="participants-current" data-ds-example="current" data-known-defect="people-compact-clipping" aria-label="Historical compact People panel, clipping defect">
    <div className="cp-ds-history-people" aria-hidden="true">
      {PEOPLE.map((p) => <div className="cp-ds-history-person" key={p.id}>
        <span className="cp-ds-history-initials">{p.initials}</span>
        {p.presenting && <span className="cp-ds-history-presenting">Presenting</span>}
        {p.sharing && <span className="cp-ds-history-sharing">Sharing screen</span>}
        {p.recording && <span className="cp-ds-history-recording">Recording</span>}
        {p.handRaised && <span className="cp-ds-history-hand">✋</span>}
      </div>)}
    </div>
    <p className="cp-ds-fixture-caption">Frozen historical styles, not an approved recipe. Expanded badges were inside the 48px circular crop.</p>
  </div>;
}

export function ParticipantExamples() {
  const [presenter, setPresenter] = useState("m0");
  const [stress, setStress] = useState(true);
  const [connection, setConnection] = useState<NonNullable<CatalogParticipant["connection"]>>("connecting");
  const [cameraOn, setCameraOn] = useState(false);
  const [longActionUsed, setLongActionUsed] = useState(false);
  const [muted, setMuted] = useState(true);
  const people = PEOPLE.map((p) => ({ ...p, presenting: p.id === presenter, sharing: p.sharing && stress, recording: p.recording && stress, handRaised: p.handRaised && stress,
    muted: p.self ? muted : p.muted, cameraOff: !cameraOn, connection: p.self ? p.connection : connection }));
  const tile = (p: CatalogParticipant, density: "compact" | "expanded" | "theater") => <ParticipantTile key={p.id} participant={p} density={density}
    onToggleMic={p.self ? () => setMuted(value => !value) : undefined} onToggleCamera={p.self ? () => setCameraOn(value => !value) : undefined} />;
  return <div className="cp-ds-participant-examples">
    <div className="cp-ds-fixture-actions">
      <Button size="compact" onClick={() => setPresenter((id) => id === "m0" ? "m1" : "m0")}><IconScreenShare size={13} />Switch presenter</Button>
      <Button size="compact" variant="quiet" aria-pressed={stress} onClick={() => setStress((s) => !s)}>All indicators {stress ? "on" : "off"}</Button>
      <Button size="compact" data-testid="participant-camera-state" variant="quiet" aria-pressed={cameraOn} onClick={() => setCameraOn((on) => !on)}>Camera {cameraOn ? "on" : "off"} · fixture</Button>
      <Button size="compact" data-testid="participant-connection-state" variant="quiet" onClick={() => setConnection((s) => s === "connecting" ? "disconnected" : s === "disconnected" ? "connected" : "connecting")}>Peer {connection}</Button>
      <span className="cp-ds-fixture-caption">Mock state only. Open an avatar with a click, Enter, or Space.</span>
    </div>
    <p className="cp-ds-fixture-caption">Corrected production People recipes with local participant state. Camera imagery is a static fixture; no media, devices or room actions run here.</p>
    <div className="cp-ds-participant-comparison">
      <section className="cp-ds-fixture-column" data-ds-example="proposed" data-testid="participants-proposed"><h3 className="cp-ds-fixture-title">Corrected · compact</h3>
        <div className="cp-people spine cp-ds-people-rail" data-testid="participants-compact" aria-label="Corrected compact People panel"><div className="cp-people-list">{people.map((p) => tile(p, "compact"))}</div></div>
        <p className="cp-ds-fixture-caption">Same 72px rail. Presenter pin sits outside the clipped picture; status icons have their own space. Camera/mic buttons are hidden here; open participant details for those actions, or use the room toolbar.</p>
      </section>
      <section className="cp-ds-fixture-column" data-ds-example="proposed"><h3 className="cp-ds-fixture-title">Corrected · expanded</h3>
        <div className="cp-people cp-ds-people-expanded" data-testid="participants-expanded" aria-label="Corrected expanded People panel"><div className="cp-people-list">{people.map((p) => tile(p, "expanded"))}</div></div>
      </section>
    </div>
    <section className="cp-ds-theater-example" data-ds-example="proposed"><h3 className="cp-ds-fixture-title">Corrected · theater strip</h3>
      <div className="cp-people strip cp-ds-people-theater" data-testid="participants-theater" aria-label="Corrected theater participants"><div className="cp-people-list">{people.map((p) => tile(p, "theater"))}</div></div>
      <p className="cp-ds-fixture-caption">The same presenter, mute state, and accessible details at every density. No stream is opened or remounted by this fixture.</p>
    </section>
    <section className="cp-ds-long-label-example" data-ds-example="proposed">
      <h3 className="cp-ds-fixture-title">Narrow action · full label retained</h3>
      <div className="cp-ds-long-label-width"><Button size="compact" data-testid="participant-long-action" onClick={() => setLongActionUsed(true)}>Choose a different Premiere sequence</Button></div>
      <p className="cp-ds-fixture-caption" role="status">{longActionUsed ? "Demo action selected. No source changed." : "160px container. The action grows vertically instead of clipping or hiding its label."}</p>
    </section>
    <details className="cp-ds-before-fix" data-testid="participants-before-fix"><summary>Before the fix</summary><CurrentCompact /></details>
  </div>;
}
