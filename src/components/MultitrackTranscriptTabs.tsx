import type { MultitrackPerson } from "../lib/multitrack-person";
import { TabStrip } from "./TabStrip";

export function MultitrackTranscriptTabs({ people, selected, onSelect, panelId }: {
  people: MultitrackPerson[]; selected: string; onSelect: (id: string) => void; panelId: string;
}) {
  const tabs = [{ id: "all", label: "All voices" }, ...people.map((person) => ({ id: person.id, label: person.name, swatch: person.color }))];
  return <div className="cp-multitrack-person-nav">
    <TabStrip tabs={tabs} selected={selected} onSelect={onSelect} label="Transcripts by person" noun="people" panelId={panelId} />
  </div>;
}
