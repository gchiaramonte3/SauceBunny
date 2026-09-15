import { useId, useRef } from "react";
import type { MultitrackPerson } from "../lib/multitrack-person";

export function MultitrackTranscriptTabs({ people, selected, onSelect, panelId }: {
  people: MultitrackPerson[]; selected: string; onSelect: (id: string) => void; panelId: string;
}) {
  const tabs = [{ id: "all", name: "All voices", color: null }, ...people], prefix = useId(), list = useRef<HTMLDivElement>(null);
  const choose = (id: string) => {
    onSelect(id);
    const button = list.current?.querySelector<HTMLButtonElement>(`[data-person-index="${tabs.findIndex((tab) => tab.id === id)}"]`);
    button?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  };
  return <div className="cp-multitrack-person-nav">
    <div ref={list} className="cp-multitrack-person-tabs" role="tablist" aria-label="Transcripts by person" onKeyDown={(event) => {
      const index = tabs.findIndex((tab) => tab.id === selected);
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "ArrowRight" ? (index + 1) % tabs.length : -1;
      if (next < 0) return; event.preventDefault(); choose(tabs[next].id); list.current?.querySelector<HTMLButtonElement>(`[data-person-index="${next}"]`)?.focus();
    }}>{tabs.map((tab, index) => <button key={tab.id} id={`${prefix}-${index}`} role="tab" data-person-index={index} aria-selected={selected === tab.id} aria-controls={panelId} tabIndex={selected === tab.id ? 0 : -1} className={`cp-tab${selected === tab.id ? " active" : ""}`} title={tab.name} onClick={() => choose(tab.id)}>
      {tab.color && <span className="cp-multitrack-person-color" style={{ background: tab.color }} aria-hidden="true" />}{tab.name}
    </button>)}</div>
    <select className="cp-select cp-multitrack-person-picker" aria-label="Choose transcript" title="Choose transcript" value={selected} onChange={(event) => choose(event.target.value)}>
      {tabs.map((tab) => <option key={tab.id} value={tab.id}>{tab.name}</option>)}
    </select>
  </div>;
}
