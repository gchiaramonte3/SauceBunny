import { RF_LAYOUTS, RF_SOURCES, type RfLayout, type RfSourceKind } from "./review-fullscreen-fixture";

export type RfOptionsState = { layout: RfLayout; source: RfSourceKind; count: number; longNames: boolean; handRaised: boolean; camerasOff: boolean; pinned: boolean };

/**
 * The reviewer's controls, not part of the design: which layout, what is on
 * the stage, and the room states worth judging it in. Nothing here is saved.
 */
export function RfOptions({ value, onChange }: { value: RfOptionsState; onChange: (next: RfOptionsState) => void }) {
  const set = <K extends keyof RfOptionsState>(key: K, next: RfOptionsState[K]) => onChange({ ...value, [key]: next });
  return <details className="cp-rf-options" data-testid="rf-options">
    <summary>Prototype options</summary>
    <fieldset><legend>Layout</legend>
      {RF_LAYOUTS.map((layout) => <label key={layout.id} title={layout.note}>
        <input type="radio" name="cp-rf-layout" checked={value.layout === layout.id} onChange={() => set("layout", layout.id)} />{layout.label}</label>)}
    </fieldset>
    <fieldset><legend>On the stage</legend>
      {(Object.keys(RF_SOURCES) as RfSourceKind[]).map((kind) => <label key={kind}>
        <input type="radio" name="cp-rf-source" checked={value.source === kind} onChange={() => set("source", kind)} />
        {RF_SOURCES[kind].live ? `${RF_SOURCES[kind].detail} (live)` : "A file the room plays"}</label>)}
    </fieldset>
    <fieldset><legend>People</legend>
      {[2, 4, 8].map((count) => <label key={count}><input type="radio" name="cp-rf-count" checked={value.count === count} onChange={() => set("count", count)} />{count}</label>)}
    </fieldset>
    <fieldset><legend>States</legend>
      <label><input type="checkbox" checked={value.longNames} onChange={(event) => set("longNames", event.target.checked)} />A long name</label>
      <label><input type="checkbox" checked={value.handRaised} onChange={(event) => set("handRaised", event.target.checked)} />A raised hand</label>
      <label><input type="checkbox" checked={value.camerasOff} onChange={(event) => set("camerasOff", event.target.checked)} />Cameras off</label>
      <label><input type="checkbox" checked={value.pinned} onChange={(event) => set("pinned", event.target.checked)} />Keep the controls shown</label>
    </fieldset>
    <p>Esc leaves full screen. Every action is a demo: nothing joins a session, captures or saves.</p>
  </details>;
}
